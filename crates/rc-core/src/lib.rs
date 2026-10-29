//! Rust Commander core library.
//!
//! * [`Vfs`] — the file system abstraction implemented by every protocol
//!   (local, SFTP, SCP, FTP/FTPS, WebDAV, S3, Azure, GCS, Rust Commander peers).
//! * [`connect()`] — open a [`Vfs`] for a [`SiteConfig`].

pub mod archive;
pub mod connect;
pub mod error;
pub mod jobs;
pub mod known_hosts;
pub mod local;
mod local_pty;
pub mod mask;
pub mod net;
pub mod ops;
pub mod path;
pub mod prompt;
pub mod protocols;
pub mod reconnect;
pub mod search;
pub mod site;
pub mod store;
pub mod sync;
pub mod transfer;
pub mod tunnel;
pub mod types;
pub mod vfs;
pub mod watch;

pub use connect::{connect, connect_with_shell_fallback, ConnectContext};
pub use error::{Error, ErrorCode, Result};
pub use known_hosts::{HostKeyStatus, KnownHosts};
pub use local::LocalVfs;
pub use prompt::{PromptRequest, PromptResponse, Prompter};
pub use site::SiteConfig;
pub use types::*;
pub use vfs::*;

/// Install ring as the process-wide rustls crypto provider. HTTP clients (reqwest is built
/// without a provider) need it; call once at startup. Repeated calls are harmless.
pub fn init_tls() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

/// Version of Rust Commander.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
