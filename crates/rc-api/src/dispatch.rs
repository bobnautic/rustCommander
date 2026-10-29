//! The RPC router: `method` + JSON `params` → JSON result. See `ui/src/api/types.ts`.

use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use rc_core::jobs::Job;
use rc_core::prompt::PromptResponse;
use rc_core::search::SearchParams;
use rc_core::site::SiteConfig;
use rc_core::store::import;
use rc_core::sync::SyncParams;
use rc_core::tunnel::{TunnelKind, TunnelSpec};
use rc_core::{Error, Protocol};

use crate::handlers::{discovery, edit, fs, jobs, misc, sessions, terminal};
use crate::server::ServerStatus;
use crate::settings::Settings;
use crate::state::{AppState, Bookmark, CustomCommand, Origin};

/// Error returned to the UI.
#[derive(Debug, Clone, Serialize)]
pub struct RpcError {
    pub code: String,
    pub message: String,
}

impl RpcError {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        RpcError { code: code.into(), message: message.into() }
    }
}

impl From<Error> for RpcError {
    fn from(e: Error) -> Self {
        let code = serde_json::to_value(e.code())
            .ok()
            .and_then(|v| v.as_str().map(|s| s.to_string()))
            .unwrap_or_else(|| "other".into());
        RpcError { code, message: e.to_string() }
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

type R = Result<Value, RpcError>;

fn parse<T: DeserializeOwned>(params: Value) -> Result<T, RpcError> {
    let params = if params.is_null() { json!({}) } else { params };
    serde_json::from_value(params).map_err(|e| RpcError::new("invalid_input", format!("invalid parameters: {e}")))
}

fn ok<T: Serialize>(v: T) -> R {
    serde_json::to_value(v).map_err(|e| RpcError::new("other", e.to_string()))
}

fn desktop_only(origin: &Origin) -> Result<(), RpcError> {
    if matches!(origin, Origin::Web { .. }) {
        return Err(RpcError::new("forbidden", "not available in the web interface"));
    }
    Ok(())
}

#[derive(Deserialize)]
struct Id {
    id: String,
}

#[derive(Deserialize)]
struct Session {
    session: String,
}

pub async fn dispatch(state: &Arc<AppState>, origin: &Origin, method: &str, params: Value) -> R {
    let st = state;
    match method {
        // ---------------------------------------------------------- app
        "app.info" => ok(misc::app_info(st, origin).await),
        "app.open" => {
            desktop_only(origin)?;
            #[derive(Deserialize)]
            struct P {
                target: String,
            }
            let p: P = parse(params)?;
            let target = if p.target.contains("://") {
                p.target
            } else {
                rc_core::local::to_native(&p.target).display().to_string()
            };
            open::that_detached(&target).map_err(|e| RpcError::new("other", format!("cannot open {target}: {e}")))?;
            ok(Value::Null)
        }

        // ---------------------------------------------------------- settings
        "settings.get" => ok(st.settings.read().clone()),
        "settings.set" => {
            #[derive(Deserialize)]
            struct P {
                settings: Settings,
            }
            let p: P = parse(params)?;
            let (old_disc, old_jobs) = {
                let s = st.settings.read();
                (serde_json::to_value(&s.discovery).ok(), s.max_concurrent_jobs)
            };
            *st.settings.write() = p.settings.clone();
            st.save_settings()?;
            if old_jobs != p.settings.max_concurrent_jobs {
                st.jobs.set_max_concurrent(p.settings.max_concurrent_jobs as usize);
            }
            if old_disc != serde_json::to_value(&p.settings.discovery).ok() {
                st.restart_discovery().await;
            }
            ok(p.settings)
        }

        // ---------------------------------------------------------- vault
        "vault.status" => ok(st.vault.status()),
        "vault.unlock" => {
            #[derive(Deserialize)]
            struct P {
                password: String,
            }
            let p: P = parse(params)?;
            st.vault.unlock(&p.password)?;
            ok(st.vault.status())
        }
        "vault.lock" => {
            st.vault.lock();
            ok(st.vault.status())
        }
        "vault.setMasterPassword" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                current: Option<String>,
                new_password: Option<String>,
            }
            let p: P = parse(params)?;
            let (old, new) = st.vault.change_master(p.current.as_deref(), p.new_password.as_deref())?;
            st.sites.reencrypt(&old, &new)?;
            ok(st.vault.status())
        }

        // ---------------------------------------------------------- sites
        "sites.list" => ok(st.sites.list_masked()),
        "sites.template" => {
            #[derive(Deserialize, Default)]
            struct P {
                protocol: Option<Protocol>,
            }
            let p: P = parse(params).unwrap_or_default();
            let mut s = SiteConfig::default();
            if let Some(pr) = p.protocol {
                s.protocol = pr;
            }
            ok(s)
        }
        "sites.save" => {
            #[derive(Deserialize)]
            struct P {
                site: SiteConfig,
            }
            let p: P = parse(params)?;
            ok(st.sites.save(p.site)?)
        }
        "sites.delete" => {
            let p: Id = parse(params)?;
            st.sites.delete(&p.id)?;
            ok(Value::Null)
        }
        "sites.duplicate" => {
            let p: Id = parse(params)?;
            ok(st.sites.duplicate(&p.id)?)
        }
        "sites.renameFolder" => {
            #[derive(Deserialize)]
            struct P {
                from: String,
                to: String,
            }
            let p: P = parse(params)?;
            st.sites.rename_folder(&p.from, &p.to)?;
            ok(Value::Null)
        }
        "sites.import" => {
            #[derive(Deserialize)]
            struct P {
                format: String,
                content: Option<String>,
            }
            let p: P = parse(params)?;
            let content = p.content.unwrap_or_default();
            let sites = match p.format.as_str() {
                "openssh" if content.trim().is_empty() => import::read_openssh_config()?,
                "openssh" => import::from_openssh_config(&content),
                "winscp" => import::from_winscp_ini(&content),
                "filezilla" => import::from_filezilla_xml(&content)?,
                "json" => import::from_json(&content)?,
                f => return Err(RpcError::new("invalid_input", format!("unknown import format {f}"))),
            };
            let imported = st.sites.import(sites)?;
            ok(json!({ "imported": imported.len(), "sites": imported }))
        }
        "sites.export" => {
            #[derive(Deserialize, Default)]
            struct P {
                ids: Option<Vec<String>>,
            }
            let p: P = parse(params).unwrap_or_default();
            ok(json!({ "content": st.sites.export(p.ids.as_deref())? }))
        }
        "sites.fromUrl" => {
            #[derive(Deserialize)]
            struct P {
                url: String,
            }
            let p: P = parse(params)?;
            let url = if p.url.contains("://") { p.url.clone() } else { format!("sftp://{}", p.url) };
            let (site, _) = SiteConfig::from_url(&url)
                .ok_or_else(|| RpcError::new("invalid_input", format!("cannot parse {url}")))?;
            ok(site)
        }
        "sites.toUrl" => {
            #[derive(Deserialize)]
            struct P {
                site: SiteConfig,
                path: Option<String>,
            }
            let p: P = parse(params)?;
            ok(p.site.to_url(p.path.as_deref()))
        }

        // ---------------------------------------------------------- sessions
        "session.list" => ok(sessions::list(st)),
        "session.open" => ok(sessions::open(st, parse(params)?).await?),
        "session.close" => {
            let p: Id = parse(params)?;
            sessions::close(st, &p.id).await?;
            ok(Value::Null)
        }
        "session.reconnect" => {
            let p: Id = parse(params)?;
            ok(sessions::reconnect(st, &p.id).await?)
        }
        "session.info" => {
            let p: Id = parse(params)?;
            ok(sessions::info(st, &p.id)?)
        }

        // ---------------------------------------------------------- fs
        "fs.list" => ok(fs::list(st, parse(params)?).await?),
        "fs.home" => {
            let p: Session = parse(params)?;
            ok(fs::home(st, &p.session).await?)
        }
        "fs.realpath" => ok(fs::realpath(st, parse(params)?).await?),
        "fs.stat" => ok(fs::stat(st, parse(params)?).await?),
        "fs.mkdir" => ok(fs::mkdir(st, parse(params)?).await?),
        "fs.createFile" => ok(fs::create_file(st, parse(params)?).await?),
        "fs.rename" => ok(fs::rename(st, parse(params)?).await?),
        "fs.delete" => ok(fs::delete(st, parse(params)?)?),
        // Synchronous removal of a single path (used by Rust Commander peers).
        "fs.remove" => {
            #[derive(Deserialize)]
            struct P {
                session: String,
                path: String,
                #[serde(default)]
                recursive: bool,
            }
            let p: P = parse(params)?;
            let vfs = st.vfs(&p.session)?;
            let e = vfs.stat(&p.path).await?;
            if e.kind == rc_core::FileKind::Dir {
                if p.recursive {
                    vfs.remove_dir_all(&p.path).await?;
                } else {
                    vfs.remove_dir(&p.path).await?;
                }
            } else {
                vfs.remove_file(&p.path).await?;
            }
            st.emit_changed(&p.session, &rc_core::path::parent(&p.path));
            ok(Value::Null)
        }
        "fs.setAttributes" => ok(fs::set_attributes(st, parse(params)?).await?),
        "fs.symlink" => ok(fs::symlink(st, parse(params)?).await?),
        "fs.readText" => ok(fs::read_text(st, parse(params)?).await?),
        "fs.writeText" => ok(fs::write_text(st, parse(params)?).await?),
        "fs.readBase64" => ok(fs::read_base64(st, parse(params)?).await?),
        "fs.checksum" => ok(fs::checksum(st, parse(params)?).await?),
        "fs.dirSize" => ok(fs::dir_size(st, parse(params)?).await?),
        "fs.diskInfo" => ok(fs::disk_info(st, parse(params)?).await?),
        "fs.exec" => ok(fs::exec(st, origin, parse(params)?).await?),

        // ---------------------------------------------------------- archives
        "archive.extract" => ok(jobs::archive_extract(st, parse(params)?)?),
        "archive.create" => ok(jobs::archive_create(st, parse(params)?)?),

        // ---------------------------------------------------------- transfers / jobs
        "transfer.defaults" => ok(st.settings.read().transfer.clone()),
        "transfer.start" => ok(jobs::start_transfer(st, parse(params)?)?),
        "jobs.list" => ok(st.jobs.list()),
        "jobs.pause" => {
            let p: Id = parse(params)?;
            st.jobs.pause(&p.id)?;
            ok(Value::Null)
        }
        "jobs.resume" => {
            let p: Id = parse(params)?;
            st.jobs.resume(&p.id)?;
            ok(Value::Null)
        }
        "jobs.cancel" => {
            let p: Id = parse(params)?;
            st.jobs.cancel(&p.id)?;
            ok(Value::Null)
        }
        "jobs.retry" => {
            let p: Id = parse(params)?;
            let j: Job = st.jobs.retry(&p.id)?;
            ok(j)
        }
        "jobs.remove" => {
            let p: Id = parse(params)?;
            st.jobs.remove(&p.id)?;
            ok(Value::Null)
        }
        "jobs.clearFinished" => {
            st.jobs.clear_finished();
            ok(Value::Null)
        }
        "jobs.resolveConflict" => ok(jobs::resolve_conflict(st, parse(params)?)?),

        // ---------------------------------------------------------- sync / watch
        "sync.defaults" => ok(SyncParams::default()),
        "sync.compare" => {
            #[derive(Deserialize)]
            struct P {
                params: SyncParams,
            }
            let p: P = parse(params)?;
            ok(jobs::sync_compare(st, p.params).await?)
        }
        "sync.execute" => ok(jobs::sync_execute(st, parse(params)?)?),
        "sync.discard" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                plan_id: String,
            }
            let p: P = parse(params)?;
            st.sync_plans.lock().remove(&p.plan_id);
            ok(Value::Null)
        }
        "watch.list" => ok(st.watches.lock().values().map(|w| w.status()).collect::<Vec<_>>()),
        "watch.start" => ok(jobs::watch_start(st, parse(params)?).await?),
        "watch.stop" => {
            let p: Id = parse(params)?;
            if let Some(w) = st.watches.lock().remove(&p.id) {
                w.stop();
            }
            ok(Value::Null)
        }

        // ---------------------------------------------------------- search
        "search.start" => {
            #[derive(Deserialize)]
            struct P {
                params: SearchParams,
            }
            let p: P = parse(params)?;
            ok(json!({ "id": jobs::search_start(st, p.params)? }))
        }
        "search.cancel" => {
            let p: Id = parse(params)?;
            if let Some(t) = st.searches.lock().get(&p.id) {
                t.cancel();
            }
            ok(Value::Null)
        }

        // ---------------------------------------------------------- terminal
        "terminal.open" => ok(terminal::open(st, origin, parse(params)?).await?),
        "terminal.list" => ok(terminal::list(st)),
        "terminal.write" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                data: String,
            }
            let p: P = parse(params)?;
            terminal::write(st, &p.id, p.data)?;
            ok(Value::Null)
        }
        "terminal.resize" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                cols: u16,
                rows: u16,
            }
            let p: P = parse(params)?;
            terminal::resize(st, &p.id, p.cols, p.rows)?;
            ok(Value::Null)
        }
        "terminal.close" => {
            let p: Id = parse(params)?;
            terminal::close(st, &p.id)?;
            ok(Value::Null)
        }

        // ---------------------------------------------------------- tunnels
        "tunnel.list" => ok(st.tunnels.lock().values().map(|t| t.status()).collect::<Vec<_>>()),
        "tunnel.start" => {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct P {
                session: String,
                kind: TunnelKind,
                bind_host: String,
                bind_port: u16,
                target_host: Option<String>,
                target_port: Option<u16>,
            }
            let p: P = parse(params)?;
            let vfs = st.vfs(&p.session)?;
            if !vfs.capabilities().tunnels {
                return Err(RpcError::new("unsupported", "this session does not support port forwarding (SSH only)"));
            }
            let t = rc_core::tunnel::start(
                &p.session,
                vfs,
                TunnelSpec {
                    kind: p.kind,
                    bind_host: p.bind_host,
                    bind_port: p.bind_port,
                    target_host: p.target_host,
                    target_port: p.target_port,
                },
            )
            .await?;
            let status = t.status();
            st.events.emit("tunnel.updated", &status);
            st.tunnels.lock().insert(t.id.clone(), t);
            ok(status)
        }
        "tunnel.stop" => {
            let p: Id = parse(params)?;
            if let Some(t) = st.tunnels.lock().remove(&p.id) {
                t.stop();
            }
            ok(Value::Null)
        }

        // ---------------------------------------------------------- bookmarks / commands
        "bookmarks.list" => ok(st.bookmarks.lock().clone()),
        "bookmarks.save" => {
            #[derive(Deserialize)]
            struct P {
                bookmark: Bookmark,
            }
            let p: P = parse(params)?;
            ok(misc::bookmark_save(st, p.bookmark)?)
        }
        "bookmarks.delete" => {
            let p: Id = parse(params)?;
            misc::bookmark_delete(st, &p.id)?;
            ok(Value::Null)
        }
        "commands.list" => ok(st.commands.lock().clone()),
        "commands.save" => {
            #[derive(Deserialize)]
            struct P {
                command: CustomCommand,
            }
            let p: P = parse(params)?;
            ok(misc::command_save(st, p.command)?)
        }
        "commands.delete" => {
            let p: Id = parse(params)?;
            misc::command_delete(st, &p.id)?;
            ok(Value::Null)
        }
        "commands.run" => ok(misc::command_run(st, origin, parse(params)?).await?),

        // ---------------------------------------------------------- external editing
        "edit.external" => {
            desktop_only(origin)?;
            #[derive(Deserialize)]
            struct P {
                session: String,
                path: String,
            }
            let p: P = parse(params)?;
            ok(edit::external(st, &p.session, &p.path).await?)
        }
        "edit.list" => ok(edit::list(st)),
        "edit.stop" => {
            let p: Id = parse(params)?;
            edit::stop(st, &p.id)?;
            ok(Value::Null)
        }

        // ---------------------------------------------------------- known hosts
        "knownHosts.list" => ok(st.known_hosts.list()),
        "knownHosts.remove" => {
            #[derive(Deserialize)]
            struct P {
                key: String,
                fingerprint: Option<String>,
            }
            let p: P = parse(params)?;
            st.known_hosts.remove(&p.key, p.fingerprint.as_deref())?;
            ok(Value::Null)
        }

        // ---------------------------------------------------------- prompts / log
        "prompt.pending" => ok(st.prompts.pending()),
        "prompt.respond" => {
            #[derive(Deserialize)]
            struct P {
                id: String,
                response: Option<PromptResponse>,
            }
            let p: P = parse(params)?;
            st.prompts.respond(&p.id, p.response);
            ok(Value::Null)
        }
        "log.recent" => ok(crate::logs::recent()),

        // ---------------------------------------------------------- discovery
        "discovery.status" => ok(discovery::status(st)),
        "discovery.peers" => ok(discovery::peers(st)),
        "discovery.refresh" => {
            if let Some(d) = st.discovery.lock().as_ref() {
                d.refresh();
            }
            ok(Value::Null)
        }
        "discovery.add" => {
            #[derive(Deserialize)]
            struct P {
                address: String,
            }
            let p: P = parse(params)?;
            ok(discovery::add(st, &p.address).await?)
        }
        "discovery.remove" => {
            let p: Id = parse(params)?;
            discovery::remove(st, &p.id)?;
            ok(Value::Null)
        }

        // ---------------------------------------------------------- web server
        "server.status" => ok(server_status(st)),
        "server.start" => {
            desktop_only(origin)?;
            #[derive(Deserialize, Default)]
            struct P {
                bind: Option<String>,
                port: Option<u16>,
                tls: Option<bool>,
            }
            let p: P = parse(params).unwrap_or_default();
            ok(start_server(st, p.bind, p.port, p.tls).await?)
        }
        "server.stop" => {
            desktop_only(origin)?;
            let ctl = st.server.read().clone();
            if let Some(ctl) = ctl {
                ctl.stop().await?;
            }
            st.reannounce();
            let s = server_status(st);
            st.events.emit("server.status", &s);
            ok(s)
        }
        "server.setPassword" => {
            desktop_only(origin)?;
            #[derive(Deserialize)]
            struct P {
                password: String,
            }
            let p: P = parse(params)?;
            st.server_auth.set_password(&p.password)?;
            let s = server_status(st);
            st.events.emit("server.status", &s);
            ok(s)
        }

        _ => Err(RpcError::new("unknown_method", format!("unknown method {method}"))),
    }
}

