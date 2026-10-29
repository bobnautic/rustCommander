//! SFTP, SCP, SSH terminal and port forwarding (russh).
//!
//! * [`conn`] — transport (direct, proxy, jump host), host key verification, channels.
//! * [`auth`] — agent / key / password / keyboard-interactive authentication.
//! * [`sftp`] — the SFTP file system.
//! * [`scp`] — shell commands + the classic SCP protocol for servers without SFTP.

mod auth;
mod conn;
mod scp;
mod sftp;
mod shell;

use std::sync::Arc;

use crate::connect::ConnectContext;
use crate::error::{Error, Result};
use crate::site::SiteConfig;
use crate::types::Protocol;
use crate::vfs::Vfs;

pub async fn connect_sftp(site: &SiteConfig, ctx: &ConnectContext) -> Result<Arc<dyn Vfs>> {
    let conn = Arc::new(conn::SshConnection::connect(site, ctx).await?);
    Ok(Arc::new(sftp::SftpVfs::open(conn, site, ctx).await?))
}

pub async fn connect_scp(site: &SiteConfig, ctx: &ConnectContext) -> Result<Arc<dyn Vfs>> {
    let conn = Arc::new(conn::SshConnection::connect(site, ctx).await?);
    Ok(Arc::new(scp::ScpVfs::open(conn, site, ctx).await?))
}

/// SFTP, or shell commands (SCP mode) on the same authenticated connection when the server
/// has no usable SFTP server (refused subsystem, missing `sftp-server` binary). Returns the
/// protocol that is actually in use.
pub async fn connect_sftp_or_shell(site: &SiteConfig, ctx: &ConnectContext) -> Result<(Arc<dyn Vfs>, Protocol)> {
    let conn = Arc::new(conn::SshConnection::connect(site, ctx).await?);
    match sftp::SftpVfs::open(conn.clone(), site, ctx).await {
        Ok(vfs) => Ok((Arc::new(vfs), Protocol::Sftp)),
        Err(e @ (Error::Unsupported(_) | Error::Protocol(_))) => {
            tracing::info!(session = %ctx.session_id, "SFTP not available ({e}), using shell commands");
            let vfs = scp::ScpVfs::open(conn, site, ctx).await.map_err(|shell_err| {
                Error::Unsupported(format!("neither SFTP ({e}) nor shell commands ({shell_err}) are available"))
            })?;
            Ok((Arc::new(vfs), Protocol::Scp))
        }
        Err(e) => Err(e),
    }
}
