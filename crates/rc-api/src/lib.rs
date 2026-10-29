//! Rust Commander application layer.
//!
//! [`AppState`] holds sessions, jobs, settings and services; [`dispatch()`] implements the
//! RPC API described in `ui/src/api/types.ts`. The desktop app (Tauri `invoke`) and the
//! web server (`POST /api/rpc`) both call [`dispatch()`], and both forward the events of
//! [`AppState::events`] to their front ends.

pub mod dispatch;
pub mod events;
pub mod handlers;
pub mod logs;
pub mod prompts;
pub mod server;
pub mod settings;
pub mod state;

pub use dispatch::{dispatch, RpcError};
pub use events::{Event, EventBus};
pub use state::{AppMode, AppState, InitOptions, Origin, LOCAL_SESSION};
