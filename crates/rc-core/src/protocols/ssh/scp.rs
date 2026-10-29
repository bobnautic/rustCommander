//! SCP mode: file operations through shell commands and file
//! transfers through the classic `scp -f` / `scp -t` protocol.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;

use super::conn::{ExecChannel, SshConnection};
use super::shell::{command_error, parse_ls_line, quote, quote_path, LsEntry};
use crate::connect::ConnectContext;
use crate::error::{Error, Result};
use crate::path as vpath;
use crate::site::SiteConfig;
use crate::types::*;
use crate::vfs::*;

/// Symlinks resolved per `ls -lLd` command.
const LINKS_PER_COMMAND: usize = 100;

/// Timestamp format of the server's `ls -l`.
#[derive(Debug, Clone, Copy, PartialEq)]
enum LsStyle {
    /// GNU `--time-style=+%s`.
    Epoch,
    /// `--full-time` (busybox).
    FullTime,
    /// BSD / macOS `-T`.
    Bsd,
    /// `Mon DD HH:MM` / `Mon DD YYYY` (minute precision at best).
    Classic,
}

const LS_PROBE: &str = "if ls -d --time-style=+%s / >/dev/null 2>&1; then echo ls-style:epoch; \
    elif ls -d --full-time / >/dev/null 2>&1; then echo ls-style:full; \
    elif ls -dT / >/dev/null 2>&1; then echo ls-style:bsd; fi";

pub(crate) struct ScpVfs {
    conn: Arc<SshConnection>,
    home: String,
    shell: String,
    ls_style: LsStyle,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn to_entry(e: LsEntry, path: String) -> FileEntry {
    let mut f = FileEntry::new(e.name, path, e.kind);
    f.size = if e.kind == FileKind::Dir { 0 } else { e.size };
    f.modified = e.modified;
    f.permissions = e.permissions;
    f.owner = Some(e.owner);
    f.group = Some(e.group);
    f.link_target = e.link_target;
    f
}

fn scp_error(msg: &[u8], path: &str) -> Error {
    let msg = String::from_utf8_lossy(msg);
    if msg.contains("not a regular file") {
        return Error::IsADirectory(path.to_string());
    }
    command_error(&msg, None, path)
}

async fn read_ack(ch: &mut ExecChannel, path: &str) -> Result<()> {
    match ch.read_byte().await? {
        Some(0) => Ok(()),
        Some(1) | Some(2) => {
            let line = ch.read_line(64 * 1024).await.unwrap_or_default();
            Err(scp_error(&line, path))
        }
        Some(b) => {
            // Probably text printed by the login scripts or a shell error.
            let mut line = vec![b];
            line.extend(ch.read_line(64 * 1024).await.unwrap_or_default());
            Err(Error::Protocol(format!("unexpected SCP response: {}", String::from_utf8_lossy(&line).trim())))
        }
        None => Err(command_error(&ch.stderr(), None, path)),
    }
}

impl ScpVfs {
    pub(crate) async fn open(conn: Arc<SshConnection>, site: &SiteConfig, ctx: &ConnectContext) -> Result<ScpVfs> {
        let shell = site.ssh.shell.clone().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "/bin/sh".into());
        let mut vfs = ScpVfs { conn, home: "/".into(), shell, ls_style: LsStyle::Classic };
        let out = vfs.run(&format!("pwd; {LS_PROBE}")).await?;
        match out.stdout.lines().map(str::trim).find(|l| l.starts_with('/')) {
            Some(home) => vfs.home = home.to_string(),
            None => {
                return Err(Error::Unsupported(format!(
                    "cannot run shell commands on the server: {}",
                    out.stderr.trim()
                )))
            }
        }
        vfs.ls_style = match out.stdout.lines().find_map(|l| l.trim().strip_prefix("ls-style:")) {
            Some("epoch") => LsStyle::Epoch,
            Some("full") => LsStyle::FullTime,
            Some("bsd") => LsStyle::Bsd,
            _ => LsStyle::Classic,
        };
        tracing::info!(session = %ctx.session_id, "SCP mode ready, home {}, ls style {:?}", vfs.home, vfs.ls_style);
        Ok(vfs)
    }

