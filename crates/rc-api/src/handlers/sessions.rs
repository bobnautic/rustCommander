use std::sync::Arc;

use serde::Deserialize;

use rc_core::prompt::Prompter;
use rc_core::store::SECRET_PLACEHOLDER;
use rc_core::{ConnectContext, Error, Protocol, Result, SessionInfo, SiteConfig};

use crate::prompts::SessionPrompter;
use crate::state::{AppState, Session, SessionSummary, LOCAL_SESSION};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenParams {
    pub site_id: Option<String>,
    pub site: Option<SiteConfig>,
    pub url: Option<String>,
    pub password: Option<String>,
}

/// Fill placeholders of an inline site from the stored copy (connect without saving).
fn merge_stored_secrets(state: &AppState, mut site: SiteConfig) -> Result<SiteConfig> {
    let uses_placeholder = [
        &site.password,
        &site.ssh.private_key,
        &site.ssh.passphrase,
        &site.s3.session_token,
        &site.azure.sas_token,
        &site.gcs.credential_json,
        &site.proxy.password,
    ]
    .iter()
    .any(|f| f.as_deref() == Some(SECRET_PLACEHOLDER));
    let stored = if !site.id.is_empty() && state.sites.exists(&site.id) {
        Some(state.sites.get_decrypted(&site.id)?)
    } else {
        None
    };
    if uses_placeholder {
        let s =
            stored.clone().ok_or_else(|| Error::InvalidInput("saved secrets referenced for an unknown site".into()))?;
        let pick = |v: &mut Option<String>, src: &Option<String>| {
            if v.as_deref() == Some(SECRET_PLACEHOLDER) {
                *v = src.clone();
            }
        };
        pick(&mut site.password, &s.password);
        pick(&mut site.ssh.private_key, &s.ssh.private_key);
        pick(&mut site.ssh.passphrase, &s.ssh.passphrase);
        pick(&mut site.s3.session_token, &s.s3.session_token);
        pick(&mut site.azure.sas_token, &s.azure.sas_token);
        pick(&mut site.gcs.credential_json, &s.gcs.credential_json);
        pick(&mut site.proxy.password, &s.proxy.password);
    }
    if let Some(jid) = site.ssh.jump_site_id.clone().filter(|j| !j.is_empty()) {
        if site.ssh.jump.is_none() {
            site.ssh.jump = Some(Box::new(state.sites.get_decrypted(&jid)?));
        }
    }
    Ok(site)
}

pub async fn open(state: &Arc<AppState>, p: OpenParams) -> Result<SessionSummary> {
    let mut site = if let Some(id) = p.site_id.as_deref().filter(|s| !s.is_empty()) {
        state.sites.get_decrypted(id)?
    } else if let Some(site) = p.site {
        merge_stored_secrets(state, site)?
    } else if let Some(url) = p.url.as_deref() {
        let url = url.trim();
        let url = if url.contains("://") { url.to_string() } else { format!("sftp://{url}") };
        SiteConfig::from_url(&url)
            .map(|(s, _)| s)
            .ok_or_else(|| Error::InvalidInput(format!("cannot parse URL {url}")))?
    } else {
        return Err(Error::InvalidInput("siteId, site or url required".into()));
    };
    if let Some(pw) = p.password.filter(|p| !p.is_empty()) {
        site.password = Some(pw);
    }
    connect_site(state, site).await
}

pub async fn connect_site(state: &Arc<AppState>, site: SiteConfig) -> Result<SessionSummary> {
    connect_site_opts(state, site, false).await
}

/// `shell_fallback`: browse an SFTP site through shell commands when the server cannot run
/// SFTP (see [`rc_core::connect_with_shell_fallback`]).
pub async fn connect_site_opts(
    state: &Arc<AppState>,
    site: SiteConfig,
    shell_fallback: bool,
) -> Result<SessionSummary> {
    connect_as(state, site, shell_fallback, None).await
}

