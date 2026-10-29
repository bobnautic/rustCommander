//! Web access: password/token authentication and the server control interface that the
//! embedding application (desktop app, `rcmd serve`) provides.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use async_trait::async_trait;
use parking_lot::{Mutex, RwLock};
use rand::RngCore;
use serde::{Deserialize, Serialize};

use rc_core::store::{load_json, save_json};
use rc_core::{Error, Result};

use crate::state::AppState;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStatus {
    pub running: bool,
    pub bind: String,
    pub port: u16,
    pub tls: bool,
    pub fingerprint: Option<String>,
    pub urls: Vec<String>,
    pub has_password: bool,
    pub clients: usize,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct RunningServer {
    pub bind: String,
    pub port: u16,
    pub tls: bool,
    pub fingerprint: Option<String>,
}

/// Implemented by `rc-server`; lets the RPC layer start/stop the embedded web server.
#[async_trait]
pub trait ServerControl: Send + Sync {
    async fn start(&self, state: Arc<AppState>, bind: String, port: u16, tls: bool) -> Result<RunningServer>;
    async fn stop(&self) -> Result<()>;
    fn running(&self) -> Option<RunningServer>;
    fn clients(&self) -> usize;
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthFile {
    password_hash: Option<String>,
}

/// Password + session tokens for web clients.
pub struct ServerAuth {
    path: Option<PathBuf>,
    hash: RwLock<Option<String>>,
    tokens: Mutex<HashMap<String, Instant>>,
    /// Temporary password for this process only (e.g. printed by `rcmd serve`).
    ephemeral: RwLock<Option<String>>,
    disabled: RwLock<bool>,
}

const TOKEN_IDLE: Duration = Duration::from_secs(7 * 24 * 3600);

impl ServerAuth {
    pub fn load(path: Option<PathBuf>) -> Self {
        let file: AuthFile = path.as_ref().and_then(|p| load_json(p).ok()).unwrap_or_default();
        ServerAuth {
            path,
            hash: RwLock::new(file.password_hash),
            tokens: Mutex::new(HashMap::new()),
            ephemeral: RwLock::new(None),
            disabled: RwLock::new(false),
        }
    }

    pub fn has_password(&self) -> bool {
        self.hash.read().is_some() || self.ephemeral.read().is_some()
    }

    /// Authentication switched off entirely (`rcmd serve --no-auth`, trusted networks only).
    pub fn set_disabled(&self, disabled: bool) {
        *self.disabled.write() = disabled;
    }

    pub fn is_disabled(&self) -> bool {
        *self.disabled.read()
    }

    pub fn set_password(&self, password: &str) -> Result<()> {
        if password.len() < 4 {
            return Err(Error::InvalidInput("password must have at least 4 characters".into()));
        }
        let salt = SaltString::generate(&mut OsRng);
        let hash = argon2::Argon2::default()
            .hash_password(password.as_bytes(), &salt)
            .map_err(|e| Error::other(e.to_string()))?
            .to_string();
        *self.hash.write() = Some(hash.clone());
        // Existing sessions keep working; a password change is not a logout.
        if let Some(p) = &self.path {
            save_json(p, &AuthFile { password_hash: Some(hash) })?;
        }
        Ok(())
    }

    pub fn set_ephemeral(&self, password: Option<String>) {
        *self.ephemeral.write() = password;
    }

    pub fn verify_password(&self, password: &str) -> bool {
        if let Some(e) = self.ephemeral.read().as_deref() {
            if constant_time_eq(e.as_bytes(), password.as_bytes()) {
                return true;
            }
        }
        let Some(hash) = self.hash.read().clone() else { return false };
        let Ok(parsed) = PasswordHash::new(&hash) else { return false };
        argon2::Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok()
    }

    pub fn create_token(&self) -> String {
        let mut b = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut b);
        let t = hex::encode(b);
        self.tokens.lock().insert(t.clone(), Instant::now());
        t
    }

    pub fn check_token(&self, token: &str) -> bool {
        if self.is_disabled() {
            return true;
        }
        let mut tokens = self.tokens.lock();
        tokens.retain(|_, t| t.elapsed() < TOKEN_IDLE);
        match tokens.get_mut(token) {
            Some(t) => {
                *t = Instant::now();
                true
            }
            None => false,
        }
    }

    pub fn revoke(&self, token: &str) {
        self.tokens.lock().remove(token);
    }
}

pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Random human-friendly password (for `rcmd serve` without a configured password).
pub fn generate_password() -> String {
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut rng = rand::thread_rng();
    (0..16).map(|_| ALPHABET[(rng.next_u32() as usize) % ALPHABET.len()] as char).collect()
}
