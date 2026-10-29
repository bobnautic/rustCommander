//! SSH user authentication: agent, explicit key, default keys, password and
//! keyboard-interactive, in that order.

use std::collections::HashSet;
use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{AuthResult, Handle, KeyboardInteractiveAuthResponse};
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::agent::AgentIdentity;
use russh::keys::{HashAlg, PrivateKey, PrivateKeyWithHashAlg};
use russh::{MethodKind, MethodSet};

use super::conn::{ssh_error, ClientHandler, Shared};
use crate::connect::ConnectContext;
use crate::error::{Error, Result};
use crate::prompt::{KbdPrompt, PromptRequest, PromptResponse};
use crate::site::SiteConfig;

/// Signing with an agent may need user confirmation (`ssh-add -c`, hardware tokens).
const AGENT_TIMEOUT: Duration = Duration::from_secs(120);
const DEFAULT_KEYS: [&str; 3] = ["id_ed25519", "id_ecdsa", "id_rsa"];

type DynAgent = AgentClient<Box<dyn AgentStream + Send + Unpin + 'static>>;

struct Auth<'a> {
    handle: &'a mut Handle<ClientHandler>,
    ctx: &'a ConnectContext,
    shared: &'a Shared,
    host: String,
    user: String,
    timeout: Duration,
    allowed: Option<MethodSet>,
    tried: Vec<&'static str>,
    tried_keys: HashSet<String>,
    rsa_hash: Option<Option<HashAlg>>,
    password: Option<String>,
    cancelled: bool,
}

pub(super) async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    site: &SiteConfig,
    ctx: &ConnectContext,
    shared: &Shared,
    timeout: Duration,
) -> Result<String> {
    let host = site.host.trim().to_string();
    let user = if site.username.is_empty() {
        match prompt(shared, ctx, PromptRequest::Username { host: host.clone() }).await {
            Some(r) if r.accepted && r.value(0).is_some_and(|v| !v.is_empty()) => {
                r.value(0).unwrap_or_default().to_string()
            }
            _ => return Err(Error::Cancelled),
        }
    } else {
        site.username.clone()
    };
    let mut a = Auth {
        handle,
        ctx,
        shared,
        host,
        user: user.clone(),
        timeout,
        allowed: None,
        tried: Vec::new(),
        tried_keys: HashSet::new(),
        rsa_hash: None,
        password: site.password.clone().filter(|p| !p.is_empty()),
        cancelled: false,
    };
    if a.run(site).await? {
        return Ok(user);
    }
    if a.cancelled {
        return Err(Error::Cancelled);
    }
    let mut msg =
        if a.tried.is_empty() { "no usable method".to_string() } else { format!("tried: {}", a.tried.join(", ")) };
    if let Some(allowed) = &a.allowed {
        let names: Vec<&str> = allowed.iter().map(<&str>::from).collect();
        msg.push_str(&format!(" (server allows: {})", names.join(", ")));
    }
    Err(Error::AuthFailed(msg))
}

async fn prompt(shared: &Shared, ctx: &ConnectContext, req: PromptRequest) -> Option<PromptResponse> {
    shared.begin_prompt();
    let r = ctx.prompter.prompt(req).await;
    shared.end_prompt();
    r
}

async fn timed<T, E, F>(timeout: Duration, what: &str, fut: F) -> Result<T>
where
    F: Future<Output = std::result::Result<T, E>>,
    E: Into<russh::Error>,
{
    match tokio::time::timeout(timeout, fut).await {
        Ok(Ok(v)) => Ok(v),
        Ok(Err(e)) => Err(ssh_error(e.into(), what)),
        Err(_) => Err(Error::Timeout(what.to_string())),
    }
}

