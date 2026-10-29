//! One logged-in control connection: establishing it (TLS, proxy, login) and the
//! commands the [`super::FtpVfs`] runs on it.

use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use parking_lot::Mutex;
use suppaftp::tokio::{AsyncRustlsStream, AsyncTlsConnector, ImplAsyncFtpStream, TransferStream};
use suppaftp::tokio_rustls::TlsConnector;
use suppaftp::types::{FileType, Response};
use suppaftp::{FtpError, FtpResult, Mode, Status};
use tokio::net::{TcpListener, TcpStream};

use super::listing;
use crate::error::{Error, Result};
use crate::net;
use crate::path as vpath;
use crate::prompt::{PromptRequest, Prompter};
use crate::protocols::tls::CertTrust;
use crate::site::{FtpEncryption, ProxyKind, ProxyOptions};
use crate::types::{ChecksumAlgo, FileEntry, FileKind};

pub(super) type FtpStream = ImplAsyncFtpStream<AsyncRustlsStream>;
pub(super) type Transfer = TransferStream<AsyncRustlsStream>;

/// Symlinks per listing whose target kind is probed with `CWD`.
const MAX_LINK_PROBES: usize = 32;

/// What the server announced in `FEAT`.
#[derive(Debug, Clone, Default)]
pub(super) struct Features {
    pub mlst: bool,
    pub mlst_facts: Vec<String>,
    pub mdtm: bool,
    pub mfmt: bool,
    pub size: bool,
    pub rest_stream: bool,
    pub utf8: bool,
    /// `HASH` algorithms (`SHA-256`, `MD5`, ...).
    pub hash: Vec<String>,
    /// `XMD5`, `XSHA1`, `XSHA256`, ...
    pub xhash: Vec<String>,
    /// Raw feature lines for display.
    pub raw: Vec<String>,
}

impl Features {
    fn parse(map: &suppaftp::types::Features) -> Self {
        let mut f = Features::default();
        for (k, v) in map {
            let v = v.as_deref().unwrap_or("");
            f.raw.push(if v.is_empty() { k.clone() } else { format!("{k} {v}") });
            let list = |v: &str| -> Vec<String> {
                v.split(';').map(|s| s.trim().trim_end_matches('*').to_string()).filter(|s| !s.is_empty()).collect()
            };
            match k.to_ascii_uppercase().as_str() {
                "MLST" | "MLSD" => {
                    f.mlst = true;
                    if !v.is_empty() {
                        f.mlst_facts = list(v);
                    }
                }
                "MDTM" => f.mdtm = true,
                "MFMT" => f.mfmt = true,
                "SIZE" => f.size = true,
                "REST" => f.rest_stream = v.to_ascii_uppercase().contains("STREAM"),
                "UTF8" => f.utf8 = true,
                "HASH" => f.hash = list(v).into_iter().map(|s| s.to_ascii_uppercase()).collect(),
                k @ ("XMD5" | "XSHA1" | "XSHA256" | "XSHA512") => f.xhash.push(k.to_string()),
                _ => {}
            }
        }
        f.raw.sort();
        f
    }
}

/// Facts about the server gathered on the first connection.
#[derive(Debug, Clone, Default)]
pub(super) struct ServerInfo {
    pub welcome: String,
    pub system: String,
    pub feat: Features,
    pub home: String,
}

/// `SetModified` strategies, cached after the first success.
pub(super) mod mtime_cmd {
    pub const UNKNOWN: u8 = 0;
    pub const MFMT: u8 = 1;
    pub const SITE_UTIME: u8 = 2;
    pub const SITE_UTIME5: u8 = 3;
    pub const MDTM: u8 = 4;
    pub const NONE: u8 = 255;
}

/// Connection parameters and server state shared by all pooled connections.
pub(super) struct Shared {
    pub host: String,
    pub port: u16,
    pub encryption: FtpEncryption,
    pub passive: bool,
    pub proxy: ProxyOptions,
    pub timeout: Duration,
    pub username: String,
    pub password: Mutex<Option<String>>,
    pub prompter: Arc<dyn Prompter>,
    pub trust: Option<Arc<CertTrust>>,
    pub tls: Option<Arc<rustls::ClientConfig>>,
    /// Negotiated protocol / cipher suite of the last TLS handshake.
    pub tls_session: Arc<Mutex<Option<String>>>,
    pub session_id: String,
    pub server: OnceLock<ServerInfo>,
    pub prefer_mlsd: bool,
    pub mlsd_broken: AtomicBool,
    pub mlst_broken: AtomicBool,
    /// `LIST -a`: 0 = untested, 1 = works, 2 = rejected.
    pub list_a: AtomicU8,
    pub mtime_cmd: AtomicU8,
}

impl Shared {
    pub fn info(&self) -> &ServerInfo {
        static EMPTY: OnceLock<ServerInfo> = OnceLock::new();
        self.server.get().unwrap_or_else(|| EMPTY.get_or_init(ServerInfo::default))
    }

