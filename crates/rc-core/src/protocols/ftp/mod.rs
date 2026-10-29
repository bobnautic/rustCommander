//! FTP / FTPS (suppaftp).
//!
//! Operations run on a pool of up to `max_connections` logged-in control connections,
//! so the UI can browse while transfers run. Readers and writers keep their connection
//! until the transfer is finished. Plain FTP, explicit (`AUTH TLS`) and implicit FTPS,
//! passive and active mode, proxies (control and passive data connections).

mod conn;
mod listing;
mod pool;
mod transfer;

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;

use self::conn::{mtime_cmd, Shared};
use self::pool::Pool;
use self::transfer::{FtpReader, FtpWriter};
use crate::connect::ConnectContext;
use crate::error::{Error, Result};
use crate::path as vpath;
use crate::protocols::tls::CertTrust;
use crate::site::{FtpEncryption, SiteConfig};
use crate::types::*;
use crate::vfs::*;

pub async fn connect(site: &SiteConfig, ctx: &ConnectContext) -> Result<Arc<dyn Vfs>> {
    Ok(Arc::new(FtpVfs::connect(site, ctx).await?))
}

/// Run `$body` with a pooled connection bound to `$c`, under the operation timeout.
/// With `retry`, a connection error on a reused (possibly stale) connection is retried
/// once on a fresh connection.
macro_rules! with_conn {
    ($vfs:expr, retry = $retry:expr, |$c:ident| $body:expr) => {{
        let mut fresh = false;
        loop {
            let mut lease = $vfs.pool.checkout(fresh).await?;
            let reused = lease.reused();
            let res = {
                let $c = lease.conn();
                match tokio::time::timeout($vfs.op_timeout, async { $body }).await {
                    Ok(r) => r,
                    Err(_) => Err(Error::Timeout("waiting for the FTP server".into())),
                }
            };
            if matches!(res, Err(Error::Timeout(_))) {
                lease.conn().broken = true;
            }
            lease.release();
            match res {
                Err(e) if $retry && reused && !fresh && e.is_connection_error() => fresh = true,
                other => break other,
            }
        }
    }};
}

pub struct FtpVfs {
    pool: Arc<Pool>,
    shared: Arc<Shared>,
    trust: Option<Arc<CertTrust>>,
    max_connections: usize,
    op_timeout: Duration,
}

impl FtpVfs {
    pub async fn connect(site: &SiteConfig, ctx: &ConnectContext) -> Result<Self> {
        let host = site.host.trim().to_string();
        if host.is_empty() {
            return Err(Error::InvalidInput("no host name".into()));
        }
        let port = site.effective_port();
        let trust = match site.ftp.encryption {
            FtpEncryption::None => None,
            _ => Some(CertTrust::new(&host, port, ctx.known_hosts.clone(), site.ftp.allow_invalid_certs)),
        };
        let tls = trust.as_ref().map(|t| t.client_config().map(Arc::new)).transpose()?;
        let shared = Arc::new(Shared {
            host: host.clone(),
            port,
            encryption: site.ftp.encryption,
            passive: site.ftp.passive,
            proxy: site.proxy.clone(),
            timeout: site.timeout(),
            username: site.username.clone(),
            password: Mutex::new(site.password.clone()),
            prompter: ctx.prompter.clone(),
            trust: trust.clone(),
            tls,
            tls_session: Arc::new(Mutex::new(None)),
            session_id: ctx.session_id.clone(),
            server: OnceLock::new(),
            prefer_mlsd: site.ftp.use_mlsd,
            mlsd_broken: AtomicBool::new(false),
            mlst_broken: AtomicBool::new(false),
            list_a: AtomicU8::new(0),
            mtime_cmd: AtomicU8::new(mtime_cmd::UNKNOWN),
        });
        let max_connections = site.ftp.max_connections.clamp(1, 64) as usize;
        let pool = Pool::new(shared.clone(), max_connections);
        // The first connection asks for password / certificate and reads the features.
        pool.checkout(true).await?.release();
        let info = shared.info();
        tracing::info!(
            session = %ctx.session_id,
            "FTP connected to {host}:{port} ({:?}, {}), home {}",
            site.ftp.encryption,
            info.system,
            info.home
        );
        if site.keepalive_secs > 0 {
            spawn_keepalive(&pool, Duration::from_secs(site.keepalive_secs as u64));
        }
        Ok(FtpVfs { pool, shared, trust, max_connections, op_timeout: site.timeout() * 3 })
    }

