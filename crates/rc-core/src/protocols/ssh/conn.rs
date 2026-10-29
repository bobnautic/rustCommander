//! The SSH connection shared by the SFTP and SCP backends: transport (direct, proxy or
//! jump host), host key verification, and the channel based features (exec, terminal,
//! port forwarding).

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use parking_lot::Mutex;
use russh::client::{self, Handle, Msg};
use russh::keys::{HashAlg, PublicKey, PublicKeyBase64, PublicKeyOrCertificate};
use russh::{Channel, ChannelMsg, ChannelReadHalf, ChannelWriteHalf, Disconnect, Preferred, Sig, SshId};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};

use super::{auth, shell};
use crate::connect::ConnectContext;
use crate::error::{Error, Result};
use crate::known_hosts::{HostKeyStatus, KnownHosts};
use crate::prompt::{HostKeyState, PromptRequest, Prompter};
use crate::site::SiteConfig;
use crate::types::*;
use crate::vfs::*;

/// Receive window per channel. Large enough for deep SFTP read pipelines.
const WINDOW_SIZE: u32 = 16 * 1024 * 1024;
/// Largest SSH packet we accept (russh warns above 64 KiB).
const MAX_PACKET_SIZE: u32 = 65535;
/// Messages buffered per channel before the session applies backpressure.
const CHANNEL_BUFFER: usize = 512;
/// Upper bound for stderr collected from commands.
const MAX_STDERR: usize = 64 * 1024;
/// Concurrent command channels per connection. OpenSSH allows 10 sessions per connection
/// by default (`MaxSessions`); the rest is left for SFTP and terminals.
const MAX_EXEC_CHANNELS: usize = 6;

/// State shared between the [`ClientHandler`] (owned by the russh session task) and the
/// connection.
#[derive(Default)]
pub(crate) struct Shared {
    rejection: Mutex<Option<Error>>,
    server_id: Mutex<String>,
    algorithms: Mutex<Vec<(String, String)>>,
    host_key: Mutex<Option<(String, String)>>,
    banner: Mutex<Option<String>>,
    prompting: AtomicBool,
    prompt_done: Mutex<Option<Instant>>,
}

impl Shared {
    pub(crate) fn begin_prompt(&self) {
        self.prompting.store(true, Ordering::SeqCst);
    }

    pub(crate) fn end_prompt(&self) {
        *self.prompt_done.lock() = Some(Instant::now());
        self.prompting.store(false, Ordering::SeqCst);
    }
}

/// Run `fut` with a timeout that does not count the time spent waiting for the user.
pub(crate) async fn prompt_aware_timeout<F: Future>(fut: F, timeout: Duration, shared: &Shared) -> Option<F::Output> {
    tokio::pin!(fut);
    let mut deadline = Instant::now() + timeout;
    loop {
        tokio::select! {
            r = &mut fut => return Some(r),
            _ = tokio::time::sleep_until(deadline.into()) => {
                let now = Instant::now();
                if shared.prompting.load(Ordering::SeqCst) {
                    deadline = now + timeout;
                    continue;
                }
                if let Some(done) = *shared.prompt_done.lock() {
                    if done + timeout > now {
                        deadline = done + timeout;
                        continue;
                    }
                }
                return None;
            }
        }
    }
}

/// Map a russh error to a crate error.
pub(crate) fn ssh_error(e: russh::Error, what: &str) -> Error {
    use russh::Error as E;
    match e {
        E::IO(io) if io.kind() == std::io::ErrorKind::TimedOut => Error::Timeout(what.to_string()),
        E::IO(io) => Error::ConnectionLost(format!("{what}: {io}")),
        E::Elapsed(_) | E::ConnectionTimeout => Error::Timeout(what.to_string()),
        E::Disconnect | E::HUP | E::SendError | E::RecvError | E::KeepaliveTimeout | E::InactivityTimeout => {
            Error::ConnectionLost(format!("{what}: {e}"))
        }
        E::ChannelOpenFailure(reason) => match reason {
            russh::ChannelOpenFailure::AdministrativelyProhibited => {
                Error::PermissionDenied(format!("{what}: prohibited by the server"))
            }
            russh::ChannelOpenFailure::ConnectFailed => Error::Other(format!("{what}: connection failed")),
            other => Error::Other(format!("{what}: {other:?}")),
        },
        E::UnknownKey => Error::HostKeyRejected(what.to_string()),
        other => Error::Protocol(format!("{what}: {other}")),
    }
}

