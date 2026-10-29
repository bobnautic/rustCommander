//! Persistent application data: sites, settings, vault, bookmarks.

use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{Error, Result};

/// Directory for configuration files. Overridable with `RCMD_CONFIG_DIR`.
pub fn config_dir() -> PathBuf {
    if let Ok(p) = std::env::var("RCMD_CONFIG_DIR") {
        return PathBuf::from(p);
    }
    directories::ProjectDirs::from("dev", "RustCommander", "rust-commander")
        .map(|d| d.config_dir().to_path_buf())
        .unwrap_or_else(|| PathBuf::from(".rust-commander"))
}

/// Directory for temporary files (external editing, previews).
pub fn temp_dir() -> PathBuf {
    std::env::temp_dir().join("rust-commander")
}

pub fn load_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let data = std::fs::read(path).map_err(|e| Error::io_at(e, &path.display().to_string()))?;
    serde_json::from_slice(&data).map_err(|e| Error::Other(format!("{}: {e}", path.display())))
}

/// Atomically write JSON (write temp file + rename), with `0600` permissions on Unix.
pub fn save_json<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let data = serde_json::to_vec_pretty(value)?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, data)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub mod import;
pub mod sites;
pub mod vault;

pub use sites::{SiteStore, SECRET_PLACEHOLDER};
pub use vault::{Vault, VaultStatus};
