//! Another Rust Commander instance, accessed through its web API: browse and transfer
//! files of the peer's machine like any other server.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use parking_lot::Mutex;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use sha2::Digest;
use tokio::sync::mpsc;

use crate::connect::ConnectContext;
use crate::error::{Error, Result};
use crate::known_hosts::{HostKeyStatus, KnownHosts};
use crate::prompt::{HostKeyState, PromptRequest};
use crate::site::SiteConfig;
use crate::types::*;
use crate::vfs::*;

/// Session on the peer whose file system we expose.
const PEER_SESSION: &str = "local";

pub fn fingerprint(der: &[u8]) -> String {
    sha2::Sha256::digest(der).iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

/// Accepts exactly one certificate (pinned by SHA-256), or records any certificate when
/// `pinned` is `None` (probe mode).
#[derive(Debug)]
struct PinnedVerifier {
    pinned: Option<String>,
    seen: Mutex<Option<String>>,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        let fp = fingerprint(end_entity.as_ref());
        *self.seen.lock() = Some(fp.clone());
        match &self.pinned {
            None => Ok(ServerCertVerified::assertion()),
            Some(p) if p.eq_ignore_ascii_case(&fp) => Ok(ServerCertVerified::assertion()),
            Some(_) => Err(rustls::Error::General("certificate fingerprint mismatch".into())),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

fn client(pinned: Option<String>, timeout: Duration) -> Result<(reqwest::Client, Arc<PinnedVerifier>)> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = Arc::new(PinnedVerifier { pinned, seen: Mutex::new(None), provider: provider.clone() });
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| Error::other(e.to_string()))?
        .dangerous()
        .with_custom_certificate_verifier(verifier.clone())
        .with_no_client_auth();
    let c = reqwest::Client::builder()
        .use_preconfigured_tls(config)
        .connect_timeout(timeout)
        .no_proxy()
        .build()
        .map_err(|e| Error::other(e.to_string()))?;
    Ok((c, verifier))
}

pub struct RcmdVfs {
    base: String,
    client: reqwest::Client,
    token: String,
    host: String,
    info: SessionInfo,
    remote_caps: Capabilities,
}

fn map_http_error(status: reqwest::StatusCode, body: &Value) -> Error {
    let code = body["error"]["code"].as_str().unwrap_or("");
    let msg = body["error"]["message"].as_str().unwrap_or("request failed").to_string();
    match code {
        "not_found" => Error::NotFound(msg),
        "permission_denied" | "forbidden" => Error::PermissionDenied(msg),
        "already_exists" => Error::AlreadyExists(msg),
        "not_a_directory" => Error::NotADirectory(msg),
        "is_a_directory" => Error::IsADirectory(msg),
        "directory_not_empty" => Error::DirectoryNotEmpty(msg),
        "unsupported" => Error::Unsupported(msg),
        "invalid_input" => Error::InvalidInput(msg),
        "unauthorized" => Error::AuthFailed(msg),
        "locked" => Error::Locked,
        _ if status == reqwest::StatusCode::UNAUTHORIZED => Error::AuthFailed(msg),
        _ => Error::Other(msg),
    }
}

fn net_err(e: reqwest::Error) -> Error {
    if e.is_timeout() {
        Error::Timeout(e.to_string())
    } else {
        Error::ConnectionLost(e.to_string())
    }
}

impl RcmdVfs {
    async fn call<T: DeserializeOwned>(&self, method: &str, params: Value) -> Result<T> {
        let resp = self
            .client
            .post(format!("{}/api/rpc", self.base))
            .bearer_auth(&self.token)
            .json(&json!({ "method": method, "params": params }))
            .send()
            .await
            .map_err(net_err)?;
        let status = resp.status();
        let body: Value = resp.json().await.map_err(net_err)?;
        if !status.is_success() {
            return Err(map_http_error(status, &body));
        }
        serde_json::from_value(body["result"].clone()).map_err(|e| Error::protocol(format!("{method}: {e}")))
    }

    fn sp(&self, path: &str) -> Value {
        json!({ "session": PEER_SESSION, "path": path })
    }
}

pub async fn connect(site: &SiteConfig, ctx: &ConnectContext) -> Result<Arc<dyn Vfs>> {
    let port = site.effective_port();
    let host_part = if site.host.contains(':') { format!("[{}]", site.host) } else { site.host.clone() };
    let base = format!("{}://{host_part}:{port}", if site.rcmd.tls { "https" } else { "http" });
    let timeout = site.timeout();

    // 1. Determine which certificate to trust (TOFU, pinned per host).
    let mut pinned = site.rcmd.fingerprint.clone().filter(|f| !f.is_empty());
    if site.rcmd.tls && pinned.is_none() {
        let (probe, verifier) = client(None, timeout)?;
        probe.get(format!("{base}/api/info")).timeout(timeout).send().await.map_err(net_err)?;
        let seen = verifier.seen.lock().clone().ok_or_else(|| Error::protocol("no certificate presented"))?;
        let key = KnownHosts::tls_key(&site.host, port);
        match ctx.known_hosts.check(&key, "x509", &seen) {
            HostKeyStatus::Trusted => {}
            status => {
                let (state, reason) = match &status {
                    HostKeyStatus::Mismatch { .. } => (HostKeyState::Changed, "the certificate changed since the last connection"),
                    _ => (HostKeyState::New, "self-signed certificate of a Rust Commander instance"),
                };
                let req = PromptRequest::Certificate {
                    host: site.host.clone(),
                    port,
                    fingerprint: seen.clone(),
                    subject: format!("Rust Commander on {}", site.host),
                    issuer: "self-signed".into(),
                    reason: reason.into(),
                    state,
                };
                let resp = ctx.prompter.prompt(req).await.filter(|r| r.accepted).ok_or_else(|| Error::HostKeyRejected(format!("certificate of {}", site.host)))?;
                if resp.remember {
                    ctx.known_hosts.add(&key, "x509", &seen, "")?;
                }
            }
        }
        pinned = Some(seen);
    }
    let (client, _) = client(pinned, timeout)?;

    // 2. Log in.
    let password = match &site.password {
        Some(p) => p.clone(),
        None => {
            let info: Value = client.get(format!("{base}/api/info")).send().await.map_err(net_err)?.json().await.map_err(net_err)?;
            if info["authRequired"].as_bool() == Some(false) {
                String::new()
            } else {
                let r = ctx
                    .prompter
                    .prompt(PromptRequest::Password { host: site.host.clone(), username: "Rust Commander".into(), message: String::new() })
                    .await
                    .filter(|r| r.accepted)
                    .ok_or(Error::Cancelled)?;
                r.value(0).unwrap_or("").to_string()
            }
        }
    };
    let resp = client.post(format!("{base}/api/login")).json(&json!({ "password": password })).send().await.map_err(net_err)?;
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    let token = if status.is_success() {
        body["token"].as_str().unwrap_or_default().to_string()
    } else if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(Error::AuthFailed(format!("wrong password for {}", site.host)));
    } else {
        return Err(map_http_error(status, &body));
    };

    let mut vfs = RcmdVfs { base: base.clone(), client, token, host: site.host.clone(), info: SessionInfo::default(), remote_caps: Capabilities::default() };
    let app: Value = vfs.call("app.info", Value::Null).await?;
    let sessions: Vec<Value> = vfs.call("session.list", Value::Null).await?;
    if let Some(local) = sessions.iter().find(|s| s["id"] == PEER_SESSION) {
        vfs.remote_caps = serde_json::from_value(local["capabilities"].clone()).unwrap_or_default();
    }
    vfs.info.push("Protocol", "Rust Commander peer");
    vfs.info.push("Endpoint", base);
    vfs.info.push("Instance", app["instanceName"].as_str().unwrap_or(""));
    vfs.info.push("Version", app["version"].as_str().unwrap_or(""));
    vfs.info.push("Operating system", format!("{} ({})", app["os"].as_str().unwrap_or(""), app["arch"].as_str().unwrap_or("")));
    tracing::info!(session = %ctx.session_id, "logged in to Rust Commander peer {}", vfs.host);
    Ok(Arc::new(vfs))
}