fn signal_number(sig: &Sig) -> i32 {
    match sig {
        Sig::HUP => 1,
        Sig::INT => 2,
        Sig::QUIT => 3,
        Sig::ILL => 4,
        Sig::ABRT => 6,
        Sig::FPE => 8,
        Sig::KILL => 9,
        Sig::USR1 => 10,
        Sig::SEGV => 11,
        Sig::PIPE => 13,
        Sig::ALRM => 14,
        Sig::TERM => 15,
        Sig::Custom(_) => 0,
    }
}

/// The russh client callbacks.
pub(crate) struct ClientHandler {
    host: String,
    port: u16,
    prompter: Arc<dyn Prompter>,
    known_hosts: Arc<KnownHosts>,
    use_openssh_known_hosts: bool,
    session_id: String,
    shared: Arc<Shared>,
}

enum OpenSshStatus {
    Match,
    Changed(String),
    Unknown,
}

impl ClientHandler {
    fn openssh_known_hosts(&self, key: &PublicKey) -> OpenSshStatus {
        if !self.use_openssh_known_hosts {
            return OpenSshStatus::Unknown;
        }
        match russh::keys::known_hosts::known_host_keys(&self.host, self.port) {
            Ok(list) => {
                if list.iter().any(|(_, k)| k.key_data() == key.key_data()) {
                    return OpenSshStatus::Match;
                }
                match list.iter().find(|(_, k)| k.algorithm() == key.algorithm()) {
                    Some((_, k)) => OpenSshStatus::Changed(k.fingerprint(HashAlg::Sha256).to_string()),
                    None => OpenSshStatus::Unknown,
                }
            }
            Err(e) => {
                tracing::debug!(session = %self.session_id, "cannot read ~/.ssh/known_hosts: {e}");
                OpenSshStatus::Unknown
            }
        }
    }

    async fn verify_host_key(&self, key: &PublicKey) -> Result<()> {
        let key_type = key.algorithm().as_str().to_string();
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        *self.shared.host_key.lock() = Some((key_type.clone(), fingerprint.clone()));
        let store_key = KnownHosts::ssh_key(&self.host, self.port);
        let (state, previous_fingerprint) = match self.known_hosts.check(&store_key, &key_type, &fingerprint) {
            HostKeyStatus::Trusted => return Ok(()),
            HostKeyStatus::Mismatch { stored } => (HostKeyState::Changed, Some(stored.fingerprint)),
            HostKeyStatus::Unknown => match self.openssh_known_hosts(key) {
                OpenSshStatus::Match => {
                    tracing::debug!(session = %self.session_id, "host key found in ~/.ssh/known_hosts");
                    return Ok(());
                }
                OpenSshStatus::Changed(prev) => (HostKeyState::Changed, Some(prev)),
                OpenSshStatus::Unknown => (HostKeyState::New, None),
            },
        };
        if state == HostKeyState::Changed {
            tracing::warn!(
                session = %self.session_id,
                "host key of {}:{} changed ({} -> {fingerprint})",
                self.host,
                self.port,
                previous_fingerprint.as_deref().unwrap_or("?")
            );
        }
        self.shared.begin_prompt();
        let answer = self
            .prompter
            .prompt(PromptRequest::HostKey {
                host: self.host.clone(),
                port: self.port,
                key_type: key_type.clone(),
                fingerprint: fingerprint.clone(),
                state,
                previous_fingerprint,
            })
            .await;
        self.shared.end_prompt();
        match answer {
            Some(r) if r.accepted => {
                if r.remember {
                    if let Err(e) = self.known_hosts.add(&store_key, &key_type, &fingerprint, &key.public_key_base64())
                    {
                        tracing::warn!(session = %self.session_id, "cannot store host key: {e}");
                    }
                }
                Ok(())
            }
            _ => Err(Error::HostKeyRejected(format!(
                "{key_type} key {fingerprint} of {}:{} was not accepted",
                self.host, self.port
            ))),
        }
    }
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, server_public_key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key = match server_public_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => PublicKey::new(cert.public_key().clone(), ""),
        };
        match self.verify_host_key(&key).await {
            Ok(()) => Ok(true),
            Err(e) => {
                *self.shared.rejection.lock() = Some(e);
                Ok(false)
            }
        }
    }

    async fn auth_banner(&mut self, banner: &str, _session: &mut client::Session) -> Result<(), Self::Error> {
        tracing::info!(session = %self.session_id, "server banner: {}", banner.trim_end());
        *self.shared.banner.lock() = Some(banner.to_string());
        let prompter = self.prompter.clone();
        let req = PromptRequest::Banner { host: self.host.clone(), message: banner.to_string() };
        tokio::spawn(async move {
            let _ = prompter.prompt(req).await;
        });
        Ok(())
    }

    async fn kex_done(
        &mut self,
        _shared_secret: Option<&[u8]>,
        names: &russh::Names,
        session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let mac = |m: &russh::mac::Name| m.as_ref().to_string();
        let mut algs = vec![
            ("Key exchange".to_string(), names.kex.as_ref().to_string()),
            ("Host key algorithm".to_string(), names.key.as_str().to_string()),
            ("Cipher".to_string(), names.cipher.as_ref().to_string()),
        ];
        let (cmac, smac) = (mac(&names.client_mac), mac(&names.server_mac));
        if cmac != "none" || smac != "none" {
            algs.push(("MAC".to_string(), if cmac == smac { cmac } else { format!("{cmac} / {smac}") }));
        }
        let compression = match names.client_compression {
            russh::compression::Compression::None => "none",
            russh::compression::Compression::Zlib => "zlib",
            russh::compression::Compression::ZlibOpenSSH => "zlib@openssh.com",
        };
        algs.push(("Compression".to_string(), compression.to_string()));
        *self.shared.algorithms.lock() = algs;
        *self.shared.server_id.lock() = String::from_utf8_lossy(session.remote_sshid()).trim().to_string();
        Ok(())
    }
}

