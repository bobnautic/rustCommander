//! Generic operations built on top of [`Vfs`]: tree walking, sizes, checksums.

use std::collections::HashSet;

use futures::stream::{FuturesUnordered, StreamExt};
use md5::Digest;
use serde::Serialize;

use crate::error::{Error, Result};
use crate::mask::{FileMask, MaskTarget};
use crate::path as vpath;
use crate::types::*;
use crate::vfs::Vfs;

/// An entry found while walking a tree.
#[derive(Debug, Clone)]
pub struct WalkItem {
    pub entry: FileEntry,
    /// Path relative to the walk root (`/`-separated, empty for the root itself).
    pub rel: String,
    pub depth: usize,
    /// Treat as directory (directories and followed directory symlinks).
    pub is_dir: bool,
}

#[derive(Debug, Clone)]
pub struct WalkOptions {
    pub mask: FileMask,
    pub exclude_hidden: bool,
    /// Descend into symlinked directories.
    pub follow_symlinks: bool,
    pub max_depth: Option<usize>,
    /// Parallel directory listings (helps a lot on high-latency links).
    pub concurrency: usize,
}

impl Default for WalkOptions {
    fn default() -> Self {
        WalkOptions {
            mask: FileMask::default(),
            exclude_hidden: false,
            follow_symlinks: false,
            max_depth: None,
            concurrency: 8,
        }
    }
}

