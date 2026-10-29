//! "Keep remote directory up to date": watch a local directory and mirror changes.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use notify::{RecursiveMode, Watcher as _};
use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::mpsc;

use crate::error::{Error, Result};
use crate::jobs::{JobKind, JobQueue, JobSpec};
use crate::local::{from_native, to_native};
use crate::mask::{FileMask, MaskTarget};
use crate::path as vpath;
use crate::transfer::{DeleteTask, Endpoint, OverwriteMode, TransferOptions, TransferTask};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchStatus {
    pub id: String,
    pub local_path: String,
    pub remote_session: String,
    pub remote_path: String,
    pub delete_remote: bool,
    pub file_mask: String,
    pub uploads: u64,
    pub last_event: Option<String>,
    pub error: Option<String>,
}

pub struct DirWatch {
    status: Arc<Mutex<WatchStatus>>,
    _watcher: notify::RecommendedWatcher,
    stop: tokio_util::sync::CancellationToken,
}

impl DirWatch {
    pub fn status(&self) -> WatchStatus {
        self.status.lock().clone()
    }

    pub fn stop(&self) {
        self.stop.cancel();
    }
}

impl Drop for DirWatch {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

pub struct WatchParams {
    pub local_path: String,
    pub remote: Endpoint,
    pub remote_path: String,
    pub delete_remote: bool,
    pub file_mask: String,
    pub options: TransferOptions,
}

/// Start watching. `on_update` is called whenever the status changes.
pub fn start(
    params: WatchParams,
    local: Endpoint,
    queue: JobQueue,
    on_update: Arc<dyn Fn(WatchStatus) + Send + Sync>,
) -> Result<DirWatch> {
    let mask = FileMask::parse(&params.file_mask).map_err(Error::InvalidInput)?;
    let root = vpath::normalize(&params.local_path);
    let (tx, mut rx) = mpsc::unbounded_channel::<notify::Event>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            let _ = tx.send(ev);
        }
    })
    .map_err(|e| Error::other(format!("cannot watch directory: {e}")))?;
    watcher
        .watch(&to_native(&root), RecursiveMode::Recursive)
        .map_err(|e| Error::other(format!("cannot watch {root}: {e}")))?;

    let status = Arc::new(Mutex::new(WatchStatus {
        id: uuid::Uuid::new_v4().to_string(),
        local_path: root.clone(),
        remote_session: params.remote.session.clone(),
        remote_path: params.remote_path.clone(),
        delete_remote: params.delete_remote,
        file_mask: params.file_mask.clone(),
        uploads: 0,
        last_event: None,
        error: None,
    }));
    let stop = tokio_util::sync::CancellationToken::new();
    let st = status.clone();
    let stop2 = stop.clone();
    tokio::spawn(async move {
        loop {
            // Wait for the first event, then debounce.
            let first = tokio::select! {
                _ = stop2.cancelled() => break,
                ev = rx.recv() => match ev { Some(e) => e, None => break },
            };
            let mut paths: BTreeSet<String> = first.paths.iter().map(|p| from_native(p)).collect();
            loop {
                match tokio::time::timeout(Duration::from_millis(600), rx.recv()).await {
                    Ok(Some(ev)) => paths.extend(ev.paths.iter().map(|p| from_native(p))),
                    Ok(None) => break,
                    Err(_) => break,
                }
            }
            let mut uploads: Vec<(String, String)> = Vec::new();
            let mut deletes: Vec<String> = Vec::new();
            for p in paths {
                let Some(rel) = vpath::relative_to(&p, &root) else { continue };
                if rel.is_empty() {
                    continue;
                }
                let name = vpath::file_name(&p).to_string();
                if name.ends_with(".filepart") || name.ends_with('~') || name.starts_with(".#") {
                    continue;
                }
                let remote_target = vpath::join(&params.remote_path, &rel);
                match local.vfs.try_stat(&p).await {
                    Ok(Some(e)) => {
                        let t = MaskTarget {
                            name: &name,
                            rel_path: &rel,
                            is_dir: e.is_dir(),
                            size: e.size,
                            modified: e.modified,
                        };
                        if !mask.matches(&t) {
                            continue;
                        }
                        if e.is_dir() {
                            let _ = params.remote.vfs.mkdir_all(&remote_target).await;
                        } else {
                            uploads.push((p.clone(), vpath::parent(&remote_target)));
                        }
                    }
                    Ok(None) if params.delete_remote => deletes.push(remote_target),
                    _ => {}
                }
            }
            for (src, dst_dir) in uploads {
                if let Err(e) = params.remote.vfs.mkdir_all(&dst_dir).await {
                    st.lock().error = Some(e.to_string());
                    continue;
                }
                let opts = TransferOptions {
                    overwrite: OverwriteMode::Overwrite,
                    move_files: false,
                    new_name: None,
                    ..params.options.clone()
                };
                let task = TransferTask {
                    src: local.clone(),
                    src_paths: vec![src.clone()],
                    dst: params.remote.clone(),
                    dst_dir: dst_dir.clone(),
                    options: opts,
                };
                let spec = JobSpec {
                    title: format!("Keep up to date: {}", vpath::file_name(&src)),
                    src_session: Some(local.session.clone()),
                    dst_session: Some(params.remote.session.clone()),
                    src_paths: vec![src.clone()],
                    dst_dir: Some(dst_dir),
                };
                queue.submit(JobKind::Transfer, spec, Arc::new(task), params.options.speed_limit);
                let mut s = st.lock();
                s.uploads += 1;
                s.last_event = Some(format!("upload {src}"));
                s.error = None;
            }
            if !deletes.is_empty() {
                let spec = JobSpec {
                    title: "Keep up to date: delete".into(),
                    dst_session: Some(params.remote.session.clone()),
                    src_paths: deletes.clone(),
                    ..Default::default()
                };
                st.lock().last_event = Some(format!("delete {}", deletes.join(", ")));
                queue.submit(
                    JobKind::Delete,
                    spec,
                    Arc::new(DeleteTask { target: params.remote.clone(), paths: deletes }),
                    0,
                );
            }
            on_update(st.lock().clone());
        }
    });
    Ok(DirWatch { status, _watcher: watcher, stop })
}
