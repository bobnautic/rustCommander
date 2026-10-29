//! Transparent reconnect: when an operation fails because the connection dropped (idle
//! timeout, network change), connect again and retry the operation once.

use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use parking_lot::RwLock;

use crate::connect::{connect, ConnectContext};
use crate::error::{Error, Result};
use crate::site::SiteConfig;
use crate::types::*;
use crate::vfs::*;

pub struct ReconnectingVfs {
    site: SiteConfig,
    ctx: ConnectContext,
    inner: RwLock<Arc<dyn Vfs>>,
    /// Serializes reconnect attempts; holds the time of the last one.
    lock: tokio::sync::Mutex<Option<Instant>>,
}

impl ReconnectingVfs {
    pub fn new(site: SiteConfig, ctx: ConnectContext, vfs: Arc<dyn Vfs>) -> Self {
        ReconnectingVfs { site, ctx, inner: RwLock::new(vfs), lock: tokio::sync::Mutex::new(None) }
    }

    fn current(&self) -> Arc<dyn Vfs> {
        self.inner.read().clone()
    }

    /// Replace the connection if `failed` is still the current one.
    async fn reconnect(&self, failed: &Arc<dyn Vfs>) -> Result<Arc<dyn Vfs>> {
        let mut last = self.lock.lock().await;
        let cur = self.current();
        if !Arc::ptr_eq(&cur, failed) {
            // Somebody else reconnected meanwhile.
            return Ok(cur);
        }
        if last.is_some_and(|t| t.elapsed() < Duration::from_secs(3)) {
            return Err(Error::ConnectionLost("reconnect attempted too recently".into()));
        }
        *last = Some(Instant::now());
        tracing::info!(session = %self.ctx.session_id, "connection to {} lost, reconnecting", self.site.display_name());
        let _ = failed.close().await;
        let fresh = connect(&self.site, &self.ctx).await?;
        *self.inner.write() = fresh.clone();
        tracing::info!(session = %self.ctx.session_id, "reconnected to {}", self.site.display_name());
        Ok(fresh)
    }

    async fn with<T, F, Fut>(&self, f: F) -> Result<T>
    where
        F: Fn(Arc<dyn Vfs>) -> Fut,
        Fut: Future<Output = Result<T>>,
    {
        let vfs = self.current();
        match f(vfs.clone()).await {
            Err(e) if e.is_connection_error() => {
                let fresh = self.reconnect(&vfs).await.map_err(|re| {
                    tracing::warn!(session = %self.ctx.session_id, "reconnect failed: {re}");
                    e
                })?;
                f(fresh).await
            }
            r => r,
        }
    }
}