/// Walk the tree below `root` (not including `root` itself). Directories are reported
/// before their contents. `cb` returns `false` to stop early.
pub async fn walk<F>(vfs: &dyn Vfs, root: &str, opts: &WalkOptions, mut cb: F) -> Result<()>
where
    F: FnMut(WalkItem) -> Result<bool>,
{
    let mut visited: HashSet<String> = HashSet::new();
    visited.insert(vpath::normalize(root));
    let mut pending: FuturesUnordered<_> = FuturesUnordered::new();
    let mut queue: std::collections::VecDeque<(String, String, usize)> = std::collections::VecDeque::new();
    queue.push_back((vpath::normalize(root), String::new(), 0));
    loop {
        while pending.len() < opts.concurrency.max(1) {
            let Some((dir, rel, depth)) = queue.pop_front() else { break };
            pending.push(async move {
                let r = vfs.list(&dir).await;
                (dir, rel, depth, r)
            });
        }
        let Some((dir, rel, depth, res)) = pending.next().await else { break };
        let mut entries = match res {
            Ok(e) => e,
            Err(e) if depth > 0 => {
                tracing::warn!("cannot list {dir}: {e}");
                continue;
            }
            Err(e) => return Err(e),
        };
        entries.sort_by(|a, b| a.name.cmp(&b.name));
        for e in entries {
            if opts.exclude_hidden && e.hidden {
                continue;
            }
            let child_rel = if rel.is_empty() { e.name.clone() } else { format!("{rel}/{}", e.name) };
            let is_dir = e.kind == FileKind::Dir || (opts.follow_symlinks && e.is_dir());
            let target = MaskTarget { name: &e.name, rel_path: &child_rel, is_dir, size: e.size, modified: e.modified };
            if !opts.mask.matches(&target) {
                continue;
            }
            let path = e.path.clone();
            let item = WalkItem { entry: e, rel: child_rel.clone(), depth: depth + 1, is_dir };
            if !cb(item)? {
                return Ok(());
            }
            if is_dir && opts.max_depth.is_none_or(|m| depth + 1 < m) {
                let key = vpath::normalize(&path);
                if visited.insert(key) {
                    queue.push_back((path, child_rel, depth + 1));
                }
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct DirSize {
    pub size: u64,
    pub files: u64,
    pub dirs: u64,
}

pub async fn dir_size(vfs: &dyn Vfs, path: &str) -> Result<DirSize> {
    let mut total = DirSize::default();
    walk(vfs, path, &WalkOptions::default(), |item| {
        if item.is_dir {
            total.dirs += 1;
        } else {
            total.files += 1;
            total.size += item.entry.size;
        }
        Ok(true)
    })
    .await?;
    Ok(total)
}

/// Hash state for streaming checksums.
pub enum Hasher {
    Md5(md5::Md5),
    Sha1(sha1::Sha1),
    Sha256(sha2::Sha256),
}

impl Hasher {
    pub fn new(algo: ChecksumAlgo) -> Self {
        match algo {
            ChecksumAlgo::Md5 => Hasher::Md5(md5::Md5::new()),
            ChecksumAlgo::Sha1 => Hasher::Sha1(sha1::Sha1::new()),
            ChecksumAlgo::Sha256 => Hasher::Sha256(sha2::Sha256::new()),
        }
    }
    pub fn update(&mut self, data: &[u8]) {
        match self {
            Hasher::Md5(h) => h.update(data),
            Hasher::Sha1(h) => h.update(data),
            Hasher::Sha256(h) => h.update(data),
        }
    }
    pub fn finish(self) -> String {
        match self {
            Hasher::Md5(h) => hex::encode(h.finalize()),
            Hasher::Sha1(h) => hex::encode(h.finalize()),
            Hasher::Sha256(h) => hex::encode(h.finalize()),
        }
    }
}

/// Checksum of a file: server-side when the protocol supports it, otherwise streamed.
pub async fn checksum(vfs: &dyn Vfs, path: &str, algo: ChecksumAlgo) -> Result<String> {
    if let Ok(Some(sum)) = vfs.checksum(path, algo).await {
        return Ok(sum.to_ascii_lowercase());
    }
    stream_checksum(vfs, path, algo).await
}

pub async fn stream_checksum(vfs: &dyn Vfs, path: &str, algo: ChecksumAlgo) -> Result<String> {
    let mut r = vfs.open_read(path, 0).await?;
    let mut h = Hasher::new(algo);
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = r.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finish())
}

/// Remove a file or a directory tree.
pub async fn remove_any(vfs: &dyn Vfs, path: &str) -> Result<()> {
    let st = vfs.stat(path).await?;
    if st.kind == FileKind::Dir {
        vfs.remove_dir_all(path).await
    } else {
        vfs.remove_file(path).await
    }
}

/// A file name in `dir` that does not exist yet: `name`, `name (1)`, `name (2)`, ...
pub async fn unique_name(vfs: &dyn Vfs, dir: &str, name: &str) -> Result<String> {
    if vfs.try_stat(&vpath::join(dir, name)).await?.is_none() {
        return Ok(name.to_string());
    }
    for n in 1..10_000 {
        let cand = vpath::numbered_name(name, n);
        if vfs.try_stat(&vpath::join(dir, &cand)).await?.is_none() {
            return Ok(cand);
        }
    }
    Err(Error::other("cannot find a free file name"))
}

/// Guess a MIME type from the extension (for previews and downloads).
pub fn mime_for(name: &str) -> &'static str {
    match vpath::extension(name).as_deref() {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        Some("ico") => "image/x-icon",
        Some("avif") => "image/avif",
        Some("pdf") => "application/pdf",
        Some("txt" | "log" | "md" | "csv" | "ini" | "conf" | "cfg") => "text/plain; charset=utf-8",
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("css") => "text/css",
        Some("js" | "mjs") => "text/javascript",
        Some("json") => "application/json",
        Some("xml") => "application/xml",
        Some("zip") => "application/zip",
        Some("gz" | "tgz") => "application/gzip",
        Some("tar") => "application/x-tar",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local::{from_native, LocalVfs};
    use crate::vfs::write_all;

    #[tokio::test]
    async fn walk_and_size() {
        let dir = tempfile::tempdir().unwrap();
        let base = from_native(dir.path());
        let vfs = LocalVfs::new();
        for p in ["a/1.txt", "a/b/2.txt", "a/b/3.log", "c.txt", ".hidden/x"] {
            let full = vpath::join(&base, p);
            vfs.mkdir_all(&vpath::parent(&full)).await.unwrap();
            write_all(&vfs, &full, b"12345").await.unwrap();
        }
        let s = dir_size(&vfs, &base).await.unwrap();
        assert_eq!(s.files, 5);
        assert_eq!(s.size, 25);
        assert_eq!(s.dirs, 3);

        let mut found = vec![];
        let opts = WalkOptions { mask: FileMask::parse("*.txt").unwrap(), exclude_hidden: true, ..Default::default() };
        walk(&vfs, &base, &opts, |i| {
            if !i.is_dir {
                found.push(i.rel);
            }
            Ok(true)
        })
        .await
        .unwrap();
        found.sort();
        assert_eq!(found, vec!["a/1.txt", "a/b/2.txt", "c.txt"]);

        let sum = checksum(&vfs, &vpath::join(&base, "c.txt"), ChecksumAlgo::Md5).await.unwrap();
        assert_eq!(sum, "827ccb0eea8a706c4c34a16891f84e7b");
        assert_eq!(unique_name(&vfs, &base, "c.txt").await.unwrap(), "c (1).txt");
    }
}