    fn use_mlsd(&self) -> bool {
        self.prefer_mlsd && self.info().feat.mlst && !self.mlsd_broken.load(Ordering::Relaxed)
    }

    fn use_mlst(&self) -> bool {
        self.info().feat.mlst && !self.mlst_broken.load(Ordering::Relaxed)
    }

    fn proxied(&self) -> bool {
        self.proxy.kind != ProxyKind::None
    }

    fn connector(&self) -> Result<Connector> {
        let cfg = self.tls.clone().ok_or_else(|| Error::other("TLS is not configured"))?;
        Ok(Connector { inner: TlsConnector::from(cfg), session: self.tls_session.clone() })
    }
}

/// Decrements the pool's live connection count when the connection goes away.
pub(super) struct LiveGuard(pub Arc<AtomicUsize>);

impl Drop for LiveGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

/// A logged-in control connection.
pub(super) struct Conn {
    pub ftp: FtpStream,
    /// Set when the connection must not be reused (I/O error, timeout, desync).
    pub broken: bool,
    pub last_used: Instant,
    pub shared: Arc<Shared>,
    _live: LiveGuard,
}

// ---------------------------------------------------------------------------------------
// Errors

/// Numeric reply code (the `Status` enum folds unknown codes).
pub(super) fn reply_code(r: &Response) -> u32 {
    r.body.get(..3).and_then(|c| std::str::from_utf8(c).ok()).and_then(|c| c.parse().ok()).unwrap_or(0)
}

/// Reply text without the status codes.
pub(super) fn reply_text(r: &Response) -> String {
    let body = String::from_utf8_lossy(&r.body);
    let lines: Vec<&str> = body
        .lines()
        .map(|l| {
            let b = l.as_bytes();
            if b.len() >= 4 && b[..3].iter().all(u8::is_ascii_digit) && (b[3] == b' ' || b[3] == b'-') {
                l[4..].trim()
            } else {
                l.trim()
            }
        })
        .filter(|l| !l.is_empty())
        .collect();
    lines.join(" ")
}

/// Whether the control connection is unusable after this error.
pub(super) fn is_fatal(e: &FtpError) -> bool {
    match e {
        FtpError::ConnectionError(io) => io.kind() != std::io::ErrorKind::InvalidInput,
        FtpError::UnexpectedResponse(r) => matches!(reply_code(r), 0 | 421),
        FtpError::InvalidAddress(_) => false,
        _ => true,
    }
}

fn classify_text(text: &str, path: &str, msg: &str) -> Option<Error> {
    let t = text.to_ascii_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| t.contains(w));
    if has(&["not empty"]) {
        Some(Error::DirectoryNotEmpty(path.to_string()))
    } else if has(&[
        "no such",
        "not found",
        "not exist",
        "doesn't exist",
        "does not exist",
        "cannot find",
        "can't find",
        "could not find",
        "unable to find",
    ]) {
        Some(Error::NotFound(path.to_string()))
    } else if has(&["already exist", "file exists", "directory exists", " exists"]) {
        Some(Error::AlreadyExists(path.to_string()))
    } else if has(&["not a directory"]) {
        Some(Error::NotADirectory(path.to_string()))
    } else if has(&["is a directory"]) {
        Some(Error::IsADirectory(path.to_string()))
    } else if has(&["permission", "denied", "not allowed", "forbidden", "not authorized", "read-only", "read only"]) {
        Some(Error::PermissionDenied(msg.to_string()))
    } else {
        None
    }
}

pub(super) fn map_reply(r: &Response, path: &str) -> Error {
    let code = reply_code(r);
    let text = reply_text(r);
    let msg = if path.is_empty() { text.clone() } else { format!("{path}: {text}") };
    match code {
        421 => Error::ConnectionLost(format!("server closed the connection: {text}")),
        425 => Error::Protocol(format!("cannot open data connection: {text}")),
        426 => Error::ConnectionLost(format!("transfer aborted: {msg}")),
        530 => Error::AuthFailed(text),
        532 => Error::PermissionDenied(msg),
        500 | 502 | 504 => Error::Unsupported(msg),
        501 => Error::InvalidInput(msg),
        450 | 451 | 452 | 550 | 551 | 552 | 553 | 521 => classify_text(&text, path, &msg).unwrap_or(match code {
            450 | 550 => Error::NotFound(if path.is_empty() { text } else { path.to_string() }),
            452 | 552 => Error::Other(format!("insufficient storage: {msg}")),
            553 => Error::InvalidInput(format!("file name not allowed: {msg}")),
            _ => Error::Other(msg),
        }),
        _ => Error::Protocol(format!("unexpected reply {code}: {msg}")),
    }
}

