//! Copying files between any two file systems.

use std::sync::Arc;

use async_trait::async_trait;
use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::jobs::{ConflictAction, ConflictDecision, JobCtx, JobTask};
use crate::mask::FileMask;
use crate::ops::{self, WalkOptions};
use crate::path as vpath;
use crate::types::*;
use crate::vfs::Vfs;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum OverwriteMode {
    #[default]
    Ask,
    Overwrite,
    Skip,
    Newer,
    DifferentSize,
    /// Overwrite only when the content differs (SHA-256 of both sides, computed on the
    /// servers where the protocol allows it).
    DifferentChecksum,
    Resume,
    Rename,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TransferMode {
    #[default]
    Binary,
    Text,
    Auto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TransferOptions {
    #[serde(rename = "move")]
    pub move_files: bool,
    pub overwrite: OverwriteMode,
    pub preserve_timestamps: bool,
    pub preserve_permissions: bool,
    pub permissions: Option<u32>,
    pub mode: TransferMode,
    pub text_masks: String,
    pub file_mask: String,
    pub exclude_hidden: bool,
    pub speed_limit: u64,
    pub temp_upload: bool,
    pub verify_checksum: bool,
    pub parallel: u32,
    pub new_name: Option<String>,
    pub follow_symlinks: bool,
}

impl Default for TransferOptions {
    fn default() -> Self {
        TransferOptions {
            move_files: false,
            overwrite: OverwriteMode::Ask,
            preserve_timestamps: true,
            preserve_permissions: true,
            permissions: None,
            mode: TransferMode::Binary,
            text_masks: "*.txt; *.htm; *.html; *.php; *.cgi; *.c; *.cpp; *.h; *.pas; *.bas; *.tex; *.pl; *.js; .htaccess; *.xtml; *.css; *.cfg; *.ini; *.sh; *.xml".into(),
            file_mask: String::new(),
            exclude_hidden: false,
            speed_limit: 0,
            temp_upload: false,
            verify_checksum: false,
            parallel: 2,
            new_name: None,
            follow_symlinks: true,
        }
    }
}

/// A file system plus the session id it belongs to.
#[derive(Clone)]
pub struct Endpoint {
    pub session: String,
    pub vfs: Arc<dyn Vfs>,
}

impl Endpoint {
    pub fn new(session: impl Into<String>, vfs: Arc<dyn Vfs>) -> Self {
        Endpoint { session: session.into(), vfs }
    }

    fn same_fs(&self, other: &Endpoint) -> bool {
        self.session == other.session && Arc::ptr_eq(&self.vfs, &other.vfs)
    }
}

/// One file or directory to create at the target.
#[derive(Debug, Clone)]
struct Item {
    src: FileEntry,
    dst_path: String,
    is_dir: bool,
}

/// Copy/move `src_paths` into `dst_dir`.
pub struct TransferTask {
    pub src: Endpoint,
    pub src_paths: Vec<String>,
    pub dst: Endpoint,
    pub dst_dir: String,
    pub options: TransferOptions,
}

#[async_trait]
impl JobTask for TransferTask {
    async fn run(&self, ctx: &JobCtx) -> Result<()> {
        let opts = &self.options;
        let mask = FileMask::parse(&opts.file_mask).map_err(Error::InvalidInput)?;
        let text_mask = FileMask::parse(&opts.text_masks).unwrap_or_default();
        let same_fs = self.src.same_fs(&self.dst);

        // 1. Collect everything to do (and the totals).
        ctx.set_scanning(true);
        let mut dirs: Vec<Item> = Vec::new();
        let mut files: Vec<Item> = Vec::new();
        let mut moved_by_rename: Vec<(String, String)> = Vec::new();
        for (idx, src_path) in self.src_paths.iter().enumerate() {
            ctx.check().await?;
            let entry = match self.src.vfs.stat(src_path).await {
                Ok(e) => e,
                Err(e) => {
                    ctx.error(src_path, &e);
                    continue;
                }
            };
            let name = match (&opts.new_name, idx, self.src_paths.len()) {
                (Some(n), 0, 1) if !n.is_empty() => n.clone(),
                _ => entry.name.clone(),
            };
            let dst_path = vpath::join(&self.dst_dir, &name);
            if same_fs && vpath::normalize(src_path) == vpath::normalize(&dst_path) {
                if opts.move_files {
                    continue;
                }
                // Copy onto itself: duplicate with a numbered name.
                let unique = ops::unique_name(self.dst.vfs.as_ref(), &self.dst_dir, &name).await?;
                let item =
                    Item { src: entry.clone(), dst_path: vpath::join(&self.dst_dir, &unique), is_dir: entry.is_dir() };
                self.collect(ctx, item, &mask, &mut dirs, &mut files).await?;
                continue;
            }
            let is_dir = entry.is_dir() && (entry.kind == FileKind::Dir || opts.follow_symlinks);
            if same_fs && is_dir && vpath::relative_to(&dst_path, src_path).is_some() {
                ctx.error(src_path, &Error::InvalidInput("cannot copy a directory into itself".into()));
                continue;
            }
            // Fast path: move within one file system by renaming.
            if opts.move_files && same_fs && mask.is_empty() {
                match self.try_rename(ctx, &entry, &dst_path).await {
                    Ok(true) => {
                        moved_by_rename.push((src_path.clone(), dst_path));
                        continue;
                    }
                    Ok(false) => {}
                    Err(Error::Cancelled) => return Err(Error::Cancelled),
                    Err(e) => {
                        ctx.error(src_path, &e);
                        continue;
                    }
                }
            }
            let item = Item { src: entry, dst_path, is_dir };
            self.collect(ctx, item, &mask, &mut dirs, &mut files).await?;
        }
        ctx.set_scanning(false);

        // 2. Directories first (parents before children).
        for d in &dirs {
            ctx.check().await?;
            if let Err(e) = self.dst.vfs.mkdir_all(&d.dst_path).await {
                ctx.error(&d.dst_path, &e);
            }
        }

        // 3. Files, `parallel` at a time.
        let parallel = opts.parallel.clamp(1, 8) as usize;
        let text_mask = &text_mask;
        let futs: Vec<_> = files.iter().map(|item| self.copy_logged(ctx, item, text_mask)).collect();
        let results: Vec<Result<()>> = stream::iter(futs).buffer_unordered(parallel).collect().await;
        if results.iter().any(|r| matches!(r, Err(Error::Cancelled))) {
            return Err(Error::Cancelled);
        }

        // 4. Directory timestamps (deepest first) and removal of moved source dirs.
        for d in dirs.iter().rev() {
            if opts.preserve_timestamps && self.dst.vfs.capabilities().set_modified {
                if let Some(m) = d.src.modified {
                    let _ = self.dst.vfs.set_modified(&d.dst_path, m).await;
                }
            }
            if opts.move_files && !ctx.has_errors() {
                if let Err(e) = self.src.vfs.remove_dir(&d.src.path).await {
                    tracing::debug!("not removing {}: {e}", d.src.path);
                }
            }
        }
        ctx.set_current(None);
        Ok(())
    }
}

impl TransferTask {
    async fn collect(
        &self,
        ctx: &JobCtx,
        root: Item,
        mask: &FileMask,
        dirs: &mut Vec<Item>,
        files: &mut Vec<Item>,
    ) -> Result<()> {
        if !root.is_dir {
            ctx.add_total(root.src.size, 1);
            files.push(root);
            return Ok(());
        }
        let walk_opts = WalkOptions {
            mask: mask.clone(),
            exclude_hidden: self.options.exclude_hidden,
            follow_symlinks: self.options.follow_symlinks,
            ..Default::default()
        };
        let base_dst = root.dst_path.clone();
        let root_src = root.src.path.clone();
        dirs.push(root);
        let mut found: Vec<Item> = Vec::new();
        ops::walk(self.src.vfs.as_ref(), &root_src, &walk_opts, |w| {
            let dst_path = vpath::join(&base_dst, &w.rel);
            if w.is_dir {
                found.push(Item { src: w.entry, dst_path, is_dir: true });
            } else if w.entry.kind == FileKind::Symlink && w.entry.target_kind.is_none() {
                // Dangling symlink: nothing to copy.
            } else if w.entry.is_dir() {
                // Directory symlink that we do not follow.
            } else {
                ctx.add_total(w.entry.size, 1);
                found.push(Item { src: w.entry, dst_path, is_dir: false });
            }
            Ok(!ctx.is_cancelled())
        })
        .await?;
        for it in found {
            if it.is_dir {
                dirs.push(it);
            } else {
                files.push(it);
            }
        }
        Ok(())
    }

    /// Returns Ok(true) when moved by rename, Ok(false) to fall back to copy+delete.
    async fn try_rename(&self, ctx: &JobCtx, src: &FileEntry, dst_path: &str) -> Result<bool> {
        let vfs = &self.dst.vfs;
        let count_file = || {
            if !src.is_dir() {
                ctx.add_total(src.size, 1);
                ctx.add_bytes(src.size);
                ctx.file_done();
            }
        };
        if let Some(target) = vfs.try_stat(dst_path).await? {
            if src.is_dir() && target.is_dir() {
                // Merge directories: copy+delete handles that.
                return Ok(false);
            }
            if target.is_dir() {
                // As when copying: a file never replaces a whole directory tree.
                return Err(Error::IsADirectory(dst_path.to_string()));
            }
            match self.decide(ctx, src, &target).await? {
                Decision::Skip => {
                    count_file();
                    return Ok(true);
                }
                Decision::Write { path, .. } if path != dst_path => {
                    vfs.rename(&src.path, &path).await?;
                    count_file();
                    return Ok(true);
                }
                Decision::Write { offset, .. } if offset > 0 => return Ok(false),
                Decision::Write { .. } => {
                    ops::remove_any(vfs.as_ref(), dst_path).await?;
                }
            }
        }
        match vfs.rename(&src.path, dst_path).await {
            Ok(()) => {
                count_file();
                Ok(true)
            }
            Err(Error::Unsupported(_)) => Ok(false),
            Err(e) if e.code() == crate::ErrorCode::Io => Ok(false), // e.g. cross-device
            Err(e) => Err(e),
        }
    }

    /// Same SHA-256 on both sides. A checksum that cannot be computed counts as different.
    async fn same_content(&self, src: &FileEntry, target: &FileEntry) -> Result<bool> {
        let (a, b) = tokio::join!(
            ops::checksum(self.src.vfs.as_ref(), &src.path, ChecksumAlgo::Sha256),
            ops::checksum(self.dst.vfs.as_ref(), &target.path, ChecksumAlgo::Sha256)
        );
        match (a, b) {
            (Ok(a), Ok(b)) => Ok(a == b),
            (Err(Error::Cancelled), _) | (_, Err(Error::Cancelled)) => Err(Error::Cancelled),
            (Err(e), _) | (_, Err(e)) => {
                tracing::debug!("checksum of {} for comparison failed: {e}", src.path);
                Ok(false)
            }
        }
    }

    async fn decide(&self, ctx: &JobCtx, src: &FileEntry, target: &FileEntry) -> Result<Decision> {
        let opts = &self.options;
        let mut mode = opts.overwrite;
        let mut new_name = None;
        if mode == OverwriteMode::Ask {
            let d: ConflictDecision = ctx.ask_conflict(src.clone(), target.clone()).await?;
            mode = match d.action {
                ConflictAction::Overwrite => OverwriteMode::Overwrite,
                ConflictAction::Skip => OverwriteMode::Skip,
                ConflictAction::Resume => OverwriteMode::Resume,
                ConflictAction::Newer => OverwriteMode::Newer,
                ConflictAction::Rename => {
                    new_name = d.new_name.filter(|n| vpath::is_valid_name(n));
                    OverwriteMode::Rename
                }
                ConflictAction::Cancel => return Err(Error::Cancelled),
            };
        }
        let dir = vpath::parent(&target.path);
        Ok(match mode {
            OverwriteMode::Ask | OverwriteMode::Overwrite => Decision::Write { path: target.path.clone(), offset: 0 },
            OverwriteMode::Skip => Decision::Skip,
            OverwriteMode::Newer => match (src.modified, target.modified) {
                (Some(s), Some(t)) if s > t => Decision::Write { path: target.path.clone(), offset: 0 },
                (_, None) => Decision::Write { path: target.path.clone(), offset: 0 },
                _ => Decision::Skip,
            },
            OverwriteMode::DifferentSize => {
                if src.size != target.size {
                    Decision::Write { path: target.path.clone(), offset: 0 }
                } else {
                    Decision::Skip
                }
            }
            OverwriteMode::DifferentChecksum => {
                if src.size != target.size || target.is_dir() || !self.same_content(src, target).await? {
                    Decision::Write { path: target.path.clone(), offset: 0 }
                } else {
                    Decision::Skip
                }
            }
            OverwriteMode::Resume => {
                if target.size < src.size && !target.is_dir() {
                    Decision::Write { path: target.path.clone(), offset: target.size }
                } else if target.size == src.size {
                    Decision::Skip
                } else {
                    Decision::Write { path: target.path.clone(), offset: 0 }
                }
            }
            OverwriteMode::Rename => {
                let name = match new_name {
                    Some(n) => n,
                    None => ops::unique_name(self.dst.vfs.as_ref(), &dir, &target.name).await?,
                };
                Decision::Write { path: vpath::join(&dir, &name), offset: 0 }
            }
        })
    }

    /// Copy one file; errors other than cancellation are recorded in the job.
    async fn copy_logged(&self, ctx: &JobCtx, item: &Item, text_mask: &FileMask) -> Result<()> {
        match self.copy_one(ctx, item, text_mask).await {
            Err(Error::Cancelled) => Err(Error::Cancelled),
            Err(e) => {
                ctx.error(&item.src.path, &e);
                Ok(())
            }
            Ok(()) => Ok(()),
        }
    }

    async fn copy_one(&self, ctx: &JobCtx, item: &Item, text_mask: &FileMask) -> Result<()> {
        ctx.check().await?;
        let opts = &self.options;
        let src = &item.src;
        let mut dst_path = item.dst_path.clone();
        let mut offset = 0u64;
        if let Some(target) = self.dst.vfs.try_stat(&dst_path).await? {
            if target.is_dir() {
                return Err(Error::IsADirectory(dst_path));
            }
            match self.decide(ctx, src, &target).await? {
                Decision::Skip => {
                    ctx.add_bytes(src.size);
                    ctx.file_done();
                    return Ok(());
                }
                Decision::Write { path, offset: o } => {
                    dst_path = path;
                    offset = o;
                }
            }
        }
        let text = match opts.mode {
            TransferMode::Text => true,
            TransferMode::Auto => text_mask.matches_name(&src.name),
            TransferMode::Binary => false,
        };
        if text {
            offset = 0;
        }
        let caps_dst = self.dst.vfs.capabilities();
        let caps_src = self.src.vfs.capabilities();
        if offset > 0 && !(caps_dst.resume_upload && caps_src.resume_download) {
            offset = 0;
        }
        ctx.set_current(Some(&src.path));
        let write_path = if opts.temp_upload && offset == 0 && self.dst.vfs.protocol() != Protocol::Local {
            format!("{dst_path}.filepart")
        } else {
            dst_path.clone()
        };
        if offset > 0 {
            ctx.add_bytes(offset);
        }

        let same_fs = self.src.same_fs(&self.dst);
        let mut copied = false;
        if same_fs && !text && offset == 0 && caps_dst.server_copy {
            match self.dst.vfs.copy_file(&src.path, &write_path).await {
                Ok(()) => {
                    ctx.add_bytes(src.size);
                    copied = true;
                }
                Err(Error::Unsupported(_)) => {}
                Err(e) => return Err(e),
            }
        }
        if !copied {
            if let Err(e) = self.stream(ctx, src, &write_path, offset, text).await {
                if matches!(e, Error::Cancelled) && offset == 0 && write_path != dst_path {
                    let _ = self.dst.vfs.remove_file(&write_path).await;
                }
                return Err(e);
            }
        }
        if write_path != dst_path {
            if let Err(e) = self.dst.vfs.rename(&write_path, &dst_path).await {
                // Some servers refuse to overwrite on rename.
                let _ = self.dst.vfs.remove_file(&dst_path).await;
                self.dst.vfs.rename(&write_path, &dst_path).await.map_err(|_| e)?;
            }
        }

        // Attributes.
        if opts.preserve_timestamps && caps_dst.set_modified {
            if let Some(m) = src.modified {
                if let Err(e) = self.dst.vfs.set_modified(&dst_path, m).await {
                    tracing::debug!("set mtime {dst_path}: {e}");
                }
            }
        }
        if caps_dst.permissions {
            let mode = opts.permissions.or(if opts.preserve_permissions && caps_src.permissions {
                src.permissions
            } else {
                None
            });
            if let Some(m) = mode {
                if let Err(e) = self.dst.vfs.set_permissions(&dst_path, m).await {
                    tracing::debug!("chmod {dst_path}: {e}");
                }
            }
        }
        if opts.verify_checksum && !text {
            let (a, b) = tokio::join!(
                ops::checksum(self.src.vfs.as_ref(), &src.path, ChecksumAlgo::Sha256),
                ops::checksum(self.dst.vfs.as_ref(), &dst_path, ChecksumAlgo::Sha256)
            );
            let (a, b) = (a?, b?);
            if a != b {
                return Err(Error::Other(format!("checksum mismatch after transfer ({a} != {b})")));
            }
        }
        if opts.move_files {
            self.src.vfs.remove_file(&src.path).await?;
        }
        ctx.file_done();
        Ok(())
    }

    async fn stream(&self, ctx: &JobCtx, src: &FileEntry, dst_path: &str, offset: u64, text: bool) -> Result<()> {
        let mut reader = self.src.vfs.open_read(&src.path, offset).await?;
        let mut writer = self
            .dst
            .vfs
            .open_write(
                dst_path,
                crate::types::WriteOptions {
                    offset,
                    // Line-ending conversion changes the size (SCP announces it up front).
                    size_hint: (!text).then(|| src.size.saturating_sub(offset)),
                    mode: None,
                },
            )
            .await?;
        let to_crlf = text && self.dst.vfs.protocol() == Protocol::Local && cfg!(windows);
        let mut conv = LineEndings::default();
        let mut buf = vec![0u8; 256 * 1024];
        let mut transferred = 0u64;
        let token = ctx.cancel_token();
        loop {
            ctx.check().await?;
            let n = tokio::select! {
                r = reader.read(&mut buf) => r?,
                _ = token.cancelled() => return Err(Error::Cancelled),
            };
            if n == 0 {
                break;
            }
            ctx.limiter().consume(n).await;
            if text {
                let out = conv.convert(&buf[..n], to_crlf);
                writer.write_all(&out).await?;
            } else {
                writer.write_all(&buf[..n]).await?;
            }
            transferred += n as u64;
            ctx.add_bytes(n as u64);
        }
        writer.finish().await?;
        // The source may have shrunk meanwhile; keep the totals honest.
        let expected = src.size.saturating_sub(offset);
        if transferred < expected {
            ctx.add_bytes(expected - transferred);
        }
        Ok(())
    }
}

enum Decision {
    Skip,
    Write { path: String, offset: u64 },
}

/// Streaming line-ending conversion for text mode.
#[derive(Default)]
struct LineEndings {
    last_cr: bool,
}

impl LineEndings {
    fn convert(&mut self, data: &[u8], to_crlf: bool) -> Vec<u8> {
        let mut out = Vec::with_capacity(data.len() + data.len() / 32);
        for &b in data {
            if to_crlf {
                if b == b'\n' && !self.last_cr {
                    out.push(b'\r');
                }
                out.push(b);
            } else {
                match b {
                    // CR and CRLF both become LF (a lone CR is an old Mac line break).
                    b'\r' => out.push(b'\n'),
                    b'\n' if self.last_cr => {}
                    _ => out.push(b),
                }
            }
            self.last_cr = b == b'\r';
        }
        out
    }
}

/// Delete files and directory trees.
pub struct DeleteTask {
    pub target: Endpoint,
    pub paths: Vec<String>,
}

#[async_trait]
impl JobTask for DeleteTask {
    async fn run(&self, ctx: &JobCtx) -> Result<()> {
        let vfs = self.target.vfs.as_ref();
        ctx.set_scanning(true);
        let mut plan: Vec<(FileEntry, Vec<ops::WalkItem>)> = Vec::new();
        for p in &self.paths {
            ctx.check().await?;
            let entry = match vfs.stat(p).await {
                Ok(e) => e,
                Err(e) => {
                    ctx.error(p, &e);
                    continue;
                }
            };
            let mut children = Vec::new();
            if entry.kind == FileKind::Dir && vfs.protocol() != Protocol::Local {
                ops::walk(vfs, p, &WalkOptions::default(), |w| {
                    children.push(w);
                    Ok(!ctx.is_cancelled())
                })
                .await?;
            }
            ctx.add_total(0, 1 + children.iter().filter(|c| !c.is_dir).count() as u64);
            plan.push((entry, children));
        }
        ctx.set_scanning(false);
        for (entry, children) in plan {
            ctx.check().await?;
            ctx.set_current(Some(&entry.path));
            if entry.kind != FileKind::Dir {
                match vfs.remove_file(&entry.path).await {
                    Ok(()) => ctx.file_done(),
                    Err(e) => ctx.error(&entry.path, &e),
                }
                continue;
            }
            if vfs.protocol() == Protocol::Local {
                match vfs.remove_dir_all(&entry.path).await {
                    Ok(()) => ctx.file_done(),
                    Err(e) => ctx.error(&entry.path, &e),
                }
                continue;
            }
            // Files (in parallel), then directories deepest first.
            let files: Vec<&ops::WalkItem> = children.iter().filter(|c| !c.is_dir).collect();
            let futs: Vec<_> = files.into_iter().map(|c| remove_counted(ctx, vfs, c)).collect();
            let results: Vec<Result<()>> = stream::iter(futs).buffer_unordered(4).collect().await;
            if results.iter().any(|r| r.is_err()) {
                return Err(Error::Cancelled);
            }
            let mut dirs: Vec<&ops::WalkItem> = children.iter().filter(|c| c.is_dir).collect();
            dirs.sort_by_key(|d| std::cmp::Reverse(d.depth));
            for d in dirs {
                ctx.check().await?;
                // Directory symlinks are removed as files.
                let r = if d.entry.kind == FileKind::Symlink {
                    vfs.remove_file(&d.entry.path).await
                } else {
                    vfs.remove_dir(&d.entry.path).await
                };
                if let Err(e) = r {
                    ctx.error(&d.entry.path, &e);
                }
            }
            match vfs.remove_dir(&entry.path).await {
                Ok(()) => ctx.file_done(),
                Err(e) => ctx.error(&entry.path, &e),
            }
        }
        ctx.set_current(None);
        Ok(())
    }
}

async fn remove_counted(ctx: &JobCtx, vfs: &dyn Vfs, c: &ops::WalkItem) -> Result<()> {
    ctx.check().await?;
    match vfs.remove_file(&c.entry.path).await {
        Ok(()) => ctx.file_done(),
        Err(e) => ctx.error(&c.entry.path, &e),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::{JobKind, JobQueue, JobSpec, JobState};
    use crate::local::{from_native, LocalVfs};
    use crate::vfs::{read_to_end, write_all};

    fn queue() -> JobQueue {
        JobQueue::new(2, Arc::new(|_| {}))
    }

    async fn setup() -> (tempfile::TempDir, String, Arc<dyn Vfs>) {
        let dir = tempfile::tempdir().unwrap();
        let base = from_native(dir.path());
        let vfs: Arc<dyn Vfs> = Arc::new(LocalVfs::new());
        for (p, c) in [("src/a.txt", "aaa"), ("src/sub/b.txt", "bbbb"), ("src/sub/c.log", "c")] {
            let full = vpath::join(&base, p);
            vfs.mkdir_all(&vpath::parent(&full)).await.unwrap();
            write_all(vfs.as_ref(), &full, c.as_bytes()).await.unwrap();
        }
        vfs.mkdir(&vpath::join(&base, "dst")).await.unwrap();
        (dir, base, vfs)
    }

    #[tokio::test]
    async fn copy_tree_and_conflicts() {
        let (_d, base, vfs) = setup().await;
        let q = queue();
        let ep = Endpoint::new("local", vfs.clone());
        let task = TransferTask {
            src: ep.clone(),
            src_paths: vec![vpath::join(&base, "src")],
            dst: ep.clone(),
            dst_dir: vpath::join(&base, "dst"),
            options: TransferOptions {
                overwrite: OverwriteMode::Overwrite,
                file_mask: "| *.log".into(),
                ..Default::default()
            },
        };
        let job = q.submit(JobKind::Transfer, JobSpec::default(), Arc::new(task), 0);
        let done = q.wait(&job.id).await.unwrap();
        assert_eq!(done.state, JobState::Completed, "{:?}", done.errors);
        assert_eq!(done.files_done, 2);
        assert_eq!(done.bytes_done, 7);
        let b = read_to_end(vfs.as_ref(), &vpath::join(&base, "dst/src/sub/b.txt"), 100).await.unwrap();
        assert_eq!(b, b"bbbb");
        assert!(vfs.try_stat(&vpath::join(&base, "dst/src/sub/c.log")).await.unwrap().is_none());

        // Ask → answer skip for all.
        let task = TransferTask {
            src: ep.clone(),
            src_paths: vec![vpath::join(&base, "src")],
            dst: ep.clone(),
            dst_dir: vpath::join(&base, "dst"),
            options: TransferOptions { overwrite: OverwriteMode::Ask, ..Default::default() },
        };
        let job = q.submit(JobKind::Transfer, JobSpec::default(), Arc::new(task), 0);
        let mut answered = false;
        loop {
            let j = q.get(&job.id).unwrap();
            if let Some(c) = &j.conflict {
                q.resolve_conflict(
                    &job.id,
                    &c.id,
                    ConflictDecision { action: ConflictAction::Skip, new_name: None },
                    true,
                )
                .unwrap();
                answered = true;
            }
            if j.state.is_finished() {
                assert_eq!(j.state, JobState::Completed);
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(answered);

        // Move by rename within the same fs.
        let task = TransferTask {
            src: ep.clone(),
            src_paths: vec![vpath::join(&base, "src/a.txt")],
            dst: ep.clone(),
            dst_dir: vpath::join(&base, "dst"),
            options: TransferOptions { move_files: true, overwrite: OverwriteMode::Overwrite, ..Default::default() },
        };
        let job = q.submit(JobKind::Transfer, JobSpec::default(), Arc::new(task), 0);
        assert_eq!(q.wait(&job.id).await.unwrap().state, JobState::Completed);
        assert!(vfs.try_stat(&vpath::join(&base, "src/a.txt")).await.unwrap().is_none());
        assert!(vfs.try_stat(&vpath::join(&base, "dst/a.txt")).await.unwrap().is_some());

        // Duplicate onto itself.
        let task = TransferTask {
            src: ep.clone(),
            src_paths: vec![vpath::join(&base, "dst/a.txt")],
            dst: ep.clone(),
            dst_dir: vpath::join(&base, "dst"),
            options: TransferOptions::default(),
        };
        let job = q.submit(JobKind::Transfer, JobSpec::default(), Arc::new(task), 0);
        assert_eq!(q.wait(&job.id).await.unwrap().state, JobState::Completed);
        assert!(vfs.try_stat(&vpath::join(&base, "dst/a (1).txt")).await.unwrap().is_some());

        // Delete job.
        let task = DeleteTask { target: ep.clone(), paths: vec![vpath::join(&base, "dst/src")] };
        let job = q.submit(JobKind::Delete, JobSpec::default(), Arc::new(task), 0);
        assert_eq!(q.wait(&job.id).await.unwrap().state, JobState::Completed);
        assert!(vfs.try_stat(&vpath::join(&base, "dst/src")).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn overwrite_only_changed_content() {
        let (_d, base, vfs) = setup().await;
        // dst/src/a.txt: same content; sub/b.txt: same size, other content; sub/c.log: missing
        for (p, c) in [("dst/src/a.txt", "aaa"), ("dst/src/sub/b.txt", "BBBB")] {
            let full = vpath::join(&base, p);
            vfs.mkdir_all(&vpath::parent(&full)).await.unwrap();
            write_all(vfs.as_ref(), &full, c.as_bytes()).await.unwrap();
        }
        let a = vpath::join(&base, "dst/src/a.txt");
        vfs.set_modified(&a, 1_000_000).await.unwrap();
        let q = queue();
        let ep = Endpoint::new("local", vfs.clone());
        let task = TransferTask {
            src: ep.clone(),
            src_paths: vec![vpath::join(&base, "src")],
            dst: ep,
            dst_dir: vpath::join(&base, "dst"),
            options: TransferOptions { overwrite: OverwriteMode::DifferentChecksum, ..Default::default() },
        };
        let job = q.submit(JobKind::Transfer, JobSpec::default(), Arc::new(task), 0);
        let done = q.wait(&job.id).await.unwrap();
        assert_eq!(done.state, JobState::Completed, "{:?}", done.errors);
        // the identical file was skipped (its old timestamp proves it was not rewritten)
        assert_eq!(vfs.stat(&a).await.unwrap().modified, Some(1_000_000));
        let b = read_to_end(vfs.as_ref(), &vpath::join(&base, "dst/src/sub/b.txt"), 100).await.unwrap();
        assert_eq!(b, b"bbbb");
        assert!(vfs.try_stat(&vpath::join(&base, "dst/src/sub/c.log")).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn resume_and_verify() {
        let (_d, base, vfs) = setup().await;
        let big: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
        let src = vpath::join(&base, "big.bin");
        write_all(vfs.as_ref(), &src, &big).await.unwrap();
        let dst = vpath::join(&base, "dst/big.bin");
        write_all(vfs.as_ref(), &dst, &big[..1_000_000]).await.unwrap();
        let q = queue();
        let ep = Endpoint::new("local", vfs.clone());
        // Use a second endpoint so the same-fs server-side copy is not taken.
        let ep2 = Endpoint::new("local2", Arc::new(LocalVfs::new()));
        let task = TransferTask {
            src: ep,
            src_paths: vec![src],
            dst: ep2,
            dst_dir: vpath::join(&base, "dst"),
            options: TransferOptions { overwrite: OverwriteMode::Resume, verify_checksum: true, ..Default::default() },
        };
        let job = q.submit(JobKind::Transfer, JobSpec::default(), Arc::new(task), 0);
        let done = q.wait(&job.id).await.unwrap();
        assert_eq!(done.state, JobState::Completed, "{:?}", done.errors);
        assert_eq!(read_to_end(vfs.as_ref(), &dst, 10_000_000).await.unwrap(), big);
    }

    #[tokio::test]
    async fn move_never_replaces_a_directory_with_a_file() {
        let (_d, base, vfs) = setup().await;
        // dst/a.txt is a directory with content; moving the file src/a.txt there must fail.
        let keep = vpath::join(&base, "dst/a.txt/keep");
        vfs.mkdir_all(&vpath::parent(&keep)).await.unwrap();
        write_all(vfs.as_ref(), &keep, b"k").await.unwrap();
        let q = queue();
        let ep = Endpoint::new("local", vfs.clone());
        let task = TransferTask {
            src: ep.clone(),
            src_paths: vec![vpath::join(&base, "src/a.txt")],
            dst: ep,
            dst_dir: vpath::join(&base, "dst"),
            options: TransferOptions { move_files: true, overwrite: OverwriteMode::Overwrite, ..Default::default() },
        };
        let job = q.submit(JobKind::Transfer, JobSpec::default(), Arc::new(task), 0);
        assert_eq!(q.wait(&job.id).await.unwrap().state, JobState::Failed);
        assert!(vfs.try_stat(&keep).await.unwrap().is_some());
        assert!(vfs.try_stat(&vpath::join(&base, "src/a.txt")).await.unwrap().is_some());
    }

    #[test]
    fn line_endings() {
        let mut c = LineEndings::default();
        assert_eq!(c.convert(b"a\r\nb\r", false), b"a\nb\n");
        assert_eq!(c.convert(b"\nc", false), b"c");
        let mut c = LineEndings::default();
        assert_eq!(c.convert(b"a\nb\r\n", true), b"a\r\nb\r\n");
    }
}
