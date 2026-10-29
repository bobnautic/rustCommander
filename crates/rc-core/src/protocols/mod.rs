//! Protocol implementations of [`crate::Vfs`].

#[cfg(feature = "ssh")]
pub mod ssh;

#[cfg(feature = "ftp")]
pub mod ftp;

#[cfg(feature = "cloud")]
pub mod cloud;

pub mod rcmd;