pub(super) fn map_error(e: FtpError, path: &str) -> Error {
    let at = |s: String| if path.is_empty() { s } else { format!("{path}: {s}") };
    match e {
        FtpError::ConnectionError(io) => match io.kind() {
            std::io::ErrorKind::TimedOut => Error::Timeout(at(io.to_string())),
            std::io::ErrorKind::InvalidInput => Error::InvalidInput(at(io.to_string())),
            _ => Error::ConnectionLost(at(io.to_string())),
        },
        FtpError::SecureError(s) => Error::ConnectionLost(format!("TLS: {s}")),
        FtpError::UnexpectedResponse(r) => map_reply(&r, path),
        FtpError::BadResponse => Error::Protocol(at("invalid server response".into())),
        FtpError::InvalidAddress(a) => Error::Protocol(format!("invalid passive mode address: {a}")),
        FtpError::DataConnectionAlreadyOpen => Error::Protocol("a data connection is already open".into()),
    }
}

async fn timed<T>(t: Duration, what: &str, fut: impl Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(t, fut).await.map_err(|_| Error::Timeout(what.to_string()))?
}

// ---------------------------------------------------------------------------------------
// TLS

/// rustls connector that records the negotiated parameters for `session_info`.
pub(super) struct Connector {
    inner: TlsConnector,
    session: Arc<Mutex<Option<String>>>,
}

impl std::fmt::Debug for Connector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Connector")
    }
}

#[async_trait]
impl AsyncTlsConnector for Connector {
    type Stream = AsyncRustlsStream;

    async fn connect(&self, domain: &str, stream: TcpStream) -> FtpResult<AsyncRustlsStream> {
        let name = rustls::pki_types::ServerName::try_from(domain.to_string())
            .map_err(|e| FtpError::SecureError(format!("invalid server name {domain}: {e}")))?;
        let tls = self.inner.connect(name, stream).await.map_err(|e| FtpError::SecureError(e.to_string()))?;
        let (_, c) = tls.get_ref();
        if let (Some(v), Some(s)) = (c.protocol_version(), c.negotiated_cipher_suite()) {
            *self.session.lock() = Some(format!("{v:?}, {:?}", s.suite()));
        }
        Ok(AsyncRustlsStream::from(tls))
    }
}

// ---------------------------------------------------------------------------------------
// Data connections

fn is_unroutable(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64)
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

/// Where to open a passive data connection announced as `addr`.
fn passive_target(addr: SocketAddr, control_peer: Option<IpAddr>, host: &str, proxied: bool) -> (String, u16) {
    let ip = addr.ip();
    if proxied {
        // The control connection's peer is the proxy (or a local relay): reach the
        // server by name unless it explicitly announced another public address.
        if Some(ip) == control_peer || is_unroutable(ip) {
            return (host.to_string(), addr.port());
        }
        return (ip.to_string(), addr.port());
    }
    match control_peer {
        // Servers behind NAT often announce their private address.
        Some(peer) if ip.is_unspecified() || (is_unroutable(ip) && !is_unroutable(peer)) => {
            (peer.to_string(), addr.port())
        }
        _ => (ip.to_string(), addr.port()),
    }
}

type PassiveFuture = Pin<Box<dyn Future<Output = FtpResult<TcpStream>> + Send + Sync>>;

fn passive_builder(
    shared: &Shared,
    control_peer: Option<IpAddr>,
    via_relay: bool,
) -> impl Fn(SocketAddr) -> PassiveFuture + Send + Sync + 'static {
    let host = shared.host.clone();
    let proxy = shared.proxy.clone();
    let proxied = shared.proxied() || via_relay;
    let timeout = shared.timeout;
    move |addr: SocketAddr| -> PassiveFuture {
        let (h, port) = passive_target(addr, control_peer, &host, proxied);
        let proxy = proxy.clone();
        tracing::trace!("passive data connection to {h}:{port} (announced {addr})");
        Box::pin(async move {
            // Spawned so the future handed to suppaftp is `Sync`.
            let task = tokio::spawn(async move { net::connect_tcp(&h, port, &proxy, timeout).await });
            let io = |kind: std::io::ErrorKind, msg: String| FtpError::ConnectionError(std::io::Error::new(kind, msg));
            match task.await {
                Ok(Ok(s)) => Ok(s),
                Ok(Err(Error::Timeout(m))) => Err(io(std::io::ErrorKind::TimedOut, m)),
                Ok(Err(e)) => Err(io(std::io::ErrorKind::ConnectionRefused, e.to_string())),
                Err(e) => Err(FtpError::ConnectionError(std::io::Error::other(e.to_string()))),
            }
        })
    }
}

/// Forward a local loopback port to an already connected (proxied) stream, so that
/// suppaftp's implicit-TLS constructor, which dials an address itself, can use it.
async fn relay(remote: TcpStream) -> Result<SocketAddr> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await?;
    let addr = listener.local_addr()?;
    tokio::spawn(async move {
        if let Ok(Ok((mut local, _))) = tokio::time::timeout(Duration::from_secs(30), listener.accept()).await {
            let mut remote = remote;
            let _ = tokio::io::copy_bidirectional(&mut local, &mut remote).await;
        }
    });
    Ok(addr)
}