pub fn server_status(st: &AppState) -> ServerStatus {
    let ctl = st.server.read().clone();
    let running = ctl.as_ref().and_then(|c| c.running());
    let settings = st.settings.read().server.clone();
    let mut s = ServerStatus {
        running: running.is_some(),
        bind: running.as_ref().map(|r| r.bind.clone()).unwrap_or(settings.bind),
        port: running.as_ref().map(|r| r.port).unwrap_or(settings.port),
        tls: running.as_ref().map(|r| r.tls).unwrap_or(settings.tls),
        fingerprint: running.as_ref().and_then(|r| r.fingerprint.clone()),
        urls: vec![],
        has_password: st.server_auth.has_password(),
        clients: ctl.as_ref().map(|c| c.clients()).unwrap_or(0),
        error: st.server_error.lock().clone(),
    };
    if let Some(r) = running {
        let scheme = if r.tls { "https" } else { "http" };
        let mut hosts: Vec<String> = Vec::new();
        if r.bind == "0.0.0.0" || r.bind == "::" {
            if let Some(d) = st.discovery.lock().as_ref() {
                if let Some(me) = d.peers().into_iter().find(|p| p.is_self) {
                    hosts.extend(me.addresses);
                }
            }
            hosts.push(crate::state::hostname());
            hosts.push("127.0.0.1".into());
        } else {
            hosts.push(r.bind.clone());
        }
        hosts.dedup();
        s.urls = hosts.into_iter().map(|h| format!("{scheme}://{h}:{}/", r.port)).collect();
    }
    s
}

