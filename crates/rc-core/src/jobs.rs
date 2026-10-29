//! Background job queue (transfers, deletions, synchronizations) with pause, cancel,
//! retry, progress reporting and interactive overwrite questions.

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::sync::{oneshot, watch, Semaphore};
use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result};
use crate::types::FileEntry;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    Transfer,
    Delete,
    Sync,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobState {
    Queued,
    Running,
    Paused,
    /// Waiting for the user to answer an overwrite question.
    Waiting,
    Completed,
    Failed,
    Cancelled,
}

impl JobState {
    pub fn is_finished(self) -> bool {
        matches!(self, JobState::Completed | JobState::Failed | JobState::Cancelled)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobError {
    pub path: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictInfo {
    pub id: String,
    pub source: FileEntry,
    pub target: FileEntry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictAction {
    Overwrite,
    Skip,
    Resume,
    Rename,
    Newer,
    Cancel,
}

#[derive(Debug, Clone)]
pub struct ConflictDecision {
    pub action: ConflictAction,
    pub new_name: Option<String>,
}

/// Serializable snapshot of a job (sent to the UI).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub id: String,
    pub kind: JobKind,
    pub title: String,
    pub state: JobState,
    pub src_session: Option<String>,
    pub dst_session: Option<String>,
    pub src_paths: Vec<String>,
    pub dst_dir: Option<String>,
    pub bytes_total: u64,
    pub bytes_done: u64,
    pub files_total: u64,
    pub files_done: u64,
    pub scanning: bool,
    pub current_file: Option<String>,
    pub speed: f64,
    pub eta: Option<u64>,
    pub errors: Vec<JobError>,
    pub conflict: Option<ConflictInfo>,
    pub created_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

/// Static description of a job when it is created.
#[derive(Debug, Clone, Default)]
pub struct JobSpec {
    pub title: String,
    pub src_session: Option<String>,
    pub dst_session: Option<String>,
    pub src_paths: Vec<String>,
    pub dst_dir: Option<String>,
}

/// The work a job performs. Must be re-runnable for "retry".
#[async_trait]
pub trait JobTask: Send + Sync {
    async fn run(&self, ctx: &JobCtx) -> Result<()>;
}

/// Byte-rate limiter shared by all files of one job.
pub struct RateLimiter {
    bytes_per_sec: AtomicU64,
    state: tokio::sync::Mutex<(Instant, f64)>,
}

impl RateLimiter {
    pub fn new(bytes_per_sec: u64) -> Self {
        RateLimiter { bytes_per_sec: AtomicU64::new(bytes_per_sec), state: tokio::sync::Mutex::new((Instant::now(), 0.0)) }
    }

    pub fn set(&self, bytes_per_sec: u64) {
        self.bytes_per_sec.store(bytes_per_sec, Ordering::Relaxed);
    }

    /// Account for `n` bytes, sleeping as needed to stay below the limit.
    pub async fn consume(&self, n: usize) {
        let limit = self.bytes_per_sec.load(Ordering::Relaxed);
        if limit == 0 {
            return;
        }
        let wait = {
            let mut st = self.state.lock().await;
            let now = Instant::now();
            let elapsed = now.duration_since(st.0).as_secs_f64();
            // Token bucket with one second of burst.
            let mut tokens = (st.1 + elapsed * limit as f64).min(limit as f64);
            st.0 = now;
            tokens -= n as f64;
            st.1 = tokens;
            if tokens < 0.0 {
                Some(Duration::from_secs_f64(-tokens / limit as f64))
            } else {
                None
            }
        };
        if let Some(w) = wait {
            tokio::time::sleep(w).await;
        }
    }
}

struct Progress {
    snapshot: Job,
    pending_conflict: Option<oneshot::Sender<ConflictDecision>>,
    /// Decision remembered by "apply to all".
    conflict_all: Option<ConflictDecision>,
}

/// Handle given to a running [`JobTask`].
pub struct JobCtx {
    inner: Arc<JobInner>,
}

struct JobInner {
    id: String,
    kind: JobKind,
    task: Arc<dyn JobTask>,
    spec: JobSpec,
    progress: Mutex<Progress>,
    cancel: Mutex<CancellationToken>,
    paused: watch::Sender<bool>,
    bytes_done: AtomicU64,
    dirty: AtomicBool,
    pub limiter: RateLimiter,
    speed_state: Mutex<(Instant, u64, f64)>,
    conflict_lock: tokio::sync::Mutex<()>,
    queue: std::sync::Weak<QueueInner>,
}

impl JobCtx {
    pub fn id(&self) -> &str {
        &self.inner.id
    }

    pub fn cancel_token(&self) -> CancellationToken {
        self.inner.cancel.lock().clone()
    }

    pub fn is_cancelled(&self) -> bool {
        self.inner.cancel.lock().is_cancelled()
    }

    /// Wait while paused; fail with [`Error::Cancelled`] when cancelled.
    pub async fn check(&self) -> Result<()> {
        let token = self.cancel_token();
        if token.is_cancelled() {
            return Err(Error::Cancelled);
        }
        let mut rx = self.inner.paused.subscribe();
        while *rx.borrow_and_update() {
            tokio::select! {
                _ = token.cancelled() => return Err(Error::Cancelled),
                r = rx.changed() => { if r.is_err() { break; } }
            }
        }
        Ok(())
    }

    pub fn limiter(&self) -> &RateLimiter {
        &self.inner.limiter
    }

    pub fn set_scanning(&self, scanning: bool) {
        self.update(|j| j.scanning = scanning);
    }

    pub fn add_total(&self, bytes: u64, files: u64) {
        self.update(|j| {
            j.bytes_total += bytes;
            j.files_total += files;
        });
    }

    /// Hot path: called for every chunk.
    pub fn add_bytes(&self, n: u64) {
        self.inner.bytes_done.fetch_add(n, Ordering::Relaxed);
        self.inner.dirty.store(true, Ordering::Relaxed);
    }

    /// Undo progress (e.g. when a partially transferred file is retried).
    pub fn sub_bytes(&self, n: u64) {
        let _ = self.inner.bytes_done.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| Some(v.saturating_sub(n)));
    }

    pub fn file_done(&self) {
        self.update(|j| j.files_done += 1);
    }

    pub fn set_current(&self, path: Option<&str>) {
        self.update(|j| j.current_file = path.map(|s| s.to_string()));
    }

    pub fn error(&self, path: &str, err: &Error) {
        tracing::warn!(job = %self.inner.id, "{path}: {err}");
        self.update(|j| {
            if j.errors.len() < 1000 {
                j.errors.push(JobError { path: path.to_string(), message: err.to_string() });
            }
        });
        self.emit_now();
    }

    pub fn has_errors(&self) -> bool {
        !self.inner.progress.lock().snapshot.errors.is_empty()
    }

    fn update(&self, f: impl FnOnce(&mut Job)) {
        let mut p = self.inner.progress.lock();
        f(&mut p.snapshot);
        self.inner.dirty.store(true, Ordering::Relaxed);
    }

    fn emit_now(&self) {
        if let Some(q) = self.inner.queue.upgrade() {
            q.emit(&self.inner);
        }
    }

    /// Ask the user what to do with an existing target. Honours "apply to all".
    pub async fn ask_conflict(&self, source: FileEntry, target: FileEntry) -> Result<ConflictDecision> {
        // Parallel transfers ask one question at a time.
        let _guard = self.inner.conflict_lock.lock().await;
        let rx = {
            let mut p = self.inner.progress.lock();
            if let Some(d) = &p.conflict_all {
                return Ok(d.clone());
            }
            let (tx, rx) = oneshot::channel();
            p.pending_conflict = Some(tx);
            p.snapshot.conflict = Some(ConflictInfo { id: uuid::Uuid::new_v4().to_string(), source, target });
            p.snapshot.state = JobState::Waiting;
            rx
        };
        self.emit_now();
        let token = self.cancel_token();
        let res = tokio::select! {
            _ = token.cancelled() => Err(Error::Cancelled),
            r = rx => r.map_err(|_| Error::Cancelled),
        };
        {
            let mut p = self.inner.progress.lock();
            p.snapshot.conflict = None;
            if p.snapshot.state == JobState::Waiting {
                p.snapshot.state = if *self.inner.paused.borrow() { JobState::Paused } else { JobState::Running };
            }
        }
        self.emit_now();
        let d = res?;
        if d.action == ConflictAction::Cancel {
            self.inner.cancel.lock().cancel();
            return Err(Error::Cancelled);
        }
        Ok(d)
    }
}

impl JobInner {
    fn snapshot(&self) -> Job {
        let mut j = self.progress.lock().snapshot.clone();
        j.bytes_done = self.bytes_done.load(Ordering::Relaxed);
        if j.state == JobState::Running && j.speed > 1.0 && j.bytes_total > j.bytes_done {
            j.eta = Some(((j.bytes_total - j.bytes_done) as f64 / j.speed) as u64);
        } else {
            j.eta = None;
        }
        j
    }

    fn update_speed(&self) {
        let done = self.bytes_done.load(Ordering::Relaxed);
        let mut st = self.speed_state.lock();
        let now = Instant::now();
        let dt = now.duration_since(st.0).as_secs_f64();
        if dt < 0.2 {
            return;
        }
        let inst = (done.saturating_sub(st.1)) as f64 / dt;
        // Exponential smoothing.
        st.2 = if st.2 == 0.0 { inst } else { st.2 * 0.7 + inst * 0.3 };
        st.0 = now;
        st.1 = done;
        self.progress.lock().snapshot.speed = st.2;
    }

    fn set_state(&self, s: JobState) {
        let mut p = self.progress.lock();
        p.snapshot.state = s;
        let now = chrono::Utc::now().timestamp();
        match s {
            JobState::Running if p.snapshot.started_at.is_none() => p.snapshot.started_at = Some(now),
            s if s.is_finished() => {
                p.snapshot.finished_at = Some(now);
                p.snapshot.speed = 0.0;
                p.snapshot.current_file = None;
                p.snapshot.conflict = None;
                p.snapshot.scanning = false;
            }
            _ => {}
        }
    }
}

pub type JobListener = Arc<dyn Fn(JobEvent) + Send + Sync>;

#[derive(Debug, Clone)]
pub enum JobEvent {
    Updated(Job),
    Removed(String),
}

struct QueueInner {
    jobs: Mutex<Vec<Arc<JobInner>>>,
    semaphore: Arc<Semaphore>,
    max_concurrent: AtomicUsize,
    listener: JobListener,
}

impl QueueInner {
    fn emit(&self, job: &JobInner) {
        job.dirty.store(false, Ordering::Relaxed);
        (self.listener)(JobEvent::Updated(job.snapshot()));
    }
}

/// The job queue. Cheap to clone.
#[derive(Clone)]
pub struct JobQueue {
    inner: Arc<QueueInner>,
}

impl JobQueue {
    pub fn new(max_concurrent: usize, listener: JobListener) -> Self {
        let max = max_concurrent.clamp(1, 32);
        let inner = Arc::new(QueueInner {
            jobs: Mutex::new(Vec::new()),
            semaphore: Arc::new(Semaphore::new(max)),
            max_concurrent: AtomicUsize::new(max),
            listener,
        });
        // Progress ticker: emits throttled updates for running jobs.
        let weak = Arc::downgrade(&inner);
        tokio::spawn(async move {
            let mut iv = tokio::time::interval(Duration::from_millis(300));
            loop {
                iv.tick().await;
                let Some(q) = weak.upgrade() else { break };
                let jobs: Vec<Arc<JobInner>> = q.jobs.lock().clone();
                for j in jobs {
                    let state = j.progress.lock().snapshot.state;
                    if state == JobState::Running {
                        j.update_speed();
                        q.emit(&j);
                    } else if j.dirty.load(Ordering::Relaxed) {
                        q.emit(&j);
                    }
                }
            }
        });
        JobQueue { inner }
    }

    pub fn set_max_concurrent(&self, n: usize) {
        let n = n.clamp(1, 32);
        let old = self.inner.max_concurrent.swap(n, Ordering::SeqCst);
        if n > old {
            self.inner.semaphore.add_permits(n - old);
        } else if n < old {
            self.inner.semaphore.forget_permits(old - n);
        }
    }

    /// Enqueue a job; it starts as soon as a slot is free.
    pub fn submit(&self, kind: JobKind, spec: JobSpec, task: Arc<dyn JobTask>, speed_limit: u64) -> Job {
        let id = uuid::Uuid::new_v4().to_string();
        let snapshot = Job {
            id: id.clone(),
            kind,
            title: spec.title.clone(),
            state: JobState::Queued,
            src_session: spec.src_session.clone(),
            dst_session: spec.dst_session.clone(),
            src_paths: spec.src_paths.clone(),
            dst_dir: spec.dst_dir.clone(),
            bytes_total: 0,
            bytes_done: 0,
            files_total: 0,
            files_done: 0,
            scanning: true,
            current_file: None,
            speed: 0.0,
            eta: None,
            errors: vec![],
            conflict: None,
            created_at: chrono::Utc::now().timestamp(),
            started_at: None,
            finished_at: None,
        };
        let (paused, _) = watch::channel(false);
        let inner = Arc::new(JobInner {
            id,
            kind,
            task,
            spec,
            progress: Mutex::new(Progress { snapshot, pending_conflict: None, conflict_all: None }),
            cancel: Mutex::new(CancellationToken::new()),
            paused,
            bytes_done: AtomicU64::new(0),
            dirty: AtomicBool::new(false),
            limiter: RateLimiter::new(speed_limit),
            speed_state: Mutex::new((Instant::now(), 0, 0.0)),
            conflict_lock: tokio::sync::Mutex::new(()),
            queue: Arc::downgrade(&self.inner),
        });
        self.inner.jobs.lock().push(inner.clone());
        self.inner.emit(&inner);
        self.spawn(inner.clone());
        inner.snapshot()
    }

    fn spawn(&self, job: Arc<JobInner>) {
        let q = self.inner.clone();
        tokio::spawn(async move {
            let token = job.cancel.lock().clone();
            let permit = tokio::select! {
                p = q.semaphore.clone().acquire_owned() => p.ok(),
                _ = token.cancelled() => None,
            };
            if permit.is_none() {
                job.set_state(JobState::Cancelled);
                q.emit(&job);
                return;
            }
            let paused = *job.paused.borrow();
            job.set_state(if paused { JobState::Paused } else { JobState::Running });
            {
                let mut s = job.speed_state.lock();
                *s = (Instant::now(), job.bytes_done.load(Ordering::Relaxed), 0.0);
            }
            q.emit(&job);
            let ctx = JobCtx { inner: job.clone() };
            let result = job.task.run(&ctx).await;
            let has_errors = !job.progress.lock().snapshot.errors.is_empty();
            let final_state = match result {
                Err(Error::Cancelled) => JobState::Cancelled,
                _ if token.is_cancelled() => JobState::Cancelled,
                Err(e) => {
                    ctx.error("", &e);
                    JobState::Failed
                }
                Ok(()) if has_errors => JobState::Failed,
                Ok(()) => JobState::Completed,
            };
            job.set_state(final_state);
            tracing::info!(job = %job.id, "{} finished: {:?}", job.spec.title, final_state);
            q.emit(&job);
            drop(permit);
        });
    }

    fn find(&self, id: &str) -> Result<Arc<JobInner>> {
        self.inner
            .jobs
            .lock()
            .iter()
            .find(|j| j.id == id)
            .cloned()
            .ok_or_else(|| Error::NotFound(format!("job {id}")))
    }

    pub fn list(&self) -> Vec<Job> {
        self.inner.jobs.lock().iter().map(|j| j.snapshot()).collect()
    }

    pub fn get(&self, id: &str) -> Result<Job> {
        Ok(self.find(id)?.snapshot())
    }

    pub fn pause(&self, id: &str) -> Result<()> {
        let j = self.find(id)?;
        let _ = j.paused.send(true);
        {
            let mut p = j.progress.lock();
            if matches!(p.snapshot.state, JobState::Running | JobState::Queued) {
                p.snapshot.state = JobState::Paused;
            }
        }
        self.inner.emit(&j);
        Ok(())
    }

    pub fn resume(&self, id: &str) -> Result<()> {
        let j = self.find(id)?;
        let _ = j.paused.send(false);
        {
            let mut p = j.progress.lock();
            if p.snapshot.state == JobState::Paused {
                p.snapshot.state =
                    if p.snapshot.started_at.is_some() { JobState::Running } else { JobState::Queued };
            }
        }
        self.inner.emit(&j);
        Ok(())
    }

    pub fn cancel(&self, id: &str) -> Result<()> {
        let j = self.find(id)?;
        j.cancel.lock().cancel();
        Ok(())
    }

    /// Run a finished job again (same task, fresh progress).
    pub fn retry(&self, id: &str) -> Result<Job> {
        let j = self.find(id)?;
        let state = j.progress.lock().snapshot.state;
        if !state.is_finished() {
            return Err(Error::InvalidInput("job is still running".into()));
        }
        let speed = j.limiter.bytes_per_sec.load(Ordering::Relaxed);
        self.remove(id)?;
        Ok(self.submit(j.kind, j.spec.clone(), j.task.clone(), speed))
    }

    /// Remove a job from the list (cancels it if still running).
    pub fn remove(&self, id: &str) -> Result<()> {
        let j = self.find(id)?;
        j.cancel.lock().cancel();
        self.inner.jobs.lock().retain(|x| x.id != id);
        (self.inner.listener)(JobEvent::Removed(id.to_string()));
        Ok(())
    }

    pub fn clear_finished(&self) {
        let removed: Vec<String> = {
            let mut jobs = self.inner.jobs.lock();
            let ids = jobs
                .iter()
                .filter(|j| j.progress.lock().snapshot.state.is_finished())
                .map(|j| j.id.clone())
                .collect::<Vec<_>>();
            jobs.retain(|j| !ids.contains(&j.id));
            ids
        };
        for id in removed {
            (self.inner.listener)(JobEvent::Removed(id));
        }
    }

    pub fn resolve_conflict(&self, id: &str, conflict_id: &str, decision: ConflictDecision, apply_to_all: bool) -> Result<()> {
        let j = self.find(id)?;
        let tx = {
            let mut p = j.progress.lock();
            match &p.snapshot.conflict {
                Some(c) if c.id == conflict_id => {}
                _ => return Err(Error::NotFound("conflict already resolved".into())),
            }
            if apply_to_all && decision.action != ConflictAction::Rename {
                p.conflict_all = Some(decision.clone());
            }
            p.pending_conflict.take()
        };
        if let Some(tx) = tx {
            let _ = tx.send(decision);
        }
        Ok(())
    }

    /// Wait until a job has finished (used by scripting and tests).
    pub async fn wait(&self, id: &str) -> Result<Job> {
        loop {
            let j = self.get(id)?;
            if j.state.is_finished() {
                return Ok(j);
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}