// ---------------------------------------------------------------------------------------
// Connecting

/// Open, secure and log in a new control connection. Asks the user about untrusted
/// certificates and a missing password (once per session).
pub(super) async fn open(shared: &Arc<Shared>, live: LiveGuard) -> Result<Conn> {
    let mut asked = false;
    let mut ftp = loop {
        match timed(shared.timeout * 2, "connecting", establish(shared)).await {
            Ok(ftp) => break ftp,
            Err(e) => {
                let rejected = shared.trust.as_ref().and_then(|t| t.take_rejected().map(|c| (t.clone(), c)));
                match rejected {
                    Some((trust, cert)) if !asked => {
                        trust.confirm(&*shared.prompter, cert).await?;
                        asked = true;
                    }
                    Some((_, cert)) => return Err(Error::HostKeyRejected(cert.reason)),
                    None => return Err(e),
                }
            }
        }
    };
    login(&mut ftp, shared).await?;
    let t = shared.timeout;
    timed(t, "TYPE I", async { ftp.transfer_type(FileType::Binary).await.map_err(|e| map_error(e, "")) }).await?;
    if shared.server.get().is_none() {
        let info = timed(t * 2, "reading server features", server_info(&mut ftp)).await?;
        tracing::debug!(session = %shared.session_id, "FTP server: {} / {:?}", info.system, info.feat.raw);
        let _ = shared.server.set(info);
    }
    let feat = shared.info().feat.clone();
    if feat.utf8 {
        soft(
            timed(t, "OPTS UTF8", async {
                Ok(ftp.custom_command("OPTS UTF8 ON", &[Status::CommandOk, Status::CommandNotImplemented]).await)
            })
            .await?,
        )?;
    }
    if feat.mlst && !feat.mlst_facts.is_empty() {
        let wanted = [
            "type",
            "size",
            "modify",
            "unix.mode",
            "unix.owner",
            "unix.group",
            "unix.ownername",
            "unix.groupname",
            "unix.uid",
            "unix.gid",
        ];
        let facts: Vec<&str> = feat
            .mlst_facts
            .iter()
            .map(String::as_str)
            .filter(|f| wanted.contains(&f.to_ascii_lowercase().as_str()))
            .collect();
        if !facts.is_empty() {
            let cmd = format!("OPTS MLST {};", facts.join(";"));
            soft(timed(t, "OPTS MLST", async { Ok(ftp.custom_command(cmd, &[Status::CommandOk]).await) }).await?)?;
        }
    }
    Ok(Conn { ftp, broken: false, last_used: Instant::now(), shared: shared.clone(), _live: live })
}

/// Ignore a refused optional command, but not a broken connection.
fn soft<T>(r: FtpResult<T>) -> Result<Option<T>> {
    match r {
        Ok(v) => Ok(Some(v)),
        Err(e) if is_fatal(&e) => Err(map_error(e, "")),
        Err(e) => {
            tracing::debug!("optional FTP command refused: {e}");
            Ok(None)
        }
    }
}

async fn establish(shared: &Arc<Shared>) -> Result<FtpStream> {
    let (host, port) = (shared.host.as_str(), shared.port);
    let mut via_relay = false;
    let mut ftp = match shared.encryption {
        FtpEncryption::Implicit if shared.proxied() => {
            let tcp = net::connect_tcp(host, port, &shared.proxy, shared.timeout).await?;
            let local = relay(tcp).await?;
            via_relay = true;
            FtpStream::connect_secure_implicit(local, shared.connector()?, host).await.map_err(|e| map_error(e, ""))?
        }
        FtpEncryption::Implicit => {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host, port))
                .await
                .map_err(|e| Error::ConnectionLost(format!("cannot resolve {host}: {e}")))?
                .collect();
            let mut last = Error::ConnectionLost(format!("no address found for {host}"));
            let mut stream = None;
            for addr in addrs {
                match tokio::time::timeout(
                    shared.timeout,
                    FtpStream::connect_secure_implicit(addr, shared.connector()?, host),
                )
                .await
                {
                    Ok(Ok(s)) => {
                        stream = Some(s);
                        break;
                    }
                    Ok(Err(e @ FtpError::SecureError(_))) => return Err(map_error(e, "")),
                    Ok(Err(e)) => last = map_error(e, ""),
                    Err(_) => last = Error::Timeout(format!("connecting to {addr}")),
                }
            }
            stream.ok_or(last)?
        }
        FtpEncryption::Explicit | FtpEncryption::None => {
            let tcp = net::connect_tcp(host, port, &shared.proxy, shared.timeout).await?;
            let ftp = FtpStream::connect_with_stream(tcp).await.map_err(|e| map_error(e, ""))?;
            if shared.encryption == FtpEncryption::Explicit {
                ftp.into_secure(shared.connector()?, host).await.map_err(|e| match e {
                    FtpError::UnexpectedResponse(r) if matches!(reply_code(&r), 500..=504 | 530 | 534) => {
                        Error::Unsupported(format!("the server does not support FTPS (AUTH TLS): {}", reply_text(&r)))
                    }
                    e => map_error(e, ""),
                })?
            } else {
                ftp
            }
        }
    };
    if shared.encryption == FtpEncryption::Implicit {
        ftp.custom_command("PBSZ 0", &[Status::CommandOk]).await.map_err(|e| map_error(e, ""))?;
        ftp.custom_command("PROT P", &[Status::CommandOk]).await.map_err(|e| map_error(e, ""))?;
    }
    let control_peer = ftp.get_ref().await.peer_addr().ok().map(|a| a.ip());
    if shared.passive || shared.proxied() {
        if !shared.passive {
            tracing::warn!(session = %shared.session_id, "active mode is not possible through a proxy; using passive mode");
        }
        let ipv6 = host.parse::<Ipv6Addr>().is_ok() || (!via_relay && control_peer.is_some_and(|ip| ip.is_ipv6()));
        ftp.set_mode(if ipv6 { Mode::ExtendedPassive } else { Mode::Passive });
        Ok(ftp.passive_stream_builder(passive_builder(shared, control_peer, via_relay)))
    } else {
        Ok(ftp.active_mode(shared.timeout))
    }
}

