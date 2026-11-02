//! Recursive file search by name, size, date and content.

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result};
use crate::mask::FileMask;
use crate::ops::{self, WalkOptions};
use crate::types::FileEntry;
use crate::vfs::Vfs;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchParams {
    pub session: String,
    pub root: String,
    pub name_mask: String,
    pub content_text: Option<String>,
    pub case_sensitive: bool,
    pub min_size: Option<u64>,
    pub max_size: Option<u64>,
    pub modified_after: Option<i64>,
    pub modified_before: Option<i64>,
    pub include_hidden: bool,
    pub include_dirs: bool,
    pub max_depth: Option<usize>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSummary {
    pub scanned: u64,
    pub found: u64,
    pub cancelled: bool,
}

/// Content search reads at most this much of each file.
const MAX_CONTENT_BYTES: u64 = 64 * 1024 * 1024;

/// Does `e` pass the name, size and date filters?
fn matches_filters(params: &SearchParams, name_mask: &FileMask, e: &FileEntry, is_dir: bool) -> bool {
    if is_dir && !params.include_dirs {
        return false;
    }
    if !name_mask.is_empty() && !name_mask.matches_name(&e.name) {
        return false;
    }
    if !is_dir && (params.min_size.is_some_and(|m| e.size < m) || params.max_size.is_some_and(|m| e.size > m)) {
        return false;
    }
    if let Some(after) = params.modified_after {
        if e.modified.is_none_or(|m| m < after) {
            return false;
        }
    }
    if let Some(before) = params.modified_before {
        if e.modified.is_none_or(|m| m > before) {
            return false;
        }
    }
    true
}

/// Run a search. `on_results` receives batches of matches. On SSH hosts the tree is listed
/// by `find` and contents are searched by `grep` on the server (nothing is downloaded).
pub async fn search(
    vfs: &dyn Vfs,
    params: &SearchParams,
    cancel: CancellationToken,
    mut on_results: impl FnMut(Vec<FileEntry>) + Send,
) -> Result<SearchSummary> {
    let name_mask = FileMask::parse(&params.name_mask).map_err(Error::InvalidInput)?;
    let content = params.content_text.as_deref().filter(|s| !s.is_empty());
    let needle = content.map(|s| {
        if params.case_sensitive {
            s.as_bytes().to_vec()
        } else {
            // The file content is folded byte-wise, so the needle must be folded the same
            // way (Unicode lowercasing would never match a non-ASCII needle like "Äpfel").
            s.to_ascii_lowercase().into_bytes()
        }
    });
    let mut summary = SearchSummary::default();
    let mut candidates: Vec<FileEntry> = Vec::new();
    let mut batch: Vec<FileEntry> = Vec::new();
    let mut last_flush = std::time::Instant::now();
    let mut visit = |e: FileEntry, is_dir: bool, summary: &mut SearchSummary| {
        summary.scanned += 1;
        if !matches_filters(params, &name_mask, &e, is_dir) {
            return;
        }
        if needle.is_some() {
            if !is_dir {
                candidates.push(e);
            }
            return;
        }
        summary.found += 1;
        batch.push(e);
        if batch.len() >= 200 || last_flush.elapsed().as_millis() > 300 {
            on_results(std::mem::take(&mut batch));
            last_flush = std::time::Instant::now();
        }
    };

    let listed = if crate::remote::available(vfs) {
        crate::remote::find_entries(vfs, &params.root, params.max_depth, params.include_hidden, &cancel).await?
    } else {
        None
    };
    if let Some(entries) = listed {
        for e in entries {
            if cancel.is_cancelled() {
                break;
            }
            let is_dir = e.kind == crate::types::FileKind::Dir;
            visit(e, is_dir, &mut summary);
        }
    } else {
        let opts = WalkOptions {
            mask: FileMask::default(),
            exclude_hidden: !params.include_hidden,
            follow_symlinks: false,
            max_depth: params.max_depth,
            concurrency: 8,
        };
        ops::walk(vfs, &params.root, &opts, |item| {
            if cancel.is_cancelled() {
                return Ok(false);
            }
            visit(item.entry, item.is_dir, &mut summary);
            Ok(true)
        })
        .await?;
    }
    if !batch.is_empty() {
        on_results(std::mem::take(&mut batch));
    }
    let (Some(needle), Some(text)) = (needle, content) else {
        summary.cancelled = cancel.is_cancelled();
        return Ok(summary);
    };
    if crate::remote::available(vfs) && !candidates.is_empty() {
        let paths: Vec<String> = candidates.iter().map(|e| e.path.clone()).collect();
        let by_path: std::collections::HashMap<&str, &FileEntry> =
            candidates.iter().map(|e| (e.path.as_str(), e)).collect();
        let grepped = crate::remote::grep_files(vfs, text, params.case_sensitive, &paths, &cancel, |hits| {
            on_results(hits.iter().filter_map(|p| by_path.get(p.as_str()).map(|e| (*e).clone())).collect());
        })
        .await?;
        if let Some(found) = grepped {
            summary.found += found as u64;
            summary.cancelled = cancel.is_cancelled();
            return Ok(summary);
        }
    }
    for e in candidates {
        if cancel.is_cancelled() {
            break;
        }
        match contains(vfs, &e.path, &needle, params.case_sensitive, &cancel).await {
            Ok(true) => {
                summary.found += 1;
                on_results(vec![e]);
            }
            Ok(false) => {}
            Err(err) => tracing::debug!("search {}: {err}", e.path),
        }
    }
    summary.cancelled = cancel.is_cancelled();
    Ok(summary)
}

async fn contains(
    vfs: &dyn Vfs,
    path: &str,
    needle: &[u8],
    case_sensitive: bool,
    cancel: &CancellationToken,
) -> Result<bool> {
    let mut r = vfs.open_read(path, 0).await?;
    let mut buf = vec![0u8; 256 * 1024];
    let keep = needle.len().saturating_sub(1);
    let mut window: Vec<u8> = Vec::with_capacity(buf.len() + keep);
    let mut read = 0u64;
    loop {
        if cancel.is_cancelled() {
            return Ok(false);
        }
        let n = r.read(&mut buf).await?;
        if n == 0 {
            return Ok(false);
        }
        read += n as u64;
        if case_sensitive {
            window.extend_from_slice(&buf[..n]);
        } else {
            window.extend(buf[..n].iter().map(|b| b.to_ascii_lowercase()));
        }
        if memfind(&window, needle) {
            return Ok(true);
        }
        if read > MAX_CONTENT_BYTES {
            return Ok(false);
        }
        let cut = window.len().saturating_sub(keep);
        window.drain(..cut);
    }
}

fn memfind(hay: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() {
        return true;
    }
    hay.windows(needle.len()).any(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local::{from_native, LocalVfs};
    use crate::path as vpath;
    use crate::vfs::write_all;

    #[tokio::test]
    async fn find_by_name_and_content() {
        let dir = tempfile::tempdir().unwrap();
        let base = from_native(dir.path());
        let vfs = LocalVfs::new();
        for (p, c) in [("a/x.log", "hello World"), ("a/b/y.log", "nothing Äpfel"), ("z.txt", "WORLD")] {
            let full = vpath::join(&base, p);
            vfs.mkdir_all(&vpath::parent(&full)).await.unwrap();
            write_all(&vfs, &full, c.as_bytes()).await.unwrap();
        }
        let mut found = vec![];
        let p = SearchParams { root: base.clone(), name_mask: "*.log".into(), ..Default::default() };
        let s = search(&vfs, &p, CancellationToken::new(), |b| found.extend(b)).await.unwrap();
        assert_eq!(s.found, 2);
        found.clear();
        let p = SearchParams { root: base.clone(), content_text: Some("world".into()), ..Default::default() };
        search(&vfs, &p, CancellationToken::new(), |b| found.extend(b)).await.unwrap();
        let mut names: Vec<_> = found.iter().map(|e| e.name.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["x.log", "z.txt"]);
        // Non-ASCII text in the needle (umlauts) must still match.
        let p = SearchParams { root: base.clone(), content_text: Some("ÄPFEL".into()), ..Default::default() };
        let s = search(&vfs, &p, CancellationToken::new(), |_| {}).await.unwrap();
        assert_eq!(s.found, 1);
    }
}
