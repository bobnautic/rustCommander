//! SFTP (protocol version 3 plus the OpenSSH extensions) on top of russh-sftp's raw session.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use bytes::BufMut;
use futures::StreamExt;
use parking_lot::Mutex;
use russh::ChannelMsg;
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::RawSftpSession;
use russh_sftp::protocol::{Data, FileAttributes, OpenFlags, Packet, Status, StatusCode};
use tokio::task::JoinHandle;

use super::conn::{ssh_error, SshConnection};
use crate::connect::ConnectContext;
use crate::error::{Error, Result};
use crate::path as vpath;
use crate::site::SiteConfig;
use crate::types::*;
use crate::vfs::*;

const S_IFMT: u32 = 0o170000;
const S_IFDIR: u32 = 0o040000;
const S_IFREG: u32 = 0o100000;
const S_IFLNK: u32 = 0o120000;

/// Largest read/write request we issue (OpenSSH allows 255 KiB).
const MAX_CHUNK: u32 = 255 * 1024;
/// Request size for servers that do not announce `limits@openssh.com`.
const LEGACY_CHUNK: u32 = 32 * 1024;
/// Bytes kept in flight per transfer.
const PIPELINE_BYTES: u32 = 8 * 1024 * 1024;
/// Concurrent stat/readlink requests when resolving symlinks in a listing.
const LINK_CONCURRENCY: usize = 16;

pub(crate) struct SftpVfs {
    conn: Arc<SshConnection>,
    sftp: Arc<RawSftpSession>,
    version: u32,
    extensions: Vec<(String, String)>,
    home: String,
    read_chunk: u32,
    write_chunk: u32,
    posix_rename: bool,
    statvfs: bool,
    copy_data: bool,
    symlink_swapped: bool,
    subsystem: String,
    /// uid/gid -> name, learned from directory listings (lstat only returns numbers).
    names: Mutex<(HashMap<u32, String>, HashMap<u32, String>)>,
}

fn sftp_error(e: SftpError, path: &str) -> Error {
    match e {
        SftpError::Status(s) => status_error(&s, path),
        SftpError::Timeout => Error::Timeout(format!("SFTP request ({path})")),
        SftpError::IO(m) => Error::ConnectionLost(format!("SFTP: {m}")),
        SftpError::UnexpectedBehavior(m)
            if m.contains("session closed")
                || m.contains("sender dropped")
                || m.contains("SendError")
                || m.contains("RecvError") =>
        {
            Error::ConnectionLost("SFTP session closed".into())
        }
        SftpError::UnexpectedBehavior(m) => Error::Protocol(format!("SFTP: {m}")),
        SftpError::Limited(m) => Error::Other(format!("SFTP: {m}")),
        SftpError::UnexpectedPacket => Error::protocol("unexpected SFTP packet"),
    }
}

fn status_error(s: &Status, path: &str) -> Error {
    let msg = if s.error_message.is_empty() { s.status_code.to_string() } else { s.error_message.clone() };
    match s.status_code {
        StatusCode::NoSuchFile => Error::NotFound(path.to_string()),
        StatusCode::PermissionDenied => Error::PermissionDenied(path.to_string()),
        StatusCode::OpUnsupported => Error::Unsupported(format!("{path}: {msg}")),
        StatusCode::NoConnection | StatusCode::ConnectionLost => Error::ConnectionLost(msg),
        StatusCode::Eof => {
            Error::Io(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, format!("{path}: unexpected end of file")))
        }
        _ => Error::Other(format!("{path}: {msg}")),
    }
}

fn status_result(packet: Packet, path: &str) -> Result<()> {
    match packet {
        Packet::Status(s) if s.status_code == StatusCode::Ok => Ok(()),
        Packet::Status(s) => Err(status_error(&s, path)),
        _ => Err(Error::protocol("unexpected SFTP reply")),
    }
}

fn put_string(buf: &mut Vec<u8>, s: &str) {
    buf.put_u32(s.len() as u32);
    buf.put_slice(s.as_bytes());
}

