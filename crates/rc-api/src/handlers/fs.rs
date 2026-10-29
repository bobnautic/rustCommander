use std::sync::Arc;

use base64::Engine;
use serde::{Deserialize, Serialize};

use rc_core::jobs::{Job, JobKind, JobSpec};
use rc_core::ops::{self, WalkOptions};
use rc_core::path as vpath;
use rc_core::transfer::{DeleteTask, Endpoint};
use rc_core::{ChecksumAlgo, DiskInfo, Error, ExecOutput, FileEntry, Result};

use crate::state::{AppState, Origin, LOCAL_SESSION};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPath {
    pub session: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub path: String,
    pub entries: Vec<FileEntry>,
}

pub async fn list(state: &AppState, p: SessionPath) -> Result<Listing> {
    let vfs = state.vfs(&p.session)?;
    let path = if p.path.trim().is_empty() { vfs.home().await? } else { vpath::normalize(&p.path) };
    let entries = vfs.list(&path).await?;
    Ok(Listing { path, entries })
}

pub async fn home(state: &AppState, session: &str) -> Result<String> {
    state.vfs(session)?.home().await
}

pub async fn realpath(state: &AppState, p: SessionPath) -> Result<String> {
    state.vfs(&p.session)?.canonicalize(&p.path).await
}