async fn login(ftp: &mut FtpStream, shared: &Shared) -> Result<()> {
    let t = shared.timeout;
    let anonymous = shared.username.is_empty();
    let user = if anonymous { "anonymous" } else { shared.username.as_str() };
    let known = shared.password.lock().clone();
    let login_err = |e: FtpError| match e {
        FtpError::UnexpectedResponse(r) if matches!(reply_code(&r), 530 | 331 | 332) => {
            Error::AuthFailed(format!("login as {user} failed: {}", reply_text(&r)))
        }
        e => map_error(e, ""),
    };
    let password = match known {
        Some(p) => p,
        None if anonymous => "anonymous@".to_string(),
        None => {
            // Only ask for a password when the server wants one.
            let r = timed(t, "USER", async {
                ftp.custom_command(format!("USER {user}"), &[Status::LoggedIn, Status::NeedPassword])
                    .await
                    .map_err(login_err)
            })
            .await?;
            if r.status == Status::LoggedIn {
                return Ok(());
            }
            let req = PromptRequest::Password {
                host: shared.host.clone(),
                username: user.to_string(),
                message: reply_text(&r),
            };
            let resp = shared.prompter.prompt(req).await.filter(|r| r.accepted).ok_or(Error::Cancelled)?;
            let pw = resp.value(0).unwrap_or_default().to_string();
            timed(t, "login", async { ftp.login(user, pw.as_str()).await.map_err(login_err) }).await?;
            *shared.password.lock() = Some(pw);
            return Ok(());
        }
    };
    timed(t, "login", async { ftp.login(user, password.as_str()).await.map_err(login_err) }).await
}

async fn server_info(ftp: &mut FtpStream) -> Result<ServerInfo> {
    let welcome = ftp.get_welcome_msg().unwrap_or_default().trim().to_string();
    let feat = match ftp.feat().await {
        Ok(map) => Features::parse(&map),
        Err(e) if is_fatal(&e) && !matches!(e, FtpError::BadResponse) => return Err(map_error(e, "")),
        Err(e) => {
            tracing::debug!("FEAT failed: {e}");
            Features::default()
        }
    };
    let system = soft(ftp.custom_command("SYST", &[Status::Name]).await)?.map(|r| reply_text(&r)).unwrap_or_default();
    let home = match ftp.pwd().await {
        Ok(p) if !p.is_empty() => vpath::normalize(&p),
        Ok(_) => "/".to_string(),
        Err(e) if is_fatal(&e) => return Err(map_error(e, "")),
        Err(_) => "/".to_string(),
    };
    Ok(ServerInfo { welcome, system, feat, home })
}

// ---------------------------------------------------------------------------------------
// Commands

impl Conn {
    /// Map an error and remember whether the connection is still usable.
    pub fn fail(&mut self, e: FtpError, path: &str) -> Error {
        if is_fatal(&e) {
            self.broken = true;
        }
        map_error(e, path)
    }

    pub async fn noop(&mut self) -> Result<()> {
        self.ftp.noop().await.map_err(|e| self.fail(e, ""))
    }

    /// Bring the control connection back in sync after an aborted transfer: servers
    /// may send an extra `225`/`226` that has to be consumed.
    pub async fn resync(&mut self) -> FtpResult<()> {
        let mut r = self.ftp.custom_command("NOOP", &[Status::CommandOk]).await;
        for _ in 0..3 {
            match r {
                Err(FtpError::UnexpectedResponse(ref resp)) if matches!(reply_code(resp), 225 | 226 | 426 | 451) => {
                    r = self.ftp.read_response(Status::CommandOk).await;
                }
                _ => break,
            }
        }
        r.map(|_| ())
    }