    fn abs(&self, path: &str) -> Result<String> {
        if path.contains(['\r', '\n', '\0']) {
            return Err(Error::InvalidInput(format!("invalid path {path:?}")));
        }
        Ok(if vpath::is_absolute(path) { vpath::normalize(path) } else { vpath::join(&self.shared.info().home, path) })
    }

    fn retry_open(&self, e: &Error, reused: bool, fresh: bool) -> bool {
        reused && !fresh && e.is_connection_error()
    }
}

fn spawn_keepalive(pool: &Arc<Pool>, every: Duration) {
    let weak = Arc::downgrade(pool);
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(every);
        tick.tick().await;
        loop {
            tick.tick().await;
            let Some(pool) = weak.upgrade() else { break };
            if pool.is_closed() {
                break;
            }
            pool.keepalive(every).await;
        }
    });
}

#[async_trait]
impl Vfs for FtpVfs {
    fn protocol(&self) -> Protocol {
        Protocol::Ftp
    }

    fn capabilities(&self) -> Capabilities {
        let info = self.shared.info();
        let mtime = self.shared.mtime_cmd.load(Ordering::Relaxed);
        Capabilities {
            permissions: info.system.to_ascii_uppercase().contains("UNIX")
                || info.feat.mlst_facts.iter().any(|f| f.eq_ignore_ascii_case("unix.mode")),
            resume_upload: info.feat.rest_stream,
            resume_download: info.feat.rest_stream,
            set_modified: info.feat.mfmt || !matches!(mtime, mtime_cmd::UNKNOWN | mtime_cmd::NONE),
            server_checksum: !info.feat.hash.is_empty() || !info.feat.xhash.is_empty(),
            ..Default::default()
        }
    }

    fn session_info(&self) -> SessionInfo {
        let info = self.shared.info();
        let mut i = SessionInfo::default();
        i.push(
            "Protocol",
            match self.shared.encryption {
                FtpEncryption::None => "FTP",
                FtpEncryption::Explicit => "FTPS (explicit TLS)",
                FtpEncryption::Implicit => "FTPS (implicit TLS)",
            },
        );
        i.push("Server", format!("{}:{}", self.shared.host, self.shared.port));
        if !info.welcome.is_empty() {
            i.push("Welcome message", info.welcome.clone());
        }
        if !info.system.is_empty() {
            i.push("System", info.system.clone());
        }
        i.push("Encryption", self.shared.tls_session.lock().clone().unwrap_or_else(|| "none".into()));
        if let Some(cert) = self.trust.as_ref().and_then(|t| t.peer()) {
            i.push("Certificate subject", cert.subject);
            i.push("Certificate issuer", cert.issuer);
            i.push("Certificate valid until", cert.not_after);
            i.push("Certificate SHA-256", cert.fingerprint);
            i.push(
                "Certificate trust",
                if cert.ca_verified { "verified by a trusted authority" } else { "accepted by the user" },
            );
        }
        i.push("Data connection", if self.shared.passive { "passive" } else { "active" });
        let mlsd = self.shared.prefer_mlsd && info.feat.mlst && !self.shared.mlsd_broken.load(Ordering::Relaxed);
        i.push("Directory listing", if mlsd { "MLSD" } else { "LIST" });
        i.push("Connections", format!("up to {}", self.max_connections));
        if !info.feat.raw.is_empty() {
            i.push("Server features", info.feat.raw.join(", "));
        }
        i
    }

    async fn home(&self) -> Result<String> {
        Ok(self.shared.info().home.clone())
    }

    async fn canonicalize(&self, path: &str) -> Result<String> {
        let p = self.abs(path)?;
        with_conn!(self, retry = true, |c| c.canonicalize(&p).await)
    }

    async fn list(&self, path: &str) -> Result<Vec<FileEntry>> {
        let p = self.abs(path)?;
        with_conn!(self, retry = true, |c| c.list(&p).await)
    }