/// AES-GCM beats ChaCha20-Poly1305 by far when the CPU has AES instructions.
fn hardware_aes() -> bool {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    {
        std::arch::is_x86_feature_detected!("aes") && std::arch::is_x86_feature_detected!("pclmulqdq")
    }
    #[cfg(target_arch = "aarch64")]
    {
        std::arch::is_aarch64_feature_detected!("aes") && std::arch::is_aarch64_feature_detected!("pmull")
    }
    #[cfg(not(any(target_arch = "x86", target_arch = "x86_64", target_arch = "aarch64")))]
    {
        false
    }
}

fn client_config(site: &SiteConfig) -> client::Config {
    let mut preferred = Preferred::default();
    if hardware_aes() {
        use russh::cipher::*;
        preferred.cipher = std::borrow::Cow::Borrowed(&[
            AES_256_GCM,
            AES_128_GCM,
            CHACHA20_POLY1305,
            AES_256_CTR,
            AES_192_CTR,
            AES_128_CTR,
        ]);
    }
    if site.ssh.compression {
        preferred.compression = std::borrow::Cow::Borrowed(&[
            russh::compression::ZLIB_LEGACY,
            russh::compression::ZLIB,
            russh::compression::NONE,
        ]);
    } else {
        preferred.compression = std::borrow::Cow::Borrowed(&[russh::compression::NONE]);
    }
    client::Config {
        client_id: SshId::Standard(format!("SSH-2.0-RustCommander_{}", crate::VERSION).into()),
        keepalive_interval: (site.keepalive_secs > 0).then(|| Duration::from_secs(site.keepalive_secs as u64)),
        keepalive_max: 3,
        window_size: WINDOW_SIZE,
        maximum_packet_size: MAX_PACKET_SIZE,
        channel_buffer_size: CHANNEL_BUFFER,
        preferred,
        nodelay: true,
        ..Default::default()
    }
}

/// An authenticated SSH connection.
pub(crate) struct SshConnection {
    handle: Handle<ClientHandler>,
    shared: Arc<Shared>,
    host: String,
    port: u16,
    username: String,
    env: Vec<(String, String)>,
    timeout: Duration,
    session_id: String,
    /// Keeps the jump host connection alive while this one is in use.
    jump: Option<Arc<SshConnection>>,
    exec_slots: Arc<Semaphore>,
}