    /// `CWD`: `Ok(true)` for directories, `Ok(false)` when refused.
    pub async fn is_dir(&mut self, path: &str) -> Result<bool> {
        match self.ftp.cwd(path).await {
            Ok(()) => Ok(true),
            Err(e @ FtpError::UnexpectedResponse(_)) if !is_fatal(&e) => Ok(false),
            Err(e) => Err(self.fail(e, path)),
        }
    }

    pub async fn canonicalize(&mut self, path: &str) -> Result<String> {
        if !self.is_dir(path).await? {
            return Ok(path.to_string());
        }
        match self.ftp.pwd().await {
            Ok(p) if p.starts_with('/') => Ok(vpath::normalize(&p)),
            Ok(_) => Ok(path.to_string()),
            Err(e) => Err(self.fail(e, path)),
        }
    }

    pub async fn list(&mut self, path: &str) -> Result<Vec<FileEntry>> {
        let mut entries = self.list_raw(path).await?;
        self.resolve_links(&mut entries).await?;
        Ok(entries)
    }

    async fn list_raw(&mut self, path: &str) -> Result<Vec<FileEntry>> {
        let shared = self.shared.clone();
        if shared.use_mlsd() {
            match self.ftp.mlsd(Some(path)).await {
                Ok(lines) => return Ok(lines.iter().filter_map(|l| listing::parse_mlsx(l, path)).collect()),
                Err(FtpError::UnexpectedResponse(r)) if matches!(reply_code(&r), 500 | 502 | 504) => {
                    tracing::info!(session = %shared.session_id, "MLSD refused ({}), falling back to LIST", reply_text(&r));
                    shared.mlsd_broken.store(true, Ordering::Relaxed);
                }
                Err(e) => return Err(self.fail(e, path)),
            }
        }
        // Change into the directory so that names with spaces or leading dashes are not
        // taken for options.
        self.ftp.cwd(path).await.map_err(|e| self.fail(e, path))?;
        let lines = if shared.list_a.load(Ordering::Relaxed) != 2 {
            match self.ftp.list(Some("-a")).await {
                Ok(l) => {
                    shared.list_a.store(1, Ordering::Relaxed);
                    l
                }
                Err(e @ FtpError::UnexpectedResponse(_))
                    if !is_fatal(&e) && shared.list_a.load(Ordering::Relaxed) == 0 =>
                {
                    let lines = self.ftp.list(None).await.map_err(|e| self.fail(e, path))?;
                    // Only a working plain LIST proves that `-a` was the problem.
                    tracing::debug!("LIST -a refused ({e}), using LIST");
                    shared.list_a.store(2, Ordering::Relaxed);
                    lines
                }
                Err(e) => return Err(self.fail(e, path)),
            }
        } else {
            self.ftp.list(None).await.map_err(|e| self.fail(e, path))?
        };
        let now = chrono::Utc::now();
        Ok(lines.iter().filter_map(|l| listing::parse_list_line(l, path, now)).collect())
    }

    /// Fill in `target_kind` (and the target size) of symlinks, bounded per listing.
    async fn resolve_links(&mut self, entries: &mut [FileEntry]) -> Result<()> {
        let size = self.shared.info().feat.size;
        for e in
            entries.iter_mut().filter(|e| e.kind == FileKind::Symlink && e.target_kind.is_none()).take(MAX_LINK_PROBES)
        {
            if self.is_dir(&e.path).await? {
                e.target_kind = Some(FileKind::Dir);
            } else {
                e.target_kind = Some(FileKind::File);
                if size {
                    if let Ok(n) = self.ftp.size(&e.path).await {
                        e.size = n as u64;
                    }
                }
            }
        }
        Ok(())
    }

    pub async fn stat(&mut self, path: &str) -> Result<FileEntry> {
        if path == "/" {
            return Ok(FileEntry::new("/", "/", FileKind::Dir));
        }
        let name = vpath::file_name(path).to_string();
        let parent = vpath::parent(path);
        let shared = self.shared.clone();
        if shared.use_mlst() {
            match self.ftp.mlst(Some(path)).await {
                Ok(line) => {
                    if let Some(mut e) = listing::parse_mlsx(&line, &parent) {
                        e.name = name.clone();
                        e.hidden = name.starts_with('.');
                        e.path = path.to_string();
                        self.resolve_links(std::slice::from_mut(&mut e)).await?;
                        return Ok(e);
                    }
                }
                Err(FtpError::UnexpectedResponse(r)) if matches!(reply_code(&r), 500 | 502 | 504) => {
                    shared.mlst_broken.store(true, Ordering::Relaxed);
                }
                Err(e) => return Err(self.fail(e, path)),
            }
        }
        match self.list_raw(&parent).await {
            Ok(entries) => {
                if let Some(mut e) = entries.into_iter().find(|e| e.name == name) {
                    self.resolve_links(std::slice::from_mut(&mut e)).await?;
                    return Ok(e);
                }
            }
            Err(e) if e.is_connection_error() || self.broken => return Err(e),
            Err(_) => {}
        }
        // Hidden or unlistable parent: probe the path itself.
        if self.is_dir(path).await? {
            return Ok(FileEntry::new(name, path, FileKind::Dir));
        }
        if shared.info().feat.size {
            match self.ftp.size(path).await {
                Ok(n) => {
                    let mut e = FileEntry::new(name, path, FileKind::File);
                    e.size = n as u64;
                    if shared.info().feat.mdtm {
                        if let Ok(t) = self.ftp.mdtm(path).await {
                            e.modified = Some(t.and_utc().timestamp());
                        }
                    }
                    return Ok(e);
                }
                Err(e) if is_fatal(&e) => return Err(self.fail(e, path)),
                Err(_) => {}
            }
        }
        Err(Error::NotFound(path.to_string()))
    }