#[async_trait]
impl Vfs for RcmdVfs {
    fn protocol(&self) -> Protocol {
        Protocol::Rcmd
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            permissions: self.remote_caps.permissions,
            owner: self.remote_caps.owner,
            symlinks: self.remote_caps.symlinks,
            exec: self.remote_caps.exec,
            terminal: false,
            tunnels: false,
            server_copy: false,
            resume_upload: true,
            resume_download: true,
            set_modified: self.remote_caps.set_modified,
            server_checksum: true,
            disk_info: self.remote_caps.disk_info,
        }
    }

    fn session_info(&self) -> SessionInfo {
        self.info.clone()
    }

    async fn home(&self) -> Result<String> {
        self.call("fs.home", json!({ "session": PEER_SESSION })).await
    }

    async fn canonicalize(&self, path: &str) -> Result<String> {
        self.call("fs.realpath", self.sp(path)).await
    }

    async fn list(&self, path: &str) -> Result<Vec<FileEntry>> {
        let v: Value = self.call("fs.list", self.sp(path)).await?;
        serde_json::from_value(v["entries"].clone()).map_err(|e| Error::protocol(e.to_string()))
    }

    async fn stat(&self, path: &str) -> Result<FileEntry> {
        self.call("fs.stat", self.sp(path)).await
    }

    async fn mkdir(&self, path: &str) -> Result<()> {
        self.call::<Value>("fs.mkdir", json!({ "session": PEER_SESSION, "path": path, "parents": false })).await.map(|_| ())
    }

    async fn mkdir_all(&self, path: &str) -> Result<()> {
        self.call::<Value>("fs.mkdir", json!({ "session": PEER_SESSION, "path": path, "parents": true })).await.map(|_| ())
    }

    async fn remove_file(&self, path: &str) -> Result<()> {
        self.call::<Value>("fs.remove", json!({ "session": PEER_SESSION, "path": path })).await.map(|_| ())
    }

    async fn remove_dir(&self, path: &str) -> Result<()> {
        self.call::<Value>("fs.remove", json!({ "session": PEER_SESSION, "path": path })).await.map(|_| ())
    }

    async fn remove_dir_all(&self, path: &str) -> Result<()> {
        self.call::<Value>("fs.remove", json!({ "session": PEER_SESSION, "path": path, "recursive": true })).await.map(|_| ())
    }

    async fn rename(&self, from: &str, to: &str) -> Result<()> {
        self.call::<Value>("fs.rename", json!({ "session": PEER_SESSION, "from": from, "to": to })).await.map(|_| ())
    }

    async fn set_permissions(&self, path: &str, mode: u32) -> Result<()> {
        self.call::<Value>("fs.setAttributes", json!({ "session": PEER_SESSION, "paths": [path], "permissions": mode })).await.map(|_| ())
    }

    async fn set_owner(&self, path: &str, owner: Option<&str>, group: Option<&str>) -> Result<()> {
        self.call::<Value>("fs.setAttributes", json!({ "session": PEER_SESSION, "paths": [path], "owner": owner, "group": group }))
            .await
            .map(|_| ())
    }

    async fn set_modified(&self, path: &str, mtime: i64) -> Result<()> {
        self.call::<Value>("fs.setAttributes", json!({ "session": PEER_SESSION, "paths": [path], "modified": mtime })).await.map(|_| ())
    }

    async fn symlink(&self, target: &str, link: &str) -> Result<()> {
        self.call::<Value>("fs.symlink", json!({ "session": PEER_SESSION, "target": target, "link": link })).await.map(|_| ())
    }

    async fn read_link(&self, path: &str) -> Result<String> {
        self.stat(path).await?.link_target.ok_or_else(|| Error::InvalidInput(format!("{path} is not a symbolic link")))
    }

    async fn open_read(&self, path: &str, offset: u64) -> Result<Box<dyn FileReader>> {
        let mut req = self
            .client
            .get(format!("{}/api/download", self.base))
            .query(&[("session", PEER_SESSION), ("path", path)])
            .bearer_auth(&self.token);
        if offset > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={offset}-"));
        }
        let resp = req.send().await.map_err(net_err)?;
        let status = resp.status();
        if !status.is_success() {
            let body: Value = resp.json().await.unwrap_or(Value::Null);
            return Err(map_http_error(status, &body));
        }
        if offset > 0 && status != reqwest::StatusCode::PARTIAL_CONTENT {
            return Err(Error::protocol("peer ignored the resume offset"));
        }
        Ok(Box::new(HttpReader { stream: Box::pin(resp.bytes_stream()), buf: bytes::Bytes::new() }))
    }

    async fn open_write(&self, path: &str, opts: WriteOptions) -> Result<Box<dyn FileWriter>> {
        let (tx, rx) = mpsc::channel::<std::result::Result<bytes::Bytes, std::io::Error>>(4);
        let stream = futures::stream::poll_fn({
            let mut rx = rx;
            move |cx| rx.poll_recv(cx)
        });
        let req = self
            .client
            .put(format!("{}/api/upload", self.base))
            .query(&[("session", PEER_SESSION), ("path", path), ("offset", &opts.offset.to_string())])
            .bearer_auth(&self.token)
            .body(reqwest::Body::wrap_stream(stream));
        let handle = tokio::spawn(async move {
            let resp = req.send().await.map_err(net_err)?;
            let status = resp.status();
            if !status.is_success() {
                let body: Value = resp.json().await.unwrap_or(Value::Null);
                return Err(map_http_error(status, &body));
            }
            Ok(())
        });
        Ok(Box::new(HttpWriter { tx: Some(tx), handle: Some(handle) }))
    }

    async fn exec(&self, command: &str, cwd: Option<&str>) -> Result<ExecOutput> {
        self.call("fs.exec", json!({ "session": PEER_SESSION, "command": command, "cwd": cwd })).await
    }

    async fn checksum(&self, path: &str, algo: ChecksumAlgo) -> Result<Option<String>> {
        self.call::<String>("fs.checksum", json!({ "session": PEER_SESSION, "path": path, "algo": algo })).await.map(Some)
    }

    async fn disk_info(&self, path: &str) -> Result<Option<DiskInfo>> {
        self.call("fs.diskInfo", self.sp(path)).await
    }

    async fn close(&self) -> Result<()> {
        let _ = self.client.post(format!("{}/api/logout", self.base)).bearer_auth(&self.token).send().await;
        Ok(())
    }
}