type ConnectFuture<'a> = Pin<Box<dyn Future<Output = Result<SshConnection>> + Send + 'a>>;

impl SshConnection {
    pub(crate) fn connect<'a>(site: &'a SiteConfig, ctx: &'a ConnectContext) -> ConnectFuture<'a> {
        Box::pin(Self::connect_inner(site, ctx))
    }

    async fn connect_inner(site: &SiteConfig, ctx: &ConnectContext) -> Result<SshConnection> {
        if site.host.trim().is_empty() {
            return Err(Error::InvalidInput("no host name given".into()));
        }
        let host = site.host.trim().to_string();
        let port = if site.port == 0 { 22 } else { site.port };
        let timeout = site.timeout();
        let shared = Arc::new(Shared::default());
        let handler = ClientHandler {
            host: host.clone(),
            port,
            prompter: ctx.prompter.clone(),
            known_hosts: ctx.known_hosts.clone(),
            use_openssh_known_hosts: site.ssh.use_openssh_known_hosts,
            session_id: ctx.session_id.clone(),
            shared: shared.clone(),
        };
        let config = Arc::new(client_config(site));
        let (mut handle, jump) = match &site.ssh.jump {
            Some(jump_site) => {
                tracing::info!(session = %ctx.session_id, "connecting to {host}:{port} via jump host {}", jump_site.display_name());
                let jump = Arc::new(SshConnection::connect(jump_site, ctx).await?);
                let what = format!("jump host {} cannot reach {host}:{port}", jump_site.display_name());
                let channel = tokio::time::timeout(
                    timeout,
                    jump.handle.channel_open_direct_tcpip(host.clone(), port as u32, "127.0.0.1", 0),
                )
                .await
                .map_err(|_| Error::Timeout(what.clone()))?
                .map_err(|e| match ssh_error(e, &what) {
                    Error::Other(m) | Error::PermissionDenied(m) => Error::ConnectionLost(m),
                    other => other,
                })?;
                let handle = handshake(config, channel.into_stream(), handler, timeout, &shared, &host, port).await?;
                (handle, Some(jump))
            }
            None => {
                let tcp = crate::net::connect_tcp(&host, port, &site.proxy, timeout).await?;
                (handshake(config, tcp, handler, timeout, &shared, &host, port).await?, None)
            }
        };
        tracing::info!(
            session = %ctx.session_id,
            "SSH connection to {host}:{port} established ({})",
            shared.server_id.lock()
        );
        let username = auth::authenticate(&mut handle, site, ctx, &shared, timeout).await?;
        tracing::info!(session = %ctx.session_id, "authenticated as {username}");
        Ok(SshConnection {
            handle,
            shared,
            host,
            port,
            username,
            env: site.ssh.env.clone(),
            timeout,
            session_id: ctx.session_id.clone(),
            jump,
            exec_slots: Arc::new(Semaphore::new(MAX_EXEC_CHANNELS)),
        })
    }

    pub(crate) fn timeout(&self) -> Duration {
        self.timeout
    }

    pub(crate) fn session_id(&self) -> &str {
        &self.session_id
    }

    /// The server's identification string, e.g. `SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13`.
    pub(crate) fn server_id(&self) -> String {
        self.shared.server_id.lock().clone()
    }

    pub(crate) fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    pub(crate) fn push_session_info(&self, info: &mut SessionInfo) {
        info.push("Server", format!("{}:{}", self.host, self.port));
        info.push("User", self.username.clone());
        let id = self.server_id();
        if !id.is_empty() {
            info.push("Server software", id);
        }
        if let Some((t, fp)) = self.shared.host_key.lock().clone() {
            info.push("Host key", format!("{t} {fp}"));
        }
        for (k, v) in self.shared.algorithms.lock().iter() {
            info.push(k.clone(), v.clone());
        }
        if let Some(j) = &self.jump {
            info.push("Jump host", format!("{}@{}:{}", j.username, j.host, j.port));
        }
        if let Some(b) = self.shared.banner.lock().as_ref() {
            info.push("Banner", b.trim_end().to_string());
        }
    }