    /// Wrap a POSIX shell script so it runs under the configured shell with C locale.
    fn script(&self, cmd: &str) -> String {
        format!("{} -c {}", self.shell, quote(&format!("LC_ALL=C; export LC_ALL; {cmd}")))
    }

    async fn run(&self, cmd: &str) -> Result<ExecOutput> {
        self.conn.exec(&self.script(cmd), None).await
    }

    async fn check(&self, cmd: &str, path: &str) -> Result<String> {
        let out = self.run(cmd).await?;
        if out.exit_code == Some(0) {
            Ok(out.stdout)
        } else {
            Err(command_error(&out.stderr, out.exit_code, path))
        }
    }

    fn ls(&self, flags: &str) -> String {
        match self.ls_style {
            LsStyle::Epoch => format!("TZ=UTC ls {flags} --time-style=+%s"),
            LsStyle::FullTime => format!("TZ=UTC ls {flags} --full-time"),
            LsStyle::Bsd => format!("TZ=UTC ls {flags}T"),
            LsStyle::Classic => format!("TZ=UTC ls {flags}"),
        }
    }

    /// Resolve the targets of symlink entries with `ls -lLd`.
    async fn resolve_links(&self, entries: &mut [FileEntry]) -> Result<()> {
        let links: Vec<String> =
            entries.iter().filter(|e| e.kind == FileKind::Symlink).map(|e| e.path.clone()).collect();
        let mut targets: HashMap<String, LsEntry> = HashMap::new();
        for chunk in links.chunks(LINKS_PER_COMMAND) {
            let args: Vec<String> = chunk.iter().map(|p| quote_path(p)).collect();
            let out = self.run(&format!("{} {} 2>/dev/null", self.ls("-lLd"), args.join(" "))).await?;
            for line in out.stdout.lines() {
                if let Some(e) = parse_ls_line(line, now()) {
                    targets.insert(e.name.clone(), e);
                }
            }
        }
        for e in entries.iter_mut().filter(|e| e.kind == FileKind::Symlink) {
            if let Some(t) = targets.get(&e.path).or_else(|| targets.get(&format!("./{}", e.path))) {
                e.target_kind = Some(if t.kind == FileKind::Dir { FileKind::Dir } else { FileKind::File });
                if t.kind == FileKind::File {
                    e.size = t.size;
                }
            }
        }
        Ok(())
    }

    async fn simple(&self, cmd: String, path: &str) -> Result<()> {
        self.check(&cmd, path).await.map(|_| ())
    }
}

#[async_trait]
impl Vfs for ScpVfs {
    fn protocol(&self) -> Protocol {
        Protocol::Scp
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
        i.push("Protocol", "SCP (shell commands)");
        self.conn.push_session_info(&mut i);
        i.push("Shell", self.shell.clone());
        let style = match self.ls_style {
            LsStyle::Epoch => "ls --time-style=+%s",
            LsStyle::FullTime => "ls --full-time",
            LsStyle::Bsd => "ls -T",
            LsStyle::Classic => "ls (minute precision)",
        };
        i.push("Directory listing", style);
        i
    }

    async fn home(&self) -> Result<String> {
        Ok(self.home.clone())
    }

    async fn canonicalize(&self, path: &str) -> Result<String> {
        let p = vpath::normalize(path);
        let q = quote_path(&p);
        let out = self.run(&format!("cd {q} 2>/dev/null && pwd -P || readlink -f {q}")).await?;
        match out.stdout.lines().next().map(str::trim) {
            Some(line) if out.exit_code == Some(0) && line.starts_with('/') => Ok(line.to_string()),
            _ if out.stderr.contains("No such file") => Err(Error::NotFound(p)),
            _ => Ok(p),
        }
    }

