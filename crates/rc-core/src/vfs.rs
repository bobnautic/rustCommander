//! The virtual file system abstraction every protocol implements.

use std::pin::Pin;

use async_trait::async_trait;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::error::{Error, Result};
use crate::path;
use crate::types::*;

/// Sequential reader for file contents.
#[async_trait]
pub trait FileReader: Send {
    /// Read up to `buf.len()` bytes. Returns `0` at end of file.
    async fn read(&mut self, buf: &mut [u8]) -> Result<usize>;
}

/// Sequential writer for file contents.
///
/// `finish` must be called to commit the data; dropping a writer without calling it
/// aborts the upload on a best-effort basis.
#[async_trait]
pub trait FileWriter: Send {
    async fn write_all(&mut self, buf: &[u8]) -> Result<()>;
    async fn finish(self: Box<Self>) -> Result<()>;
}

/// Adapts any tokio [`AsyncRead`] into a [`FileReader`].
pub struct AsyncReadAdapter<R>(pub R);

#[async_trait]
impl<R: AsyncRead + Unpin + Send> FileReader for AsyncReadAdapter<R> {
    async fn read(&mut self, buf: &mut [u8]) -> Result<usize> {
        Ok(self.0.read(buf).await?)
    }
}

/// Adapts any tokio [`AsyncWrite`] into a [`FileWriter`] (finish = flush + shutdown).
pub struct AsyncWriteAdapter<W>(pub W);

#[async_trait]
impl<W: AsyncWrite + Unpin + Send> FileWriter for AsyncWriteAdapter<W> {
    async fn write_all(&mut self, buf: &[u8]) -> Result<()> {
        Ok(self.0.write_all(buf).await?)
    }
    async fn finish(mut self: Box<Self>) -> Result<()> {
        self.0.flush().await?;
        self.0.shutdown().await?;
        Ok(())
    }
}

/// Read a whole file into memory, failing if it is larger than `limit` bytes.
pub async fn read_to_end(vfs: &dyn Vfs, path: &str, limit: u64) -> Result<Vec<u8>> {
    let mut r = vfs.open_read(path, 0).await?;
    let mut out = Vec::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = r.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n]);
        if out.len() as u64 > limit {
            return Err(Error::InvalidInput(format!("file is larger than {limit} bytes")));
        }
    }
    Ok(out)
}

/// Write a whole buffer to a file (create/truncate).
pub async fn write_all(vfs: &dyn Vfs, path: &str, data: &[u8]) -> Result<()> {
    let mut w = vfs
        .open_write(path, WriteOptions { size_hint: Some(data.len() as u64), ..Default::default() })
        .await?;
    w.write_all(data).await?;
    w.finish().await
}

/// A bidirectional byte stream (used for SSH port forwarding).
pub trait TunnelStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> TunnelStream for T {}

pub type BoxedTunnelStream = Pin<Box<dyn TunnelStream>>;

/// Requested properties for an interactive terminal.
#[derive(Debug, Clone)]
pub struct TerminalOptions {
    pub cols: u16,
    pub rows: u16,
    /// `TERM` value, e.g. `xterm-256color`.
    pub term: String,
    /// Initial working directory (best effort).
    pub cwd: Option<String>,
    /// Extra environment variables (best effort; servers may reject them).
    pub env: Vec<(String, String)>,
}

impl Default for TerminalOptions {
    fn default() -> Self {
        TerminalOptions { cols: 80, rows: 24, term: "xterm-256color".into(), cwd: None, env: vec![] }
    }
}