pub async fn stat(state: &AppState, p: SessionPath) -> Result<FileEntry> {
    state.vfs(&p.session)?.stat(&p.path).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MkdirParams {
    pub session: String,
    pub path: String,
    #[serde(default)]
    pub parents: bool,
}

pub async fn mkdir(state: &AppState, p: MkdirParams) -> Result<()> {
    let vfs = state.vfs(&p.session)?;
    if p.parents {
        vfs.mkdir_all(&p.path).await?;
    } else {
        vfs.mkdir(&p.path).await?;
    }
    state.emit_changed(&p.session, &vpath::parent(&p.path));
    Ok(())
}

pub async fn create_file(state: &AppState, p: SessionPath) -> Result<()> {
    let vfs = state.vfs(&p.session)?;
    if vfs.try_stat(&p.path).await?.is_some() {
        return Err(Error::AlreadyExists(p.path));
    }
    rc_core::vfs::write_all(vfs.as_ref(), &p.path, b"").await?;
    state.emit_changed(&p.session, &vpath::parent(&p.path));
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameParams {
    pub session: String,
    pub from: String,
    pub to: String,
}

pub async fn rename(state: &AppState, p: RenameParams) -> Result<()> {
    let vfs = state.vfs(&p.session)?;
    let to = if vpath::is_absolute(&p.to) { p.to.clone() } else { vpath::join(&vpath::parent(&p.from), &p.to) };
    if vpath::normalize(&to) == vpath::normalize(&p.from) {
        return Ok(());
    }
    // Case-only renames must not be refused on case-insensitive file systems.
    let case_only = to.to_lowercase() == p.from.to_lowercase();
    if !case_only && vfs.try_stat(&to).await?.is_some() {
        return Err(Error::AlreadyExists(to));
    }
    vfs.rename(&p.from, &to).await?;
    state.emit_changed(&p.session, &vpath::parent(&p.from));
    if vpath::parent(&to) != vpath::parent(&p.from) {
        state.emit_changed(&p.session, &vpath::parent(&to));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathsParams {
    pub session: String,
    pub paths: Vec<String>,
}

pub fn delete(state: &AppState, p: PathsParams) -> Result<Job> {
    let vfs = state.vfs(&p.session)?;
    let title = if p.paths.len() == 1 {
        format!("Delete {}", vpath::file_name(&p.paths[0]))
    } else {
        format!("Delete {} items", p.paths.len())
    };
    let spec =
        JobSpec { title, src_session: Some(p.session.clone()), src_paths: p.paths.clone(), ..Default::default() };
    let task = DeleteTask { target: Endpoint::new(p.session, vfs), paths: p.paths };
    Ok(state.jobs.submit(JobKind::Delete, spec, Arc::new(task), 0))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttrParams {
    pub session: String,
    pub paths: Vec<String>,
    pub permissions: Option<u32>,
    pub dir_permissions: Option<u32>,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub modified: Option<i64>,
    #[serde(default)]
    pub recursive: bool,
}

pub async fn set_attributes(state: &AppState, p: AttrParams) -> Result<()> {
    let vfs = state.vfs(&p.session)?;
    let owner = p.owner.as_deref().filter(|s| !s.is_empty());
    let group = p.group.as_deref().filter(|s| !s.is_empty());
    let apply = |e: FileEntry| {
        let vfs = vfs.clone();
        async move {
            let is_dir = e.is_dir();
            let mode = if is_dir { p.dir_permissions.or(p.permissions) } else { p.permissions };
            if let Some(m) = mode {
                vfs.set_permissions(&e.path, m).await?;
            }
            if owner.is_some() || group.is_some() {
                vfs.set_owner(&e.path, owner, group).await?;
            }
            Ok::<(), Error>(())
        }
    };
    for path in &p.paths {
        let e = vfs.stat(path).await?;
        if p.recursive && e.kind == rc_core::FileKind::Dir {
            let mut items = Vec::new();
            ops::walk(vfs.as_ref(), path, &WalkOptions::default(), |w| {
                if w.entry.kind != rc_core::FileKind::Symlink {
                    items.push(w.entry);
                }
                Ok(true)
            })
            .await?;
            for it in items {
                apply(it).await?;
            }
        }
        apply(e).await?;
        if let Some(m) = p.modified {
            vfs.set_modified(path, m).await?;
        }
    }
    if let Some(first) = p.paths.first() {
        state.emit_changed(&p.session, &vpath::parent(first));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SymlinkParams {
    pub session: String,
    pub target: String,
    pub link: String,
}

pub async fn symlink(state: &AppState, p: SymlinkParams) -> Result<()> {
    state.vfs(&p.session)?.symlink(&p.target, &p.link).await?;
    state.emit_changed(&p.session, &vpath::parent(&p.link));
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadParams {
    pub session: String,
    pub path: String,
    pub max_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub content: String,
    pub encoding: &'static str,
    pub size: u64,
    pub modified: Option<i64>,
    pub binary: bool,
}

pub async fn read_text(state: &AppState, p: ReadParams) -> Result<TextFile> {
    let vfs = state.vfs(&p.session)?;
    let st = vfs.stat(&p.path).await?;
    if st.is_dir() {
        return Err(Error::IsADirectory(p.path));
    }
    let limit = p.max_bytes.unwrap_or(16 * 1024 * 1024);
    if st.size > limit {
        return Err(Error::InvalidInput(format!("file is too large to edit ({} bytes)", st.size)));
    }
    let data = rc_core::vfs::read_to_end(vfs.as_ref(), &p.path, limit).await?;
    let binary = data.iter().take(8192).any(|b| *b == 0);
    let (content, encoding) = match String::from_utf8(data) {
        Ok(s) => (s, "utf-8"),
        Err(e) => (e.into_bytes().iter().map(|&b| b as char).collect(), "latin1"),
    };
    Ok(TextFile { content, encoding, size: st.size, modified: st.modified, binary })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteParams {
    pub session: String,
    pub path: String,
    pub content: String,
    pub encoding: Option<String>,
}

pub async fn write_text(state: &AppState, p: WriteParams) -> Result<()> {
    let vfs = state.vfs(&p.session)?;
    let bytes: Vec<u8> = if p.encoding.as_deref() == Some("latin1") {
        p.content
            .chars()
            .map(|c| {
                u8::try_from(c as u32)
                    .map_err(|_| Error::InvalidInput(format!("character {c:?} cannot be saved as Latin-1")))
            })
            .collect::<Result<Vec<u8>>>()?
    } else {
        p.content.into_bytes()
    };
    // Keep the permissions of an existing file (some protocols reset them on rewrite).
    let old = vfs.try_stat(&p.path).await?;
    rc_core::vfs::write_all(vfs.as_ref(), &p.path, &bytes).await?;
    if let Some(m) = old.and_then(|o| o.permissions) {
        if vfs.capabilities().permissions {
            let _ = vfs.set_permissions(&p.path, m).await;
        }
    }
    state.emit_changed(&p.session, &vpath::parent(&p.path));
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Base64File {
    pub data: String,
    pub mime: String,
    pub size: u64,
}

pub async fn read_base64(state: &AppState, p: ReadParams) -> Result<Base64File> {
    let vfs = state.vfs(&p.session)?;
    let limit = p.max_bytes.unwrap_or(32 * 1024 * 1024);
    let data = rc_core::vfs::read_to_end(vfs.as_ref(), &p.path, limit).await?;
    Ok(Base64File {
        size: data.len() as u64,
        data: base64::engine::general_purpose::STANDARD.encode(&data),
        mime: ops::mime_for(&p.path).to_string(),
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChecksumParams {
    pub session: String,
    pub path: String,
    pub algo: ChecksumAlgo,
}

pub async fn checksum(state: &AppState, p: ChecksumParams) -> Result<String> {
    ops::checksum(state.vfs(&p.session)?.as_ref(), &p.path, p.algo).await
}

pub async fn dir_size(state: &AppState, p: SessionPath) -> Result<ops::DirSize> {
    let vfs = state.vfs(&p.session)?;
    let e = vfs.stat(&p.path).await?;
    if !e.is_dir() {
        return Ok(ops::DirSize { size: e.size, files: 1, dirs: 0 });
    }
    ops::dir_size(vfs.as_ref(), &p.path).await
}

pub async fn disk_info(state: &AppState, p: SessionPath) -> Result<Option<DiskInfo>> {
    state.vfs(&p.session)?.disk_info(&p.path).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecParams {
    pub session: String,
    pub command: String,
    pub cwd: Option<String>,
}

/// Web clients may only run local commands when the server allows terminals.
pub fn check_local_shell(state: &AppState, origin: &Origin, session: &str) -> Result<()> {
    if session == LOCAL_SESSION && matches!(origin, Origin::Web { .. }) && !state.settings.read().server.allow_terminal
    {
        return Err(Error::PermissionDenied("shell access is disabled on this server".into()));
    }
    Ok(())
}

pub async fn exec(state: &AppState, origin: &Origin, p: ExecParams) -> Result<ExecOutput> {
    check_local_shell(state, origin, &p.session)?;
    let out = state.vfs(&p.session)?.exec(&p.command, p.cwd.as_deref()).await?;
    if let Some(cwd) = &p.cwd {
        state.emit_changed(&p.session, cwd);
    }
    Ok(out)
}
