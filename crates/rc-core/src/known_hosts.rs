//! Trusted SSH host keys and TLS certificate fingerprints (trust on first use).

use std::collections::BTreeMap;
use std::path::PathBuf;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::store::{load_json, save_json};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KnownHost {
    /// `host:port` for SSH, `tls:host:port` for certificates.
    pub key: String,
    pub key_type: String,
    /// `SHA256:<base64>` for SSH keys, hex SHA-256 for certificates.
    pub fingerprint: String,
    /// Base64 public key (SSH) — optional, informational.
    #[serde(default)]
    pub public_key: String,
    pub added: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum HostKeyStatus {
    Trusted,
    Unknown,
    /// A different fingerprint is stored.
    Mismatch { stored: KnownHost },
}

/// JSON-backed store of trusted keys.
pub struct KnownHosts {
    path: Option<PathBuf>,
    entries: Mutex<BTreeMap<String, Vec<KnownHost>>>,
}

impl KnownHosts {
    /// In-memory store (tests, scripting).
    pub fn in_memory() -> Self {
        KnownHosts { path: None, entries: Mutex::new(BTreeMap::new()) }
    }

    pub fn load(path: PathBuf) -> Self {
        let list: Vec<KnownHost> = load_json(&path).unwrap_or_default();
        let mut map: BTreeMap<String, Vec<KnownHost>> = BTreeMap::new();
        for e in list {
            map.entry(e.key.clone()).or_default().push(e);
        }
        KnownHosts { path: Some(path), entries: Mutex::new(map) }
    }

    pub fn ssh_key(host: &str, port: u16) -> String {
        format!("{}:{}", host.to_ascii_lowercase(), port)
    }

    pub fn tls_key(host: &str, port: u16) -> String {
        format!("tls:{}:{}", host.to_ascii_lowercase(), port)
    }

    /// Check a fingerprint for `key` (see [`Self::ssh_key`] / [`Self::tls_key`]).
    /// Entries of other key types for the same host do not count as mismatch.
    pub fn check(&self, key: &str, key_type: &str, fingerprint: &str) -> HostKeyStatus {
        let map = self.entries.lock();
        let Some(list) = map.get(key) else {
            return HostKeyStatus::Unknown;
        };
        if list.iter().any(|e| e.fingerprint == fingerprint) {
            return HostKeyStatus::Trusted;
        }
        if let Some(same_type) = list.iter().find(|e| e.key_type == key_type) {
            return HostKeyStatus::Mismatch { stored: same_type.clone() };
        }
        HostKeyStatus::Unknown
    }

    /// Trust a key; replaces any stored key of the same type for this host.
    pub fn add(&self, key: &str, key_type: &str, fingerprint: &str, public_key: &str) -> Result<()> {
        {
            let mut map = self.entries.lock();
            let list = map.entry(key.to_string()).or_default();
            list.retain(|e| e.key_type != key_type);
            list.push(KnownHost {
                key: key.to_string(),
                key_type: key_type.to_string(),
                fingerprint: fingerprint.to_string(),
                public_key: public_key.to_string(),
                added: chrono::Utc::now().timestamp(),
            });
        }
        self.save()
    }

    pub fn remove(&self, key: &str, fingerprint: Option<&str>) -> Result<()> {
        {
            let mut map = self.entries.lock();
            match fingerprint {
                Some(fp) => {
                    if let Some(list) = map.get_mut(key) {
                        list.retain(|e| e.fingerprint != fp);
                        if list.is_empty() {
                            map.remove(key);
                        }
                    }
                }
                None => {
                    map.remove(key);
                }
            }
        }
        self.save()
    }

    pub fn list(&self) -> Vec<KnownHost> {
        self.entries.lock().values().flatten().cloned().collect()
    }

    fn save(&self) -> Result<()> {
        if let Some(p) = &self.path {
            save_json(p, &self.list())?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tofu() {
        let kh = KnownHosts::in_memory();
        let k = KnownHosts::ssh_key("Example.com", 22);
        assert_eq!(kh.check(&k, "ssh-ed25519", "SHA256:a"), HostKeyStatus::Unknown);
        kh.add(&k, "ssh-ed25519", "SHA256:a", "").unwrap();
        assert_eq!(kh.check(&k, "ssh-ed25519", "SHA256:a"), HostKeyStatus::Trusted);
        assert!(matches!(kh.check(&k, "ssh-ed25519", "SHA256:b"), HostKeyStatus::Mismatch { .. }));
        assert_eq!(kh.check(&k, "rsa-sha2-512", "SHA256:c"), HostKeyStatus::Unknown);
    }
}