#[derive(Debug, Clone)]
pub enum TerminalInput {
    Data(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

#[derive(Debug, Clone)]
pub enum TerminalOutput {
    Data(Vec<u8>),
    Exit(Option<i32>),
}

/// An interactive terminal: send [`TerminalInput`] into `input`, receive output on `output`.
/// The backend must emit [`TerminalOutput::Exit`] (and close `output`) when the shell ends.
pub struct TerminalChannel {
    pub input: mpsc::UnboundedSender<TerminalInput>,
    pub output: mpsc::UnboundedReceiver<TerminalOutput>,
}

/// A connected file system. Implementations must be safe for concurrent use: the UI
/// browses while several background transfers run on the same instance.
#[async_trait]
pub trait Vfs: Send + Sync {
    fn protocol(&self) -> Protocol;
    fn capabilities(&self) -> Capabilities;

    /// Human-readable information about the connection (server software, cipher, ...).
    fn session_info(&self) -> SessionInfo {
        SessionInfo::default()
    }

    /// Initial directory after connecting (user home or configured root).
    async fn home(&self) -> Result<String>;

    /// Resolve `.`/`..`/symlinks into an absolute path.
    async fn canonicalize(&self, path: &str) -> Result<String> {
        Ok(path::normalize(path))
    }

    /// List a directory. Must not include `.` and `..`.
    async fn list(&self, path: &str) -> Result<Vec<FileEntry>>;

    /// Metadata of a single path (follows symlinks for `target_kind`).
    async fn stat(&self, path: &str) -> Result<FileEntry>;

    /// Like `stat` but returns `Ok(None)` when the path does not exist.
    async fn try_stat(&self, path: &str) -> Result<Option<FileEntry>> {
        match self.stat(path).await {
            Ok(e) => Ok(Some(e)),
            Err(Error::NotFound(_)) => Ok(None),
            Err(e) => Err(e),
        }
    }

    async fn mkdir(&self, path: &str) -> Result<()>;

    /// Create a directory and all missing parents.
    async fn mkdir_all(&self, path: &str) -> Result<()> {
        let norm = path::normalize(path);
        if self.try_stat(&norm).await?.is_some() {
            return Ok(());
        }
        let par = path::parent(&norm);
        if par != norm && par != "/" && !(path::is_drive_path(&par) && par.len() <= 3) {
            Box::pin(self.mkdir_all(&par)).await?;
        }
        match self.mkdir(&norm).await {
            Ok(()) | Err(Error::AlreadyExists(_)) => Ok(()),
            Err(e) => Err(e),
        }
    }

    async fn remove_file(&self, path: &str) -> Result<()>;

    /// Remove an empty directory.
    async fn remove_dir(&self, path: &str) -> Result<()>;

    /// Remove a directory tree.
    async fn remove_dir_all(&self, path: &str) -> Result<()> {
        for entry in self.list(path).await? {
            if entry.kind == FileKind::Dir {
                Box::pin(self.remove_dir_all(&entry.path)).await?;
            } else {
                self.remove_file(&entry.path).await?;
            }
        }
        self.remove_dir(path).await
    }

    /// Rename / move within the same file system. Fails if `to` exists and the
    /// protocol cannot overwrite atomically; callers remove the target first if needed.
    async fn rename(&self, from: &str, to: &str) -> Result<()>;

    /// Server-side copy of a single file.
    async fn copy_file(&self, _from: &str, _to: &str) -> Result<()> {
        Err(Error::unsupported("server-side copy"))
    }

    async fn set_permissions(&self, _path: &str, _mode: u32) -> Result<()> {
        Err(Error::unsupported("changing permissions"))
    }

    async fn set_owner(&self, _path: &str, _owner: Option<&str>, _group: Option<&str>) -> Result<()> {
        Err(Error::unsupported("changing owner"))
    }

    /// Set modification time (Unix seconds).
    async fn set_modified(&self, _path: &str, _mtime: i64) -> Result<()> {
        Err(Error::unsupported("setting modification time"))
    }

    /// Create a symbolic link at `link` pointing to `target`.
    async fn symlink(&self, _target: &str, _link: &str) -> Result<()> {
        Err(Error::unsupported("symbolic links"))
    }

    async fn read_link(&self, _path: &str) -> Result<String> {
        Err(Error::unsupported("symbolic links"))
    }

    /// Open a file for reading, starting at `offset` (for resumed downloads).
    async fn open_read(&self, path: &str, offset: u64) -> Result<Box<dyn FileReader>>;

    /// Open a file for writing.
    async fn open_write(&self, path: &str, opts: WriteOptions) -> Result<Box<dyn FileWriter>>;

    /// Run a non-interactive command (SSH exec, local shell).
    async fn exec(&self, _command: &str, _cwd: Option<&str>) -> Result<ExecOutput> {
        Err(Error::unsupported("command execution"))
    }

    /// Open an interactive terminal (PTY shell).
    async fn open_terminal(&self, _opts: TerminalOptions) -> Result<TerminalChannel> {
        Err(Error::unsupported("terminal"))
    }

    /// Open a TCP connection to `host:port` as seen from the server (SSH direct-tcpip).
    async fn open_tunnel(&self, _host: &str, _port: u16) -> Result<BoxedTunnelStream> {
        Err(Error::unsupported("port forwarding"))
    }

    /// Server-side checksum (`Ok(None)` when not available; callers fall back to
    /// streaming the content).
    async fn checksum(&self, _path: &str, _algo: ChecksumAlgo) -> Result<Option<String>> {
        Ok(None)
    }

    async fn disk_info(&self, _path: &str) -> Result<Option<DiskInfo>> {
        Ok(None)
    }

    /// Cheap liveness probe used for reconnect decisions.
    async fn ping(&self) -> Result<()> {
        self.home().await.map(|_| ())
    }

    async fn close(&self) -> Result<()> {
        Ok(())
    }
}
