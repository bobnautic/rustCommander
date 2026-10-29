//! Create and extract archives (zip, tar, tar.gz) on the local file system.

use std::fs::File;
use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::jobs::{JobCtx, JobTask};
use crate::local::to_native;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ArchiveFormat {
    #[serde(rename = "zip")]
    Zip,
    #[serde(rename = "tar")]
    Tar,
    #[serde(rename = "tar.gz")]
    TarGz,
}

impl ArchiveFormat {
    pub fn detect(name: &str) -> Option<Self> {
        let n = name.to_ascii_lowercase();
        if n.ends_with(".zip") || n.ends_with(".jar") {
            Some(ArchiveFormat::Zip)
        } else if n.ends_with(".tar.gz") || n.ends_with(".tgz") {
            Some(ArchiveFormat::TarGz)
        } else if n.ends_with(".tar") {
            Some(ArchiveFormat::Tar)
        } else {
            None
        }
    }
}

pub enum ArchiveTask {
    Create { paths: Vec<String>, dst: String, format: ArchiveFormat },
    Extract { path: String, dst_dir: String },
}

#[async_trait]
impl JobTask for ArchiveTask {
    async fn run(&self, ctx: &JobCtx) -> Result<()> {
        ctx.check().await?;
        match self {
            ArchiveTask::Create { paths, dst, format } => {
                let paths: Vec<PathBuf> = paths.iter().map(|p| to_native(p)).collect();
                let dst = to_native(dst);
                let format = *format;
                tokio::task::block_in_place(|| create(ctx, &paths, &dst, format))
            }
            ArchiveTask::Extract { path, dst_dir } => {
                let format = ArchiveFormat::detect(path).ok_or_else(|| Error::unsupported("unknown archive format"))?;
                let src = to_native(path);
                let dst = to_native(dst_dir);
                tokio::task::block_in_place(|| extract(ctx, &src, &dst, format))
            }
        }
    }
}

fn collect(root: &Path, out: &mut Vec<(PathBuf, String, bool)>, prefix: &str) -> std::io::Result<()> {
    let meta = std::fs::symlink_metadata(root)?;
    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
    if meta.is_dir() {
        out.push((root.to_path_buf(), rel.clone(), true));
        let mut children: Vec<_> = std::fs::read_dir(root)?.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        children.sort();
        for c in children {
            collect(&c, out, &rel)?;
        }
    } else if meta.is_file() {
        out.push((root.to_path_buf(), rel, false));
    }
    Ok(())
}

fn create(ctx: &JobCtx, paths: &[PathBuf], dst: &Path, format: ArchiveFormat) -> Result<()> {
    let mut items = Vec::new();
    for p in paths {
        collect(p, &mut items, "")?;
    }
    let total: u64 = items.iter().filter(|i| !i.2).filter_map(|i| std::fs::metadata(&i.0).ok()).map(|m| m.len()).sum();
    ctx.add_total(total, items.iter().filter(|i| !i.2).count() as u64);
    ctx.set_scanning(false);
    let file = BufWriter::new(File::create(dst)?);
    match format {
        ArchiveFormat::Zip => {
            let mut zw = zip::ZipWriter::new(file);
            let opts = zip::write::SimpleFileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .large_file(true);
            for (path, rel, is_dir) in &items {
                if ctx.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                if *is_dir {
                    zw.add_directory(format!("{rel}/"), opts).map_err(Error::other)?;
                    continue;
                }
                ctx.set_current(Some(rel));
                zw.start_file(rel.as_str(), opts).map_err(Error::other)?;
                let mut f = File::open(path)?;
                let n = std::io::copy(&mut f, &mut zw)?;
                ctx.add_bytes(n);
                ctx.file_done();
            }
            zw.finish().map_err(Error::other)?;
        }
        ArchiveFormat::Tar | ArchiveFormat::TarGz => {
            let writer: Box<dyn std::io::Write> = if format == ArchiveFormat::TarGz {
                Box::new(flate2::write::GzEncoder::new(file, flate2::Compression::default()))
            } else {
                Box::new(file)
            };
            let mut tb = tar::Builder::new(writer);
            tb.follow_symlinks(false);
            for (path, rel, is_dir) in &items {
                if ctx.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                if *is_dir {
                    tb.append_dir(rel, path)?;
                    continue;
                }
                ctx.set_current(Some(rel));
                tb.append_path_with_name(path, rel)?;
                ctx.add_bytes(std::fs::metadata(path).map(|m| m.len()).unwrap_or(0));
                ctx.file_done();
            }
            tb.into_inner()?.flush()?;
        }
    }
    Ok(())
}

