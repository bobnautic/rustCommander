//! Jobs and sessions that survive a restart (or a crash).
//!
//! * `jobs.json`: every unfinished job with what it does ([`JobDescriptor`]) and its
//!   journal (finished items, partially written files). On start the jobs come back with
//!   their ids: finished items are skipped, partial files are resumed.
//! * `sessions.json`: the open connections (saved site or the site settings without
//!   secrets). On start they are connected again under their old ids, so panels, tabs and
//!   restored jobs find them.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use rc_core::jobs::{JobCtx, JobJournal, JobKind, JobSpec, JobState, JobTask, SubmitOptions};
use rc_core::store::{load_json, save_json, sites::without_secrets};
use rc_core::sync::{SyncAction, SyncParams, SyncTask};
use rc_core::transfer::{DeleteTask, Endpoint, TransferOptions, TransferTask};
use rc_core::{Error, Protocol, Result, SiteConfig, Vfs};

use crate::state::{AppState, LOCAL_SESSION};

/// What a job does, in a form that can be stored and run again after a restart.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum JobDescriptor {
    #[serde(rename_all = "camelCase")]
    Transfer {
        src_session: String,
        src_paths: Vec<String>,
        dst_session: String,
        dst_dir: String,
        options: TransferOptions,
    },
    #[serde(rename_all = "camelCase")]
    Delete { session: String, paths: Vec<String>, trash: bool },
    #[serde(rename_all = "camelCase")]
    Sync { params: SyncParams, actions: Vec<SyncAction>, options: TransferOptions },
}

