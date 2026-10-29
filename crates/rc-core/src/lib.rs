//! Rust Commander core library.
//!
//! * [`Vfs`] — the file system abstraction implemented by every protocol
//!   (local, SFTP, SCP, FTP/FTPS, WebDAV, S3, Azure, GCS, Rust Commander peers).
//! * [`connect()`] — open a [`Vfs`] for a [`SiteConfig`].

pub mod connect;
pub mod error;
pub mod known_hosts;
pub mod local;
mod local_pty;
pub mod net;
pub mod path;
pub mod prompt;
pub mod protocols;
pub mod site;
pub mod store;
pub mod types;
pub mod vfs;

pub use connect::{connect, ConnectContext};
pub use error::{Error, ErrorCode, Result};
pub use known_hosts::{HostKeyStatus, KnownHosts};
pub use local::LocalVfs;
pub use prompt::{PromptRequest, PromptResponse, Prompter};
pub use site::SiteConfig;
pub use types::*;
pub use vfs::*;

/// Version of Rust Commander.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
