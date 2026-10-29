//! Streaming downloads and uploads. Each holds its pooled connection until the data
//! transfer is finalized (`226`), then returns it to the pool.

use std::time::Duration;

use async_trait::async_trait;
use suppaftp::tokio::{AsyncDataStream, TokioTlsStream};
use suppaftp::FtpError;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use super::conn::{reply_code, Transfer};
use super::pool::Lease;
use crate::error::{Error, Result};
use crate::vfs::{FileReader, FileWriter};

const ABORT_TIMEOUT: Duration = Duration::from_secs(10);
/// Minimum wait for the server's reply after the last byte of an upload.
const MIN_FINISH_TIMEOUT: Duration = Duration::from_secs(60);
/// How long an upload waits for the server to close the TLS data connection.
const TLS_CLOSE_WAIT: Duration = Duration::from_secs(15);

/// Abort an unfinished transfer in the background (`ABOR`) and return the connection
/// to the pool if it is back in sync afterwards.
fn abort_later(mut lease: Lease, stream: Transfer) {
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        // Without a runtime the lease is dropped, which discards the connection.
        return;
    };
    handle.spawn(async move {
        let res = tokio::time::timeout(ABORT_TIMEOUT, async {
            let conn = lease.conn();
            match conn.ftp.abort(stream).await {
                // "225 ABOR successful; data connection closed" (no transfer in progress)
                Err(FtpError::UnexpectedResponse(r)) if reply_code(&r) == 225 => {}
                r => r?,
            }
            conn.resync().await
        })
        .await;
        if !matches!(res, Ok(Ok(()))) {
            tracing::debug!("FTP transfer abort failed: {res:?}");
            lease.conn().broken = true;
        }
        lease.release();
    });
}

/// End the TLS layer of an upload (`close_notify`) and wait until the server has read
/// everything and closed its side. Closing our socket earlier lets data the server sends
/// late (TLS 1.3 session tickets on a busy server) hit a closed socket; the resulting RST
/// can discard the end of the upload on the server, which then still reports success.
/// `TransferStream::finish` afterwards only shuts down TCP and reads the reply.
async fn close_tls_upload(stream: &mut Transfer) -> std::io::Result<()> {
    let AsyncDataStream::Ssl(tls) = stream.get_mut() else { return Ok(()) };
    let tls = tls.mut_ref();
    tls.get_mut().1.send_close_notify();
    tls.flush().await?;
    let mut buf = [0u8; 4096];
    let _ = tokio::time::timeout(TLS_CLOSE_WAIT, async { while matches!(tls.read(&mut buf).await, Ok(n) if n > 0) {} })
        .await;
    Ok(())
}

/// Release the lease after a transfer error; the connection is not reused.
fn discard(lease: Option<Lease>) {
    if let Some(mut l) = lease {
        l.conn().broken = true;
        l.release();
    }
}

pub(super) struct FtpReader {
    lease: Option<Lease>,
    stream: Option<Transfer>,
    /// Bytes still to be skipped (resume without `REST`).
    skip: u64,
    timeout: Duration,
    path: String,
}

impl FtpReader {
    pub fn new(lease: Lease, stream: Transfer, skip: u64, timeout: Duration, path: String) -> Self {
        FtpReader { lease: Some(lease), stream: Some(stream), skip, timeout, path }
    }

    fn fail(&mut self) {
        self.stream = None;
        discard(self.lease.take());
    }

    /// End of data: read the completion reply and return the connection.
    async fn complete(&mut self) -> Result<()> {
        let Some(stream) = self.stream.take() else { return Ok(()) };
        let res = tokio::time::timeout(self.timeout, stream.finish()).await;
        let Some(mut lease) = self.lease.take() else { return Ok(()) };
        let out = match res {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(lease.conn().fail(e, &self.path)),
            Err(_) => {
                lease.conn().broken = true;
                Err(Error::Timeout(format!("{}: waiting for the end of the transfer", self.path)))
            }
        };
        lease.release();
        out
    }
}

