//! Interactive questions raised while connecting or transferring (host keys, passwords,
//! keyboard-interactive challenges, overwrite confirmations). The application layer
//! forwards them to the UI and resolves them with the user's answer.

use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KbdPrompt {
    pub text: String,
    /// Whether the answer may be displayed (false for passwords/OTPs).
    pub echo: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostKeyState {
    /// Never seen before.
    New,
    /// A different key was stored for this host: possible man-in-the-middle attack.
    Changed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum PromptRequest {
    /// Verify an SSH host key. Answer: `accepted`, optionally `remember`.
    HostKey {
        host: String,
        port: u16,
        key_type: String,
        /// `SHA256:...` fingerprint.
        fingerprint: String,
        state: HostKeyState,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        previous_fingerprint: Option<String>,
    },
    /// Verify an untrusted TLS certificate (FTPS / WebDAV / Rust Commander peer).
    Certificate {
        host: String,
        port: u16,
        fingerprint: String,
        subject: String,
        issuer: String,
        reason: String,
        state: HostKeyState,
    },
    /// Ask for a password. Answer: `values[0]`.
    Password {
        host: String,
        username: String,
        #[serde(default)]
        message: String,
    },
    /// Ask for a username (when none is configured). Answer: `values[0]`.
    Username { host: String },
    /// Passphrase for an encrypted private key. Answer: `values[0]`.
    Passphrase { key_path: String },
    /// SSH keyboard-interactive round. Answer: one value per prompt.
    KeyboardInteractive { host: String, name: String, instructions: String, prompts: Vec<KbdPrompt> },
    /// Display the server's authentication banner; answer just acknowledges.
    Banner { host: String, message: String },
    /// Generic yes/no question.
    Confirm { title: String, message: String },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptResponse {
    pub accepted: bool,
    #[serde(default)]
    pub values: Vec<String>,
    /// Persist the answer (store host key / save password).
    #[serde(default)]
    pub remember: bool,
}

impl PromptResponse {
    pub fn value(&self, i: usize) -> Option<&str> {
        self.values.get(i).map(|s| s.as_str())
    }
}

/// Something that can ask the user. `None` means the prompt was cancelled.
#[async_trait]
pub trait Prompter: Send + Sync {
    async fn prompt(&self, req: PromptRequest) -> Option<PromptResponse>;
}

/// A prompter for non-interactive use: rejects everything (except banners).
pub struct NoPrompter;

#[async_trait]
impl Prompter for NoPrompter {
    async fn prompt(&self, req: PromptRequest) -> Option<PromptResponse> {
        match req {
            PromptRequest::Banner { .. } => Some(PromptResponse { accepted: true, ..Default::default() }),
            _ => None,
        }
    }
}

/// A prompter that accepts unknown host keys / certificates without asking (scripting
/// with `-hostkey=*`), and rejects anything requiring input.
pub struct AcceptAllPrompter;

#[async_trait]
impl Prompter for AcceptAllPrompter {
    async fn prompt(&self, req: PromptRequest) -> Option<PromptResponse> {
        match req {
            PromptRequest::HostKey { .. } | PromptRequest::Certificate { .. } | PromptRequest::Banner { .. } => {
                Some(PromptResponse { accepted: true, remember: false, values: vec![] })
            }
            _ => None,
        }
    }
}

pub type SharedPrompter = Arc<dyn Prompter>;
