//! The local file system as a [`Vfs`].

use std::path::{Path, PathBuf};
use std::time::{Duration, UNIX_EPOCH};

use async_trait::async_trait;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};

use crate::error::{Error, Result};
use crate::path as vpath;
use crate::types::*;
use crate::vfs::*;

#[derive(Default)]
pub struct LocalVfs;

impl LocalVfs {
    pub fn new() -> Self {
        LocalVfs
    }
}

/// Convert a virtual path into a native path.
pub fn to_native(p: &str) -> PathBuf {
    let n = vpath::normalize(p);
    #[cfg(windows)]
    {
        PathBuf::from(n.replace('/', "\\"))
    }
    #[cfg(not(windows))]
    {
        PathBuf::from(n)
    }
}

/// Convert a native path into a virtual path.
pub fn from_native(p: &Path) -> String {
    let s = p.to_string_lossy();
    #[cfg(windows)]
    {
        let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
        vpath::normalize(s)
    }
    #[cfg(not(windows))]
    {
        vpath::normalize(&s)
    }
}

fn system_time_secs(t: std::io::Result<std::time::SystemTime>) -> Option<i64> {
    let t = t.ok()?;
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => Some(d.as_secs() as i64),
        Err(e) => Some(-(e.duration().as_secs() as i64)),
    }
}