    async fn list(&self, path: &str) -> Result<Vec<FileEntry>> {
        let dir = vpath::normalize(path);
        let target = if dir.ends_with('/') { dir.clone() } else { format!("{dir}/") };
        let out = self.run(&format!("{} {}", self.ls("-la"), quote_path(&target))).await?;
        let now = now();
        // GNU ls exits with 1 when single entries cannot be examined (another user's FUSE
        // mount, a file deleted meanwhile) but still lists the rest.
        let listed = match out.exit_code {
            Some(0) => true,
            Some(1) => out.stdout.lines().any(|l| parse_ls_line(l, now).is_some()),
            _ => false,
        };
        if !listed {
            return Err(command_error(&out.stderr, out.exit_code, &dir));
        }
        let mut entries: Vec<FileEntry> = out
            .stdout
            .lines()
            .filter_map(|l| parse_ls_line(l, now))
            .filter(|e| e.name != "." && e.name != ".." && !e.name.contains('/'))
            .map(|e| {
                let p = vpath::join(&dir, &e.name);
                to_entry(e, p)
            })
            .collect();
        self.resolve_links(&mut entries).await?;
        Ok(entries)
    }

    async fn stat(&self, path: &str) -> Result<FileEntry> {
        let p = vpath::normalize(path);
        let out = self.check(&format!("{} {}", self.ls("-lad"), quote_path(&p)), &p).await?;
        let e = out
            .lines()
            .find_map(|l| parse_ls_line(l, now()))
            .ok_or_else(|| Error::Protocol(format!("cannot parse ls output for {p}")))?;
        let name = vpath::file_name(&p);
        let mut e = to_entry(LsEntry { name: if name.is_empty() { "/".into() } else { name.into() }, ..e }, p);
        if e.kind == FileKind::Symlink {
            self.resolve_links(std::slice::from_mut(&mut e)).await?;
        }
        Ok(e)
    }

    async fn mkdir(&self, path: &str) -> Result<()> {
        self.simple(format!("mkdir {}", quote_path(path)), path).await
    }

    async fn mkdir_all(&self, path: &str) -> Result<()> {
        self.simple(format!("mkdir -p {}", quote_path(path)), path).await
    }

    async fn remove_file(&self, path: &str) -> Result<()> {
        self.simple(format!("rm -f {}", quote_path(path)), path).await
    }

    async fn remove_dir(&self, path: &str) -> Result<()> {
        self.simple(format!("rmdir {}", quote_path(path)), path).await
    }

    async fn remove_dir_all(&self, path: &str) -> Result<()> {
        let p = vpath::normalize(path);
        if p == "/" {
            return Err(Error::InvalidInput("refusing to remove /".into()));
        }
        self.simple(format!("rm -rf {}", quote_path(&p)), &p).await
    }

    async fn rename(&self, from: &str, to: &str) -> Result<()> {
        let (f, t) = (quote_path(from), quote_path(to));
        // `mv` would move into an existing directory; rename semantics want a failure.
        // The message is quoted too: the target name must never reach the shell unquoted.
        let msg = quote(&format!("mv: {to}: File exists"));
        let cmd = format!("if [ -d {t} ] && [ ! -L {t} ]; then echo {msg} >&2; exit 1; fi; mv -f {f} {t}");
        match self.check(&cmd, from).await {
            Err(Error::AlreadyExists(_)) => Err(Error::AlreadyExists(to.to_string())),
            r => r.map(|_| ()),
        }
    }

    async fn copy_file(&self, from: &str, to: &str) -> Result<()> {
        self.simple(format!("cp -p {} {}", quote_path(from), quote_path(to)), from).await
    }

    async fn set_permissions(&self, path: &str, mode: u32) -> Result<()> {
        self.simple(format!("chmod {:o} {}", mode & 0o7777, quote_path(path)), path).await
    }

    async fn set_owner(&self, path: &str, owner: Option<&str>, group: Option<&str>) -> Result<()> {
        let owner = owner.filter(|o| !o.is_empty());
        let group = group.filter(|g| !g.is_empty());
        let p = quote_path(path);
        let cmd = match (owner, group) {
            (Some(o), Some(g)) => format!("chown {} {p}", quote(&format!("{o}:{g}"))),
            (Some(o), None) => format!("chown {} {p}", quote(o)),
            (None, Some(g)) => format!("chgrp {} {p}", quote(g)),
            (None, None) => return Ok(()),
        };
        self.simple(cmd, path).await
    }