/// Connect; with `reuse_id` the new connection replaces that session under the same id.
async fn connect_as(
    state: &Arc<AppState>,
    mut site: SiteConfig,
    shell_fallback: bool,
    reuse_id: Option<&str>,
) -> Result<SessionSummary> {
    if site.protocol == Protocol::Local {
        return Ok(state.session(LOCAL_SESSION)?.summary.clone());
    }
    let id = reuse_id.map(str::to_string).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let saved_id = Some(site.id.clone()).filter(|i| !i.is_empty() && state.sites.exists(i));
    let st = state.clone();
    let sid = saved_id.clone();
    let prompter: Arc<dyn Prompter> = Arc::new(SessionPrompter {
        broker: state.prompts.clone(),
        on_password: Box::new(move |pw| {
            // "Remember password" in the login prompt of a saved site.
            if let Some(site_id) = &sid {
                if let Ok(mut s) = st.sites.get_decrypted(site_id) {
                    s.password = Some(pw.to_string());
                    s.ssh.jump = None;
                    if let Err(e) = st.sites.save(s) {
                        tracing::warn!("cannot save password: {e}");
                    }
                }
            }
        }),
    });
    let ctx = ConnectContext { prompter, known_hosts: state.known_hosts.clone(), session_id: id.clone() };
    let connected = if shell_fallback {
        rc_core::connect_with_shell_fallback(&site, &ctx).await
    } else {
        rc_core::connect(&site, &ctx).await.map(|vfs| (vfs, site.protocol))
    };
    let (vfs, protocol) = connected.inspect_err(|e| {
        tracing::warn!(session = %id, "connection to {} failed: {e}", site.display_name());
    })?;
    // Reconnects use the protocol that worked.
    site.protocol = protocol;
    // Reconnect transparently when the server drops an idle connection.
    let vfs: Arc<dyn rc_core::Vfs> = Arc::new(rc_core::reconnect::ReconnectingVfs::new(site.clone(), ctx, vfs));
    let home = vfs.home().await.unwrap_or_else(|_| "/".into());
    let initial_dir = if site.remote_dir.trim().is_empty() { home.clone() } else { site.remote_dir.clone() };
    let summary = SessionSummary {
        id: id.clone(),
        name: site.display_name(),
        protocol: site.protocol,
        site_id: saved_id,
        host: site.host.clone(),
        username: site.username.clone(),
        color: site.color.clone(),
        url: site.to_url(None),
        home,
        initial_dir,
        local_dir: site.local_dir.clone(),
        capabilities: vfs.capabilities(),
        connected_at: chrono::Utc::now().timestamp(),
    };
    tracing::info!(session = %id, "connected to {}", site.display_name());
    let replaced = state.sessions.write().insert(id.clone(), Arc::new(Session { summary: summary.clone(), vfs, site }));
    if let Some(old) = replaced {
        stop_bound(state, &id);
        let _ = old.vfs.close().await;
    }
    state.events.emit("session.opened", &summary);
    Ok(summary)
}

pub fn list(state: &AppState) -> Vec<SessionSummary> {
    let mut v: Vec<SessionSummary> = state.sessions.read().values().map(|s| s.summary.clone()).collect();
    v.sort_by_key(|s| (s.id != LOCAL_SESSION, s.connected_at));
    v
}

pub async fn close(state: &AppState, id: &str) -> Result<()> {
    if id == LOCAL_SESSION {
        return Err(Error::InvalidInput("the local session cannot be closed".into()));
    }
    let s = state.sessions.write().remove(id).ok_or_else(|| Error::NotFound(format!("session {id}")))?;
    stop_bound(state, id);
    let _ = s.vfs.close().await;
    tracing::info!(session = %id, "disconnected from {}", s.summary.name);
    state.events.emit("session.closed", serde_json::json!({ "id": id, "reason": null }));
    Ok(())
}

/// Stop the tunnels and terminals that run over a session's connection.
fn stop_bound(state: &AppState, id: &str) {
    state.tunnels.lock().retain(|_, t| t.status().session != id);
    let terms: Vec<String> =
        state.terminals.lock().values().filter(|t| t.session == id).map(|t| t.id.clone()).collect();
    for t in terms {
        if let Some(t) = state.terminals.lock().remove(&t) {
            let _ = t.input.send(rc_core::TerminalInput::Close);
        }
    }
}

/// Reconnect keeps the session id, so panels and tabs that show the session stay attached.
pub async fn reconnect(state: &Arc<AppState>, id: &str) -> Result<SessionSummary> {
    let old = state.session(id)?;
    if id == LOCAL_SESSION {
        return Ok(old.summary.clone());
    }
    let mut site = old.site.clone();
    if let Some(sid) = &old.summary.site_id {
        site.id = sid.clone();
    }
    connect_as(state, site, false, Some(id)).await
}

pub fn info(state: &AppState, id: &str) -> Result<SessionInfo> {
    let s = state.session(id)?;
    let mut info = s.vfs.session_info();
    info.items.insert(0, ("URL".into(), s.summary.url.clone()));
    Ok(info)
}
