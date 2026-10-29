//! Streaming readers and writers on top of OpenDAL, plus a streaming WebDAV `PUT`
//! (OpenDAL's WebDAV writer buffers whole files in memory).

use async_trait::async_trait;
use bytes::Bytes;
use futures::StreamExt;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use super::{map_err, map_io_err};
use crate::error::{Error, Result};
use crate::vfs::{FileReader, FileWriter};

pub(super) struct ObjectReader {
    stream: Option<opendal::FuturesBytesStream>,
    pending: Bytes,
    path: String,
}

impl ObjectReader {
    pub fn new(stream: Option<opendal::FuturesBytesStream>, path: String) -> Self {
        ObjectReader { stream, pending: Bytes::new(), path }
    }
}

#[async_trait]
impl FileReader for ObjectReader {
    async fn read(&mut self, buf: &mut [u8]) -> Result<usize> {
        while self.pending.is_empty() {
            let Some(stream) = self.stream.as_mut() else { return Ok(0) };
            match stream.next().await {
                Some(Ok(b)) => self.pending = b,
                Some(Err(e)) => {
                    self.stream = None;
                    return Err(map_io_err(e, &self.path));
                }
                None => {
                    self.stream = None;
                    return Ok(0);
                }
            }
        }
        let n = buf.len().min(self.pending.len());
        buf[..n].copy_from_slice(&self.pending.split_to(n));
        Ok(n)
    }
}

pub(super) struct ObjectWriter {
    inner: Option<opendal::Writer>,
    path: String,
}

impl ObjectWriter {
    pub fn new(inner: opendal::Writer, path: String) -> Self {
        ObjectWriter { inner: Some(inner), path }
    }
}

#[async_trait]
impl FileWriter for ObjectWriter {
    async fn write_all(&mut self, buf: &[u8]) -> Result<()> {
        let w = self.inner.as_mut().ok_or_else(|| Error::other(format!("{}: upload already failed", self.path)))?;
        if let Err(e) = w.write(Bytes::copy_from_slice(buf)).await {
            let err = map_err(e, &self.path);
            if let Some(mut w) = self.inner.take() {
                let _ = w.abort().await;
            }
            return Err(err);
        }
        Ok(())
    }

    async fn finish(mut self: Box<Self>) -> Result<()> {
        let mut w = self.inner.take().ok_or_else(|| Error::other(format!("{}: upload already failed", self.path)))?;
        w.close().await.map(|_| ()).map_err(|e| map_err(e, &self.path))
    }
}

impl Drop for ObjectWriter {
    fn drop(&mut self) {
        // Abandoned upload: abort multipart uploads instead of leaving them behind.
        if let (Some(mut w), Ok(h)) = (self.inner.take(), tokio::runtime::Handle::try_current()) {
            h.spawn(async move {
                let _ = w.abort().await;
            });
        }
    }
}

type BodyChunk = std::result::Result<Bytes, std::io::Error>;

/// `PUT` with a streamed request body.
pub(super) struct DavWriter {
    tx: Option<mpsc::Sender<BodyChunk>>,
    task: Option<JoinHandle<reqwest::Result<reqwest::Response>>>,
    path: String,
}

impl DavWriter {
    pub fn start(client: &reqwest::Client, url: String, auth: Option<&str>, size: Option<u64>, path: String) -> Self {
        let (tx, rx) = mpsc::channel::<BodyChunk>(4);
        let body = futures::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) });
        let mut req = client.put(url).body(reqwest::Body::wrap_stream(body));
        if let Some(a) = auth {
            req = req.header(reqwest::header::AUTHORIZATION, a);
        }
        if let Some(n) = size {
            req = req.header(reqwest::header::CONTENT_LENGTH, n);
        }
        DavWriter { tx: Some(tx), task: Some(tokio::spawn(req.send())), path }
    }

    async fn outcome(&mut self) -> Result<()> {
        let Some(task) = self.task.take() else {
            return Err(Error::other(format!("{}: upload already finished", self.path)));
        };
        let resp =
            task.await?.map_err(|e| Error::ConnectionLost(format!("{}: {}", self.path, super::reqwest_error(&e))))?;
        let status = resp.status();
        if status.is_success() {
            return Ok(());
        }
        let body = resp.text().await.unwrap_or_default();
        Err(super::http_status_error(status.as_u16(), &self.path, &body))
    }
}

#[async_trait]
impl FileWriter for DavWriter {
    async fn write_all(&mut self, buf: &[u8]) -> Result<()> {
        let tx = self.tx.as_ref().ok_or_else(|| Error::other(format!("{}: upload already failed", self.path)))?;
        if tx.send(Ok(Bytes::copy_from_slice(buf))).await.is_err() {
            // The request ended before the body was complete: report why.
            self.tx = None;
            return Err(match self.outcome().await {
                Err(e) => e,
                Ok(()) => Error::Protocol(format!("{}: the server finished the upload early", self.path)),
            });
        }
        Ok(())
    }

    async fn finish(mut self: Box<Self>) -> Result<()> {
        drop(self.tx.take());
        self.outcome().await
    }
}

impl Drop for DavWriter {
    fn drop(&mut self) {
        if let Some(tx) = self.tx.take() {
            let _ = tx.try_send(Err(std::io::Error::other("upload aborted")));
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}