fn entry_from_metadata(name: String, vpath_str: String, meta: &std::fs::Metadata, native: &Path) -> FileEntry {
    let ft = meta.file_type();
    let kind = if ft.is_symlink() {
        FileKind::Symlink
    } else if ft.is_dir() {
        FileKind::Dir
    } else if ft.is_file() {
        FileKind::File
    } else {
        FileKind::Other
    };
    let mut e = FileEntry::new(name, vpath_str, kind);
    e.size = if ft.is_dir() { 0 } else { meta.len() };
    e.modified = system_time_secs(meta.modified());
    if kind == FileKind::Symlink {
        e.link_target = std::fs::read_link(native).ok().map(|p| p.to_string_lossy().into_owned());
        if let Ok(tm) = std::fs::metadata(native) {
            e.target_kind = Some(if tm.is_dir() { FileKind::Dir } else { FileKind::File });
            if tm.is_file() {
                e.size = tm.len();
            }
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        e.permissions = Some(meta.mode() & 0o7777);
        e.owner = Some(unix_ids::user_name(meta.uid()));
        e.group = Some(unix_ids::group_name(meta.gid()));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        if meta.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0 {
            e.hidden = true;
        }
        e.permissions = Some(if meta.permissions().readonly() { 0o444 } else { 0o666 } | if ft.is_dir() { 0o111 } else { 0 });
    }
    e
}

#[cfg(unix)]
mod unix_ids {
    use std::collections::HashMap;
    use std::ffi::CStr;
    use std::sync::OnceLock;

    use parking_lot::Mutex;

    static USERS: OnceLock<Mutex<HashMap<u32, String>>> = OnceLock::new();
    static GROUPS: OnceLock<Mutex<HashMap<u32, String>>> = OnceLock::new();

    pub fn user_name(uid: u32) -> String {
        let cache = USERS.get_or_init(Default::default);
        if let Some(n) = cache.lock().get(&uid) {
            return n.clone();
        }
        let name = lookup_user(uid).unwrap_or_else(|| uid.to_string());
        cache.lock().insert(uid, name.clone());
        name
    }

    pub fn group_name(gid: u32) -> String {
        let cache = GROUPS.get_or_init(Default::default);
        if let Some(n) = cache.lock().get(&gid) {
            return n.clone();
        }
        let name = lookup_group(gid).unwrap_or_else(|| gid.to_string());
        cache.lock().insert(gid, name.clone());
        name
    }

    fn lookup_user(uid: u32) -> Option<String> {
        let mut buf = vec![0 as libc::c_char; 4096];
        let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
        let mut result: *mut libc::passwd = std::ptr::null_mut();
        let rc = unsafe { libc::getpwuid_r(uid, &mut pwd, buf.as_mut_ptr(), buf.len(), &mut result) };
        if rc != 0 || result.is_null() {
            return None;
        }
        Some(unsafe { CStr::from_ptr(pwd.pw_name) }.to_string_lossy().into_owned())
    }

    fn lookup_group(gid: u32) -> Option<String> {
        let mut buf = vec![0 as libc::c_char; 4096];
        let mut grp: libc::group = unsafe { std::mem::zeroed() };
        let mut result: *mut libc::group = std::ptr::null_mut();
        let rc = unsafe { libc::getgrgid_r(gid, &mut grp, buf.as_mut_ptr(), buf.len(), &mut result) };
        if rc != 0 || result.is_null() {
            return None;
        }
        Some(unsafe { CStr::from_ptr(grp.gr_name) }.to_string_lossy().into_owned())
    }

    pub fn uid_for(name: &str) -> Option<u32> {
        if let Ok(n) = name.parse() {
            return Some(n);
        }
        let cname = std::ffi::CString::new(name).ok()?;
        let mut buf = vec![0 as libc::c_char; 4096];
        let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
        let mut result: *mut libc::passwd = std::ptr::null_mut();
        let rc = unsafe { libc::getpwnam_r(cname.as_ptr(), &mut pwd, buf.as_mut_ptr(), buf.len(), &mut result) };
        if rc != 0 || result.is_null() {
            return None;
        }
        Some(pwd.pw_uid)
    }

    pub fn gid_for(name: &str) -> Option<u32> {
        if let Ok(n) = name.parse() {
            return Some(n);
        }
        let cname = std::ffi::CString::new(name).ok()?;
        let mut buf = vec![0 as libc::c_char; 4096];
        let mut grp: libc::group = unsafe { std::mem::zeroed() };
        let mut result: *mut libc::group = std::ptr::null_mut();
        let rc = unsafe { libc::getgrnam_r(cname.as_ptr(), &mut grp, buf.as_mut_ptr(), buf.len(), &mut result) };
        if rc != 0 || result.is_null() {
            return None;
        }
        Some(grp.gr_gid)
    }
}

#[cfg(windows)]
fn list_drives() -> Vec<FileEntry> {
    let mut out = Vec::new();
    for letter in b'A'..=b'Z' {
        let root = format!("{}:\\", letter as char);
        if Path::new(&root).exists() {
            let mut e = FileEntry::new(format!("{}:", letter as char), format!("{}:/", letter as char), FileKind::Dir);
            e.hidden = false;
            out.push(e);
        }
    }
    out
}

#[async_trait]
impl Vfs for LocalVfs {
    fn protocol(&self) -> Protocol {
        Protocol::Local
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            permissions: cfg!(unix),
            owner: cfg!(unix),
            symlinks: true,
            exec: true,
            terminal: true,
            tunnels: false,
            server_copy: true,
            resume_upload: true,
            resume_download: true,
            set_modified: true,
            server_checksum: false,
            disk_info: true,
        }
    }

    fn session_info(&self) -> SessionInfo {
        let mut i = SessionInfo::default();
        i.push("Protocol", "Local file system");
        i.push("OS", std::env::consts::OS);
        i.push("Architecture", std::env::consts::ARCH);
        i
    }

    async fn home(&self) -> Result<String> {
        let home = directories::UserDirs::new()
            .map(|d| d.home_dir().to_path_buf())
            .unwrap_or_else(|| PathBuf::from("/"));
        Ok(from_native(&home))
    }

    async fn canonicalize(&self, path: &str) -> Result<String> {
        #[cfg(windows)]
        if vpath::normalize(path) == "/" {
            return Ok("/".into());
        }
        let p = to_native(path);
        let c = tokio::fs::canonicalize(&p).await.map_err(|e| Error::io_at(e, path))?;
        Ok(from_native(&c))
    }

    async fn list(&self, path: &str) -> Result<Vec<FileEntry>> {
        #[cfg(windows)]
        if vpath::normalize(path) == "/" {
            return Ok(list_drives());
        }
        let native = to_native(path);
        let base = vpath::normalize(path);
        tokio::task::spawn_blocking(move || -> Result<Vec<FileEntry>> {
            let rd = std::fs::read_dir(&native).map_err(|e| Error::io_at(e, &base))?;
            let mut out = Vec::new();
            for ent in rd {
                let ent = match ent {
                    Ok(e) => e,
                    Err(_) => continue,
                };
                let name = ent.file_name().to_string_lossy().into_owned();
                let meta = match std::fs::symlink_metadata(ent.path()) {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                out.push(entry_from_metadata(name.clone(), vpath::join(&base, &name), &meta, &ent.path()));
            }
            Ok(out)
        })
        .await?
    }

    async fn stat(&self, path: &str) -> Result<FileEntry> {
        let native = to_native(path);
        let v = vpath::normalize(path);
        #[cfg(windows)]
        if v == "/" || (vpath::is_drive_path(&v) && v.len() <= 3) {
            let name = vpath::file_name(&v).to_string();
            return Ok(FileEntry::new(if name.is_empty() { v.clone() } else { name }, v, FileKind::Dir));
        }
        tokio::task::spawn_blocking(move || -> Result<FileEntry> {
            let meta = std::fs::symlink_metadata(&native).map_err(|e| Error::io_at(e, &v))?;
            let name = vpath::file_name(&v).to_string();
            Ok(entry_from_metadata(if name.is_empty() { "/".into() } else { name }, v, &meta, &native))
        })
        .await?
    }

    async fn mkdir(&self, path: &str) -> Result<()> {
        tokio::fs::create_dir(to_native(path)).await.map_err(|e| Error::io_at(e, path))
    }

    async fn mkdir_all(&self, path: &str) -> Result<()> {
        tokio::fs::create_dir_all(to_native(path)).await.map_err(|e| Error::io_at(e, path))
    }

    async fn remove_file(&self, path: &str) -> Result<()> {
        let native = to_native(path);
        match tokio::fs::remove_file(&native).await {
            Ok(()) => Ok(()),
            // Directory symlinks on Windows must be removed with remove_dir.
            #[cfg(windows)]
            Err(_) if tokio::fs::symlink_metadata(&native).await.map(|m| m.is_symlink()).unwrap_or(false) => {
                tokio::fs::remove_dir(&native).await.map_err(|e| Error::io_at(e, path))
            }
            Err(e) => Err(Error::io_at(e, path)),
        }
    }

    async fn remove_dir(&self, path: &str) -> Result<()> {
        tokio::fs::remove_dir(to_native(path)).await.map_err(|e| Error::io_at(e, path))
    }

    async fn remove_dir_all(&self, path: &str) -> Result<()> {
        tokio::fs::remove_dir_all(to_native(path)).await.map_err(|e| Error::io_at(e, path))
    }

    async fn rename(&self, from: &str, to: &str) -> Result<()> {
        tokio::fs::rename(to_native(from), to_native(to)).await.map_err(|e| Error::io_at(e, from))
    }

    async fn copy_file(&self, from: &str, to: &str) -> Result<()> {
        tokio::fs::copy(to_native(from), to_native(to)).await.map(|_| ()).map_err(|e| Error::io_at(e, from))
    }

    async fn set_permissions(&self, path: &str, mode: u32) -> Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            tokio::fs::set_permissions(to_native(path), std::fs::Permissions::from_mode(mode))
                .await
                .map_err(|e| Error::io_at(e, path))
        }
        #[cfg(not(unix))]
        {
            let native = to_native(path);
            let meta = tokio::fs::metadata(&native).await.map_err(|e| Error::io_at(e, path))?;
            let mut perms = meta.permissions();
            perms.set_readonly(mode & 0o200 == 0);
            tokio::fs::set_permissions(&native, perms).await.map_err(|e| Error::io_at(e, path))
        }
    }

    async fn set_owner(&self, path: &str, owner: Option<&str>, group: Option<&str>) -> Result<()> {
        #[cfg(unix)]
        {
            let uid = match owner {
                Some(o) if !o.is_empty() => {
                    Some(unix_ids::uid_for(o).ok_or_else(|| Error::InvalidInput(format!("unknown user {o}")))?)
                }
                _ => None,
            };
            let gid = match group {
                Some(g) if !g.is_empty() => {
                    Some(unix_ids::gid_for(g).ok_or_else(|| Error::InvalidInput(format!("unknown group {g}")))?)
                }
                _ => None,
            };
            let native = to_native(path);
            let p = path.to_string();
            tokio::task::spawn_blocking(move || std::os::unix::fs::lchown(&native, uid, gid).map_err(|e| Error::io_at(e, &p)))
                .await?
        }
        #[cfg(not(unix))]
        {
            let _ = (path, owner, group);
            Err(Error::unsupported("changing owner on this platform"))
        }
    }

    async fn set_modified(&self, path: &str, mtime: i64) -> Result<()> {
        let native = to_native(path);
        let p = path.to_string();
        tokio::task::spawn_blocking(move || {
            let ft = filetime::FileTime::from_unix_time(mtime, 0);
            filetime::set_file_mtime(&native, ft).map_err(|e| Error::io_at(e, &p))
        })
        .await?
    }

    async fn symlink(&self, target: &str, link: &str) -> Result<()> {
        #[cfg(unix)]
        {
            tokio::fs::symlink(target, to_native(link)).await.map_err(|e| Error::io_at(e, link))
        }
        #[cfg(windows)]
        {
            let is_dir = tokio::fs::metadata(to_native(target)).await.map(|m| m.is_dir()).unwrap_or(false);
            let t = to_native(target);
            let l = to_native(link);
            if is_dir {
                tokio::fs::symlink_dir(t, l).await.map_err(|e| Error::io_at(e, link))
            } else {
                tokio::fs::symlink_file(t, l).await.map_err(|e| Error::io_at(e, link))
            }
        }
    }

    async fn read_link(&self, path: &str) -> Result<String> {
        let t = tokio::fs::read_link(to_native(path)).await.map_err(|e| Error::io_at(e, path))?;
        Ok(t.to_string_lossy().into_owned())
    }

    async fn open_read(&self, path: &str, offset: u64) -> Result<Box<dyn FileReader>> {
        let mut f = tokio::fs::File::open(to_native(path)).await.map_err(|e| Error::io_at(e, path))?;
        if offset > 0 {
            f.seek(std::io::SeekFrom::Start(offset)).await?;
        }
        Ok(Box::new(AsyncReadAdapter(tokio::io::BufReader::with_capacity(256 * 1024, f))))
    }

    async fn open_write(&self, path: &str, opts: WriteOptions) -> Result<Box<dyn FileWriter>> {
        let native = to_native(path);
        let mut oo = tokio::fs::OpenOptions::new();
        oo.write(true).create(true);
        if opts.offset == 0 {
            oo.truncate(true);
        }
        #[cfg(unix)]
        if let Some(m) = opts.mode {
            oo.mode(m);
        }
        let mut f = oo.open(&native).await.map_err(|e| Error::io_at(e, path))?;
        if opts.offset > 0 {
            f.set_len(opts.offset).await?;
            f.seek(std::io::SeekFrom::Start(opts.offset)).await?;
        }
        Ok(Box::new(LocalWriter { file: tokio::io::BufWriter::with_capacity(256 * 1024, f) }))
    }

    async fn exec(&self, command: &str, cwd: Option<&str>) -> Result<ExecOutput> {
        #[cfg(windows)]
        let mut cmd = {
            let mut c = tokio::process::Command::new("cmd");
            c.arg("/C").arg(command);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
            let mut c = tokio::process::Command::new(shell);
            c.arg("-c").arg(command);
            c
        };
        if let Some(d) = cwd {
            cmd.current_dir(to_native(d));
        }
        cmd.stdin(std::process::Stdio::null());
        let out = tokio::time::timeout(Duration::from_secs(600), cmd.output())
            .await
            .map_err(|_| Error::Timeout("command".into()))??;
        Ok(ExecOutput {
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            exit_code: out.status.code(),
        })
    }

    async fn open_terminal(&self, opts: TerminalOptions) -> Result<TerminalChannel> {
        crate::local_pty::open(opts)
    }

    async fn disk_info(&self, path: &str) -> Result<Option<DiskInfo>> {
        let native = to_native(path);
        tokio::task::spawn_blocking(move || {
            let total = fs4::total_space(&native).ok()?;
            let free = fs4::free_space(&native).ok()?;
            let available = fs4::available_space(&native).ok()?;
            Some(DiskInfo { total, free, available })
        })
        .await
        .map_err(Error::from)
    }
}