    async fn set_modified(&self, path: &str, mtime: i64) -> Result<()> {
        let t = chrono::DateTime::from_timestamp(mtime, 0)
            .ok_or_else(|| Error::InvalidInput(format!("invalid time {mtime}")))?;
        let p = quote_path(path);
        let cmd = format!(
            "touch -c -m -d @{mtime} {p} 2>/dev/null || TZ=UTC touch -c -m -t {} {p}",
            t.format("%Y%m%d%H%M.%S")
        );
        self.simple(cmd, path).await
    }

    async fn symlink(&self, target: &str, link: &str) -> Result<()> {
        self.simple(format!("ln -s {} {}", quote_path(target), quote_path(link)), link).await
    }

    async fn read_link(&self, path: &str) -> Result<String> {
        let out = self.check(&format!("readlink {}", quote_path(path)), path).await?;
        Ok(out.trim_end_matches('\n').to_string())
    }

    async fn open_read(&self, path: &str, offset: u64) -> Result<Box<dyn FileReader>> {
        let p = quote_path(path);
        if offset > 0 {
            let ch = self.conn.exec_channel(&self.script(&format!("tail -c +{} {p}", offset + 1))).await?;
            ch.send_eof().await?;
            return Ok(Box::new(ScpReader { ch: Some(ch), remaining: None, path: path.to_string() }));
        }
        let mut ch = self.conn.exec_channel(&self.script(&format!("scp -f {p}"))).await?;
        ch.write_all(&[0]).await?;
        let size = loop {
            match ch.read_byte().await? {
                Some(b'C') => {
                    let line = String::from_utf8_lossy(&ch.read_line(64 * 1024).await?).into_owned();
                    let mut parts = line.splitn(3, ' ');
                    let _mode = parts.next();
                    let size: u64 = parts
                        .next()
                        .and_then(|s| s.parse().ok())
                        .ok_or_else(|| Error::Protocol(format!("bad SCP header: C{line}")))?;
                    break size;
                }
                Some(b'T') => {
                    ch.read_line(1024).await?;
                    ch.write_all(&[0]).await?;
                }
                Some(b'D') => return Err(Error::IsADirectory(path.to_string())),
                Some(1) | Some(2) => return Err(scp_error(&ch.read_line(64 * 1024).await.unwrap_or_default(), path)),
                Some(b) => {
                    let mut line = vec![b];
                    line.extend(ch.read_line(64 * 1024).await.unwrap_or_default());
                    return Err(Error::Protocol(format!(
                        "unexpected SCP response: {}",
                        String::from_utf8_lossy(&line).trim()
                    )));
                }
                None => return Err(command_error(&ch.stderr(), None, path)),
            }
        };
        ch.write_all(&[0]).await?;
        Ok(Box::new(ScpReader { ch: Some(ch), remaining: Some(size), path: path.to_string() }))
    }

    async fn open_write(&self, path: &str, opts: WriteOptions) -> Result<Box<dyn FileWriter>> {
        let p = quote_path(path);
        let mode = opts.mode.map(|m| m & 0o7777);
        if opts.offset == 0 {
            if let Some(size) = opts.size_hint {
                let name = vpath::file_name(path);
                if name.is_empty() || name.contains('\n') {
                    return Err(Error::InvalidInput(format!("invalid file name {path:?}")));
                }
                let mut ch = self.conn.exec_channel(&self.script(&format!("scp -t {p}"))).await?;
                read_ack(&mut ch, path).await?;
                ch.write_all(format!("C{:04o} {size} {name}\n", mode.unwrap_or(0o644)).as_bytes()).await?;
                read_ack(&mut ch, path).await?;
                return Ok(Box::new(ScpWriter { ch: Some(ch), size: Some(size), written: 0, path: path.to_string() }));
            }
        }
        // Unknown size or resume: stream through `cat`.
        let mut cmd = if opts.offset > 0 {
            format!("dd if=/dev/null of={p} bs=1 seek={} && cat >> {p}", opts.offset)
        } else {
            format!("cat > {p}")
        };
        if let (Some(m), 0) = (mode, opts.offset) {
            cmd.push_str(&format!(" && chmod {m:o} {p}"));
        }
        let ch = self.conn.exec_channel(&self.script(&cmd)).await?;
        Ok(Box::new(ScpWriter { ch: Some(ch), size: None, written: 0, path: path.to_string() }))
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
        self.conn.df(path).await
    }

