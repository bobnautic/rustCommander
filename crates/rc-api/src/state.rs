//! Shared application state behind the RPC API.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use rc_core::jobs::{JobEvent, JobQueue, JobState};
use rc_core::store::{self, load_json, save_json, SiteStore, Vault};
use rc_core::sync::SyncPlan;
use rc_core::tunnel::Tunnel;
use rc_core::watch::DirWatch;
use rc_core::{Capabilities, Error, KnownHosts, LocalVfs, Protocol, Result, SiteConfig, Vfs};
use rc_discovery::{Discovery, DiscoveryConfig, InstanceInfo, WebInfo};

use crate::events::EventBus;
use crate::prompts::PromptBroker;
use crate::server::{ServerAuth, ServerControl};
use crate::settings::Settings;

/// How this process presents itself.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AppMode {
    /// Tauri desktop app (may additionally expose a web server).
    Desktop,
    /// Headless server (`rcmd serve`), only reachable through the web UI.
    Web,
}

/// Where an RPC call comes from.
#[derive(Debug, Clone)]
pub enum Origin {
    Desktop,
    Web { remote: Option<String> },
    /// In-process callers (CLI scripting, tests).
    Internal,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub name: String,
    pub protocol: Protocol,
    pub site_id: Option<String>,
    pub host: String,
    pub username: String,
    pub color: Option<String>,
    pub url: String,
    pub home: String,
    pub initial_dir: String,
    pub local_dir: String,
    pub capabilities: Capabilities,
    pub connected_at: i64,
}

