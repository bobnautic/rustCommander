//! Protocol implementations of [`crate::Vfs`].

#[cfg(feature = "ssh")]
pub mod ssh;

#[cfg(feature = "ftp")]
pub mod ftp;

#[cfg(feature = "cloud")]
pub mod cloud;

#[cfg(feature = "tls")]
pub(crate) mod tls;

pub mod rcmd;