    pub(crate) async fn open_channel(&self) -> Result<Channel<Msg>> {
        let what = "opening an SSH channel";
        let deadline = Instant::now() + self.timeout;
        let mut delay = Duration::from_millis(20);
        loop {
            let r = tokio::time::timeout(self.timeout, self.handle.channel_open_session())
                .await
                .map_err(|_| Error::Timeout(what.into()))?;
            match r {
                Ok(channel) => return Ok(channel),
                // OpenSSH refuses sessions above `MaxSessions`, and releases closed ones lazily.
                Err(russh::Error::ChannelOpenFailure(reason))
                    if reason != russh::ChannelOpenFailure::UnknownChannelType && Instant::now() + delay < deadline =>
                {
                    tracing::debug!(session = %self.session_id, "session channel refused ({reason:?}), retrying");
                    tokio::time::sleep(delay).await;
                    delay = (delay * 2).min(Duration::from_millis(500));
                }
                Err(e) => return Err(ssh_error(e, what)),
            }
        }
    }

    async fn send_env(&self, channel: &Channel<Msg>, extra: &[(String, String)]) {
        for (k, v) in self.env.iter().chain(extra) {
            let _ = channel.set_env(false, k.clone(), v.clone()).await;
        }
    }

    /// Start a command; stdin/stdout are available through the returned channel.
    pub(crate) async fn exec_channel(&self, command: &str) -> Result<ExecChannel> {
        let permit = self
            .exec_slots
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| Error::ConnectionLost("connection closed".into()))?;
        let channel = self.open_channel().await?;
        self.send_env(&channel, &[]).await;
        channel.exec(true, command).await.map_err(|e| ssh_error(e, "exec request"))?;
        let (rd, wr) = channel.split();
        let mut ec = ExecChannel::new(rd, wr, permit);
        ec.started().await?;
        Ok(ec)
    }

    /// Run a command and collect its output.
    pub(crate) async fn exec(&self, command: &str, cwd: Option<&str>) -> Result<ExecOutput> {
        let full = match cwd {
            Some(d) if !d.is_empty() => format!("cd {} && {command}", shell::quote_path(d)),
            _ => command.to_string(),
        };
        tracing::debug!(session = %self.session_id, "exec: {full}");
        let mut ch = self.exec_channel(&full).await?;
        ch.send_eof().await?;
        let mut stdout = Vec::new();
        while let Some(chunk) = ch.read_chunk().await? {
            stdout.extend_from_slice(&chunk);
        }
        let (exit_code, stderr) = ch.finish().await?;
        Ok(ExecOutput { stdout: String::from_utf8_lossy(&stdout).into_owned(), stderr, exit_code })
    }

    pub(crate) async fn open_terminal(&self, opts: TerminalOptions) -> Result<TerminalChannel> {
        let channel = self.open_channel().await?;
        channel
            .request_pty(true, &opts.term, opts.cols.max(1) as u32, opts.rows.max(1) as u32, 0, 0, &[])
            .await
            .map_err(|e| ssh_error(e, "PTY request"))?;
        self.send_env(&channel, &opts.env).await;
        match opts.cwd.as_deref() {
            Some(cwd) if !cwd.is_empty() => {
                let cmd = format!("cd {} 2>/dev/null; exec \"$SHELL\" -l", shell::quote_path(cwd));
                channel.exec(true, cmd).await
            }
            _ => channel.request_shell(true).await,
        }
        .map_err(|e| ssh_error(e, "shell request"))?;
        let (mut rd, wr) = channel.split();
        let (out_tx, out_rx) = mpsc::unbounded_channel::<TerminalOutput>();
        let mut replies = 0;
        while replies < 2 {
            match rd.wait().await {
                Some(ChannelMsg::Success) => replies += 1,
                Some(ChannelMsg::Failure) => {
                    let what = if replies == 0 { "a pseudo terminal" } else { "a shell" };
                    let _ = wr.close().await;
                    return Err(Error::PermissionDenied(format!("the server refused to open {what}")));
                }
                Some(ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. }) => {
                    let _ = out_tx.send(TerminalOutput::Data(data.to_vec()));
                }
                Some(ChannelMsg::Close) | None => return Err(Error::ConnectionLost("terminal channel closed".into())),
                Some(_) => {}
            }
        }
        let (in_tx, mut in_rx) = mpsc::unbounded_channel::<TerminalInput>();
        // Dropped by the reader when the channel ends, so a writer waiting for window space
        // (which russh never grants on a closed channel) gives up.
        let (closed_tx, mut closed) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            let _closed_tx = closed_tx;
            let mut code = None;
            loop {
                match rd.wait().await {
                    Some(ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. }) => {
                        let _ = out_tx.send(TerminalOutput::Data(data.to_vec()));
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status as i32),
                    Some(ChannelMsg::ExitSignal { signal_name, .. }) => code = Some(128 + signal_number(&signal_name)),
                    Some(ChannelMsg::Close) | None => break,
                    Some(_) => {}
                }
            }
            let _ = out_tx.send(TerminalOutput::Exit(code));
        });
        tokio::spawn(async move {
            loop {
                let msg = tokio::select! {
                    m = in_rx.recv() => m,
                    _ = &mut closed => return,
                };
                match msg {
                    Some(TerminalInput::Data(d)) => {
                        tokio::select! {
                            r = wr.data_bytes(d) => if r.is_err() { break },
                            _ = &mut closed => return,
                        }
                    }
                    Some(TerminalInput::Resize { cols, rows }) => {
                        let _ = wr.window_change(cols.max(1) as u32, rows.max(1) as u32, 0, 0).await;
                    }
                    Some(TerminalInput::Close) | None => break,
                }
            }
            let _ = wr.eof().await;
            let _ = wr.close().await;
        });
        Ok(TerminalChannel { input: in_tx, output: out_rx })
    }

    pub(crate) async fn open_tunnel(&self, host: &str, port: u16) -> Result<BoxedTunnelStream> {
        let what = format!("port forwarding to {host}:{port}");
        let channel = tokio::time::timeout(
            self.timeout,
            self.handle.channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0),
        )
        .await
        .map_err(|_| Error::Timeout(what.clone()))?
        .map_err(|e| ssh_error(e, &what))?;
        tracing::debug!(session = %self.session_id, "opened tunnel to {host}:{port}");
        Ok(Box::pin(channel.into_stream()))
    }

    pub(crate) async fn checksum(&self, path: &str, algo: ChecksumAlgo) -> Result<Option<String>> {
        match self.exec(&shell::checksum_command(path, algo), None).await {
            Ok(out) if out.exit_code == Some(0) => Ok(shell::parse_checksum(&out.stdout, algo)),
            Ok(out) => {
                tracing::debug!(session = %self.session_id, "checksum failed: {}", out.stderr.trim());
                Ok(None)
            }
            Err(e) if e.is_connection_error() => Err(e),
            Err(_) => Ok(None),
        }
    }

    pub(crate) async fn df(&self, path: &str) -> Result<Option<DiskInfo>> {
        match self.exec(&format!("LC_ALL=C df -Pk {}", shell::quote_path(path)), None).await {
            Ok(out) if out.exit_code == Some(0) => Ok(shell::parse_df(&out.stdout)),
            Ok(_) => Ok(None),
            Err(e) if e.is_connection_error() => Err(e),
            Err(_) => Ok(None),
        }
    }

    /// Resolve user / group names to numeric ids on the server.
    pub(crate) async fn resolve_ids(
        &self,
        owner: Option<&str>,
        group: Option<&str>,
    ) -> Result<(Option<u32>, Option<u32>)> {
        let uid = match owner.filter(|o| !o.is_empty()) {
            None => None,
            Some(o) => match o.parse() {
                Ok(n) => Some(n),
                Err(_) => {
                    let out = self.exec(&format!("id -u {}", shell::quote(o)), None).await?;
                    Some(out.stdout.trim().parse().map_err(|_| Error::InvalidInput(format!("unknown user {o}")))?)
                }
            },
        };
        let gid = match group.filter(|g| !g.is_empty()) {
            None => None,
            Some(g) => match g.parse() {
                Ok(n) => Some(n),
                Err(_) => {
                    let q = shell::quote(g);
                    let qp = shell::quote(&format!("^{g}:"));
                    let out = self.exec(&format!("getent group {q} 2>/dev/null || grep {qp} /etc/group"), None).await?;
                    let gid =
                        out.stdout.lines().next().and_then(|l| l.split(':').nth(2)).and_then(|s| s.trim().parse().ok());
                    Some(gid.ok_or_else(|| Error::InvalidInput(format!("unknown group {g}")))?)
                }
            },
        };
        Ok((uid, gid))
    }

    pub(crate) async fn ping(&self) -> Result<()> {
        if self.is_closed() {
            return Err(Error::ConnectionLost("SSH connection closed".into()));
        }
        tokio::time::timeout(self.timeout, self.handle.send_ping())
            .await
            .map_err(|_| Error::Timeout("keepalive".into()))?
            .map_err(|e| ssh_error(e, "keepalive"))
    }

    pub(crate) async fn disconnect(&self) {
        let _ = self.handle.disconnect(Disconnect::ByApplication, "", "en").await;
        if let Some(j) = &self.jump {
            if Arc::strong_count(j) == 1 {
                j.disconnect_boxed().await;
            }
        }
    }

    fn disconnect_boxed(&self) -> Pin<Box<dyn Future<Output = ()> + Send + '_>> {
        Box::pin(self.disconnect())
    }
}

