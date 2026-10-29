use serde::Serialize;

/// Stable error codes that cross the RPC boundary so the UI can react to them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    NotFound,
    PermissionDenied,
    AlreadyExists,
    NotADirectory,
    IsADirectory,
    DirectoryNotEmpty,
    Unsupported,
    InvalidInput,
    AuthFailed,
    HostKeyRejected,
    Cancelled,
    ConnectionLost,
    Timeout,
    Protocol,
    Io,
    Locked,
    Other,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("permission denied: {0}")]
    PermissionDenied(String),
    #[error("already exists: {0}")]
    AlreadyExists(String),
    #[error("not a directory: {0}")]
    NotADirectory(String),
    #[error("is a directory: {0}")]
    IsADirectory(String),
    #[error("directory not empty: {0}")]
    DirectoryNotEmpty(String),
    #[error("operation not supported: {0}")]
    Unsupported(String),
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("authentication failed: {0}")]
    AuthFailed(String),
    #[error("host key rejected: {0}")]
    HostKeyRejected(String),
    #[error("cancelled")]
    Cancelled,
    #[error("connection lost: {0}")]
    ConnectionLost(String),
    #[error("timeout: {0}")]
    Timeout(String),
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("vault is locked")]
    Locked,
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Other(String),
}

impl Error {
    pub fn other(msg: impl std::fmt::Display) -> Self {
        Error::Other(msg.to_string())
    }

    pub fn protocol(msg: impl std::fmt::Display) -> Self {
        Error::Protocol(msg.to_string())
    }

    pub fn unsupported(what: impl std::fmt::Display) -> Self {
        Error::Unsupported(what.to_string())
    }

    pub fn code(&self) -> ErrorCode {
        match self {
            Error::NotFound(_) => ErrorCode::NotFound,
            Error::PermissionDenied(_) => ErrorCode::PermissionDenied,
            Error::AlreadyExists(_) => ErrorCode::AlreadyExists,
            Error::NotADirectory(_) => ErrorCode::NotADirectory,
            Error::IsADirectory(_) => ErrorCode::IsADirectory,
            Error::DirectoryNotEmpty(_) => ErrorCode::DirectoryNotEmpty,
            Error::Unsupported(_) => ErrorCode::Unsupported,
            Error::InvalidInput(_) => ErrorCode::InvalidInput,
            Error::AuthFailed(_) => ErrorCode::AuthFailed,
            Error::HostKeyRejected(_) => ErrorCode::HostKeyRejected,
            Error::Cancelled => ErrorCode::Cancelled,
            Error::ConnectionLost(_) => ErrorCode::ConnectionLost,
            Error::Timeout(_) => ErrorCode::Timeout,
            Error::Protocol(_) => ErrorCode::Protocol,
            Error::Locked => ErrorCode::Locked,
            Error::Io(e) => match e.kind() {
                std::io::ErrorKind::NotFound => ErrorCode::NotFound,
                std::io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
                std::io::ErrorKind::AlreadyExists => ErrorCode::AlreadyExists,
                std::io::ErrorKind::TimedOut => ErrorCode::Timeout,
                std::io::ErrorKind::ConnectionReset
                | std::io::ErrorKind::ConnectionAborted
                | std::io::ErrorKind::BrokenPipe
                | std::io::ErrorKind::UnexpectedEof => ErrorCode::ConnectionLost,
                _ => ErrorCode::Io,
            },
            Error::Other(_) => ErrorCode::Other,
        }
    }

    /// Convert an `std::io::Error` while keeping the offending path in the message.
    pub fn io_at(e: std::io::Error, path: &str) -> Self {
        match e.kind() {
            std::io::ErrorKind::NotFound => Error::NotFound(path.to_string()),
            std::io::ErrorKind::PermissionDenied => Error::PermissionDenied(path.to_string()),
            std::io::ErrorKind::AlreadyExists => Error::AlreadyExists(path.to_string()),
            _ => {
                #[cfg(unix)]
                {
                    match e.raw_os_error() {
                        Some(libc::ENOTDIR) => return Error::NotADirectory(path.to_string()),
                        Some(libc::EISDIR) => return Error::IsADirectory(path.to_string()),
                        Some(libc::ENOTEMPTY) => return Error::DirectoryNotEmpty(path.to_string()),
                        _ => {}
                    }
                }
                Error::Io(std::io::Error::new(e.kind(), format!("{path}: {e}")))
            }
        }
    }

    /// True for errors after which a connection should be considered dead.
    pub fn is_connection_error(&self) -> bool {
        matches!(self.code(), ErrorCode::ConnectionLost | ErrorCode::Timeout)
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::InvalidInput(e.to_string())
    }
}

impl From<tokio::task::JoinError> for Error {
    fn from(e: tokio::task::JoinError) -> Self {
        Error::Other(format!("task failed: {e}"))
    }
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
