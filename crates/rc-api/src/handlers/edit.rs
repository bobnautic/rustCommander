//! Edit remote files with an external application (desktop only): download to a temp
//! file, open it, upload whenever it is saved.

use std::sync::Arc;
use std::time::Duration;

use notify::{RecursiveMode, Watcher};
use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

use rc_core::local::from_native;
use rc_core::path as vpath;
use rc_core::{Error, Protocol, Result};

use crate::state::{AppState, EditEntry, EditStatus};

pub async fn external(state: &Arc<AppState>, session: &str, path: &str) -> Result<EditStatus> {
    let vfs = state.vfs(session)?;
    let id = uuid::Uuid::new_v4().to_string();
    if vfs.protocol() == Protocol::Local {
        // Local files are opened in place.
        open::that_detached(rc_core::local::to_native(path)).map_err(|e| Error::other(format!("cannot open: {e}")))?;
        return Ok(EditStatus {
            id,
            session: session.into(),
            remote_path: path.into(),
            local_path: path.into(),
            uploads: 0,
            last_error: None,
        });
    }
    let dir = rc_core::store::temp_dir().join("edit").join(&id);
    std::fs::create_dir_all(&dir)?;
    let name = vpath::file_name(path).to_string();
    let local_native = dir.join(&name);
    let data = rc_core::vfs::read_to_end(vfs.as_ref(), path, 512 * 1024 * 1024).await?;
    tokio::fs::write(&local_native, &data).await?;
    let status = Arc::new(Mutex::new(EditStatus {
        id: id.clone(),
        session: session.into(),
        remote_path: path.into(),
        local_path: from_native(&local_native),
        uploads: 0,
        last_error: None,
    }));

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
    let watch_target = local_native.clone();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res {
            if ev.paths.iter().any(|p| p.file_name() == watch_target.file_name()) && !ev.kind.is_access() {
                let _ = tx.send(());
            }
        }
    })
    .map_err(|e| Error::other(format!("cannot watch file: {e}")))?;
    // Watch the directory: many editors save via rename.
    watcher.watch(&dir, RecursiveMode::NonRecursive).map_err(|e| Error::other(e.to_string()))?;

    let stop = CancellationToken::new();
    let st = state.clone();
    let stat = status.clone();
    let remote = path.to_string();
    let sess = session.to_string();
    let stop2 = stop.clone();
    let mut last = data;
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = stop2.cancelled() => break,
                r = rx.recv() => if r.is_none() { break },
            }
            // Debounce bursts of events from one save.
            while tokio::time::timeout(Duration::from_millis(400), rx.recv()).await.is_ok_and(|r| r.is_some()) {}
            let Ok(content) = tokio::fs::read(&local_native).await else { continue };
            if content == last {
                continue;
            }
            let res = match st.vfs(&sess) {
                Ok(vfs) => rc_core::vfs::write_all(vfs.as_ref(), &remote, &content).await,
                Err(e) => Err(e),
            };
            {
                let mut s = stat.lock();
                match &res {
                    Ok(()) => {
                        s.uploads += 1;
                        s.last_error = None;
                        tracing::info!(session = %sess, "uploaded edited file {remote}");
                    }
                    Err(e) => {
                        s.last_error = Some(e.to_string());
                        tracing::warn!(session = %sess, "upload of edited file {remote} failed: {e}");
                    }
                }
            }
            if res.is_ok() {
                last = content;
                st.emit_changed(&sess, &vpath::parent(&remote));
            }
            st.events.emit("edit.updated", stat.lock().clone());
        }
    });

    open::that_detached(dir.join(&name)).map_err(|e| Error::other(format!("cannot open editor: {e}")))?;
    let snapshot = status.lock().clone();
    state.edits.lock().insert(id, EditEntry { status, stop, _watcher: Some(watcher) });
    Ok(snapshot)
}

pub fn list(state: &AppState) -> Vec<EditStatus> {
    state.edits.lock().values().map(|e| e.status.lock().clone()).collect()
}

pub fn stop(state: &AppState, id: &str) -> Result<()> {
    let e = state.edits.lock().remove(id).ok_or_else(|| Error::NotFound(format!("edit {id}")))?;
    e.stop.cancel();
    Ok(())
}