impl Auth<'_> {
    async fn run(&mut self, site: &SiteConfig) -> Result<bool> {
        let r = timed(self.timeout, "authentication", self.handle.authenticate_none(self.user.clone())).await?;
        if self.update(r) {
            return Ok(true);
        }
        if site.ssh.use_agent && self.allows(MethodKind::PublicKey) && self.try_agent().await? {
            return Ok(true);
        }
        if self.allows(MethodKind::PublicKey) {
            if let Some((key, label)) = self.explicit_key(site).await {
                if self.try_key(key, &label).await? {
                    return Ok(true);
                }
            }
        }
        if site.ssh.try_default_keys && self.allows(MethodKind::PublicKey) {
            for (key, label) in default_keys(site.ssh.passphrase.as_deref()).await {
                if !self.allows(MethodKind::PublicKey) {
                    break;
                }
                if self.try_key(key, &label).await? {
                    return Ok(true);
                }
            }
        }
        if site.ssh.try_password && self.allows(MethodKind::Password) && self.try_password().await? {
            return Ok(true);
        }
        if site.ssh.try_keyboard_interactive
            && !self.cancelled
            && self.allows(MethodKind::KeyboardInteractive)
            && self.try_keyboard_interactive().await?
        {
            return Ok(true);
        }
        Ok(false)
    }

    fn allows(&self, m: MethodKind) -> bool {
        match &self.allowed {
            Some(set) => set.is_empty() || set.contains(&m),
            None => true,
        }
    }

    fn record(&mut self, method: &'static str) {
        if !self.tried.contains(&method) {
            self.tried.push(method);
        }
    }

    fn update(&mut self, r: AuthResult) -> bool {
        match r {
            AuthResult::Success => true,
            AuthResult::Failure { remaining_methods, partial_success } => {
                if partial_success {
                    tracing::info!(session = %self.ctx.session_id, "partial authentication success, continuing");
                }
                self.allowed = Some(remaining_methods);
                false
            }
        }
    }

    fn check_alive(&self) -> Result<()> {
        if self.handle.is_closed() {
            return Err(Error::ConnectionLost("the server closed the connection during authentication".into()));
        }
        Ok(())
    }

    async fn rsa_hash(&mut self) -> Option<HashAlg> {
        if self.rsa_hash.is_none() {
            let best = match tokio::time::timeout(self.timeout, self.handle.best_supported_rsa_hash()).await {
                Ok(Ok(Some(h))) => h,
                _ => Some(HashAlg::Sha256),
            };
            self.rsa_hash = Some(best);
        }
        self.rsa_hash.flatten()
    }

    async fn try_key(&mut self, key: PrivateKey, label: &str) -> Result<bool> {
        let fp = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        if !self.tried_keys.insert(fp.clone()) {
            return Ok(false);
        }
        let hash = if key.algorithm().is_rsa() { self.rsa_hash().await } else { None };
        tracing::debug!(session = %self.ctx.session_id, "trying public key {label} ({fp})");
        self.record("publickey");
        let key = PrivateKeyWithHashAlg::new(Arc::new(key), hash);
        let r = timed(
            self.timeout,
            "public key authentication",
            self.handle.authenticate_publickey(self.user.clone(), key),
        )
        .await?;
        Ok(self.update(r))
    }

    async fn try_agent(&mut self) -> Result<bool> {
        let Some(mut agent) = connect_agent().await else {
            return Ok(false);
        };
        if let Some(binding) = self.handle.agent_session_binding().cloned() {
            let _ = agent.bind_session(&binding, false).await;
        }
        let ids = match tokio::time::timeout(self.timeout, agent.request_identities()).await {
            Ok(Ok(ids)) => ids,
            Ok(Err(e)) => {
                tracing::debug!(session = %self.ctx.session_id, "SSH agent: {e}");
                return Ok(false);
            }
            Err(_) => return Ok(false),
        };
        tracing::debug!(session = %self.ctx.session_id, "SSH agent offers {} identities", ids.len());
        for id in ids {
            if !self.allows(MethodKind::PublicKey) {
                break;
            }
            let public = id.public_key().into_owned();
            let fp = public.fingerprint(HashAlg::Sha256).to_string();
            if !self.tried_keys.insert(fp.clone()) {
                continue;
            }
            let hash = if public.algorithm().is_rsa() { self.rsa_hash().await } else { None };
            self.record("publickey");
            tracing::debug!(session = %self.ctx.session_id, "trying agent key {} ({fp})", id.comment());
            let user = self.user.clone();
            let r = match id {
                AgentIdentity::PublicKey { key, .. } => {
                    tokio::time::timeout(
                        AGENT_TIMEOUT,
                        self.handle.authenticate_publickey_with(user, key, hash, &mut agent),
                    )
                    .await
                }
                AgentIdentity::Certificate { certificate, .. } => {
                    tokio::time::timeout(
                        AGENT_TIMEOUT,
                        self.handle.authenticate_certificate_with(user, certificate, hash, &mut agent),
                    )
                    .await
                }
            };
            match r {
                Ok(Ok(r)) => {
                    if self.update(r) {
                        return Ok(true);
                    }
                }
                Ok(Err(e)) => {
                    tracing::debug!(session = %self.ctx.session_id, "agent authentication failed: {e}");
                    self.check_alive()?;
                }
                Err(_) => return Err(Error::Timeout("SSH agent signature".into())),
            }
        }
        Ok(false)
    }

    /// The key configured for the site, decrypted (asking for the passphrase if needed).
    async fn explicit_key(&mut self, site: &SiteConfig) -> Option<(PrivateKey, String)> {
        let (content, label) = if let Some(k) = site.ssh.private_key.as_ref().filter(|k| !k.trim().is_empty()) {
            (k.clone(), "stored private key".to_string())
        } else {
            let p = site.ssh.private_key_path.as_ref().filter(|p| !p.trim().is_empty())?;
            match tokio::fs::read_to_string(expand_home(p)).await {
                Ok(s) => (s, p.clone()),
                Err(e) => {
                    tracing::warn!(session = %self.ctx.session_id, "cannot read private key {p}: {e}");
                    return None;
                }
            }
        };
        let encrypted = match russh::keys::decode_secret_key(&content, None) {
            Ok(k) => return Some((k, label)),
            Err(e) if looks_encrypted(&content, &e) => true,
            Err(e) => {
                tracing::warn!(session = %self.ctx.session_id, "cannot load private key {label}: {e}");
                false
            }
        };
        if !encrypted {
            return None;
        }
        if let Some(pass) = site.ssh.passphrase.as_deref().filter(|p| !p.is_empty()) {
            match russh::keys::decode_secret_key(&content, Some(pass)) {
                Ok(k) => return Some((k, label)),
                Err(e) => {
                    tracing::warn!(session = %self.ctx.session_id, "stored passphrase for {label} does not work: {e}")
                }
            }
        }
        for _ in 0..3 {
            let r = prompt(self.shared, self.ctx, PromptRequest::Passphrase { key_path: label.clone() }).await;
            let r = r.filter(|r| r.accepted)?;
            match russh::keys::decode_secret_key(&content, Some(r.value(0).unwrap_or_default())) {
                Ok(k) => return Some((k, label)),
                Err(e) => tracing::warn!(session = %self.ctx.session_id, "wrong passphrase for {label}: {e}"),
            }
        }
        None
    }

    async fn try_password(&mut self) -> Result<bool> {
        let password = match self.password.clone() {
            Some(p) => p,
            None => {
                let req = PromptRequest::Password {
                    host: self.host.clone(),
                    username: self.user.clone(),
                    message: String::new(),
                };
                match prompt(self.shared, self.ctx, req).await {
                    Some(r) if r.accepted => {
                        let p = r.value(0).unwrap_or_default().to_string();
                        self.password = Some(p.clone());
                        p
                    }
                    _ => {
                        self.cancelled = true;
                        return Ok(false);
                    }
                }
            }
        };
        self.record("password");
        let r = timed(
            self.timeout,
            "password authentication",
            self.handle.authenticate_password(self.user.clone(), password),
        )
        .await?;
        Ok(self.update(r))
    }

    async fn try_keyboard_interactive(&mut self) -> Result<bool> {
        self.record("keyboard-interactive");
        let what = "keyboard-interactive authentication";
        let mut resp =
            timed(self.timeout, what, self.handle.authenticate_keyboard_interactive_start(self.user.clone(), None))
                .await?;
        let mut password_used = false;
        for _ in 0..20 {
            match resp {
                KeyboardInteractiveAuthResponse::Success => return Ok(true),
                KeyboardInteractiveAuthResponse::Failure { remaining_methods, partial_success } => {
                    return Ok(self.update(AuthResult::Failure { remaining_methods, partial_success }));
                }
                KeyboardInteractiveAuthResponse::InfoRequest { name, instructions, prompts } => {
                    let answers = if prompts.is_empty() {
                        Vec::new()
                    } else if prompts.len() == 1
                        && !prompts[0].echo
                        && prompts[0].prompt.to_ascii_lowercase().contains("password")
                        && !password_used
                        && self.password.is_some()
                    {
                        password_used = true;
                        vec![self.password.clone().unwrap_or_default()]
                    } else {
                        let req = PromptRequest::KeyboardInteractive {
                            host: self.host.clone(),
                            name,
                            instructions,
                            prompts: prompts
                                .iter()
                                .map(|p| KbdPrompt { text: p.prompt.clone(), echo: p.echo })
                                .collect(),
                        };
                        match prompt(self.shared, self.ctx, req).await {
                            Some(r) if r.accepted => {
                                let mut v = r.values;
                                v.resize(prompts.len(), String::new());
                                v
                            }
                            _ => {
                                self.cancelled = true;
                                return Ok(false);
                            }
                        }
                    };
                    resp = timed(self.timeout, what, self.handle.authenticate_keyboard_interactive_respond(answers))
                        .await?;
                }
            }
        }
        Ok(false)
    }
}