fn kind_of(attrs: &FileAttributes) -> FileKind {
    match attrs.permissions.map(|p| p & S_IFMT) {
        Some(S_IFDIR) => FileKind::Dir,
        Some(S_IFREG) | None => FileKind::File,
        Some(S_IFLNK) => FileKind::Symlink,
        Some(_) => FileKind::Other,
    }
}

/// Owner and group from an `ls -l` style longname, if it looks trustworthy.
fn longname_owner(longname: &str, size: Option<u64>) -> Option<(String, String)> {
    let f: Vec<&str> = longname.split_whitespace().collect();
    if f.len() < 8 {
        return None;
    }
    let perms = f[0];
    if perms.len() < 10 || !"-dlcbpsD".contains(perms.chars().next()?) || f[1].parse::<u64>().is_err() {
        return None;
    }
    if let Some(sz) = size {
        if f[4].parse::<u64>().ok() != Some(sz) {
            return None;
        }
    }
    Some((f[2].to_string(), f[3].to_string()))
}

fn mtime_u32(mtime: i64) -> Result<u32> {
    u32::try_from(mtime)
        .map_err(|_| Error::InvalidInput(format!("modification time {mtime} cannot be represented in SFTP v3")))
}

impl SftpVfs {
    pub(crate) async fn open(conn: Arc<SshConnection>, site: &SiteConfig, ctx: &ConnectContext) -> Result<SftpVfs> {
        let mut channel = conn.open_channel().await?;
        let subsystem = match site.ssh.sftp_server.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(cmd) => {
                channel.exec(true, cmd).await.map_err(|e| ssh_error(e, "starting the SFTP server"))?;
                format!("exec: {cmd}")
            }
            None => {
                channel
                    .request_subsystem(true, "sftp")
                    .await
                    .map_err(|e| ssh_error(e, "requesting the SFTP subsystem"))?;
                "sftp subsystem".to_string()
            }
        };
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) => break,
                Some(ChannelMsg::Failure) => return Err(Error::Unsupported("the server refused to start SFTP".into())),
                Some(ChannelMsg::Close) | Some(ChannelMsg::Eof) | None => {
                    return Err(Error::ConnectionLost("SFTP channel closed by the server".into()))
                }
                Some(_) => {}
            }
        }
        let timeout = conn.timeout();
        let cfg = russh_sftp::client::Config {
            max_packet_len: 1024 * 1024,
            request_timeout_secs: (timeout.as_secs() * 3).max(60),
            ..Default::default()
        };
        let sftp = RawSftpSession::new_with_config(channel.into_stream(), cfg);
        let version = tokio::time::timeout(timeout, sftp.init())
            .await
            .map_err(|_| Error::Timeout("SFTP initialization".into()))?
            .map_err(|e| match sftp_error(e, "SFTP initialization") {
                Error::ConnectionLost(_) => Error::Protocol(
                    "the SFTP server did not answer (is SFTP enabled, or does the login script print text?)".into(),
                ),
                other => other,
            })?;
        let mut extensions: Vec<(String, String)> = version.extensions.into_iter().collect();
        extensions.sort();
        let has = |name: &str, ver: &str| extensions.iter().any(|(n, v)| n == name && v == ver);
        let (mut read_chunk, mut write_chunk) = (LEGACY_CHUNK, LEGACY_CHUNK);
        if has("limits@openssh.com", "1") {
            match sftp.limits().await {
                Ok(l) => {
                    let clamp = |v: u64| if v == 0 { MAX_CHUNK } else { (v.min(MAX_CHUNK as u64)) as u32 };
                    read_chunk = clamp(l.max_read_len);
                    write_chunk = clamp(l.max_write_len);
                    if l.max_packet_len > 0 {
                        write_chunk = write_chunk.min((l.max_packet_len as u32).saturating_sub(1024).max(4096));
                    }
                }
                Err(e) => tracing::debug!(session = %ctx.session_id, "limits@openssh.com failed: {e}"),
            }
        }
        let server_id = conn.server_id();
        let symlink_swapped = ["OpenSSH", "ProFTPD", "mod_sftp"].iter().any(|s| server_id.contains(s));
        let vfs = SftpVfs {
            posix_rename: has("posix-rename@openssh.com", "1"),
            statvfs: has("statvfs@openssh.com", "2"),
            copy_data: has("copy-data", "1"),
            symlink_swapped,
            version: version.version,
            extensions,
            home: String::new(),
            read_chunk,
            write_chunk,
            subsystem,
            names: Mutex::new((HashMap::new(), HashMap::new())),
            sftp: Arc::new(sftp),
            conn,
        };
        let home = vfs.realpath(".").await?;
        tracing::info!(
            session = %ctx.session_id,
            "SFTP v{} ready, home {home}, read/write chunk {}/{} bytes",
            vfs.version,
            vfs.read_chunk,
            vfs.write_chunk
        );
        Ok(SftpVfs { home, ..vfs })
    }

    async fn realpath(&self, path: &str) -> Result<String> {
        let name = self.sftp.realpath(path).await.map_err(|e| sftp_error(e, path))?;
        name.files.into_iter().next().map(|f| f.filename).ok_or_else(|| Error::protocol("empty realpath reply"))
    }

    async fn lstat_attrs(&self, path: &str) -> Result<FileAttributes> {
        Ok(self.sftp.lstat(path).await.map_err(|e| sftp_error(e, path))?.attrs)
    }

    fn entry(&self, name: String, path: String, attrs: &FileAttributes, longname: Option<&str>) -> FileEntry {
        let kind = kind_of(attrs);
        let mut e = FileEntry::new(name, path, kind);
        e.size = if kind == FileKind::Dir { 0 } else { attrs.size.unwrap_or(0) };
        e.modified = attrs.mtime.map(i64::from);
        e.permissions = attrs.permissions.map(|p| p & 0o7777);
        let owner = longname.and_then(|l| longname_owner(l, attrs.size));
        let mut names = self.names.lock();
        match owner {
            Some((o, g)) => {
                if let Some(uid) = attrs.uid {
                    names.0.insert(uid, o.clone());
                }
                if let Some(gid) = attrs.gid {
                    names.1.insert(gid, g.clone());
                }
                e.owner = Some(o);
                e.group = Some(g);
            }
            None => {
                e.owner = attrs.uid.map(|u| names.0.get(&u).cloned().unwrap_or_else(|| u.to_string()));
                e.group = attrs.gid.map(|g| names.1.get(&g).cloned().unwrap_or_else(|| g.to_string()));
            }
        }
        e
    }

    /// Fill `link_target`, `target_kind` (and the target's size) of a symlink entry.
    async fn resolve_link(&self, e: &mut FileEntry) {
        let (target, stat) = tokio::join!(self.sftp.readlink(e.path.as_str()), self.sftp.stat(e.path.as_str()));
        if let Ok(name) = target {
            e.link_target = name.files.into_iter().next().map(|f| f.filename);
        }
        if let Ok(attrs) = stat {
            let tk = kind_of(&attrs.attrs);
            e.target_kind = Some(if tk == FileKind::Dir { FileKind::Dir } else { FileKind::File });
            if tk == FileKind::File {
                e.size = attrs.attrs.size.unwrap_or(e.size);
            }
        }
    }

    /// Turn a generic SFTP failure into a more specific error by looking at the path.
    async fn refine(&self, err: Error, path: &str, op: &str) -> Error {
        if !matches!(err, Error::Other(_)) {
            return err;
        }
        let attrs = self.sftp.lstat(path).await.ok().map(|a| a.attrs);
        let is_dir = attrs.as_ref().map(|a| kind_of(a) == FileKind::Dir);
        match (op, is_dir) {
            ("mkdir", Some(_)) | ("rename_to", Some(_)) => Error::AlreadyExists(path.to_string()),
            ("rmdir", Some(true)) => Error::DirectoryNotEmpty(path.to_string()),
            ("rmdir", Some(false)) | ("opendir", Some(false)) => Error::NotADirectory(path.to_string()),
            ("remove", Some(true)) | ("open", Some(true)) => Error::IsADirectory(path.to_string()),
            _ => err,
        }
    }

    async fn setstat(&self, path: &str, attrs: FileAttributes) -> Result<()> {
        self.sftp.setstat(path, attrs).await.map(|_| ()).map_err(|e| sftp_error(e, path))
    }

    async fn extended(&self, name: &str, data: Vec<u8>, path: &str) -> Result<Packet> {
        self.sftp.extended(name, data).await.map_err(|e| sftp_error(e, path))
    }

    async fn open_handle(&self, path: &str, flags: OpenFlags, attrs: FileAttributes) -> Result<String> {
        match self.sftp.open(path, flags, attrs).await {
            Ok(h) => Ok(h.handle),
            Err(e) => Err(self.refine(sftp_error(e, path), path, "open").await),
        }
    }

    async fn copy_with_extension(&self, from: &str, to: &str) -> Result<()> {
        let attrs = self.sftp.stat(from).await.map_err(|e| sftp_error(e, from))?.attrs;
        let src = self.open_handle(from, OpenFlags::READ, FileAttributes::empty()).await?;
        let mut create = FileAttributes::empty();
        create.permissions = attrs.permissions.map(|p| p & 0o7777);
        let dst = match self.open_handle(to, OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE, create).await {
            Ok(h) => h,
            Err(e) => {
                let _ = self.sftp.close(src).await;
                return Err(e);
            }
        };
        let mut data = Vec::new();
        put_string(&mut data, &src);
        data.put_u64(0);
        data.put_u64(0);
        put_string(&mut data, &dst);
        data.put_u64(0);
        let r = self.extended("copy-data", data, from).await;
        let _ = self.sftp.close(src).await;
        let closed = self.sftp.close(dst).await.map_err(|e| sftp_error(e, to));
        status_result(r?, from)?;
        closed.map(|_| ())
    }
}

