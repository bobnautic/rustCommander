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
    write_private(&tmp, &data)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Write a file only the user can read. The mode is set when the file is created, so the
/// content (secrets) is never readable by others, not even for a moment.
pub(crate) fn write_private(path: &Path, data: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut oo = std::fs::OpenOptions::new();
    oo.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        oo.mode(0o600);
    }
    let mut f = oo.open(path)?;
    #[cfg(unix)]
    {
        // An existing file keeps its mode on open (best effort: FAT mounts refuse chmod).
        use std::os::unix::fs::PermissionsExt;
        let _ = f.set_permissions(std::fs::Permissions::from_mode(0o600));
    }
    f.write_all(data)?;
    Ok(())
}

pub mod import;
pub mod sites;
pub mod vault;

pub use sites::{SiteStore, SECRET_PLACEHOLDER};
pub use vault::{Vault, VaultStatus};
