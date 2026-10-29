use std::sync::Arc;

use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use rc_core::archive::{ArchiveFormat, ArchiveTask};
use rc_core::jobs::{ConflictAction, ConflictDecision, Job, JobKind, JobSpec};
use rc_core::path as vpath;
use rc_core::search::SearchParams;
use rc_core::sync::{SyncParams, SyncPlan, SyncTask};
use rc_core::transfer::{Endpoint, TransferOptions, TransferTask};
use rc_core::watch::{WatchParams, WatchStatus};
use rc_core::{Error, Protocol, Result};

use crate::state::{AppState, LOCAL_SESSION};

/// Merge a partial options object over the saved defaults.
pub fn merge_options(state: &AppState, partial: Option<serde_json::Value>) -> Result<TransferOptions> {
    let mut base = serde_json::to_value(&state.settings.read().transfer)?;
    if let (Some(serde_json::Value::Object(over)), serde_json::Value::Object(b)) = (partial, &mut base) {
        for (k, v) in over {
            b.insert(k, v);
        }
    }
    Ok(serde_json::from_value(base)?)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferParams {
    pub src_session: String,
    pub src_paths: Vec<String>,
    pub dst_session: String,
    pub dst_dir: String,
    pub options: Option<serde_json::Value>,
}

pub fn start_transfer(state: &AppState, p: TransferParams) -> Result<Job> {
    if p.src_paths.is_empty() {
        return Err(Error::InvalidInput("nothing to transfer".into()));
    }
    let src = Endpoint::new(p.src_session.clone(), state.vfs(&p.src_session)?);
    let dst = Endpoint::new(p.dst_session.clone(), state.vfs(&p.dst_session)?);
    let options = merge_options(state, p.options)?;
    let verb = if options.move_files { "Move" } else { "Copy" };
    let what = if p.src_paths.len() == 1 {
        vpath::file_name(&p.src_paths[0]).to_string()
    } else {
        format!("{} items", p.src_paths.len())
    };
    let direction = match (p.src_session == LOCAL_SESSION, p.dst_session == LOCAL_SESSION) {
        (true, false) => {
            if options.move_files {
                "Upload (move)"
            } else {
                "Upload"
            }
        }
        (false, true) => {
            if options.move_files {
                "Download (move)"
            } else {
                "Download"
            }
        }
        _ => verb,
    };
    let spec = JobSpec {
        title: format!("{direction} {what} → {}", p.dst_dir),
        src_session: Some(p.src_session.clone()),
        dst_session: Some(p.dst_session.clone()),
        src_paths: p.src_paths.clone(),
        dst_dir: Some(p.dst_dir.clone()),
    };
    let speed = options.speed_limit;
    let task = TransferTask { src, src_paths: p.src_paths, dst, dst_dir: p.dst_dir, options };
    Ok(state.jobs.submit(JobKind::Transfer, spec, Arc::new(task), speed))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveParams {
    pub id: String,
    pub conflict_id: String,
    pub action: ConflictAction,
    #[serde(default)]
    pub apply_to_all: bool,
    pub new_name: Option<String>,
}

pub fn resolve_conflict(state: &AppState, p: ResolveParams) -> Result<()> {
    state.jobs.resolve_conflict(
        &p.id,
        &p.conflict_id,
        ConflictDecision { action: p.action, new_name: p.new_name },
        p.apply_to_all,
    )
}

// ------------------------------------------------------------------ archives

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractParams {
    pub session: String,
    pub path: String,
    pub dst_dir: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateArchiveParams {
    pub session: String,
    pub paths: Vec<String>,
    pub dst: String,
    pub format: ArchiveFormat,
}

fn require_local(state: &AppState, session: &str) -> Result<()> {
    if state.vfs(session)?.protocol() != Protocol::Local {
        return Err(Error::unsupported(
            "archives can only be handled in the local panel (use a custom command such as tar on servers)",
        ));
    }
    Ok(())
}

pub fn archive_extract(state: &AppState, p: ExtractParams) -> Result<Job> {
    require_local(state, &p.session)?;
    let spec = JobSpec {
        title: format!("Extract {}", vpath::file_name(&p.path)),
        dst_session: Some(p.session.clone()),
        dst_dir: Some(p.dst_dir.clone()),
        ..Default::default()
    };
    Ok(state.jobs.submit(
        JobKind::Transfer,
        spec,
        Arc::new(ArchiveTask::Extract { path: p.path, dst_dir: p.dst_dir }),
        0,
    ))
}

pub fn archive_create(state: &AppState, p: CreateArchiveParams) -> Result<Job> {
    require_local(state, &p.session)?;
    let spec = JobSpec {
        title: format!("Create {}", vpath::file_name(&p.dst)),
        dst_session: Some(p.session.clone()),
        dst_dir: Some(vpath::parent(&p.dst)),
        ..Default::default()
    };
    Ok(state.jobs.submit(
        JobKind::Transfer,
        spec,
        Arc::new(ArchiveTask::Create { paths: p.paths, dst: p.dst, format: p.format }),
        0,
    ))
}

// ------------------------------------------------------------------ sync

pub async fn sync_compare(state: &AppState, params: SyncParams) -> Result<SyncPlan> {
    let left = state.vfs(&params.left_session)?;
    let right = state.vfs(&params.right_session)?;
    let ev = state.events.clone();
    let last = parking_lot::Mutex::new(std::time::Instant::now());
    let plan = rc_core::sync::compare(left.as_ref(), right.as_ref(), &params, move |p| {
        let mut l = last.lock();
        if l.elapsed().as_millis() > 150 {
            *l = std::time::Instant::now();
            ev.emit("sync.progress", p);
        }
    })
    .await?;
    let mut plans = state.sync_plans.lock();
    if plans.len() > 20 {
        plans.clear();
    }
    plans.insert(plan.id.clone(), plan.clone());
    Ok(plan)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncExecuteParams {
    pub plan_id: String,
    pub action_ids: Vec<String>,
    pub options: Option<serde_json::Value>,
}

pub fn sync_execute(state: &AppState, p: SyncExecuteParams) -> Result<Job> {
    let plan = state
        .sync_plans
        .lock()
        .remove(&p.plan_id)
        .ok_or_else(|| Error::NotFound("synchronization plan (compare again)".into()))?;
    let wanted: std::collections::HashSet<&String> = p.action_ids.iter().collect();
    let actions: Vec<_> = plan.actions.into_iter().filter(|a| wanted.contains(&a.id)).collect();
    let params = plan.params;
    let left = Endpoint::new(params.left_session.clone(), state.vfs(&params.left_session)?);
    let right = Endpoint::new(params.right_session.clone(), state.vfs(&params.right_session)?);
    let options = merge_options(state, p.options)?;
    let speed = options.speed_limit;
    let spec = JobSpec {
        title: format!("Synchronize {} ↔ {} ({} actions)", params.left_path, params.right_path, actions.len()),
        src_session: Some(params.left_session.clone()),
        dst_session: Some(params.right_session.clone()),
        // Parents of src_paths get refreshed when the job ends: refresh the left root.
        src_paths: vec![vpath::join(&params.left_path, "*")],
        dst_dir: Some(params.right_path.clone()),
    };
    let task = SyncTask { left, right, params, actions, options };
    Ok(state.jobs.submit(JobKind::Sync, spec, Arc::new(task), speed))
}

// ------------------------------------------------------------------ keep up to date

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStartParams {
    pub local_path: String,
    pub remote_session: String,
    pub remote_path: String,
    #[serde(default)]
    pub delete_remote: bool,
    #[serde(default)]
    pub file_mask: String,
    #[serde(default)]
    pub initial_sync: bool,
}

pub async fn watch_start(state: &Arc<AppState>, p: WatchStartParams) -> Result<WatchStatus> {
    let remote = Endpoint::new(p.remote_session.clone(), state.vfs(&p.remote_session)?);
    let local = Endpoint::new(LOCAL_SESSION, state.vfs(LOCAL_SESSION)?);
    let options = state.settings.read().transfer.clone();
    if p.initial_sync {
        let params = SyncParams {
            left_session: LOCAL_SESSION.into(),
            left_path: p.local_path.clone(),
            right_session: p.remote_session.clone(),
            right_path: p.remote_path.clone(),
            delete_obsolete: p.delete_remote,
            file_mask: p.file_mask.clone(),
            ..Default::default()
        };
        let plan = rc_core::sync::compare(local.vfs.as_ref(), remote.vfs.as_ref(), &params, |_| {}).await?;
        if !plan.actions.is_empty() {
            let spec = JobSpec {
                title: format!("Keep up to date: initial synchronization of {}", p.local_path),
                src_session: Some(LOCAL_SESSION.into()),
                dst_session: Some(p.remote_session.clone()),
                src_paths: vec![],
                dst_dir: Some(p.remote_path.clone()),
            };
            let task = SyncTask {
                left: local.clone(),
                right: remote.clone(),
                params,
                actions: plan.actions,
                options: options.clone(),
            };
            state.jobs.submit(JobKind::Sync, spec, Arc::new(task), options.speed_limit);
        }
    }
    let ev = state.events.clone();
    let w = rc_core::watch::start(
        WatchParams {
            local_path: p.local_path,
            remote,
            remote_path: p.remote_path,
            delete_remote: p.delete_remote,
            file_mask: p.file_mask,
            options,
        },
        local,
        state.jobs.clone(),
        Arc::new(move |s| ev.emit("watch.updated", s)),
    )?;
    let status = w.status();
    state.watches.lock().insert(status.id.clone(), w);
    Ok(status)
}

// ------------------------------------------------------------------ search

pub fn search_start(state: &Arc<AppState>, params: SearchParams) -> Result<String> {
    let vfs = state.vfs(&params.session)?;
    let id = uuid::Uuid::new_v4().to_string();
    let token = CancellationToken::new();
    state.searches.lock().insert(id.clone(), token.clone());
    let st = state.clone();
    let sid = id.clone();
    tokio::spawn(async move {
        let ev = st.events.clone();
        let rid = sid.clone();
        let r = rc_core::search::search(vfs.as_ref(), &params, token, move |entries| {
            ev.emit("search.result", serde_json::json!({ "id": rid, "entries": entries }));
        })
        .await;
        st.searches.lock().remove(&sid);
        let payload = match r {
            Ok(s) => {
                serde_json::json!({ "id": sid, "scanned": s.scanned, "found": s.found, "cancelled": s.cancelled, "error": null })
            }
            Err(e) => {
                serde_json::json!({ "id": sid, "scanned": 0, "found": 0, "cancelled": false, "error": e.to_string() })
            }
        };
        st.events.emit("search.done", payload);
    });
    Ok(id)
}