fn extract(ctx: &JobCtx, src: &Path, dst: &Path, format: ArchiveFormat) -> Result<()> {
    std::fs::create_dir_all(dst)?;
    ctx.set_scanning(false);
    match format {
        ArchiveFormat::Zip => {
            let mut za = zip::ZipArchive::new(BufReader::new(File::open(src)?)).map_err(Error::other)?;
            let total: u64 = (0..za.len()).filter_map(|i| za.by_index(i).ok().map(|f| f.size())).sum();
            ctx.add_total(total, za.len() as u64);
            for i in 0..za.len() {
                if ctx.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                let mut f = za.by_index(i).map_err(Error::other)?;
                // `enclosed_name` rejects absolute paths and `..` (zip slip).
                let Some(rel) = f.enclosed_name() else { continue };
                let out = dst.join(rel);
                ctx.set_current(Some(&out.to_string_lossy()));
                if f.is_dir() {
                    std::fs::create_dir_all(&out)?;
                } else {
                    if let Some(p) = out.parent() {
                        std::fs::create_dir_all(p)?;
                    }
                    let mut w = File::create(&out)?;
                    let n = std::io::copy(&mut f, &mut w)?;
                    ctx.add_bytes(n);
                    #[cfg(unix)]
                    if let Some(mode) = f.unix_mode() {
                        use std::os::unix::fs::PermissionsExt;
                        let _ = std::fs::set_permissions(&out, std::fs::Permissions::from_mode(mode & 0o7777));
                    }
                }
                ctx.file_done();
            }
        }
        ArchiveFormat::Tar | ArchiveFormat::TarGz => {
            let file = BufReader::new(File::open(src)?);
            let reader: Box<dyn std::io::Read> = if format == ArchiveFormat::TarGz {
                Box::new(flate2::read::GzDecoder::new(file))
            } else {
                Box::new(file)
            };
            let mut ar = tar::Archive::new(reader);
            for entry in ar.entries()? {
                if ctx.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                let mut entry = entry?;
                let size = entry.size();
                ctx.add_total(size, 1);
                ctx.set_current(Some(&entry.path()?.to_string_lossy()));
                // `unpack_in` refuses paths escaping `dst`.
                entry.unpack_in(dst)?;
                ctx.add_bytes(size);
                ctx.file_done();
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::{JobKind, JobQueue, JobSpec, JobState};
    use crate::local::from_native;
    use std::sync::Arc;

    #[tokio::test(flavor = "multi_thread")]
    async fn zip_and_tar_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path();
        std::fs::create_dir_all(base.join("data/sub")).unwrap();
        std::fs::write(base.join("data/a.txt"), b"alpha").unwrap();
        std::fs::write(base.join("data/sub/b.txt"), b"beta").unwrap();
        let q = JobQueue::new(1, Arc::new(|_| {}));
        for (fmt, name) in
            [(ArchiveFormat::Zip, "x.zip"), (ArchiveFormat::TarGz, "x.tar.gz"), (ArchiveFormat::Tar, "x.tar")]
        {
            let dst = from_native(&base.join(name));
            let t = ArchiveTask::Create { paths: vec![from_native(&base.join("data"))], dst: dst.clone(), format: fmt };
            let j = q.submit(JobKind::Transfer, JobSpec::default(), Arc::new(t), 0);
            assert_eq!(q.wait(&j.id).await.unwrap().state, JobState::Completed);
            let out = base.join(format!("out-{name}"));
            let t = ArchiveTask::Extract { path: dst, dst_dir: from_native(&out) };
            let j = q.submit(JobKind::Transfer, JobSpec::default(), Arc::new(t), 0);
            let r = q.wait(&j.id).await.unwrap();
            assert_eq!(r.state, JobState::Completed, "{:?}", r.errors);
            assert_eq!(std::fs::read(out.join("data/sub/b.txt")).unwrap(), b"beta");
        }
    }
}