async fn handshake<S>(
    config: Arc<client::Config>,
    stream: S,
    handler: ClientHandler,
    timeout: Duration,
    shared: &Shared,
    host: &str,
    port: u16,
) -> Result<Handle<ClientHandler>>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    match prompt_aware_timeout(client::connect_stream(config, stream, handler), timeout, shared).await {
        Some(Ok(handle)) => Ok(handle),
        Some(Err(e)) => Err(shared
            .rejection
            .lock()
            .take()
            .unwrap_or_else(|| ssh_error(e, &format!("SSH handshake with {host}:{port}")))),
        None => Err(Error::Timeout(format!("SSH handshake with {host}:{port}"))),
    }
}

/// Output state of a command channel.
#[derive(Default)]
struct ExecState {
    /// stdout received while waiting for something else.
    early: VecDeque<Bytes>,
    stderr: Vec<u8>,
    exit: Option<i32>,
    eof: bool,
    closed: bool,
}

impl ExecState {
    /// Process a channel message; stdout data is queued in `early`.
    fn handle(&mut self, msg: Option<ChannelMsg>) {
        match msg {
            Some(ChannelMsg::Data { data }) => {
                if !data.is_empty() {
                    self.early.push_back(data);
                }
            }
            Some(ChannelMsg::ExtendedData { data, .. }) => {
                if self.stderr.len() < MAX_STDERR {
                    self.stderr.extend_from_slice(&data);
                }
            }
            Some(ChannelMsg::ExitStatus { exit_status }) => self.exit = Some(exit_status as i32),
            Some(ChannelMsg::ExitSignal { signal_name, .. }) => self.exit = Some(128 + signal_number(&signal_name)),
            Some(ChannelMsg::Eof) => self.eof = true,
            Some(ChannelMsg::Close) | None => {
                self.eof = true;
                self.closed = true;
            }
            Some(_) => {}
        }
    }
}