pub async fn start_server(
    st: &Arc<AppState>,
    bind: Option<String>,
    port: Option<u16>,
    tls: Option<bool>,
) -> Result<ServerStatus, RpcError> {
    let ctl = st
        .server
        .read()
        .clone()
        .ok_or_else(|| RpcError::new("unsupported", "web server not available in this build"))?;
    if !st.server_auth.has_password() && !st.server_auth.is_disabled() {
        return Err(RpcError::new("invalid_input", "set a password for web access first"));
    }
    let (bind, port, tls) = {
        let mut s = st.settings.write();
        if let Some(b) = bind {
            s.server.bind = b;
        }
        if let Some(p) = port {
            s.server.port = p;
        }
        if let Some(t) = tls {
            s.server.tls = t;
        }
        (s.server.bind.clone(), s.server.port, s.server.tls)
    };
    st.save_settings()?;
    if ctl.running().is_some() {
        ctl.stop().await?;
    }
    *st.server_error.lock() = None;
    if let Err(e) = ctl.start(st.clone(), bind, port, tls).await {
        *st.server_error.lock() = Some(e.to_string());
        let s = server_status(st);
        st.events.emit("server.status", &s);
        return Err(e.into());
    }
    st.reannounce();
    let s = server_status(st);
    st.events.emit("server.status", &s);
    Ok(s)
}

/// Translate a core error code into an HTTP status (web server).
pub fn http_status(code: &str) -> u16 {
    match code {
        "not_found" => 404,
        "permission_denied" | "forbidden" => 403,
        "unauthorized" => 401,
        "invalid_input"
        | "unknown_method"
        | "already_exists"
        | "not_a_directory"
        | "is_a_directory"
        | "directory_not_empty" => 400,
        "unsupported" => 501,
        "locked" => 423,
        _ => 500,
    }
}
