//! SFTP, SCP, SSH terminal and port forwarding (russh).

use std::sync::Arc;

use crate::connect::ConnectContext;
use crate::error::{Error, Result};
use crate::site::SiteConfig;
use crate::vfs::Vfs;

pub async fn connect_sftp(_site: &SiteConfig, _ctx: &ConnectContext) -> Result<Arc<dyn Vfs>> {
    Err(Error::unsupported("SFTP (not yet implemented)"))
}

pub async fn connect_scp(_site: &SiteConfig, _ctx: &ConnectContext) -> Result<Arc<dyn Vfs>> {
    Err(Error::unsupported("SCP (not yet implemented)"))
}
