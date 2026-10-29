//! Encryption of stored secrets (passwords, passphrases, keys).
//!
//! Without a master password a random key is kept in `vault.key` (readable only by the
//! user) — this protects the site file when it is copied or shared.
//! With a master password the key is derived with Argon2id and the vault starts locked.

use std::path::PathBuf;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use parking_lot::RwLock;
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};
use crate::store::{load_json, save_json};

const PREFIX: &str = "enc:v1:";
const CHECK_PLAINTEXT: &str = "rust-commander-vault";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultFile {
    /// Present when a master password is set.
    master: Option<MasterParams>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MasterParams {
    salt: String,
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
    /// Encrypted [`CHECK_PLAINTEXT`] to verify the password.
    check: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub has_master_password: bool,
    pub locked: bool,
}

pub struct Vault {
    dir: Option<PathBuf>,
    master: RwLock<Option<MasterParams>>,
    key: RwLock<Option<[u8; 32]>>,
}

impl Vault {
    /// In-memory vault with a random key (tests, scripting).
    pub fn ephemeral() -> Self {
        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        Vault { dir: None, master: RwLock::new(None), key: RwLock::new(Some(key)) }
    }

    pub fn open(dir: PathBuf) -> Result<Self> {
        let file: VaultFile = load_json(&dir.join("vault.json")).unwrap_or(VaultFile { master: None });
        let v = Vault { dir: Some(dir), master: RwLock::new(file.master.clone()), key: RwLock::new(None) };
        if file.master.is_none() {
            *v.key.write() = Some(v.load_or_create_keyfile()?);
        }
        Ok(v)
    }

    fn keyfile(&self) -> Option<PathBuf> {
        self.dir.as_ref().map(|d| d.join("vault.key"))
    }

    fn load_or_create_keyfile(&self) -> Result<[u8; 32]> {
        let Some(path) = self.keyfile() else {
            let mut k = [0u8; 32];
            rand::thread_rng().fill_bytes(&mut k);
            return Ok(k);
        };
        if let Ok(data) = std::fs::read_to_string(&path) {
            if let Ok(bytes) = B64.decode(data.trim()) {
                if bytes.len() == 32 {
                    let mut k = [0u8; 32];
                    k.copy_from_slice(&bytes);
                    return Ok(k);
                }
            }
        }
        let mut k = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut k);
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        crate::store::write_private(&path, B64.encode(k).as_bytes())?;
        Ok(k)
    }

    pub fn status(&self) -> VaultStatus {
        VaultStatus { has_master_password: self.master.read().is_some(), locked: self.key.read().is_none() }
    }

    pub fn is_locked(&self) -> bool {
        self.key.read().is_none()
    }

    fn derive(password: &str, p: &MasterParams) -> Result<[u8; 32]> {
        let salt = B64.decode(&p.salt).map_err(|e| Error::other(e.to_string()))?;
        let params =
            argon2::Params::new(p.m_cost, p.t_cost, p.p_cost, Some(32)).map_err(|e| Error::other(e.to_string()))?;
        let a = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
        let mut out = [0u8; 32];
        a.hash_password_into(password.as_bytes(), &salt, &mut out).map_err(|e| Error::other(e.to_string()))?;
        Ok(out)
    }

    pub fn unlock(&self, password: &str) -> Result<()> {
        let Some(m) = self.master.read().clone() else { return Ok(()) };
        let key = Self::derive(password, &m)?;
        match decrypt_with(&key, &m.check) {
            Ok(s) if s == CHECK_PLAINTEXT => {
                *self.key.write() = Some(key);
                Ok(())
            }
            _ => Err(Error::AuthFailed("wrong master password".into())),
        }
    }

    pub fn lock(&self) {
        if self.master.read().is_some() {
            *self.key.write() = None;
        }
    }

    /// Change, set (`current = None` when none is set) or remove (`new = None`) the master
    /// password. Returns `(old_key, new_key)` so callers can re-encrypt stored secrets.
    pub fn change_master(&self, current: Option<&str>, new: Option<&str>) -> Result<([u8; 32], [u8; 32])> {
        let old_key = match self.master.read().clone() {
            Some(m) => {
                let pw = current.ok_or_else(|| Error::AuthFailed("current master password required".into()))?;
                let k = Self::derive(pw, &m)?;
                if decrypt_with(&k, &m.check).ok().as_deref() != Some(CHECK_PLAINTEXT) {
                    return Err(Error::AuthFailed("wrong master password".into()));
                }
                k
            }
            None => self.key.read().ok_or(Error::Locked)?,
        };
        let new_key;
        let new_master;
        match new {
            Some(pw) if !pw.is_empty() => {
                let mut salt = [0u8; 16];
                rand::thread_rng().fill_bytes(&mut salt);
                let mut m = MasterParams {
                    salt: B64.encode(salt),
                    m_cost: 64 * 1024,
                    t_cost: 3,
                    p_cost: 1,
                    check: String::new(),
                };
                new_key = Self::derive(pw, &m)?;
                m.check = encrypt_with(&new_key, CHECK_PLAINTEXT)?;
                new_master = Some(m);
                if let Some(kf) = self.keyfile() {
                    let _ = std::fs::remove_file(kf);
                }
            }
            _ => {
                new_master = None;
                new_key = self.load_or_create_keyfile()?;
            }
        }
        if let Some(dir) = &self.dir {
            save_json(&dir.join("vault.json"), &VaultFile { master: new_master.clone() })?;
        }
        *self.master.write() = new_master;
        *self.key.write() = Some(new_key);
        Ok((old_key, new_key))
    }

    pub fn encrypt(&self, plain: &str) -> Result<String> {
        let key = self.key.read().ok_or(Error::Locked)?;
        encrypt_with(&key, plain)
    }

    /// Decrypt a stored value; values without the `enc:` prefix are returned unchanged.
    pub fn decrypt(&self, stored: &str) -> Result<String> {
        if !is_encrypted(stored) {
            return Ok(stored.to_string());
        }
        let key = self.key.read().ok_or(Error::Locked)?;
        decrypt_with(&key, stored)
    }
}