pub struct Session {
    pub summary: SessionSummary,
    pub vfs: Arc<dyn Vfs>,
    /// Decrypted settings (for reconnect).
    pub site: SiteConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bookmark {
    pub id: String,
    pub name: String,
    pub scope: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CustomCommand {
    pub id: String,
    pub name: String,
    pub command: String,
    pub per_file: bool,
    pub target: String,
    pub show_output: bool,
    pub refresh: bool,
}

impl Default for CustomCommand {
    fn default() -> Self {
        CustomCommand {
            id: String::new(),
            name: String::new(),
            command: String::new(),
            per_file: true,
            target: "session".into(),
            show_output: true,
            refresh: true,
        }
    }
}

pub struct TerminalEntry {
    pub id: String,
    pub session: String,
    pub title: String,
    pub input: tokio::sync::mpsc::UnboundedSender<rc_core::TerminalInput>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditStatus {
    pub id: String,
    pub session: String,
    pub remote_path: String,
    pub local_path: String,
    pub uploads: u64,
    pub last_error: Option<String>,
}

pub struct EditEntry {
    pub status: Arc<Mutex<EditStatus>>,
    pub stop: CancellationToken,
    pub _watcher: Option<notify::RecommendedWatcher>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct InstanceFile {
    id: String,
}

pub struct InitOptions {
    pub mode: AppMode,
    pub config_dir: Option<PathBuf>,
}

pub struct AppState {
    pub mode: AppMode,
    pub config_dir: PathBuf,
    pub instance_id: String,
    pub events: EventBus,
    pub prompts: Arc<PromptBroker>,
    pub known_hosts: Arc<KnownHosts>,
    pub vault: Arc<Vault>,
    pub sites: SiteStore,
    pub settings: RwLock<Settings>,
    pub jobs: JobQueue,
    pub sessions: RwLock<HashMap<String, Arc<Session>>>,
    pub sync_plans: Mutex<HashMap<String, SyncPlan>>,
    pub watches: Mutex<HashMap<String, DirWatch>>,
    pub searches: Mutex<HashMap<String, CancellationToken>>,
    pub terminals: Mutex<HashMap<String, TerminalEntry>>,
    pub tunnels: Mutex<HashMap<String, Tunnel>>,
    pub edits: Mutex<HashMap<String, EditEntry>>,
    pub bookmarks: Mutex<Vec<Bookmark>>,
    pub commands: Mutex<Vec<CustomCommand>>,
    pub discovery: Mutex<Option<Discovery>>,
    pub discovery_error: Mutex<Option<String>>,
    pub server: RwLock<Option<Arc<dyn ServerControl>>>,
    pub server_auth: ServerAuth,
    pub server_error: Mutex<Option<String>>,
    /// Cancelled on shutdown; background loops stop.
    pub shutdown: CancellationToken,
}

pub const LOCAL_SESSION: &str = "local";

pub fn hostname() -> String {
    gethostname::gethostname().to_string_lossy().into_owned()
}

pub fn username() -> String {
    std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_default()
}

impl AppState {
    pub async fn new(opts: InitOptions) -> Result<Arc<AppState>> {
        rc_core::init_tls();
        let config_dir = opts.config_dir.unwrap_or_else(store::config_dir);
        std::fs::create_dir_all(&config_dir).map_err(|e| Error::io_at(e, &config_dir.display().to_string()))?;
        let events = EventBus::new();
        let settings: Settings = load_json(&config_dir.join("settings.json")).unwrap_or_default();
        let vault = Arc::new(Vault::open(config_dir.clone())?);
        let sites = SiteStore::load(config_dir.join("sites.json"), vault.clone());
        let known_hosts = Arc::new(KnownHosts::load(config_dir.join("known_hosts.json")));
        let instance_id = match load_json::<InstanceFile>(&config_dir.join("instance.json")) {
            Ok(f) if !f.id.is_empty() => f.id,
            _ => {
                let id = uuid::Uuid::new_v4().to_string();
                save_json(&config_dir.join("instance.json"), &InstanceFile { id: id.clone() })?;
                id
            }
        };
        let bookmarks: Vec<Bookmark> = load_json(&config_dir.join("bookmarks.json")).unwrap_or_default();
        let commands: Vec<CustomCommand> = load_json(&config_dir.join("commands.json")).unwrap_or_else(|_| default_commands());

        let ev = events.clone();
        let notified: Mutex<HashSet<String>> = Mutex::new(HashSet::new());
        let jobs = JobQueue::new(
            settings.max_concurrent_jobs as usize,
            Arc::new(move |e| match e {
                JobEvent::Updated(job) => {
                    if job.state.is_finished() && notified.lock().insert(job.id.clone()) {
                        if let (Some(s), Some(d)) = (&job.dst_session, &job.dst_dir) {
                            ev.emit("fs.changed", serde_json::json!({ "session": s, "path": d }));
                        }
                        if let Some(s) = &job.src_session {
                            let mut parents: Vec<String> = job.src_paths.iter().map(|p| rc_core::path::parent(p)).collect();
                            parents.dedup();
                            for p in parents {
                                ev.emit("fs.changed", serde_json::json!({ "session": s, "path": p }));
                            }
                        }
                    } else if !job.state.is_finished() && job.state != JobState::Queued {
                        notified.lock().remove(&job.id);
                    }
                    ev.emit("job.updated", job);
                }
                JobEvent::Removed(id) => ev.emit("job.removed", serde_json::json!({ "id": id })),
            }),
        );

        let state = Arc::new(AppState {
            mode: opts.mode,
            config_dir: config_dir.clone(),
            instance_id,
            prompts: PromptBroker::new(events.clone()),
            events,
            known_hosts,
            vault,
            sites,
            settings: RwLock::new(settings),
            jobs,
            sessions: RwLock::new(HashMap::new()),
            sync_plans: Mutex::new(HashMap::new()),
            watches: Mutex::new(HashMap::new()),
            searches: Mutex::new(HashMap::new()),
            terminals: Mutex::new(HashMap::new()),
            tunnels: Mutex::new(HashMap::new()),
            edits: Mutex::new(HashMap::new()),
            bookmarks: Mutex::new(bookmarks),
            commands: Mutex::new(commands),
            discovery: Mutex::new(None),
            discovery_error: Mutex::new(None),
            server: RwLock::new(None),
            server_auth: ServerAuth::load(Some(config_dir.join("server.json"))),
            server_error: Mutex::new(None),
            shutdown: CancellationToken::new(),
        });
        state.add_local_session().await;
        state.forward_logs();
        Ok(state)
    }

    async fn add_local_session(&self) {
        let vfs: Arc<dyn Vfs> = Arc::new(LocalVfs::new());
        let home = vfs.home().await.unwrap_or_else(|_| "/".into());
        let site = SiteConfig { protocol: Protocol::Local, name: "Local".into(), ..Default::default() };
        let summary = SessionSummary {
            id: LOCAL_SESSION.into(),
            name: if self.mode == AppMode::Web { format!("{} (server)", hostname()) } else { "Local".into() },
            protocol: Protocol::Local,
            site_id: None,
            host: hostname(),
            username: username(),
            color: None,
            url: format!("file://{home}"),
            home: home.clone(),
            initial_dir: home,
            local_dir: String::new(),
            capabilities: vfs.capabilities(),
            connected_at: chrono::Utc::now().timestamp(),
        };
        self.sessions.write().insert(LOCAL_SESSION.into(), Arc::new(Session { summary, vfs, site }));
    }

    fn forward_logs(&self) {
        let mut rx = crate::logs::subscribe();
        let ev = self.events.clone();
        let stop = self.shutdown.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = stop.cancelled() => break,
                    r = rx.recv() => match r {
                        Ok(entry) => ev.emit("log", entry),
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    }
                }
            }
        });
    }