#[async_trait]
impl Vfs for SftpVfs {
    fn protocol(&self) -> Protocol {
        Protocol::Sftp
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            permissions: true,
            owner: true,
            symlinks: true,
            exec: true,
            terminal: true,
            tunnels: true,
            server_copy: true,
            resume_upload: true,
            resume_download: true,
            set_modified: true,
            server_checksum: true,
            disk_info: true,
        }
    }

    fn session_info(&self) -> SessionInfo {
        let mut i = SessionInfo::default();
        i.push("Protocol", format!("SFTP version {}", self.version));
        self.conn.push_session_info(&mut i);
        i.push("SFTP server", self.subsystem.clone());
        if !self.extensions.is_empty() {
            let ext: Vec<String> = self.extensions.iter().map(|(n, v)| format!("{n} ({v})")).collect();
            i.push("SFTP extensions", ext.join(", "));
        }
        i.push("Transfer block size", format!("{} / {} bytes (read / write)", self.read_chunk, self.write_chunk));
        i
    }

    async fn home(&self) -> Result<String> {
        Ok(self.home.clone())
    }

    async fn canonicalize(&self, path: &str) -> Result<String> {
        self.realpath(path).await
    }

    async fn list(&self, path: &str) -> Result<Vec<FileEntry>> {
        let dir = vpath::normalize(path);
        let handle = match self.sftp.opendir(dir.as_str()).await {
            Ok(h) => h.handle,
            Err(e) => return Err(self.refine(sftp_error(e, &dir), &dir, "opendir").await),
        };
        let mut out = Vec::new();
        let mut result = Ok(());
        loop {
            match self.sftp.readdir(handle.as_str()).await {
                Ok(name) => {
                    for f in name.files {
                        if f.filename == "." || f.filename == ".." || f.filename.contains('/') {
                            continue;
                        }
                        let p = vpath::join(&dir, &f.filename);
                        out.push(self.entry(f.filename, p, &f.attrs, Some(&f.longname)));
                    }
                }
                Err(SftpError::Status(s)) if s.status_code == StatusCode::Eof => break,
                Err(e) => {
                    result = Err(sftp_error(e, &dir));
                    break;
                }
            }
        }
        let _ = self.sftp.close(handle).await;
        result?;
        let links: Vec<FileEntry> = out.iter().filter(|e| e.kind == FileKind::Symlink).cloned().collect();
        if !links.is_empty() {
            let resolved: Vec<FileEntry> = futures::stream::iter(links)
                .map(|mut e| async move {
                    self.resolve_link(&mut e).await;
                    e
                })
                .buffer_unordered(LINK_CONCURRENCY)
                .collect()
                .await;
            let by_path: HashMap<String, FileEntry> = resolved.into_iter().map(|e| (e.path.clone(), e)).collect();
            for e in out.iter_mut().filter(|e| e.kind == FileKind::Symlink) {
                if let Some(r) = by_path.get(&e.path) {
                    *e = r.clone();
                }
            }
        }
        Ok(out)
    }

    async fn stat(&self, path: &str) -> Result<FileEntry> {
        let p = vpath::normalize(path);
        let attrs = self.lstat_attrs(&p).await?;
        let name = vpath::file_name(&p);
        let name = if name.is_empty() { "/".to_string() } else { name.to_string() };
        let mut e = self.entry(name, p, &attrs, None);
        if e.kind == FileKind::Symlink {
            self.resolve_link(&mut e).await;
        }
        Ok(e)
    }

    async fn mkdir(&self, path: &str) -> Result<()> {
        match self.sftp.mkdir(path, FileAttributes::empty()).await {
            Ok(_) => Ok(()),
            Err(e) => Err(self.refine(sftp_error(e, path), path, "mkdir").await),
        }
    }

    async fn remove_file(&self, path: &str) -> Result<()> {
        match self.sftp.remove(path).await {
            Ok(_) => Ok(()),
            Err(e) => Err(self.refine(sftp_error(e, path), path, "remove").await),
        }
    }

    async fn remove_dir(&self, path: &str) -> Result<()> {
        match self.sftp.rmdir(path).await {
            Ok(_) => Ok(()),
            Err(e) => Err(self.refine(sftp_error(e, path), path, "rmdir").await),
        }
    }

    async fn rename(&self, from: &str, to: &str) -> Result<()> {
        if self.posix_rename {
            let mut data = Vec::new();
            put_string(&mut data, from);
            put_string(&mut data, to);
            return status_result(self.extended("posix-rename@openssh.com", data, from).await?, from);
        }
        match self.sftp.rename(from, to).await {
            Ok(_) => Ok(()),
            Err(e) => {
                let err = sftp_error(e, from);
                if matches!(err, Error::Other(_)) && self.sftp.lstat(to).await.is_ok() {
                    return Err(Error::AlreadyExists(to.to_string()));
                }
                Err(err)
            }
        }
    }

    async fn copy_file(&self, from: &str, to: &str) -> Result<()> {
        if self.copy_data {
            return self.copy_with_extension(from, to).await;
        }
        let out = self
            .conn
            .exec(&format!("cp -p {} {}", super::shell::quote_path(from), super::shell::quote_path(to)), None)
            .await?;
        if out.exit_code == Some(0) {
            Ok(())
        } else {
            Err(super::shell::command_error(&out.stderr, out.exit_code, from))
        }
    }

    async fn set_permissions(&self, path: &str, mode: u32) -> Result<()> {
        let mut attrs = FileAttributes::empty();
        attrs.permissions = Some(mode & 0o7777);
        self.setstat(path, attrs).await
    }

    async fn set_owner(&self, path: &str, owner: Option<&str>, group: Option<&str>) -> Result<()> {
        let (uid, gid) = self.conn.resolve_ids(owner, group).await?;
        if uid.is_none() && gid.is_none() {
            return Ok(());
        }
        // SFTP v3 always sets uid and gid together.
        let current = self.sftp.stat(path).await.map_err(|e| sftp_error(e, path))?.attrs;
        let mut attrs = FileAttributes::empty();
        attrs.uid = uid.or(current.uid);
        attrs.gid = gid.or(current.gid);
        if attrs.uid.is_none() || attrs.gid.is_none() {
            return Err(Error::unsupported("the server does not report file ownership"));
        }
        self.setstat(path, attrs).await
    }

    async fn set_modified(&self, path: &str, mtime: i64) -> Result<()> {
        let mtime = mtime_u32(mtime)?;
        let current = self.sftp.stat(path).await.map_err(|e| sftp_error(e, path))?.attrs;
        let mut attrs = FileAttributes::empty();
        attrs.atime = Some(current.atime.unwrap_or(mtime));
        attrs.mtime = Some(mtime);
        self.setstat(path, attrs).await
    }

    async fn symlink(&self, target: &str, link: &str) -> Result<()> {
        // OpenSSH sends (target, link) in the order the draft calls (linkpath, targetpath).
        let r = if self.symlink_swapped {
            self.sftp.symlink(target, link).await
        } else {
            self.sftp.symlink(link, target).await
        };
        match r {
            Ok(_) => Ok(()),
            Err(e) => Err(self.refine(sftp_error(e, link), link, "mkdir").await),
        }
    }

    async fn read_link(&self, path: &str) -> Result<String> {
        let name = self.sftp.readlink(path).await.map_err(|e| sftp_error(e, path))?;
        name.files.into_iter().next().map(|f| f.filename).ok_or_else(|| Error::protocol("empty readlink reply"))
    }

    async fn open_read(&self, path: &str, offset: u64) -> Result<Box<dyn FileReader>> {
        let handle = self.open_handle(path, OpenFlags::READ, FileAttributes::empty()).await?;
        Ok(Box::new(SftpReader::new(self.sftp.clone(), handle, offset, self.read_chunk, path)))
    }

    async fn open_write(&self, path: &str, opts: WriteOptions) -> Result<Box<dyn FileWriter>> {
        let mut flags = OpenFlags::WRITE | OpenFlags::CREATE;
        if opts.offset == 0 {
            flags |= OpenFlags::TRUNCATE;
        }
        let mut attrs = FileAttributes::empty();
        attrs.permissions = opts.mode.map(|m| m & 0o7777);
        let handle = self.open_handle(path, flags, attrs).await?;
        if opts.offset > 0 {
            // Resume: make sure the file holds exactly `offset` bytes.
            let mut a = FileAttributes::empty();
            a.size = Some(opts.offset);
            if let Err(e) = self.sftp.fsetstat(handle.as_str(), a).await {
                tracing::debug!(session = %self.conn.session_id(), "cannot truncate {path} for resume: {e}");
            }
        }
        Ok(Box::new(SftpWriter::new(self.sftp.clone(), handle, opts.offset, self.write_chunk, path)))
    }

    async fn exec(&self, command: &str, cwd: Option<&str>) -> Result<ExecOutput> {
        self.conn.exec(command, cwd).await
    }

    async fn open_terminal(&self, opts: TerminalOptions) -> Result<TerminalChannel> {
        self.conn.open_terminal(opts).await
    }

    async fn open_tunnel(&self, host: &str, port: u16) -> Result<BoxedTunnelStream> {
        self.conn.open_tunnel(host, port).await
    }

    async fn checksum(&self, path: &str, algo: ChecksumAlgo) -> Result<Option<String>> {
        self.conn.checksum(path, algo).await
    }

    async fn disk_info(&self, path: &str) -> Result<Option<DiskInfo>> {
        if self.statvfs {
            match self.sftp.statvfs(path).await {
                Ok(s) => {
                    let unit = if s.fragment_size > 0 { s.fragment_size } else { s.block_size };
                    return Ok(Some(DiskInfo {
                        total: s.blocks.saturating_mul(unit),
                        free: s.blocks_free.saturating_mul(unit),
                        available: s.blocks_avail.saturating_mul(unit),
                    }));
                }
                Err(e) => {
                    let err = sftp_error(e, path);
                    if err.is_connection_error() {
                        return Err(err);
                    }
                }
            }
        }
        self.conn.df(path).await
    }

    async fn ping(&self) -> Result<()> {
        if self.conn.is_closed() {
            return Err(Error::ConnectionLost("SSH connection closed".into()));
        }
        tokio::time::timeout(self.conn.timeout(), self.sftp.realpath("."))
            .await
            .map_err(|_| Error::Timeout("SFTP ping".into()))?
            .map(|_| ())
            .map_err(|e| sftp_error(e, "."))
    }

    async fn close(&self) -> Result<()> {
        let _ = self.sftp.close_session();
        self.conn.disconnect().await;
        Ok(())
    }
}

