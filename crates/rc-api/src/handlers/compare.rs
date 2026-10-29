//! Pre-copy comparison: which target files a copy would hit, so the UI can compare
//! fingerprints (checksums) of source and target before anything is transferred.

use std::collections::{BTreeSet, HashMap};

use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};

use rc_core::mask::FileMask;
use rc_core::ops::{self, WalkOptions};
use rc_core::path as vpath;
use rc_core::{Error, FileEntry, Result};

use crate::state::AppState;

const DEFAULT_MAX_FILES: usize = 5000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairsParams {
    pub src_session: String,
    pub src_paths: Vec<String>,
    pub dst_session: String,
    pub dst_dir: String,
    /// For a single source item: the name it gets at the target.
    pub new_name: Option<String>,
    #[serde(default)]
    pub file_mask: String,
    #[serde(default)]
    pub exclude_hidden: bool,
    pub max_files: Option<usize>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilePair {
    /// Path below the target directory, e.g. `site/css/main.css`.
    pub rel: String,
    pub source: FileEntry,
    pub target_path: String,
    /// What exists at `target_path` today (`None` = the copy creates it).
    pub target: Option<FileEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pairs {
    pub pairs: Vec<FilePair>,
    /// More than `maxFiles` source files: the list is incomplete.
    pub truncated: bool,
}

/// Every source file (directories are walked) with the target file it would be copied to.
pub async fn pairs(state: &AppState, p: PairsParams) -> Result<Pairs> {
    let src = state.vfs(&p.src_session)?;
    let dst = state.vfs(&p.dst_session)?;
    let max = p.max_files.unwrap_or(DEFAULT_MAX_FILES).max(1);
    let mask = FileMask::parse(&p.file_mask).map_err(Error::InvalidInput)?;
    let opts = WalkOptions { mask, exclude_hidden: p.exclude_hidden, ..Default::default() };
    let dst_dir = vpath::normalize(&p.dst_dir);
    let rename = match (p.src_paths.len(), p.new_name.as_deref().map(str::trim)) {
        (1, Some(n)) if !n.is_empty() => Some(n.to_string()),
        _ => None,
    };

    let mut out = Vec::new();
    let mut truncated = false;
    for path in &p.src_paths {
        if out.len() >= max {
            truncated = true;
            break;
        }
        let entry = src.stat(path).await?;
        let name = rename.clone().unwrap_or_else(|| vpath::file_name(path).to_string());
        let target_root = vpath::join(&dst_dir, &name);
        if !entry.is_dir() {
            let target = dst.try_stat(&target_root).await?;
            out.push(FilePair { rel: name, source: entry, target_path: target_root, target });
            continue;
        }

        // Source tree: files plus every directory that contains some of them.
        let mut files: Vec<(String, FileEntry)> = Vec::new();
        let mut dirs: BTreeSet<String> = BTreeSet::from([String::new()]);
        let room = max - out.len();
        ops::walk(src.as_ref(), path, &opts, |w| {
            if w.is_dir {
                dirs.insert(w.rel);
                return Ok(true);
            }
            if w.entry.is_dir() {
                return Ok(true); // symlink to a directory that is not followed
            }
            if files.len() >= room {
                truncated = true;
                return Ok(false);
            }
            files.push((w.rel, w.entry));
            Ok(true)
        })
        .await?;

        // Target side: list only the directories the source has (missing ones are fine).
        let listings: Vec<(String, Vec<FileEntry>)> = stream::iter(dirs)
            .map(|rel| {
                let dst = dst.clone();
                let dir = if rel.is_empty() { target_root.clone() } else { vpath::join(&target_root, &rel) };
                async move {
                    match dst.list(&dir).await {
                        Ok(entries) => Ok((rel, entries)),
                        Err(Error::NotFound(_) | Error::NotADirectory(_)) => Ok((rel, Vec::new())),
                        Err(e) => Err(e),
                    }
                }
            })
            .buffer_unordered(8)
            .collect::<Vec<Result<_>>>()
            .await
            .into_iter()
            .collect::<Result<_>>()?;
        let mut existing: HashMap<String, FileEntry> = HashMap::new();
        for (rel, entries) in listings {
            for e in entries {
                let key = if rel.is_empty() { e.name.clone() } else { format!("{rel}/{}", e.name) };
                existing.insert(key, e);
            }
        }

        files.sort_by(|a, b| a.0.cmp(&b.0));
        for (rel, source) in files {
            let target_path = vpath::join(&target_root, &rel);
            let target = existing.remove(&rel);
            out.push(FilePair { rel: format!("{name}/{rel}"), source, target_path, target });
        }
    }
    Ok(Pairs { pairs: out, truncated })
}
