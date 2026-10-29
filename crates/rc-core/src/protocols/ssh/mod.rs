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
use crate::error::Result;
use crate::site::SiteConfig;
use crate::vfs::Vfs;

pub async fn connect_sftp(site: &SiteConfig, ctx: &ConnectContext) -> Result<Arc<dyn Vfs>> {
    let conn = Arc::new(conn::SshConnection::connect(site, ctx).await?);
    Ok(Arc::new(sftp::SftpVfs::open(conn, site, ctx).await?))
}

pub async fn connect_scp(site: &SiteConfig, ctx: &ConnectContext) -> Result<Arc<dyn Vfs>> {
    let conn = Arc::new(conn::SshConnection::connect(site, ctx).await?);
    Ok(Arc::new(scp::ScpVfs::open(conn, site, ctx).await?))
}
