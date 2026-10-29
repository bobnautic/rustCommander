//! WebDAV, S3, Azure Blob Storage and Google Cloud Storage (OpenDAL).

use std::sync::Arc;

use crate::connect::ConnectContext;
use crate::error::{Error, Result};
use crate::site::SiteConfig;
use crate::vfs::Vfs;

pub async fn connect(_site: &SiteConfig, _ctx: &ConnectContext) -> Result<Arc<dyn Vfs>> {
    Err(Error::unsupported("cloud storage (not yet implemented)"))
}