#[async_trait]
impl FileReader for FtpReader {
    async fn read(&mut self, buf: &mut [u8]) -> Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        loop {
            let Some(stream) = self.stream.as_mut() else { return Ok(0) };
            let n = match tokio::time::timeout(self.timeout, stream.read(buf)).await {
                Ok(Ok(n)) => n,
                // Some FTPS servers close the data connection without a TLS close_notify
                // (plain TCP never reports this). The 226 reply below decides whether the
                // transfer was complete.
                Ok(Err(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => 0,
                Ok(Err(e)) => {
                    self.fail();
                    return Err(Error::ConnectionLost(format!("{}: {e}", self.path)));
                }
                Err(_) => {
                    self.fail();
                    return Err(Error::Timeout(format!("reading {}", self.path)));
                }
            };
            if n == 0 {
                self.complete().await?;
                return Ok(0);
            }
            if self.skip == 0 {
                return Ok(n);
            }
            if n as u64 <= self.skip {
                self.skip -= n as u64;
                continue;
            }
            let s = self.skip as usize;
            buf.copy_within(s..n, 0);
            self.skip = 0;
            return Ok(n - s);
        }
    }
}

impl Drop for FtpReader {
    fn drop(&mut self) {
        if let (Some(stream), Some(lease)) = (self.stream.take(), self.lease.take()) {
            abort_later(lease, stream);
        }
    }
}

pub(super) struct FtpWriter {
    lease: Option<Lease>,
    stream: Option<Transfer>,
    timeout: Duration,
    path: String,
    mode: Option<u32>,
}

impl FtpWriter {
    pub fn new(lease: Lease, stream: Transfer, timeout: Duration, path: String, mode: Option<u32>) -> Self {
        FtpWriter { lease: Some(lease), stream: Some(stream), timeout, path, mode }
    }
}

#[async_trait]
impl FileWriter for FtpWriter {
    async fn write_all(&mut self, buf: &[u8]) -> Result<()> {
        let Some(stream) = self.stream.as_mut() else {
            return Err(Error::ConnectionLost(format!("{}: the upload was interrupted", self.path)));
        };
        let err = match tokio::time::timeout(self.timeout, stream.write_all(buf)).await {
            Ok(Ok(())) => return Ok(()),
            Ok(Err(e)) => Error::ConnectionLost(format!("{}: {e}", self.path)),
            Err(_) => Error::Timeout(format!("writing {}", self.path)),
        };
        self.stream = None;
        discard(self.lease.take());
        Err(err)
    }

    async fn finish(mut self: Box<Self>) -> Result<()> {
        let (Some(mut stream), Some(mut lease)) = (self.stream.take(), self.lease.take()) else {
            return Err(Error::ConnectionLost(format!("{}: the upload was interrupted", self.path)));
        };
        let res = tokio::time::timeout(self.timeout.max(MIN_FINISH_TIMEOUT), async {
            stream.flush().await.map_err(FtpError::ConnectionError)?;
            close_tls_upload(&mut stream).await.map_err(FtpError::ConnectionError)?;
            stream.finish().await
        })
        .await;
        let out = match res {
            Ok(Ok(())) => Ok(()),
            Ok(Err(e)) => Err(lease.conn().fail(e, &self.path)),
            Err(_) => {
                lease.conn().broken = true;
                Err(Error::Timeout(format!("{}: waiting for the end of the upload", self.path)))
            }
        };
        if let (Ok(()), Some(mode)) = (&out, self.mode) {
            match tokio::time::timeout(self.timeout, lease.conn().chmod(&self.path, mode)).await {
                Ok(Ok(())) => {}
                Ok(Err(e)) => tracing::debug!("setting permissions of {} failed: {e}", self.path),
                Err(_) => lease.conn().broken = true,
            }
        }
        lease.release();
        out
    }
}

impl Drop for FtpWriter {
    fn drop(&mut self) {
        if let (Some(stream), Some(lease)) = (self.stream.take(), self.lease.take()) {
            abort_later(lease, stream);
        }
    }
}