    async fn stat(&self, path: &str) -> Result<FileEntry> {
        let p = self.abs(path)?;
        with_conn!(self, retry = true, |c| c.stat(&p).await)
    }

    async fn mkdir(&self, path: &str) -> Result<()> {
        let p = self.abs(path)?;
        with_conn!(self, retry = false, |c| c.mkdir(&p).await)
    }

    async fn remove_file(&self, path: &str) -> Result<()> {
        let p = self.abs(path)?;
        with_conn!(self, retry = false, |c| c.remove_file(&p).await)
    }

    async fn remove_dir(&self, path: &str) -> Result<()> {
        let p = self.abs(path)?;
        with_conn!(self, retry = false, |c| c.remove_dir(&p).await)
    }

    async fn rename(&self, from: &str, to: &str) -> Result<()> {
        let (f, t) = (self.abs(from)?, self.abs(to)?);
        with_conn!(self, retry = false, |c| c.rename(&f, &t).await)
    }

    async fn set_permissions(&self, path: &str, mode: u32) -> Result<()> {
        let p = self.abs(path)?;
        with_conn!(self, retry = true, |c| c.chmod(&p, mode).await)
    }

    async fn set_modified(&self, path: &str, mtime: i64) -> Result<()> {
        let p = self.abs(path)?;
        with_conn!(self, retry = true, |c| c.set_modified(&p, mtime).await)
    }

    async fn open_read(&self, path: &str, offset: u64) -> Result<Box<dyn FileReader>> {
        let p = self.abs(path)?;
        // Without REST the skipped bytes are read and discarded.
        let (rest, skip) = if self.shared.info().feat.rest_stream { (offset, 0) } else { (0, offset) };
        let mut fresh = false;
        loop {
            let mut lease = self.pool.checkout(fresh).await?;
            let reused = lease.reused();
            let res = tokio::time::timeout(self.op_timeout, lease.conn().start_read(&p, rest))
                .await
                .unwrap_or_else(|_| Err(Error::Timeout(format!("opening {p}"))));
            match res {
                Ok(stream) => {
                    let timeout = self.shared.timeout.max(Duration::from_secs(30));
                    return Ok(Box::new(FtpReader::new(lease, stream, skip, timeout, p)));
                }
                Err(e) => {
                    if matches!(e, Error::Timeout(_)) {
                        lease.conn().broken = true;
                    }
                    lease.release();
                    if !self.retry_open(&e, reused, fresh) {
                        return Err(e);
                    }
                    fresh = true;
                }
            }
        }
    }

    async fn open_write(&self, path: &str, opts: WriteOptions) -> Result<Box<dyn FileWriter>> {
        let p = self.abs(path)?;
        let mut fresh = false;
        loop {
            let mut lease = self.pool.checkout(fresh).await?;
            let reused = lease.reused();
            let res = tokio::time::timeout(self.op_timeout, lease.conn().start_write(&p, opts.offset))
                .await
                .unwrap_or_else(|_| Err(Error::Timeout(format!("opening {p}"))));
            match res {
                Ok(stream) => {
                    let timeout = self.shared.timeout.max(Duration::from_secs(30));
                    return Ok(Box::new(FtpWriter::new(lease, stream, timeout, p, opts.mode)));
                }
                Err(e) => {
                    if matches!(e, Error::Timeout(_)) {
                        lease.conn().broken = true;
                    }
                    lease.release();
                    if !self.retry_open(&e, reused, fresh) {
                        return Err(e);
                    }
                    fresh = true;
                }
            }
        }
    }

    async fn checksum(&self, path: &str, algo: ChecksumAlgo) -> Result<Option<String>> {
        let feat = &self.shared.info().feat;
        if feat.hash.is_empty() && feat.xhash.is_empty() {
            return Ok(None);
        }
        let p = self.abs(path)?;
        with_conn!(self, retry = true, |c| c.checksum(&p, algo).await)
    }

    async fn ping(&self) -> Result<()> {
        with_conn!(self, retry = true, |c| c.noop().await)
    }

    async fn close(&self) -> Result<()> {
        self.pool.close().await;
        tracing::info!(session = %self.shared.session_id, "FTP session closed");
        Ok(())
    }
}