fn spawn_close(sftp: &Arc<RawSftpSession>, handle: String) {
    if let Ok(rt) = tokio::runtime::Handle::try_current() {
        let sftp = sftp.clone();
        rt.spawn(async move {
            let _ = sftp.close(handle).await;
        });
    }
}

type ReadTask = JoinHandle<std::result::Result<Data, SftpError>>;

/// Pipelined reader: keeps several READ requests in flight and returns the data in order.
struct SftpReader {
    sftp: Arc<RawSftpSession>,
    handle: Option<String>,
    path: String,
    /// Offset of the next request to send.
    next_offset: u64,
    chunk: u32,
    max_inflight: usize,
    window: usize,
    inflight: VecDeque<(u64, u32, ReadTask)>,
    buf: Vec<u8>,
    pos: usize,
    eof: bool,
}

impl SftpReader {
    fn new(sftp: Arc<RawSftpSession>, handle: String, offset: u64, chunk: u32, path: &str) -> Self {
        let max_inflight = (PIPELINE_BYTES / chunk.max(1)).clamp(2, 64) as usize;
        SftpReader {
            sftp,
            handle: Some(handle),
            path: path.to_string(),
            next_offset: offset,
            chunk,
            max_inflight,
            window: 2,
            inflight: VecDeque::new(),
            buf: Vec::new(),
            pos: 0,
            eof: false,
        }
    }