fn looks_encrypted(content: &str, e: &russh::keys::Error) -> bool {
    matches!(e, russh::keys::Error::KeyIsEncrypted)
        || content.contains("ENCRYPTED")
        || content.lines().any(|l| l.starts_with("Encryption:") && !l.trim_end().ends_with("none"))
}

fn ssh_dir() -> Option<PathBuf> {
    directories::BaseDirs::new().map(|d| d.home_dir().join(".ssh"))
}

fn expand_home(p: &str) -> PathBuf {
    match p.strip_prefix("~/").or_else(|| p.strip_prefix("~\\")) {
        Some(rest) => directories::BaseDirs::new().map(|d| d.home_dir().join(rest)).unwrap_or_else(|| PathBuf::from(p)),
        None => PathBuf::from(p),
    }
}

/// `~/.ssh/id_*` keys that can be used without asking (unencrypted, or the site passphrase works).
async fn default_keys(passphrase: Option<&str>) -> Vec<(PrivateKey, String)> {
    let Some(dir) = ssh_dir() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for name in DEFAULT_KEYS {
        let path = dir.join(name);
        let Ok(content) = tokio::fs::read_to_string(&path).await else {
            continue;
        };
        let key = match russh::keys::decode_secret_key(&content, None) {
            Ok(k) => Some(k),
            Err(_) => passphrase.and_then(|p| russh::keys::decode_secret_key(&content, Some(p)).ok()),
        };
        if let Some(k) = key {
            out.push((k, path.to_string_lossy().into_owned()));
        }
    }
    out
}

#[cfg(unix)]
async fn connect_agent() -> Option<DynAgent> {
    std::env::var_os("SSH_AUTH_SOCK").filter(|s| !s.is_empty())?;
    match AgentClient::connect_env().await {
        Ok(a) => Some(a.dynamic()),
        Err(e) => {
            tracing::debug!("cannot connect to the SSH agent: {e}");
            None
        }
    }
}

#[cfg(windows)]
async fn connect_agent() -> Option<DynAgent> {
    if let Ok(a) = AgentClient::connect_pageant().await {
        return Some(a.dynamic());
    }
    match AgentClient::connect_named_pipe(r"\\.\pipe\openssh-ssh-agent").await {
        Ok(a) => Some(a.dynamic()),
        Err(e) => {
            tracing::debug!("cannot connect to an SSH agent: {e}");
            None
        }
    }
}

#[cfg(not(any(unix, windows)))]
async fn connect_agent() -> Option<DynAgent> {
    None
}