struct HttpReader {
    stream: std::pin::Pin<Box<dyn futures::Stream<Item = reqwest::Result<bytes::Bytes>> + Send>>,
    buf: bytes::Bytes,
}

#[async_trait]
impl FileReader for HttpReader {
    async fn read(&mut self, out: &mut [u8]) -> Result<usize> {
        while self.buf.is_empty() {
            match self.stream.next().await {
                Some(Ok(b)) => self.buf = b,
                Some(Err(e)) => return Err(net_err(e)),
                None => return Ok(0),
            }
        }
        let n = out.len().min(self.buf.len());
        out[..n].copy_from_slice(&self.buf[..n]);
        self.buf = self.buf.slice(n..);
        Ok(n)
    }
}

struct HttpWriter {
    tx: Option<mpsc::Sender<std::result::Result<bytes::Bytes, std::io::Error>>>,
    handle: Option<tokio::task::JoinHandle<Result<()>>>,
}

#[async_trait]
impl FileWriter for HttpWriter {
    async fn write_all(&mut self, buf: &[u8]) -> Result<()> {
        let tx = self.tx.as_ref().ok_or_else(|| Error::other("writer finished"))?;
        if tx.send(Ok(bytes::Bytes::copy_from_slice(buf))).await.is_err() {
            // The request ended early: report its error.
            if let Some(h) = self.handle.take() {
                h.await??;
            }
            return Err(Error::ConnectionLost("upload aborted by peer".into()));
        }
        Ok(())
    }

    async fn finish(mut self: Box<Self>) -> Result<()> {
        drop(self.tx.take());
        match self.handle.take() {
            Some(h) => h.await?,
            None => Ok(()),
        }
    }
}

impl Drop for HttpWriter {
    fn drop(&mut self) {
        // Abort an unfinished upload: an error item makes the request fail.
        if let Some(tx) = self.tx.take() {
            let _ = tx.try_send(Err(std::io::Error::other("upload cancelled")));
        }
    }
}