    fn fill(&mut self) {
        let Some(handle) = &self.handle else {
            return;
        };
        while self.inflight.len() < self.window {
            let sftp = self.sftp.clone();
            let (h, off, len) = (handle.clone(), self.next_offset, self.chunk);
            self.inflight.push_back((off, len, tokio::spawn(async move { sftp.read(h, off, len).await })));
            self.next_offset += len as u64;
        }
    }

    fn cancel_inflight(&mut self) {
        for (_, _, t) in self.inflight.drain(..) {
            t.abort();
        }
    }

    fn finish(&mut self) {
        self.eof = true;
        self.cancel_inflight();
        if let Some(h) = self.handle.take() {
            spawn_close(&self.sftp, h);
        }
    }
}

#[async_trait]
impl FileReader for SftpReader {
    async fn read(&mut self, out: &mut [u8]) -> Result<usize> {
        loop {
            if self.pos < self.buf.len() {
                let n = out.len().min(self.buf.len() - self.pos);
                out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
                self.pos += n;
                return Ok(n);
            }
            if self.eof || out.is_empty() {
                return Ok(0);
            }
            self.fill();
            let Some((off, len, task)) = self.inflight.pop_front() else {
                return Ok(0);
            };
            match task.await {
                Ok(Ok(data)) => {
                    let n = data.data.len();
                    if n == 0 {
                        self.finish();
                        return Ok(0);
                    }
                    if (n as u32) < len {
                        // Short read: re-request the rest from here on; adapt to the server's limit.
                        self.cancel_inflight();
                        self.next_offset = off + n as u64;
                        if n >= 4096 {
                            self.chunk = n as u32;
                        }
                    } else {
                        self.window = (self.window * 2).min(self.max_inflight);
                    }
                    self.buf = data.data;
                    self.pos = 0;
                }
                Ok(Err(SftpError::Status(s))) if s.status_code == StatusCode::Eof => self.finish(),
                Ok(Err(e)) => {
                    self.finish();
                    return Err(sftp_error(e, &self.path));
                }
                Err(e) => {
                    self.finish();
                    return Err(Error::other(format!("SFTP read task failed: {e}")));
                }
            }
        }
    }
}

