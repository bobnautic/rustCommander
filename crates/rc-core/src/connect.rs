//! Open a [`Vfs`] for a [`SiteConfig`].

use std::sync::Arc;
use std::time::Duration;

use crate::error::{Error, Result};
use crate::known_hosts::KnownHosts;
use crate::local::LocalVfs;
use crate::prompt::Prompter;
use crate::site::SiteConfig;
use crate::types::Protocol;
use crate::vfs::Vfs;

/// Everything a protocol needs besides the site settings.
#[derive(Clone)]
pub struct ConnectContext {
    /// Asks the user (host keys, passwords, keyboard-interactive, certificates).
    pub prompter: Arc<dyn Prompter>,
    /// Trusted SSH host keys and TLS certificate fingerprints.
    pub known_hosts: Arc<KnownHosts>,
    /// Identifier used in log messages (`tracing` field `session`).
    pub session_id: String,
}

impl ConnectContext {
    pub fn new(prompter: Arc<dyn Prompter>, known_hosts: Arc<KnownHosts>) -> Self {
        ConnectContext { prompter, known_hosts, session_id: String::new() }
    }
}

impl SiteConfig {
    pub fn timeout(&self) -> Duration {
        Duration::from_secs(if self.timeout_secs == 0 { 20 } else { self.timeout_secs as u64 })
    }
}

/// Connect to a site and return the file system.
pub async fn connect(site: &SiteConfig, ctx: &ConnectContext) -> Result<Arc<dyn Vfs>> {
    tracing::info!(session = %ctx.session_id, "connecting to {} ({:?})", site.display_name(), site.protocol);
    match site.protocol {
        Protocol::Local => Ok(Arc::new(LocalVfs::new())),
        #[cfg(feature = "ssh")]
        Protocol::Sftp => crate::protocols::ssh::connect_sftp(site, ctx).await,
        #[cfg(feature = "ssh")]
        Protocol::Scp => crate::protocols::ssh::connect_scp(site, ctx).await,
        #[cfg(feature = "ftp")]
        Protocol::Ftp => crate::protocols::ftp::connect(site, ctx).await,
        #[cfg(feature = "cloud")]
        Protocol::Webdav | Protocol::S3 | Protocol::Azure | Protocol::Gcs => crate::protocols::cloud::connect(site, ctx).await,
        Protocol::Rcmd => crate::protocols::rcmd::connect(site, ctx).await,
        #[allow(unreachable_patterns)]
        p => Err(Error::unsupported(format!("protocol {p:?} is not compiled into this build"))),
    }
}

/// Protocols compiled into this build.
pub fn available_protocols() -> Vec<Protocol> {
    let mut v = vec![Protocol::Local];
    if cfg!(feature = "ssh") {
        v.extend([Protocol::Sftp, Protocol::Scp]);
    }
    if cfg!(feature = "ftp") {
        v.push(Protocol::Ftp);
    }
    if cfg!(feature = "cloud") {
        v.extend([Protocol::Webdav, Protocol::S3, Protocol::Azure, Protocol::Gcs]);
    }
    v.push(Protocol::Rcmd);
    v
}