    /// Start background services (discovery, auto-started web server, peer probing).
    pub async fn start_background(self: &Arc<Self>) {
        self.restart_discovery().await;
        let st = self.clone();
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(Duration::from_secs(30));
            loop {
                tokio::select! {
                    _ = st.shutdown.cancelled() => break,
                    _ = iv.tick() => crate::handlers::discovery::probe_manual_peers(&st).await,
                }
            }
        });
    }

    pub fn session(&self, id: &str) -> Result<Arc<Session>> {
        self.sessions.read().get(id).cloned().ok_or_else(|| Error::NotFound(format!("session {id} (not connected)")))
    }

    pub fn vfs(&self, id: &str) -> Result<Arc<dyn Vfs>> {
        Ok(self.session(id)?.vfs.clone())
    }

    pub fn save_settings(&self) -> Result<()> {
        save_json(&self.config_dir.join("settings.json"), &*self.settings.read())
    }

    pub fn save_bookmarks(&self) -> Result<()> {
        save_json(&self.config_dir.join("bookmarks.json"), &*self.bookmarks.lock())
    }

    pub fn save_commands(&self) -> Result<()> {
        save_json(&self.config_dir.join("commands.json"), &*self.commands.lock())
    }

    pub fn instance_name(&self) -> String {
        let n = self.settings.read().discovery.instance_name.clone();
        if n.trim().is_empty() {
            hostname()
        } else {
            n
        }
    }

    pub fn instance_info(&self) -> InstanceInfo {
        let web = self.server.read().as_ref().and_then(|s| s.running()).map(|r| WebInfo {
            port: r.port,
            tls: r.tls,
            fingerprint: r.fingerprint,
        });
        InstanceInfo {
            id: self.instance_id.clone(),
            name: self.instance_name(),
            hostname: hostname(),
            version: rc_core::VERSION.into(),
            os: std::env::consts::OS.into(),
            user: Some(username()).filter(|u| !u.is_empty()),
            web,
        }
    }

    /// (Re)start or stop LAN discovery according to the settings.
    pub async fn restart_discovery(self: &Arc<Self>) {
        let cfg = self.settings.read().discovery.clone();
        let old = self.discovery.lock().take();
        if let Some(d) = old {
            d.stop();
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        *self.discovery_error.lock() = None;
        if !cfg.enabled {
            self.events.emit("discovery.peers", Vec::<rc_discovery::Peer>::new());
            return;
        }
        let ev = self.events.clone();
        let config = DiscoveryConfig {
            port: cfg.port,
            interval: Duration::from_secs(cfg.interval_secs.clamp(1, 300)),
            announce: true,
        };
        match Discovery::start(config, self.instance_info(), Arc::new(move |peers| ev.emit("discovery.peers", peers))).await {
            Ok(d) => {
                *self.discovery.lock() = Some(d);
            }
            Err(e) => {
                tracing::warn!("LAN discovery unavailable: {e}");
                *self.discovery_error.lock() = Some(e.to_string());
            }
        }
    }

    /// Announce changed instance info (e.g. web server started/stopped).
    pub fn reannounce(&self) {
        if let Some(d) = self.discovery.lock().as_ref() {
            d.set_info(self.instance_info());
        }
    }

    pub fn emit_changed(&self, session: &str, path: &str) {
        self.events.emit("fs.changed", serde_json::json!({ "session": session, "path": path }));
    }

    pub async fn shutdown(&self) {
        self.shutdown.cancel();
        self.prompts.cancel_all();
        if let Some(d) = self.discovery.lock().take() {
            d.stop();
        }
        let server = self.server.read().clone();
        if let Some(s) = server {
            let _ = s.stop().await;
        }
        let sessions: Vec<Arc<Session>> = self.sessions.write().drain().map(|(_, s)| s).collect();
        for s in sessions {
            let _ = s.vfs.close().await;
        }
    }
}

fn default_commands() -> Vec<CustomCommand> {
    vec![
        CustomCommand {
            id: "builtin-tail".into(),
            name: "Tail (last 200 lines)".into(),
            command: "tail -n 200 \"!\"".into(),
            ..Default::default()
        },
        CustomCommand {
            id: "builtin-du".into(),
            name: "Disk usage".into(),
            command: "du -sh !&".into(),
            per_file: false,
            ..Default::default()
        },
        CustomCommand {
            id: "builtin-sha256".into(),
            name: "SHA-256 checksums".into(),
            command: "sha256sum !&".into(),
            per_file: false,
            ..Default::default()
        },
        CustomCommand {
            id: "builtin-untar".into(),
            name: "Extract archive here".into(),
            command: "tar -xf \"!\"".into(),
            refresh: true,
            show_output: false,
            ..Default::default()
        },
    ]
}