impl Drop for SftpReader {
    fn drop(&mut self) {
        self.finish();
    }
}

type WriteTask = JoinHandle<std::result::Result<Status, SftpError>>;

/// Pipelined writer: sends WRITE requests without waiting for each reply.
struct SftpWriter {
    sftp: Arc<RawSftpSession>,
    handle: Option<String>,
    path: String,
    offset: u64,
    chunk: usize,
    max_inflight: usize,
    pending: Vec<u8>,
    inflight: VecDeque<WriteTask>,
}

impl SftpWriter {
    fn new(sftp: Arc<RawSftpSession>, handle: String, offset: u64, chunk: u32, path: &str) -> Self {
        SftpWriter {
            sftp,
            handle: Some(handle),
            path: path.to_string(),
            offset,
            chunk: chunk.max(1024) as usize,
            max_inflight: (PIPELINE_BYTES / chunk.max(1)).clamp(2, 64) as usize,
            pending: Vec::new(),
            inflight: VecDeque::new(),
        }
    }

    async fn wait_one(&mut self) -> Result<()> {
        let Some(task) = self.inflight.pop_front() else {
            return Ok(());
        };
        match task.await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) => Err(sftp_error(e, &self.path)),
            Err(e) => Err(Error::other(format!("SFTP write task failed: {e}"))),
        }
    }

    async fn submit(&mut self, data: Vec<u8>) -> Result<()> {
        while self.inflight.len() >= self.max_inflight {
            self.wait_one().await?;
        }
        let handle = self.handle.clone().ok_or_else(|| Error::other("file already closed"))?;
        let sftp = self.sftp.clone();
        let off = self.offset;
        self.offset += data.len() as u64;
        self.inflight.push_back(tokio::spawn(async move { sftp.write(handle, off, data).await }));
        Ok(())
    }

    fn abort(&mut self) {
        for t in self.inflight.drain(..) {
            t.abort();
        }
        if let Some(h) = self.handle.take() {
            spawn_close(&self.sftp, h);
        }
    }
}