#[async_trait]
impl Vfs for ReconnectingVfs {
    fn protocol(&self) -> Protocol {
        self.current().protocol()
    }
    fn capabilities(&self) -> Capabilities {
        self.current().capabilities()
    }
    fn session_info(&self) -> SessionInfo {
        self.current().session_info()
    }
    async fn home(&self) -> Result<String> {
        self.with(|v| async move { v.home().await }).await
    }
    async fn canonicalize(&self, path: &str) -> Result<String> {
        self.with(|v| async move { v.canonicalize(path).await }).await
    }
    async fn list(&self, path: &str) -> Result<Vec<FileEntry>> {
        self.with(|v| async move { v.list(path).await }).await
    }
    async fn stat(&self, path: &str) -> Result<FileEntry> {
        self.with(|v| async move { v.stat(path).await }).await
    }
    async fn try_stat(&self, path: &str) -> Result<Option<FileEntry>> {
        self.with(|v| async move { v.try_stat(path).await }).await
    }
    async fn mkdir(&self, path: &str) -> Result<()> {
        self.with(|v| async move { v.mkdir(path).await }).await
    }
    async fn mkdir_all(&self, path: &str) -> Result<()> {
        self.with(|v| async move { v.mkdir_all(path).await }).await
    }
    async fn remove_file(&self, path: &str) -> Result<()> {
        self.with(|v| async move { v.remove_file(path).await }).await
    }
    async fn remove_dir(&self, path: &str) -> Result<()> {
        self.with(|v| async move { v.remove_dir(path).await }).await
    }
    async fn remove_dir_all(&self, path: &str) -> Result<()> {
        self.with(|v| async move { v.remove_dir_all(path).await }).await
    }
    async fn rename(&self, from: &str, to: &str) -> Result<()> {
        self.with(|v| async move { v.rename(from, to).await }).await
    }
    async fn copy_file(&self, from: &str, to: &str) -> Result<()> {
        self.with(|v| async move { v.copy_file(from, to).await }).await
    }
    async fn set_permissions(&self, path: &str, mode: u32) -> Result<()> {
        self.with(|v| async move { v.set_permissions(path, mode).await }).await
    }
    async fn set_owner(&self, path: &str, owner: Option<&str>, group: Option<&str>) -> Result<()> {
        self.with(|v| async move { v.set_owner(path, owner, group).await }).await
    }
    async fn set_modified(&self, path: &str, mtime: i64) -> Result<()> {
        self.with(|v| async move { v.set_modified(path, mtime).await }).await
    }
    async fn symlink(&self, target: &str, link: &str) -> Result<()> {
        self.with(|v| async move { v.symlink(target, link).await }).await
    }
    async fn read_link(&self, path: &str) -> Result<String> {
        self.with(|v| async move { v.read_link(path).await }).await
    }
    async fn open_read(&self, path: &str, offset: u64) -> Result<Box<dyn FileReader>> {
        self.with(|v| async move { v.open_read(path, offset).await }).await
    }
    async fn open_write(&self, path: &str, opts: WriteOptions) -> Result<Box<dyn FileWriter>> {
        self.with(|v| {
            let opts = opts.clone();
            async move { v.open_write(path, opts).await }
        })
        .await
    }
    async fn exec(&self, command: &str, cwd: Option<&str>) -> Result<ExecOutput> {
        self.with(|v| async move { v.exec(command, cwd).await }).await
    }
    async fn open_terminal(&self, opts: TerminalOptions) -> Result<TerminalChannel> {
        self.with(|v| {
            let opts = opts.clone();
            async move { v.open_terminal(opts).await }
        })
        .await
    }
    async fn open_tunnel(&self, host: &str, port: u16) -> Result<BoxedTunnelStream> {
        self.with(|v| async move { v.open_tunnel(host, port).await }).await
    }
    async fn checksum(&self, path: &str, algo: ChecksumAlgo) -> Result<Option<String>> {
        self.with(|v| async move { v.checksum(path, algo).await }).await
    }
    async fn disk_info(&self, path: &str) -> Result<Option<DiskInfo>> {
        self.with(|v| async move { v.disk_info(path).await }).await
    }
    async fn ping(&self) -> Result<()> {
        self.with(|v| async move { v.ping().await }).await
    }
    async fn close(&self) -> Result<()> {
        self.current().close().await
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::prompt::NoPrompter;
    use crate::KnownHosts;

    /// Fails with ConnectionLost the first time `list` is called.
    struct Flaky {
        calls: Arc<AtomicUsize>,
    }

    #[async_trait]
    impl Vfs for Flaky {
        fn protocol(&self) -> Protocol {
            Protocol::Local
        }
        fn capabilities(&self) -> Capabilities {
            Capabilities::default()
        }
        async fn home(&self) -> Result<String> {
            Ok("/".into())
        }
        async fn list(&self, _path: &str) -> Result<Vec<FileEntry>> {
            if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                Err(Error::ConnectionLost("gone".into()))
            } else {
                Ok(vec![])
            }
        }
        async fn stat(&self, p: &str) -> Result<FileEntry> {
            Err(Error::NotFound(p.into()))
        }
        async fn mkdir(&self, _: &str) -> Result<()> {
            Ok(())
        }
        async fn remove_file(&self, _: &str) -> Result<()> {
            Ok(())
        }
        async fn remove_dir(&self, _: &str) -> Result<()> {
            Ok(())
        }
        async fn rename(&self, _: &str, _: &str) -> Result<()> {
            Ok(())
        }
        async fn open_read(&self, _: &str, _: u64) -> Result<Box<dyn FileReader>> {
            Err(Error::unsupported("x"))
        }
        async fn open_write(&self, _: &str, _: WriteOptions) -> Result<Box<dyn FileWriter>> {
            Err(Error::unsupported("x"))
        }
    }

    #[tokio::test]
    async fn retries_after_reconnect() {
        let calls = Arc::new(AtomicUsize::new(0));
        // Reconnecting a "local" site yields a LocalVfs: the retry then lists for real.
        let site = SiteConfig { protocol: Protocol::Local, ..Default::default() };
        let ctx = ConnectContext::new(Arc::new(NoPrompter), Arc::new(KnownHosts::in_memory()));
        let v = ReconnectingVfs::new(site, ctx, Arc::new(Flaky { calls: calls.clone() }));
        let dir = tempfile::tempdir().unwrap();
        let r = v.list(&crate::local::from_native(dir.path())).await.unwrap();
        assert!(r.is_empty());
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // Not a connection error: no retry.
        assert!(matches!(v.stat("/nope-really-not-there").await, Err(Error::NotFound(_))));
    }
}