    pub async fn mkdir(&mut self, path: &str) -> Result<()> {
        match self.ftp.mkdir(path).await {
            Ok(()) => Ok(()),
            Err(e @ FtpError::UnexpectedResponse(_)) if !is_fatal(&e) => {
                let err = self.fail(e, path);
                if matches!(err, Error::AlreadyExists(_)) {
                    return Err(err);
                }
                // Many servers answer a plain 550: check whether the path exists.
                if self.is_dir(path).await? {
                    return Err(Error::AlreadyExists(path.to_string()));
                }
                Err(err)
            }
            Err(e) => Err(self.fail(e, path)),
        }
    }

    pub async fn remove_file(&mut self, path: &str) -> Result<()> {
        self.ftp.rm(path).await.map_err(|e| self.fail(e, path))
    }

    pub async fn remove_dir(&mut self, path: &str) -> Result<()> {
        self.ftp.rmdir(path).await.map_err(|e| self.fail(e, path))
    }

    pub async fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        self.ftp.rename(from, to).await.map_err(|e| self.fail(e, from))
    }

    pub async fn chmod(&mut self, path: &str, mode: u32) -> Result<()> {
        let cmd = format!("SITE CHMOD {:o} {path}", mode & 0o7777);
        match self.ftp.custom_command(cmd, &[Status::CommandOk, Status::RequestedFileActionOk]).await {
            Ok(_) => Ok(()),
            Err(e) => Err(self.fail(e, path)),
        }
    }

    pub async fn set_modified(&mut self, path: &str, mtime: i64) -> Result<()> {
        use mtime_cmd::*;
        let ts =
            listing::format_mlsx_time(mtime).ok_or_else(|| Error::InvalidInput(format!("invalid time {mtime}")))?;
        let shared = self.shared.clone();
        let known = shared.mtime_cmd.load(Ordering::Relaxed);
        let candidates = match known {
            NONE => return Err(Error::unsupported("setting modification time on this server")),
            UNKNOWN if shared.info().feat.mfmt => vec![MFMT],
            UNKNOWN => vec![SITE_UTIME, SITE_UTIME5, MDTM],
            k => vec![k],
        };
        for c in candidates {
            let (cmd, ok): (String, &[Status]) = match c {
                MFMT => (format!("MFMT {ts} {path}"), &[Status::File, Status::CommandOk]),
                SITE_UTIME => (format!("SITE UTIME {ts} {path}"), &[Status::CommandOk, Status::RequestedFileActionOk]),
                SITE_UTIME5 => (
                    format!("SITE UTIME {path} {ts} {ts} {ts} UTC"),
                    &[Status::CommandOk, Status::RequestedFileActionOk],
                ),
                _ => (format!("MDTM {ts} {path}"), &[Status::File, Status::CommandOk]),
            };
            match self.ftp.custom_command(cmd, ok).await {
                Ok(_) => {
                    shared.mtime_cmd.store(c, Ordering::Relaxed);
                    return Ok(());
                }
                Err(e) if is_fatal(&e) => return Err(self.fail(e, path)),
                // Known or announced command: it failed for this file.
                Err(e) if known != UNKNOWN || c == MFMT => return Err(self.fail(e, path)),
                // "Unknown command": try the next variant.
                Err(FtpError::UnexpectedResponse(r)) if matches!(reply_code(&r), 500..=504) => {}
                // SITE UTIME exists but failed (e.g. missing file); a failed MDTM with a time
                // argument proves nothing.
                Err(e) if c != MDTM => return Err(self.fail(e, path)),
                Err(_) => {}
            }
        }
        if known == UNKNOWN {
            shared.mtime_cmd.store(NONE, Ordering::Relaxed);
        }
        Err(Error::unsupported("setting modification time on this server"))
    }

    pub async fn checksum(&mut self, path: &str, algo: ChecksumAlgo) -> Result<Option<String>> {
        let feat = self.shared.info().feat.clone();
        let (hash_name, xcmd, len) = match algo {
            ChecksumAlgo::Md5 => ("MD5", "XMD5", 32),
            ChecksumAlgo::Sha1 => ("SHA-1", "XSHA1", 40),
            ChecksumAlgo::Sha256 => ("SHA-256", "XSHA256", 64),
        };
        let reply = if feat.hash.iter().any(|h| h == hash_name) {
            if let Err(e) = self.ftp.custom_command(format!("OPTS HASH {hash_name}"), &[Status::CommandOk]).await {
                return if is_fatal(&e) { Err(self.fail(e, path)) } else { Ok(None) };
            }
            self.ftp.custom_command(format!("HASH {path}"), &[Status::File]).await
        } else if feat.xhash.iter().any(|x| x == xcmd) {
            self.ftp
                .custom_command(
                    format!("{xcmd} {path}"),
                    &[Status::RequestedFileActionOk, Status::File, Status::CommandOk],
                )
                .await
        } else {
            return Ok(None);
        };
        match reply {
            Ok(r) => Ok(reply_text(&r)
                .split_whitespace()
                .find(|t| t.len() == len && t.chars().all(|c| c.is_ascii_hexdigit()))
                .map(|t| t.to_ascii_lowercase())),
            Err(e) => Err(self.fail(e, path)),
        }
    }

    /// `RETR`, with `REST` when resuming.
    pub async fn start_read(&mut self, path: &str, offset: u64) -> Result<Transfer> {
        if offset > 0 {
            self.ftp.resume_transfer(offset as usize).await.map_err(|e| self.fail(e, path))?;
        }
        self.ftp.retr_as_stream(path).await.map_err(|e| self.fail(e, path))
    }

    /// `STOR`; resuming uses `REST`+`STOR` when supported, otherwise `APPE`.
    pub async fn start_write(&mut self, path: &str, offset: u64) -> Result<Transfer> {
        let r = if offset == 0 {
            self.ftp.put_with_stream(path).await
        } else if self.shared.info().feat.rest_stream {
            self.ftp.resume_transfer(offset as usize).await.map_err(|e| self.fail(e, path))?;
            self.ftp.put_with_stream(path).await
        } else {
            self.ftp.append_with_stream(path).await
        };
        r.map_err(|e| self.fail(e, path))
    }

    pub async fn quit(&mut self) {
        let _ = tokio::time::timeout(Duration::from_secs(3), self.ftp.quit()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passive_targets() {
        let a = |s: &str| s.parse::<SocketAddr>().unwrap();
        let ip = |s: &str| Some(s.parse::<IpAddr>().unwrap());
        // NAT: private PASV address from a public server -> use the control peer
        assert_eq!(passive_target(a("10.0.0.5:5000"), ip("203.0.113.7"), "h", false), ("203.0.113.7".into(), 5000));
        // LAN server
        assert_eq!(passive_target(a("192.168.1.2:5000"), ip("192.168.1.2"), "h", false), ("192.168.1.2".into(), 5000));
        // Proxy: announced address == proxy (EPSV) or private -> server host name
        assert_eq!(
            passive_target(a("198.51.100.1:5000"), ip("198.51.100.1"), "ftp.example.com", true),
            ("ftp.example.com".into(), 5000)
        );
        assert_eq!(
            passive_target(a("10.1.1.1:5000"), ip("198.51.100.1"), "ftp.example.com", true),
            ("ftp.example.com".into(), 5000)
        );
        assert_eq!(
            passive_target(a("203.0.113.9:5000"), ip("198.51.100.1"), "ftp.example.com", true),
            ("203.0.113.9".into(), 5000)
        );
    }

    #[test]
    fn reply_mapping() {
        let r = |code: Status, body: &str| Response::new(code, body.as_bytes().to_vec());
        assert!(matches!(
            map_reply(&r(Status::FileUnavailable, "550 No such file or directory.\r\n"), "/x"),
            Error::NotFound(_)
        ));
        assert!(matches!(
            map_reply(&r(Status::FileUnavailable, "550 Directory not empty\r\n"), "/x"),
            Error::DirectoryNotEmpty(_)
        ));
        assert!(matches!(map_reply(&r(Status::FileUnavailable, "550 File exists\r\n"), "/x"), Error::AlreadyExists(_)));
        assert!(matches!(
            map_reply(&r(Status::FileUnavailable, "550 Permission denied.\r\n"), "/x"),
            Error::PermissionDenied(_)
        ));
        assert!(matches!(map_reply(&r(Status::NotLoggedIn, "530 Login incorrect.\r\n"), ""), Error::AuthFailed(_)));
        assert!(matches!(
            map_reply(&r(Status::NotImplemented, "502 Command not implemented.\r\n"), ""),
            Error::Unsupported(_)
        ));
        assert_eq!(reply_text(&r(Status::System, "211-Features:\r\n MDTM\r\n211 End\r\n")), "Features: MDTM End");
        assert_eq!(reply_code(&r(Status::Unknown, "521 exists\r\n")), 521);
    }
}
