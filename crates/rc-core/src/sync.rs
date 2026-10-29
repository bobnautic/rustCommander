//! Directory synchronization: compare two trees, review the plan, execute it.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::jobs::{JobCtx, JobTask};
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
        if n % 50 == 0 {
            progress(n, &item.entry.path);
        }
        entries.insert(item.rel, (item.entry, item.is_dir));
        Ok(true)
    })
    .await?;
    progress(n, root);
    Ok(Side { entries })
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
    let (l, r) = (l?, r?);

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
                            actions.push(mk(SyncActionKind::CopyLeftToRight, reason_for(left_newer), false, Some(le), Some(re)));
                        } else {
                            identical += 1;
                        }
                    }
                    SyncDirection::RightToLeft => {
                        if right_newer || !time_diff || params.mode == SyncMode::Mirror {
                            actions.push(mk(SyncActionKind::CopyRightToLeft, reason_for(right_newer), false, Some(le), Some(re)));
                        } else {
                            identical += 1;
                        }
                    }
                    SyncDirection::Both => {
                        if left_newer {
                            actions.push(mk(SyncActionKind::CopyLeftToRight, SyncReason::Newer, false, Some(le), Some(re)));
                        } else if right_newer {
                            actions.push(mk(SyncActionKind::CopyRightToLeft, SyncReason::Newer, false, Some(le), Some(re)));
                        } else {
                            actions.push(mk(SyncActionKind::Conflict, SyncReason::SizeDiffers, false, Some(le), Some(re)));
                        }
                    }
                }
            }
            (None, None) => {}
        }
    }

    // Checksums for files that look identical.
    for (rel, le, re) in checksum_candidates {
        let (a, b) = tokio::join!(
            ops::checksum(left, &le.path, ChecksumAlgo::Sha256),
            ops::checksum(right, &re.path, ChecksumAlgo::Sha256)
        );
        progress(SyncProgress { scanned_left: 0, scanned_right: 0, current: le.path.clone() });
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
        for a in &self.actions {
            let lp = vpath::join(&self.params.left_path, &a.rel_path);
            let rp = vpath::join(&self.params.right_path, &a.rel_path);
            match a.action {
                SyncActionKind::CopyLeftToRight => groups.entry((true, vpath::parent(&rp))).or_default().push(lp),
                SyncActionKind::CopyRightToLeft => groups.entry((false, vpath::parent(&lp))).or_default().push(rp),
                SyncActionKind::DeleteLeft => delete_left.push(lp),
                SyncActionKind::DeleteRight => delete_right.push(rp),
                SyncActionKind::Conflict => {}
            }
        }
        for ((to_right, dst_dir), paths) in groups {
            ctx.check().await?;
            let (src, dst) = if to_right { (&self.left, &self.right) } else { (&self.right, &self.left) };
            dst.vfs.mkdir_all(&dst_dir).await?;
            let t = TransferTask { src: src.clone(), src_paths: paths, dst: dst.clone(), dst_dir, options: opts.clone() };
            t.run(ctx).await?;
        }
        if !delete_left.is_empty() {
            DeleteTask { target: self.left.clone(), paths: delete_left }.run(ctx).await?;
        }
        if !delete_right.is_empty() {
            DeleteTask { target: self.right.clone(), paths: delete_right }.run(ctx).await?;
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
) -> Result<crate::jobs::Job> {
    let plan = compare(left.vfs.as_ref(), right.vfs.as_ref(), &params, |_| {}).await?;
    let actions: Vec<SyncAction> = plan.actions.into_iter().filter(|a| a.action != SyncActionKind::Conflict).collect();
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
        let mut summary: Vec<(String, SyncActionKind)> = plan.actions.iter().map(|a| (a.rel_path.clone(), a.action)).collect();
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
        let job = synchronize_all(&q, ep.clone(), ep.clone(), params.clone(), TransferOptions::default()).await.unwrap();
        assert_eq!(job.state, JobState::Completed, "{:?}", job.errors);
        let after = compare(vfs.as_ref(), vfs.as_ref(), &params, |_| {}).await.unwrap();
        assert!(after.actions.is_empty(), "{:?}", after.actions);
    }
}