/// A command channel with stdout buffering (stderr and the exit status are collected).
pub(crate) struct ExecChannel {
    rd: Option<ChannelReadHalf>,
    wr: Option<ChannelWriteHalf<Msg>>,
    /// Held until the server has released the channel (`MaxSessions`).
    permit: Option<OwnedSemaphorePermit>,
    cur: Bytes,
    st: ExecState,
}

fn channel_gone() -> Error {
    Error::ConnectionLost("channel closed".into())
}

impl ExecChannel {
    fn new(rd: ChannelReadHalf, wr: ChannelWriteHalf<Msg>, permit: OwnedSemaphorePermit) -> Self {
        ExecChannel { rd: Some(rd), wr: Some(wr), permit: Some(permit), cur: Bytes::new(), st: ExecState::default() }
    }

    async fn next_msg(&mut self) -> Result<()> {
        let rd = self.rd.as_mut().ok_or_else(channel_gone)?;
        let msg = rd.wait().await;
        self.st.handle(msg);
        Ok(())
    }

    /// Wait for the reply to the exec request.
    async fn started(&mut self) -> Result<()> {
        loop {
            let rd = self.rd.as_mut().ok_or_else(channel_gone)?;
            match rd.wait().await {
                Some(ChannelMsg::Success) => return Ok(()),
                Some(ChannelMsg::Failure) => {
                    return Err(Error::PermissionDenied("the server refused to run a command".into()))
                }
                msg => {
                    self.st.handle(msg);
                    if self.st.closed {
                        return Err(Error::ConnectionLost("channel closed before the command started".into()));
                    }
                }
            }
        }
    }

