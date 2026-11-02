//! Directory synchronization: compare two trees, review the plan, execute it.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use async_trait::async_trait;
use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::jobs::{journal_key, JobCtx, JobTask};
use crate::mask::FileMask;
use crate::ops::{self, WalkOptions};
use crate::path as vpath;
use crate::transfer::{DeleteTask, Endpoint, OverwriteMode, TransferOptions, TransferTask};
use crate::types::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SyncDirection {
    #[default]
    LeftToRight,
    RightToLeft,
    Both,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum SyncMode {
    #[default]
    Update,
    Mirror,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SyncParams {
    pub left_session: String,
    pub left_path: String,
    pub right_session: String,
    pub right_path: String,
    pub direction: SyncDirection,
    pub mode: SyncMode,
    pub delete_obsolete: bool,
    pub compare_size: bool,
    pub compare_time: bool,
    pub compare_checksum: bool,
    pub time_tolerance: i64,
    pub file_mask: String,
    pub exclude_hidden: bool,
    pub non_recursive: bool,
}

impl Default for SyncParams {
    fn default() -> Self {
        SyncParams {
            left_session: "local".into(),
            left_path: String::new(),
            right_session: String::new(),
            right_path: String::new(),
            direction: SyncDirection::LeftToRight,
            mode: SyncMode::Update,
            delete_obsolete: false,
            compare_size: true,
            compare_time: true,
            compare_checksum: false,
            time_tolerance: 2,
            file_mask: String::new(),
            exclude_hidden: false,
            non_recursive: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncActionKind {
    CopyLeftToRight,
    CopyRightToLeft,
    DeleteLeft,
    DeleteRight,
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncReason {
    New,
    Newer,
    Older,
    SizeDiffers,
    ChecksumDiffers,
    Obsolete,
    BothChanged,
}

/// How the user resolved a conflict (both sides changed).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConflictResolution {
    /// The left version replaces the right one.
    LeftWins,
    RightWins,
    /// Both versions end up on both sides: the right one under a numbered name.
    KeepBoth,
    Skip,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncAction {
    pub id: String,
    pub rel_path: String,
    pub is_dir: bool,
    pub action: SyncActionKind,
    pub reason: SyncReason,
    pub left: Option<FileEntry>,
    pub right: Option<FileEntry>,
    /// For conflicts: what to do (unset = skip).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<ConflictResolution>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPlan {
    pub id: String,
    pub params: SyncParams,
    pub actions: Vec<SyncAction>,
    pub scanned_left: u64,
    pub scanned_right: u64,
    pub identical: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    pub scanned_left: u64,
    pub scanned_right: u64,
    pub current: String,
}

struct Side {
    entries: BTreeMap<String, (FileEntry, bool)>,
}

async fn scan(
    vfs: &dyn crate::Vfs,
    root: &str,
    params: &SyncParams,
    mask: &FileMask,
    mut progress: impl FnMut(u64, &str),
) -> Result<Side> {
    let mut entries = BTreeMap::new();
    let opts = WalkOptions {
        mask: mask.clone(),
        exclude_hidden: params.exclude_hidden,
        follow_symlinks: false,
        max_depth: if params.non_recursive { Some(1) } else { None },
        concurrency: 8,
    };
    let mut n = 0u64;
    ops::walk(vfs, root, &opts, |item| {
        n += 1;
        if n.is_multiple_of(50) {
            progress(n, &item.entry.path);
        }
        entries.insert(item.rel, (item.entry, item.is_dir));
        Ok(true)
    })
    .await?;
    progress(n, root);
    Ok(Side { entries })
}

/// Object stores list upload times; the original time of a file is in its metadata, which
/// only `stat` returns. Fetch it for the files that exist on both sides (the ones whose
/// times are compared).
async fn read_stored_times(vfs: &dyn crate::Vfs, side: &mut Side, other: &Side) {
    if !matches!(vfs.protocol(), Protocol::S3 | Protocol::Azure | Protocol::Gcs) {
        return;
    }
    let common: Vec<(String, String)> = side
        .entries
        .iter()
        .filter(|(rel, (_, is_dir))| !is_dir && other.entries.get(*rel).is_some_and(|(_, d)| !d))
        .map(|(rel, (e, _))| (rel.clone(), e.path.clone()))
        .collect();
    let stats: Vec<(String, Option<i64>)> = stream::iter(common)
        .map(|(rel, path)| async move {
            let m = vfs.stat(&path).await.ok().and_then(|e| e.modified);
            (rel, m)
        })
        .buffer_unordered(16)
        .collect()
        .await;
    for (rel, m) in stats {
        if let (Some(m), Some((e, _))) = (m, side.entries.get_mut(&rel)) {
            e.modified = Some(m);
        }
    }
}

/// Compare two directory trees and produce the list of actions.
pub async fn compare(
    left: &dyn crate::Vfs,
    right: &dyn crate::Vfs,
    params: &SyncParams,
    progress: impl Fn(SyncProgress) + Send + Sync,
) -> Result<SyncPlan> {
    let mask = FileMask::parse(&params.file_mask).map_err(Error::InvalidInput)?;
    if left.try_stat(&params.left_path).await?.is_none() {
        return Err(Error::NotFound(params.left_path.clone()));
    }
    if right.try_stat(&params.right_path).await?.is_none() {
        if params.direction == SyncDirection::LeftToRight {
            right.mkdir_all(&params.right_path).await?;
        } else {
            return Err(Error::NotFound(params.right_path.clone()));
        }
    }
    let counters = parking_lot::Mutex::new((0u64, 0u64));
    let (l, r) = tokio::join!(
        scan(left, &params.left_path, params, &mask, |n, cur| {
            let mut c = counters.lock();
            c.0 = n;
            progress(SyncProgress { scanned_left: c.0, scanned_right: c.1, current: cur.to_string() });
        }),
        scan(right, &params.right_path, params, &mask, |n, cur| {
            let mut c = counters.lock();
            c.1 = n;
            progress(SyncProgress { scanned_left: c.0, scanned_right: c.1, current: cur.to_string() });
        })
    );
    let (mut l, mut r) = (l?, r?);
    if params.compare_time {
        read_stored_times(left, &mut l, &r).await;
        read_stored_times(right, &mut r, &l).await;
    }

    let all: BTreeSet<&String> = l.entries.keys().chain(r.entries.keys()).collect();
    let mut actions = Vec::new();
    let mut identical = 0u64;
    // Relative dirs that are copied/deleted as a whole: children are covered by them.
    let mut covered: Vec<String> = Vec::new();
    let is_covered = |rel: &str, covered: &Vec<String>| covered.iter().any(|c| rel.starts_with(&format!("{c}/")));
    let to_right = matches!(params.direction, SyncDirection::LeftToRight | SyncDirection::Both);
    let to_left = matches!(params.direction, SyncDirection::RightToLeft | SyncDirection::Both);
    let deletes = params.delete_obsolete && params.direction != SyncDirection::Both;
    let mut checksum_candidates: Vec<(String, FileEntry, FileEntry)> = Vec::new();

    for rel in all {
        if is_covered(rel, &covered) {
            continue;
        }
        let le = l.entries.get(rel);
        let re = r.entries.get(rel);
        let mk = |action, reason, is_dir: bool, left: Option<&FileEntry>, right: Option<&FileEntry>| SyncAction {
            id: uuid::Uuid::new_v4().to_string(),
            rel_path: rel.clone(),
            is_dir,
            action,
            reason,
            left: left.cloned(),
            right: right.cloned(),
            resolution: None,
        };
        match (le, re) {
            (Some((le, ldir)), None) => {
                if to_right {
                    actions.push(mk(SyncActionKind::CopyLeftToRight, SyncReason::New, *ldir, Some(le), None));
                } else if deletes {
                    actions.push(mk(SyncActionKind::DeleteLeft, SyncReason::Obsolete, *ldir, Some(le), None));
                }
                if *ldir {
                    covered.push(rel.clone());
                }
            }
            (None, Some((re, rdir))) => {
                if to_left {
                    actions.push(mk(SyncActionKind::CopyRightToLeft, SyncReason::New, *rdir, None, Some(re)));
                } else if deletes {
                    actions.push(mk(SyncActionKind::DeleteRight, SyncReason::Obsolete, *rdir, None, Some(re)));
                }
                if *rdir {
                    covered.push(rel.clone());
                }
            }
            (Some((le, true)), Some((re, true))) => {
                let _ = (le, re);
            }
            (Some((le, ldir)), Some((re, rdir))) if ldir != rdir => {
                actions.push(mk(SyncActionKind::Conflict, SyncReason::BothChanged, false, Some(le), Some(re)));
                // The directory's content belongs to the conflict, not to separate actions.
                covered.push(rel.clone());
            }
            (Some((le, _)), Some((re, _))) => {
                let size_diff = params.compare_size && le.size != re.size;
                let (lt, rt) = (le.modified.unwrap_or(0), re.modified.unwrap_or(0));
                let time_diff = params.compare_time && (lt - rt).abs() > params.time_tolerance.max(0);
                if !size_diff && !time_diff {
                    if params.compare_checksum {
                        checksum_candidates.push((rel.clone(), le.clone(), re.clone()));
                    } else {
                        identical += 1;
                    }
                    continue;
                }
                let left_newer = time_diff && lt > rt;
                let right_newer = time_diff && rt > lt;
                let reason_for = |src_newer: bool| {
                    if src_newer {
                        SyncReason::Newer
                    } else if time_diff {
                        SyncReason::Older
                    } else {
                        SyncReason::SizeDiffers
                    }
                };
                match params.direction {
                    SyncDirection::LeftToRight => {
                        if left_newer || !time_diff || params.mode == SyncMode::Mirror {
                            actions.push(mk(
                                SyncActionKind::CopyLeftToRight,
                                reason_for(left_newer),
                                false,
                                Some(le),
                                Some(re),
                            ));
                        } else {
                            identical += 1;
                        }
                    }
                    SyncDirection::RightToLeft => {
                        if right_newer || !time_diff || params.mode == SyncMode::Mirror {
                            actions.push(mk(
                                SyncActionKind::CopyRightToLeft,
                                reason_for(right_newer),
                                false,
                                Some(le),
                                Some(re),
                            ));
                        } else {
                            identical += 1;
                        }
                    }
                    SyncDirection::Both => {
                        if left_newer {
                            actions.push(mk(
                                SyncActionKind::CopyLeftToRight,
                                SyncReason::Newer,
                                false,
                                Some(le),
                                Some(re),
                            ));
                        } else if right_newer {
                            actions.push(mk(
                                SyncActionKind::CopyRightToLeft,
                                SyncReason::Newer,
                                false,
                                Some(le),
                                Some(re),
                            ));
                        } else {
                            actions.push(mk(
                                SyncActionKind::Conflict,
                                SyncReason::SizeDiffers,
                                false,
                                Some(le),
                                Some(re),
                            ));
                        }
                    }
                }
            }
            (None, None) => {}
        }
    }

    // Checksums for files that look identical (a few at a time; the strongest algorithm
    // both servers compute themselves, so object stores answer from their metadata).
    let algo = ops::preferred_algo(left, right);
    let progress = &progress;
    type Checked = (String, FileEntry, FileEntry, Result<String>, Result<String>);
    let mut checked: Vec<Checked> = stream::iter(checksum_candidates)
        .map(|(rel, le, re)| async move {
            let (a, b) = tokio::join!(ops::checksum(left, &le.path, algo), ops::checksum(right, &re.path, algo));
            progress(SyncProgress { scanned_left: 0, scanned_right: 0, current: le.path.clone() });
            (rel, le, re, a, b)
        })
        .buffer_unordered(4)
        .collect()
        .await;
    checked.sort_by(|a, b| a.0.cmp(&b.0));
    for (rel, le, re, a, b) in checked {
        if a? == b? {
            identical += 1;
            continue;
        }
        let action = match params.direction {
            SyncDirection::LeftToRight => SyncActionKind::CopyLeftToRight,
            SyncDirection::RightToLeft => SyncActionKind::CopyRightToLeft,
            SyncDirection::Both => SyncActionKind::Conflict,
        };
        actions.push(SyncAction {
            id: uuid::Uuid::new_v4().to_string(),
            rel_path: rel,
            is_dir: false,
            action,
            reason: SyncReason::ChecksumDiffers,
            left: Some(le),
            right: Some(re),
            resolution: None,
        });
    }

    Ok(SyncPlan {
        id: uuid::Uuid::new_v4().to_string(),
        params: params.clone(),
        actions,
        scanned_left: l.entries.len() as u64,
        scanned_right: r.entries.len() as u64,
        identical,
    })
}

/// Execute selected actions of a plan.
pub struct SyncTask {
    pub left: Endpoint,
    pub right: Endpoint,
    pub params: SyncParams,
    pub actions: Vec<SyncAction>,
    pub options: TransferOptions,
}

impl SyncTask {
    fn paths(&self, a: &SyncAction) -> (String, String) {
        (vpath::join(&self.params.left_path, &a.rel_path), vpath::join(&self.params.right_path, &a.rel_path))
    }

    /// Keep both versions: the right one is renamed (`name (1).ext`), then the left version
    /// is copied to the right and the renamed right version to the left.
    async fn keep_both(&self, ctx: &JobCtx, a: &SyncAction, opts: &TransferOptions) -> Result<()> {
        let key = journal_key("keep-both", &a.rel_path);
        if ctx.journal_done(&key) {
            return Ok(());
        }
        let (lp, rp) = self.paths(a);
        let (ldir, rdir) = (vpath::parent(&lp), vpath::parent(&rp));
        let name = vpath::file_name(&rp).to_string();
        let new_name = match ctx.journal_was_active(&key) {
            Some((n, _)) => n,
            None => {
                let mut n = 1;
                loop {
                    let cand = vpath::numbered_name(&name, n);
                    let free_right = self.right.vfs.try_stat(&vpath::join(&rdir, &cand)).await?.is_none();
                    if free_right && self.left.vfs.try_stat(&vpath::join(&ldir, &cand)).await?.is_none() {
                        break cand;
                    }
                    n += 1;
                    if n > 9999 {
                        return Err(Error::other("cannot find a free file name"));
                    }
                }
            }
        };
        ctx.journal_start(&key, &new_name, &new_name);
        let renamed = vpath::join(&rdir, &new_name);
        if self.right.vfs.try_stat(&renamed).await?.is_none() {
            self.right.vfs.rename(&rp, &renamed).await?;
        }
        TransferTask {
            src: self.left.clone(),
            src_paths: vec![lp],
            dst: self.right.clone(),
            dst_dir: rdir,
            options: opts.clone(),
        }
        .run(ctx)
        .await?;
        TransferTask {
            src: self.right.clone(),
            src_paths: vec![renamed],
            dst: self.left.clone(),
            dst_dir: ldir,
            options: opts.clone(),
        }
        .run(ctx)
        .await?;
        ctx.journal_finish(&key);
        Ok(())
    }
}

#[async_trait]
impl JobTask for SyncTask {
    async fn run(&self, ctx: &JobCtx) -> Result<()> {
        let mut opts = self.options.clone();
        opts.overwrite = OverwriteMode::Overwrite;
        opts.move_files = false;
        opts.new_name = None;
        opts.file_mask = self.params.file_mask.clone();
        opts.exclude_hidden = self.params.exclude_hidden;

        // Copies grouped by (direction, target directory).
        let mut groups: BTreeMap<(bool, String), Vec<String>> = BTreeMap::new();
        let mut delete_left = Vec::new();
        let mut delete_right = Vec::new();
        // A resolved conflict between a file and a directory replaces the losing entry.
        let mut replace_left = Vec::new();
        let mut replace_right = Vec::new();
        let mut keep_both = Vec::new();
        for a in &self.actions {
            let (lp, rp) = self.paths(a);
            let differ = |x: &Option<FileEntry>, y: &Option<FileEntry>| match (x, y) {
                (Some(x), Some(y)) => x.is_dir() != y.is_dir(),
                _ => false,
            };
            match a.action {
                SyncActionKind::CopyLeftToRight => groups.entry((true, vpath::parent(&rp))).or_default().push(lp),
                SyncActionKind::CopyRightToLeft => groups.entry((false, vpath::parent(&lp))).or_default().push(rp),
                SyncActionKind::DeleteLeft => delete_left.push(lp),
                SyncActionKind::DeleteRight => delete_right.push(rp),
                SyncActionKind::Conflict => match a.resolution {
                    Some(ConflictResolution::LeftWins) => {
                        if differ(&a.left, &a.right) {
                            replace_right.push(rp.clone());
                        }
                        groups.entry((true, vpath::parent(&rp))).or_default().push(lp);
                    }
                    Some(ConflictResolution::RightWins) => {
                        if differ(&a.left, &a.right) {
                            replace_left.push(lp.clone());
                        }
                        groups.entry((false, vpath::parent(&lp))).or_default().push(rp);
                    }
                    Some(ConflictResolution::KeepBoth) => keep_both.push(a),
                    Some(ConflictResolution::Skip) | None => {}
                },
            }
        }
        if !replace_left.is_empty() {
            DeleteTask::new(self.left.clone(), replace_left).run(ctx).await?;
        }
        if !replace_right.is_empty() {
            DeleteTask::new(self.right.clone(), replace_right).run(ctx).await?;
        }
        for a in keep_both {
            ctx.check().await?;
            match self.keep_both(ctx, a, &opts).await {
                Ok(()) => {}
                Err(Error::Cancelled) => return Err(Error::Cancelled),
                Err(e) => ctx.error(&a.rel_path, &e),
            }
        }
        for ((to_right, dst_dir), paths) in groups {
            ctx.check().await?;
            let (src, dst) = if to_right { (&self.left, &self.right) } else { (&self.right, &self.left) };
            dst.vfs.mkdir_all(&dst_dir).await?;
            let t =
                TransferTask { src: src.clone(), src_paths: paths, dst: dst.clone(), dst_dir, options: opts.clone() };
            t.run(ctx).await?;
        }
        if !delete_left.is_empty() {
            DeleteTask::new(self.left.clone(), delete_left).run(ctx).await?;
        }
        if !delete_right.is_empty() {
            DeleteTask::new(self.right.clone(), delete_right).run(ctx).await?;
        }
        Ok(())
    }
}

/// Convenience: compare + execute everything (scripting `synchronize`).
pub async fn synchronize_all(
    queue: &crate::jobs::JobQueue,
    left: Endpoint,
    right: Endpoint,
    params: SyncParams,
    options: TransferOptions,
    conflicts: Option<ConflictResolution>,
) -> Result<crate::jobs::Job> {
    let plan = compare(left.vfs.as_ref(), right.vfs.as_ref(), &params, |_| {}).await?;
    let actions: Vec<SyncAction> = plan
        .actions
        .into_iter()
        .filter_map(|mut a| {
            if a.action == SyncActionKind::Conflict {
                a.resolution = Some(conflicts.filter(|c| *c != ConflictResolution::Skip)?);
            }
            Some(a)
        })
        .collect();
    let speed = options.speed_limit;
    let task = SyncTask { left: left.clone(), right: right.clone(), params: params.clone(), actions, options };
    let spec = crate::jobs::JobSpec {
        title: format!("Synchronize {} ↔ {}", params.left_path, params.right_path),
        src_session: Some(left.session.clone()),
        dst_session: Some(right.session.clone()),
        src_paths: vec![params.left_path.clone()],
        dst_dir: Some(params.right_path.clone()),
    };
    let job = queue.submit(crate::jobs::JobKind::Sync, spec, Arc::new(task), speed);
    queue.wait(&job.id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::{JobQueue, JobState};
    use crate::local::{from_native, LocalVfs};
    use crate::vfs::{write_all, Vfs};

    #[tokio::test]
    async fn compare_and_sync() {
        let dir = tempfile::tempdir().unwrap();
        let base = from_native(dir.path());
        let vfs: Arc<dyn Vfs> = Arc::new(LocalVfs::new());
        let w = |p: &str, c: &str, t: i64| {
            let vfs = vfs.clone();
            let full = vpath::join(&base, p);
            let c = c.to_string();
            async move {
                vfs.mkdir_all(&vpath::parent(&full)).await.unwrap();
                write_all(vfs.as_ref(), &full, c.as_bytes()).await.unwrap();
                vfs.set_modified(&full, t).await.unwrap();
            }
        };
        w("L/same.txt", "x", 1000).await;
        w("R/same.txt", "x", 1000).await;
        w("L/newer.txt", "new", 2000).await;
        w("R/newer.txt", "old", 1000).await;
        w("L/older.txt", "old", 1000).await;
        w("R/older.txt", "new", 2000).await;
        w("L/only/deep.txt", "d", 1000).await;
        w("R/obsolete.txt", "o", 1000).await;

        let params = SyncParams {
            left_path: vpath::join(&base, "L"),
            right_path: vpath::join(&base, "R"),
            right_session: "local".into(),
            delete_obsolete: true,
            ..Default::default()
        };
        let plan = compare(vfs.as_ref(), vfs.as_ref(), &params, |_| {}).await.unwrap();
        let mut summary: Vec<(String, SyncActionKind)> =
            plan.actions.iter().map(|a| (a.rel_path.clone(), a.action)).collect();
        summary.sort_by(|a, b| a.0.cmp(&b.0));
        assert_eq!(
            summary,
            vec![
                ("newer.txt".to_string(), SyncActionKind::CopyLeftToRight),
                ("obsolete.txt".to_string(), SyncActionKind::DeleteRight),
                ("only".to_string(), SyncActionKind::CopyLeftToRight),
            ]
        );
        assert_eq!(plan.identical, 2);

        let mirror = SyncParams { mode: SyncMode::Mirror, ..params.clone() };
        let plan2 = compare(vfs.as_ref(), vfs.as_ref(), &mirror, |_| {}).await.unwrap();
        assert!(plan2.actions.iter().any(|a| a.rel_path == "older.txt" && a.reason == SyncReason::Older));

        let q = JobQueue::new(1, Arc::new(|_| {}));
        let ep = Endpoint::new("local", vfs.clone());
        let job = synchronize_all(&q, ep.clone(), ep.clone(), params.clone(), TransferOptions::default(), None)
            .await
            .unwrap();
        assert_eq!(job.state, JobState::Completed, "{:?}", job.errors);
        let after = compare(vfs.as_ref(), vfs.as_ref(), &params, |_| {}).await.unwrap();
        assert!(after.actions.is_empty(), "{:?}", after.actions);
    }

    #[tokio::test]
    async fn resolve_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let base = from_native(dir.path());
        let vfs: Arc<dyn Vfs> = Arc::new(LocalVfs::new());
        let w = |p: &str, c: &str| {
            let vfs = vfs.clone();
            let full = vpath::join(&base, p);
            let c = c.to_string();
            async move {
                vfs.mkdir_all(&vpath::parent(&full)).await.unwrap();
                write_all(vfs.as_ref(), &full, c.as_bytes()).await.unwrap();
                vfs.set_modified(&full, 1000).await.unwrap();
            }
        };
        // Same time, different sizes: conflicts in a two-way synchronization.
        w("L/left.txt", "left wins").await;
        w("R/left.txt", "r").await;
        w("L/right.txt", "l").await;
        w("R/right.txt", "right wins").await;
        w("L/both.txt", "left version").await;
        w("R/both.txt", "right").await;
        w("L/skip.txt", "a").await;
        w("R/skip.txt", "bb").await;
        // A file on one side, a directory on the other.
        w("L/kind", "now a file").await;
        w("R/kind/inner.txt", "x").await;
        let params = SyncParams {
            left_path: vpath::join(&base, "L"),
            right_path: vpath::join(&base, "R"),
            right_session: "local".into(),
            direction: SyncDirection::Both,
            ..Default::default()
        };
        let plan = compare(vfs.as_ref(), vfs.as_ref(), &params, |_| {}).await.unwrap();
        assert!(plan.actions.iter().all(|a| a.action == SyncActionKind::Conflict), "{:?}", plan.actions);
        assert_eq!(plan.actions.len(), 5);
        let actions: Vec<SyncAction> = plan
            .actions
            .into_iter()
            .map(|mut a| {
                a.resolution = Some(match a.rel_path.as_str() {
                    "left.txt" | "kind" => ConflictResolution::LeftWins,
                    "right.txt" => ConflictResolution::RightWins,
                    "both.txt" => ConflictResolution::KeepBoth,
                    _ => ConflictResolution::Skip,
                });
                a
            })
            .collect();
        let ep = Endpoint::new("local", vfs.clone());
        let task = SyncTask { left: ep.clone(), right: ep, params, actions, options: TransferOptions::default() };
        let q = JobQueue::new(1, Arc::new(|_| {}));
        let job = q.submit(crate::jobs::JobKind::Sync, Default::default(), Arc::new(task), 0);
        let done = q.wait(&job.id).await.unwrap();
        assert_eq!(done.state, JobState::Completed, "{:?}", done.errors);
        let read = |p: &str| {
            let full = vpath::join(&base, p);
            let vfs = vfs.clone();
            async move { String::from_utf8(crate::vfs::read_to_end(vfs.as_ref(), &full, 100).await.unwrap()).unwrap() }
        };
        assert_eq!(read("R/left.txt").await, "left wins");
        assert_eq!(read("L/right.txt").await, "right wins");
        assert_eq!(read("L/both.txt").await, "left version");
        assert_eq!(read("R/both.txt").await, "left version");
        assert_eq!(read("L/both (1).txt").await, "right");
        assert_eq!(read("R/both (1).txt").await, "right");
        assert_eq!(read("L/skip.txt").await, "a");
        assert_eq!(read("R/skip.txt").await, "bb");
        assert_eq!(read("R/kind").await, "now a file");
    }
}