pub fn is_encrypted(s: &str) -> bool {
    s.starts_with(PREFIX)
}

pub fn encrypt_with(key: &[u8; 32], plain: &str) -> Result<String> {
    let cipher = XChaCha20Poly1305::new(key.into());
    let mut nonce = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut nonce);
    let ct =
        cipher.encrypt(XNonce::from_slice(&nonce), plain.as_bytes()).map_err(|_| Error::other("encryption failed"))?;
    let mut blob = nonce.to_vec();
    blob.extend_from_slice(&ct);
    Ok(format!("{PREFIX}{}", B64.encode(blob)))
}

pub fn decrypt_with(key: &[u8; 32], stored: &str) -> Result<String> {
    let b = stored.strip_prefix(PREFIX).ok_or_else(|| Error::other("not an encrypted value"))?;
    let blob = B64.decode(b).map_err(|e| Error::other(e.to_string()))?;
    if blob.len() < 24 {
        return Err(Error::other("corrupt encrypted value"));
    }
    let cipher = XChaCha20Poly1305::new(key.into());
    let pt = cipher
        .decrypt(XNonce::from_slice(&blob[..24]), &blob[24..])
        .map_err(|_| Error::AuthFailed("cannot decrypt stored secret".into()))?;
    String::from_utf8(pt).map_err(|e| Error::other(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::open(dir.path().to_path_buf()).unwrap();
        assert!(!v.status().locked);
        let enc = v.encrypt("secret").unwrap();
        assert!(is_encrypted(&enc));
        assert_eq!(v.decrypt(&enc).unwrap(), "secret");
        // Re-open: same key from the key file.
        let v = Vault::open(dir.path().to_path_buf()).unwrap();
        assert_eq!(v.decrypt(&enc).unwrap(), "secret");

        let (old, new) = v.change_master(None, Some("pw")).unwrap();
        assert_ne!(old, new);
        let enc2 = encrypt_with(&new, &decrypt_with(&old, &enc).unwrap()).unwrap();
        let v = Vault::open(dir.path().to_path_buf()).unwrap();
        assert!(v.status().locked);
        assert!(v.decrypt(&enc2).is_err());
        assert!(v.unlock("wrong").is_err());
        v.unlock("pw").unwrap();
        assert_eq!(v.decrypt(&enc2).unwrap(), "secret");
        assert!(v.change_master(Some("bad"), None).is_err());
        v.change_master(Some("pw"), None).unwrap();
        assert!(!v.status().has_master_password);
    }
}