impl JobDescriptor {
    fn sessions(&self) -> Vec<&str> {
        match self {
            JobDescriptor::Transfer { src_session, dst_session, .. } => vec![src_session, dst_session],
            JobDescriptor::Delete { session, .. } => vec![session],
            JobDescriptor::Sync { params, .. } => vec![&params.left_session, &params.right_session],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedJob {
    id: String,
    kind: JobKind,
    spec: JobSpec,
    speed_limit: u64,
    state: JobState,
    created_at: i64,
    task: JobDescriptor,
    #[serde(default)]
    journal: JobJournal,
}

/// An open connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedSession {
    pub id: String,
    pub name: String,
    /// A saved site (its secrets come from the site store) ...
    #[serde(default)]
    pub site_id: Option<String>,
    /// ... or the settings of an ad-hoc connection, without secrets.
    #[serde(default)]
    pub site: Option<SiteConfig>,
    /// The protocol that worked (SFTP sites browsed through shell commands run as SCP).
    pub protocol: Protocol,
    pub connected_at: i64,
}

pub struct Persistence {
    jobs_file: PathBuf,
    sessions_file: PathBuf,
    descriptors: Mutex<HashMap<String, JobDescriptor>>,
    sessions: Mutex<Vec<SavedSession>>,
    /// Set on shutdown: closing the connections makes running jobs fail, which must not
    /// be saved (they are to continue after the restart).
    frozen: AtomicBool,
    saved_generation: AtomicU64,
    /// One connection attempt per session id at a time.
    connecting: tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Persistence {
    pub fn new(config_dir: &std::path::Path) -> Self {
        let sessions_file = config_dir.join("sessions.json");
        Persistence {
            jobs_file: config_dir.join("jobs.json"),
            sessions: Mutex::new(load_json(&sessions_file).unwrap_or_default()),
            sessions_file,
            descriptors: Mutex::new(HashMap::new()),
            frozen: AtomicBool::new(false),
            saved_generation: AtomicU64::new(u64::MAX),
            connecting: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Remember what a job does, so that it can continue after a restart.
    pub fn register(&self, job_id: &str, desc: JobDescriptor) {
        self.descriptors.lock().insert(job_id.to_string(), desc);
    }

    /// A job was retried under a new id.
    pub fn renamed(&self, old: &str, new: &str) {
        let mut d = self.descriptors.lock();
        if let Some(desc) = d.remove(old) {
            d.insert(new.to_string(), desc);
        }
    }

    pub fn saved_sessions(&self) -> Vec<SavedSession> {
        self.sessions.lock().clone()
    }

    fn saved_session(&self, id: &str) -> Option<SavedSession> {
        self.sessions.lock().iter().find(|s| s.id == id).cloned()
    }

    fn save_sessions(&self) {
        let list = self.sessions.lock().clone();
        if let Err(e) = save_json(&self.sessions_file, &list) {
            tracing::warn!("cannot save the open sessions: {e}");
        }
    }

    /// A connection was opened (or reconnected under the same id).
    pub fn session_opened(&self, id: &str, name: &str, site_id: Option<&str>, site: &SiteConfig) {
        if self.frozen.load(Ordering::SeqCst) {
            return;
        }
        let rec = SavedSession {
            id: id.to_string(),
            name: name.to_string(),
            site_id: site_id.map(str::to_string),
            site: if site_id.is_some() { None } else { Some(without_secrets(site.clone())) },
            protocol: site.protocol,
            connected_at: chrono::Utc::now().timestamp(),
        };
        {
            let mut s = self.sessions.lock();
            s.retain(|x| x.id != id);
            s.push(rec);
        }
        self.save_sessions();
    }

    /// The user closed a connection: it is not opened again on the next start.
    pub fn session_closed(&self, id: &str) {
        let removed = {
            let mut s = self.sessions.lock();
            let before = s.len();
            s.retain(|x| x.id != id);
            before != s.len()
        };
        if removed {
            self.save_sessions();
        }
    }

    /// Write `jobs.json` with every unfinished job that can be restored.
    pub fn save_jobs(&self, state: &AppState) {
        let generation = state.jobs.generation();
        let jobs = state.jobs.list();
        let saved: Vec<SavedJob> = {
            let mut descs = self.descriptors.lock();
            // Forget jobs that were removed from the queue.
            descs.retain(|id, _| jobs.iter().any(|j| &j.id == id));
            jobs.iter()
                .filter(|j| !j.state.is_finished())
                .filter_map(|j| {
                    let task = descs.get(&j.id)?.clone();
                    let (kind, spec, speed_limit) = state.jobs.spec(&j.id)?;
                    Some(SavedJob {
                        id: j.id.clone(),
                        kind,
                        spec,
                        speed_limit,
                        state: j.state,
                        created_at: j.created_at,
                        task,
                        journal: state.jobs.journal(&j.id).unwrap_or_default(),
                    })
                })
                .collect()
        };
        match save_json(&self.jobs_file, &saved) {
            Ok(()) => self.saved_generation.store(generation, Ordering::Relaxed),
            Err(e) => tracing::warn!("cannot save the job queue: {e}"),
        }
    }

    /// Save once more and stop saving (shutdown).
    pub fn freeze(&self, state: &AppState) {
        if !self.frozen.swap(true, Ordering::SeqCst) {
            self.save_jobs(state);
        }
    }

    async fn connect_lock(&self, id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.connecting.lock().await.entry(id.to_string()).or_default().clone()
    }
}

/// Save the queue whenever it changed (at most every few seconds; large journals less often).
pub fn spawn_saver(state: &Arc<AppState>) {
    let st = Arc::downgrade(state);
    let stop = state.shutdown.clone();
    tokio::spawn(async move {
        let mut iv = tokio::time::interval(Duration::from_secs(2));
        let mut last = Instant::now() - Duration::from_secs(60);
        loop {
            tokio::select! {
                _ = stop.cancelled() => break,
                _ = iv.tick() => {}
            }
            let Some(st) = st.upgrade() else { break };
            let p = &st.persist;
            if p.frozen.load(Ordering::SeqCst) || p.saved_generation.load(Ordering::Relaxed) == st.jobs.generation() {
                continue;
            }
            let big = std::fs::metadata(&p.jobs_file).map(|m| m.len() > 1_000_000).unwrap_or(false);
            if big && last.elapsed() < Duration::from_secs(15) {
                continue;
            }
            last = Instant::now();
            let st2 = st.clone();
            let _ = tokio::task::spawn_blocking(move || st2.persist.save_jobs(&st2)).await;
        }
    });
}

/// The file system of a session: connected now, or connected again under its old id from
/// the saved sessions.
pub async fn ensure_session(state: &Arc<AppState>, id: &str) -> Result<Arc<dyn Vfs>> {
    if let Ok(v) = state.vfs(id) {
        return Ok(v);
    }
    let lock = state.persist.connect_lock(id).await;
    let _guard = lock.lock().await;
    if let Ok(v) = state.vfs(id) {
        return Ok(v);
    }
    let rec = state
        .persist
        .saved_session(id)
        .ok_or_else(|| Error::NotFound(format!("session {id} (the connection was closed)")))?;
    let mut site = match (&rec.site_id, &rec.site) {
        (Some(site_id), _) => state.sites.get_decrypted(site_id)?,
        (None, Some(site)) => site.clone(),
        (None, None) => return Err(Error::NotFound(format!("settings of session {id}"))),
    };
    if let Some(site_id) = &rec.site_id {
        site.id = site_id.clone();
    }
    site.protocol = rec.protocol;
    tracing::info!(session = %id, "connecting to {} again", rec.name);
    crate::handlers::sessions::connect_as(state, site, false, Some(id)).await?;
    state.vfs(id)
}

/// Connect the sessions that were open when the application stopped.
pub fn restore_sessions(state: &Arc<AppState>) {
    for rec in state.persist.saved_sessions() {
        if state.vfs(&rec.id).is_ok() {
            continue;
        }
        let st = state.clone();
        tokio::spawn(async move {
            if let Err(e) = ensure_session(&st, &rec.id).await {
                tracing::warn!(session = %rec.id, "cannot reconnect to {}: {e}", rec.name);
                // Temporary problems (server down, network, locked vault) are tried again on
                // the next start; a deleted site, rejected credentials or a cancelled prompt
                // are not.
                let temporary =
                    e.is_connection_error() || matches!(e, Error::Locked | Error::Timeout(_) | Error::Io(_));
                if !temporary {
                    st.persist.session_closed(&rec.id);
                }
            }
        });
    }
}

/// A job restored from `jobs.json`: connects its sessions, then runs the real task.
struct RestoredTask {
    state: Weak<AppState>,
    desc: JobDescriptor,
}

impl RestoredTask {
    async fn endpoint(&self, st: &Arc<AppState>, ctx: &JobCtx, id: &str) -> Result<Endpoint> {
        loop {
            ctx.check().await?;
            match ensure_session(st, id).await {
                Ok(vfs) => return Ok(Endpoint::new(id, vfs)),
                // The saved password is in the locked vault: wait for the user to unlock it.
                Err(Error::Locked) => {
                    ctx.set_current(Some("waiting for the vault to be unlocked"));
                    let token = ctx.cancel_token();
                    tokio::select! {
                        _ = tokio::time::sleep(Duration::from_secs(2)) => {}
                        _ = token.cancelled() => return Err(Error::Cancelled),
                    }
                }
                Err(e) => return Err(e),
            }
        }
    }
}

#[async_trait]
impl JobTask for RestoredTask {
    async fn run(&self, ctx: &JobCtx) -> Result<()> {
        let st = self.state.upgrade().ok_or(Error::Cancelled)?;
        ctx.set_current(Some("connecting"));
        match &self.desc {
            JobDescriptor::Transfer { src_session, src_paths, dst_session, dst_dir, options } => {
                let src = self.endpoint(&st, ctx, src_session).await?;
                let dst = self.endpoint(&st, ctx, dst_session).await?;
                ctx.set_current(None);
                let t = TransferTask {
                    src,
                    src_paths: src_paths.clone(),
                    dst,
                    dst_dir: dst_dir.clone(),
                    options: options.clone(),
                };
                t.run(ctx).await
            }
            JobDescriptor::Delete { session, paths, trash } => {
                let target = self.endpoint(&st, ctx, session).await?;
                ctx.set_current(None);
                let mut t = DeleteTask::new(target, paths.clone());
                t.trash = *trash;
                t.run(ctx).await
            }
            JobDescriptor::Sync { params, actions, options } => {
                let left = self.endpoint(&st, ctx, &params.left_session).await?;
                let right = self.endpoint(&st, ctx, &params.right_session).await?;
                ctx.set_current(None);
                let t = SyncTask {
                    left,
                    right,
                    params: params.clone(),
                    actions: actions.clone(),
                    options: options.clone(),
                };
                t.run(ctx).await
            }
        }
    }
}

/// Put the jobs of `jobs.json` back into the queue. Jobs that were running or waiting
/// continue when `resume` is set; paused ones stay paused.
pub fn restore_jobs(state: &Arc<AppState>, resume: bool) -> usize {
    let saved: Vec<SavedJob> = load_json(&state.persist.jobs_file).unwrap_or_default();
    let mut n = 0;
    for j in saved {
        if j.state.is_finished() || state.jobs.get(&j.id).is_ok() {
            continue;
        }
        if j.task.sessions().iter().any(|s| *s != LOCAL_SESSION && state.persist.saved_session(s).is_none()) {
            tracing::warn!(job = %j.id, "not restoring {}: its connection was closed", j.spec.title);
            continue;
        }
        let paused = j.state == JobState::Paused || !resume;
        let task = Arc::new(RestoredTask { state: Arc::downgrade(state), desc: j.task.clone() });
        state.jobs.submit_with(
            j.kind,
            j.spec.clone(),
            task,
            j.speed_limit,
            SubmitOptions { id: Some(j.id.clone()), created_at: Some(j.created_at), paused, journal: Some(j.journal) },
        );
        state.persist.register(&j.id, j.task);
        tracing::info!(job = %j.id, "restored {}", j.spec.title);
        n += 1;
    }
    n
}