struct LocalWriter {
    file: tokio::io::BufWriter<tokio::fs::File>,
}

#[async_trait]
impl FileWriter for LocalWriter {
    async fn write_all(&mut self, buf: &[u8]) -> Result<()> {
        Ok(self.file.write_all(buf).await?)
    }
    async fn finish(mut self: Box<Self>) -> Result<()> {
        self.file.flush().await?;
        self.file.get_mut().sync_all().await.ok();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn local_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let base = from_native(dir.path());
        let vfs = LocalVfs::new();
        let sub = vpath::join(&base, "a/b");
        vfs.mkdir_all(&sub).await.unwrap();
        let f = vpath::join(&sub, "x.txt");
        write_all(&vfs, &f, b"hello").await.unwrap();
        let st = vfs.stat(&f).await.unwrap();
        assert_eq!(st.size, 5);
        assert_eq!(st.kind, FileKind::File);
        let data = read_to_end(&vfs, &f, 100).await.unwrap();
        assert_eq!(data, b"hello");
        // resume
        let mut w = vfs.open_write(&f, WriteOptions { offset: 5, ..Default::default() }).await.unwrap();
        w.write_all(b" world").await.unwrap();
        w.finish().await.unwrap();
        assert_eq!(read_to_end(&vfs, &f, 100).await.unwrap(), b"hello world");
        let mut r = vfs.open_read(&f, 6).await.unwrap();
        let mut buf = [0u8; 16];
        let n = r.read(&mut buf).await.unwrap();
        assert_eq!(&buf[..n], b"world");
        let list = vfs.list(&sub).await.unwrap();
        assert_eq!(list.len(), 1);
        vfs.set_modified(&f, 1_000_000_000).await.unwrap();
        assert_eq!(vfs.stat(&f).await.unwrap().modified, Some(1_000_000_000));
        vfs.rename(&f, &vpath::join(&sub, "y.txt")).await.unwrap();
        vfs.remove_dir_all(&vpath::join(&base, "a")).await.unwrap();
        assert!(vfs.try_stat(&sub).await.unwrap().is_none());
    }
}