    /// Next chunk of stdout; `None` at end of output.
    pub(crate) async fn read_chunk(&mut self) -> Result<Option<Bytes>> {
        if !self.cur.is_empty() {
            return Ok(Some(std::mem::take(&mut self.cur)));
        }
        loop {
            if let Some(b) = self.st.early.pop_front() {
                return Ok(Some(b));
            }
            if self.st.eof {
                return Ok(None);
            }
            self.next_msg().await?;
        }
    }

    async fn fill(&mut self) -> Result<bool> {
        if self.cur.is_empty() {
            match self.read_chunk().await? {
                Some(b) => self.cur = b,
                None => return Ok(false),
            }
        }
        Ok(true)
    }

    pub(crate) async fn read(&mut self, buf: &mut [u8]) -> Result<usize> {
        if buf.is_empty() || !self.fill().await? {
            return Ok(0);
        }
        let n = buf.len().min(self.cur.len());
        buf[..n].copy_from_slice(&self.cur.split_to(n));
        Ok(n)
    }

    pub(crate) async fn read_byte(&mut self) -> Result<Option<u8>> {
        if !self.fill().await? {
            return Ok(None);
        }
        let b = self.cur[0];
        let _ = self.cur.split_to(1);
        Ok(Some(b))
    }

    /// Read up to (not including) `\n`.
    pub(crate) async fn read_line(&mut self, max: usize) -> Result<Vec<u8>> {
        let mut line = Vec::new();
        loop {
            match self.read_byte().await? {
                Some(b'\n') => return Ok(line),
                Some(b) => {
                    if line.len() >= max {
                        return Err(Error::protocol("line too long"));
                    }
                    line.push(b);
                }
                None => return Err(Error::protocol("unexpected end of output")),
            }
        }
    }

    /// Send stdin data. Keeps processing incoming messages meanwhile: russh does not wake
    /// writers waiting for window space when the channel or the connection goes away.
    pub(crate) async fn write_all(&mut self, data: &[u8]) -> Result<()> {
        if data.is_empty() {
            return Ok(());
        }
        let (Some(rd), Some(wr)) = (self.rd.as_mut(), self.wr.as_ref()) else {
            return Err(channel_gone());
        };
        let send = wr.data_bytes(Bytes::copy_from_slice(data));
        tokio::pin!(send);
        loop {
            if self.st.closed {
                let msg = String::from_utf8_lossy(&self.st.stderr).trim().to_string();
                return Err(if msg.is_empty() {
                    Error::ConnectionLost("the remote command ended while receiving data".into())
                } else {
                    Error::Other(msg)
                });
            }
            tokio::select! {
                r = &mut send => return r.map_err(|e| ssh_error(e, "sending data")),
                msg = rd.wait() => self.st.handle(msg),
            }
        }
    }

    pub(crate) async fn send_eof(&self) -> Result<()> {
        let wr = self.wr.as_ref().ok_or_else(channel_gone)?;
        wr.eof().await.map_err(|e| ssh_error(e, "sending EOF"))
    }

    pub(crate) fn stderr(&self) -> String {
        String::from_utf8_lossy(&self.st.stderr).trim().to_string()
    }

    /// Wait until the server closes the channel (remaining stdout is discarded); returns
    /// the exit code and stderr.
    pub(crate) async fn finish(mut self) -> Result<(Option<i32>, String)> {
        while !self.st.closed {
            self.next_msg().await?;
            self.st.early.clear();
        }
        Ok((self.st.exit, String::from_utf8_lossy(&self.st.stderr).into_owned()))
    }
}

impl Drop for ExecChannel {
    fn drop(&mut self) {
        let (rd, wr, permit) = (self.rd.take(), self.wr.take(), self.permit.take());
        if self.st.closed {
            return;
        }
        if let (Ok(rt), Some(mut rd), Some(wr)) = (tokio::runtime::Handle::try_current(), rd, wr) {
            rt.spawn(async move {
                let _ = wr.close().await;
                let wait_close = async { while !matches!(rd.wait().await, Some(ChannelMsg::Close) | None) {} };
                let _ = tokio::time::timeout(Duration::from_secs(10), wait_close).await;
                drop(permit);
            });
        }
    }
}