    async fn ping(&self) -> Result<()> {
        self.conn.ping().await
    }

    async fn close(&self) -> Result<()> {
        self.conn.disconnect().await;
        Ok(())
    }
}

/// Download through `scp -f` (`remaining` = bytes announced in the `C` record) or a raw
/// command (`tail -c`, `remaining` = `None`).
struct ScpReader {
    ch: Option<ExecChannel>,
    remaining: Option<u64>,
    path: String,
}

impl ScpReader {
    async fn end(&mut self) -> Result<()> {
        let Some(mut ch) = self.ch.take() else {
            return Ok(());
        };
        if self.remaining.is_some() {
            read_ack(&mut ch, &self.path).await?;
            ch.write_all(&[0]).await?;
            ch.send_eof().await?;
        }
        let (code, stderr) = ch.finish().await?;
        if code == Some(0) {
            Ok(())
        } else {
            Err(command_error(&stderr, code, &self.path))
        }
    }
}

#[async_trait]
impl FileReader for ScpReader {
    async fn read(&mut self, buf: &mut [u8]) -> Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let Some(ch) = self.ch.as_mut() else {
            return Ok(0);
        };
        let want = match self.remaining {
            Some(0) => {
                self.end().await?;
                return Ok(0);
            }
            Some(r) => buf.len().min(r.min(usize::MAX as u64) as usize),
            None => buf.len(),
        };
        let n = ch.read(&mut buf[..want]).await?;
        match (n, self.remaining.as_mut()) {
            (0, Some(_)) => Err(Error::ConnectionLost(format!("SCP transfer of {} ended early", self.path))),
            (0, None) => {
                self.end().await?;
                Ok(0)
            }
            (n, Some(r)) => {
                *r -= n as u64;
                Ok(n)
            }
            (n, None) => Ok(n),
        }
    }
}

/// Upload through `scp -t` (`size` known) or a raw `cat` command.
struct ScpWriter {
    ch: Option<ExecChannel>,
    size: Option<u64>,
    written: u64,
    path: String,
}

#[async_trait]
impl FileWriter for ScpWriter {
    async fn write_all(&mut self, buf: &[u8]) -> Result<()> {
        if let Some(size) = self.size {
            if self.written + buf.len() as u64 > size {
                return Err(Error::InvalidInput(format!("{}: more data than the announced {size} bytes", self.path)));
            }
        }
        let ch = self.ch.as_mut().ok_or_else(|| Error::other("file already closed"))?;
        ch.write_all(buf).await?;
        self.written += buf.len() as u64;
        Ok(())
    }

    async fn finish(mut self: Box<Self>) -> Result<()> {
        let mut ch = self.ch.take().ok_or_else(|| Error::other("file already closed"))?;
        if let Some(size) = self.size {
            if self.written != size {
                return Err(Error::InvalidInput(format!(
                    "{}: wrote {} of {size} announced bytes",
                    self.path, self.written
                )));
            }
            ch.write_all(&[0]).await?;
            read_ack(&mut ch, &self.path).await?;
        }
        ch.send_eof().await?;
        while ch.read_chunk().await?.is_some() {}
        let (code, stderr) = ch.finish().await?;
        if code == Some(0) {
            Ok(())
        } else {
            Err(command_error(&stderr, code, &self.path))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scp_errors() {
        assert!(matches!(scp_error(b"scp: /x: No such file or directory", "/x"), Error::NotFound(_)));
        assert!(matches!(scp_error(b"scp: /x: not a regular file", "/x"), Error::IsADirectory(_)));
    }
}
