use serde::{Deserialize, Serialize};

/// Kind of a directory entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileKind {
    File,
    Dir,
    Symlink,
    Other,
}

/// One entry of a directory listing. All timestamps are Unix seconds (UTC).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    /// Absolute path of the entry inside its file system (forward slashes).
    pub path: String,
    pub kind: FileKind,
    pub size: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modified: Option<i64>,
    /// Permission bits (`0o7777` mask) when the protocol exposes them.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permissions: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub link_target: Option<String>,
    /// For symlinks: the kind of the resolved target, if known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_kind: Option<FileKind>,
    #[serde(default)]
    pub hidden: bool,
}

impl FileEntry {
    pub fn new(name: impl Into<String>, path: impl Into<String>, kind: FileKind) -> Self {
        let name = name.into();
        let hidden = name.starts_with('.');
        FileEntry {
            name,
            path: path.into(),
            kind,
            size: 0,
            modified: None,
            permissions: None,
            owner: None,
            group: None,
            link_target: None,
            target_kind: None,
            hidden,
        }
    }

    /// True for directories and for symlinks pointing to directories.
    pub fn is_dir(&self) -> bool {
        self.kind == FileKind::Dir || (self.kind == FileKind::Symlink && self.target_kind == Some(FileKind::Dir))
    }

    pub fn is_file(&self) -> bool {
        !self.is_dir()
    }

    /// Render the permissions like `ls -l` does (`rwxr-xr-x`).
    pub fn permission_string(&self) -> Option<String> {
        self.permissions.map(format_mode)
    }
}

/// Format permission bits as `rwxr-xr-x` (including setuid/setgid/sticky).
pub fn format_mode(mode: u32) -> String {
    let mut s = String::with_capacity(9);
    let bits = [
        (0o400, 'r'),
        (0o200, 'w'),
        (0o100, 'x'),
        (0o040, 'r'),
        (0o020, 'w'),
        (0o010, 'x'),
        (0o004, 'r'),
        (0o002, 'w'),
        (0o001, 'x'),
    ];
    for (i, (bit, ch)) in bits.iter().enumerate() {
        let set = mode & bit != 0;
        let c = match i {
            2 if mode & 0o4000 != 0 => {
                if set {
                    's'
                } else {
                    'S'
                }
            }
            5 if mode & 0o2000 != 0 => {
                if set {
                    's'
                } else {
                    'S'
                }
            }
            8 if mode & 0o1000 != 0 => {
                if set {
                    't'
                } else {
                    'T'
                }
            }
            _ => {
                if set {
                    *ch
                } else {
                    '-'
                }
            }
        };
        s.push(c);
    }
    s
}

/// Parse `rwxr-xr-x` (9 chars, optional leading type char) into mode bits.
pub fn parse_mode_string(s: &str) -> Option<u32> {
    let s = if s.len() == 10 { &s[1..] } else { s };
    if s.len() != 9 {
        return None;
    }
    let c: Vec<char> = s.chars().collect();
    let mut mode = 0u32;
    let triplet =
        |r: char, w: char, x: char, shift: u32, special: u32, special_set: char, special_noexec: char| -> Option<u32> {
            let mut m = 0;
            match r {
                'r' => m |= 0o4 << shift,
                '-' => {}
                _ => return None,
            }
            match w {
                'w' => m |= 0o2 << shift,
                '-' => {}
                _ => return None,
            }
            if x == 'x' {
                m |= 0o1 << shift;
            } else if x == special_set {
                m |= (0o1 << shift) | special;
            } else if x == special_noexec {
                m |= special;
            } else if x != '-' {
                return None;
            }
            Some(m)
        };
    mode |= triplet(c[0], c[1], c[2], 6, 0o4000, 's', 'S')?;
    mode |= triplet(c[3], c[4], c[5], 3, 0o2000, 's', 'S')?;
    mode |= triplet(c[6], c[7], c[8], 0, 0o1000, 't', 'T')?;
    Some(mode)
}

/// Supported connection protocols.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Protocol {
    Local,
    #[default]
    Sftp,
    Scp,
    Ftp,
    Webdav,
    S3,
    Azure,
    Gcs,
    /// Another Rust Commander instance (web API).
    Rcmd,
}

impl Protocol {
    pub fn default_port(self) -> u16 {
        match self {
            Protocol::Sftp | Protocol::Scp => 22,
            Protocol::Ftp => 21,
            Protocol::Webdav => 443,
            Protocol::S3 | Protocol::Azure | Protocol::Gcs => 443,
            Protocol::Rcmd => 8822,
            Protocol::Local => 0,
        }
    }

    pub fn scheme(self) -> &'static str {
        match self {
            Protocol::Local => "file",
            Protocol::Sftp => "sftp",
            Protocol::Scp => "scp",
            Protocol::Ftp => "ftp",
            Protocol::Webdav => "davs",
            Protocol::S3 => "s3",
            Protocol::Azure => "azure",
            Protocol::Gcs => "gs",
            Protocol::Rcmd => "rcmd",
        }
    }
}

/// What a file system backend can do. The UI enables/disables actions based on this.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub permissions: bool,
    pub owner: bool,
    pub symlinks: bool,
    pub exec: bool,
    pub terminal: bool,
    pub tunnels: bool,
    pub server_copy: bool,
    pub resume_upload: bool,
    pub resume_download: bool,
    pub set_modified: bool,
    pub server_checksum: bool,
    pub disk_info: bool,
}

/// Free / total space of the file system that holds a path.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskInfo {
    pub total: u64,
    pub free: u64,
    pub available: u64,
}

/// Result of running a command on the remote side.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChecksumAlgo {
    Md5,
    Sha1,
    Sha256,
}

impl ChecksumAlgo {
    pub fn command(self) -> &'static str {
        match self {
            ChecksumAlgo::Md5 => "md5sum",
            ChecksumAlgo::Sha1 => "sha1sum",
            ChecksumAlgo::Sha256 => "sha256sum",
        }
    }
}

/// Key/value information about a connected session (server banner, cipher, ...).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub items: Vec<(String, String)>,
}

impl SessionInfo {
    pub fn push(&mut self, key: impl Into<String>, value: impl Into<String>) {
        self.items.push((key.into(), value.into()));
    }
}

/// Options passed to [`crate::Vfs::open_write`].
#[derive(Debug, Clone, Default)]
pub struct WriteOptions {
    /// Resume an interrupted upload: append starting at this offset (file must already
    /// contain exactly `offset` bytes). `0` means create/truncate.
    pub offset: u64,
    /// Expected final size, if known (lets object stores pick a multipart strategy).
    pub size_hint: Option<u64>,
    /// Permission bits for newly created files, if the protocol supports it.
    pub mode: Option<u32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_roundtrip() {
        for m in [0o755, 0o644, 0o4755, 0o2750, 0o1777, 0o000, 0o4644] {
            let s = format_mode(m);
            assert_eq!(parse_mode_string(&s), Some(m), "{s}");
        }
        assert_eq!(format_mode(0o755), "rwxr-xr-x");
        assert_eq!(parse_mode_string("drwxr-xr-x"), Some(0o755));
    }
}