#[async_trait]
impl FileWriter for SftpWriter {
    async fn write_all(&mut self, mut buf: &[u8]) -> Result<()> {
        if self.pending.is_empty() {
            while buf.len() >= self.chunk {
                let (head, rest) = buf.split_at(self.chunk);
                buf = rest;
                if let Err(e) = self.submit(head.to_vec()).await {
                    self.abort();
                    return Err(e);
                }
            }
        }
        self.pending.extend_from_slice(buf);
        while self.pending.len() >= self.chunk {
            let rest = self.pending.split_off(self.chunk);
            let data = std::mem::replace(&mut self.pending, rest);
            if let Err(e) = self.submit(data).await {
                self.abort();
                return Err(e);
            }
        }
        Ok(())
    }

    async fn finish(mut self: Box<Self>) -> Result<()> {
        if !self.pending.is_empty() {
            let data = std::mem::take(&mut self.pending);
            if let Err(e) = self.submit(data).await {
                self.abort();
                return Err(e);
            }
        }
        while !self.inflight.is_empty() {
            if let Err(e) = self.wait_one().await {
                self.abort();
                return Err(e);
            }
        }
        let handle = self.handle.take().ok_or_else(|| Error::other("file already closed"))?;
        tokio::time::timeout(Duration::from_secs(120), self.sftp.close(handle))
            .await
            .map_err(|_| Error::Timeout(format!("closing {}", self.path)))?
            .map(|_| ())
            .map_err(|e| sftp_error(e, &self.path))
    }
}

impl Drop for SftpWriter {
    fn drop(&mut self) {
        self.abort();
    }
}
