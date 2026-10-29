//! Connection settings ("sites" in the site manager).

use serde::{Deserialize, Serialize};

use crate::types::Protocol;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum FtpEncryption {
    /// Plain FTP.
    #[default]
    None,
    /// FTPS with `AUTH TLS` on the normal port.
    Explicit,
    /// FTPS with TLS from the first byte (port 990).
    Implicit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FtpOptions {
    pub encryption: FtpEncryption,
    /// Passive mode (recommended behind NAT). Active mode otherwise.
    pub passive: bool,
    /// Accept TLS certificates that fail verification (after prompting the user).
    pub allow_invalid_certs: bool,
    /// Prefer `MLSD` over `LIST` when the server supports it.
    pub use_mlsd: bool,
    /// Maximum simultaneous control connections used for parallel operations.
    pub max_connections: u32,
}

impl Default for FtpOptions {
    fn default() -> Self {
        FtpOptions {
            encryption: FtpEncryption::None,
            passive: true,
            allow_invalid_certs: false,
            use_mlsd: true,
            max_connections: 4,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SshOptions {
    /// Path to a private key file (OpenSSH / PEM / PuTTY .ppk where supported).
    pub private_key_path: Option<String>,
    /// Private key content (alternative to a path). Stored encrypted.
    pub private_key: Option<String>,
    /// Passphrase for the private key. Stored encrypted.
    pub passphrase: Option<String>,
    /// Try keys from a running SSH agent (`SSH_AUTH_SOCK` / Pageant).
    pub use_agent: bool,
    /// Try password authentication.
    pub try_password: bool,
    /// Try keyboard-interactive authentication (OTP, 2FA).
    pub try_keyboard_interactive: bool,
    /// Also try the default keys in `~/.ssh` (id_ed25519, id_rsa, ...).
    pub try_default_keys: bool,
    pub compression: bool,
    /// Custom SFTP server command, e.g. `sudo -n /usr/lib/openssh/sftp-server`.
    /// Uses exec instead of the `sftp` subsystem when set.
    pub sftp_server: Option<String>,
    /// Site id of a jump host (ProxyJump). Resolved into `jump` before connecting.
    pub jump_site_id: Option<String>,
    /// Resolved jump host configuration (filled in by the application layer).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jump: Option<Box<SiteConfig>>,
    /// Environment variables sent with terminal/exec requests.
    pub env: Vec<(String, String)>,
    /// Shell used for SCP mode commands (default `/bin/sh`).
    pub shell: Option<String>,
    /// Lookup `~/.ssh/known_hosts` in addition to the app's own store.
    pub use_openssh_known_hosts: bool,
}

impl Default for SshOptions {
    fn default() -> Self {
        SshOptions {
            private_key_path: None,
            private_key: None,
            passphrase: None,
            use_agent: true,
            try_password: true,
            try_keyboard_interactive: true,
            try_default_keys: true,
            compression: false,
            sftp_server: None,
            jump_site_id: None,
            jump: None,
            env: Vec::new(),
            shell: None,
            use_openssh_known_hosts: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WebdavOptions {
    /// Use HTTPS (default) or plain HTTP.
    pub https: bool,
    /// Base path on the server, e.g. `/remote.php/dav/files/me`.
    pub root: String,
    pub allow_invalid_certs: bool,
}

impl Default for WebdavOptions {
    fn default() -> Self {
        WebdavOptions { https: true, root: "/".into(), allow_invalid_certs: false }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct S3Options {
    /// Region, e.g. `eu-central-1` (`auto` for R2).
    pub region: String,
    /// Custom endpoint URL for S3-compatible storage (MinIO, Wasabi, R2, Ceph, ...).
    /// Empty = AWS (derived from region).
    pub endpoint: String,
    /// Bucket. Empty = the root lists all buckets (where supported).
    pub bucket: String,
    /// Path-style addressing (`endpoint/bucket/key`), required by many S3 clones.
    pub path_style: bool,
    /// Optional STS session token.
    pub session_token: Option<String>,
    /// Anonymous access to public buckets.
    pub anonymous: bool,
}

impl Default for S3Options {
    fn default() -> Self {
        S3Options {
            region: "us-east-1".into(),
            endpoint: String::new(),
            bucket: String::new(),
            path_style: false,
            session_token: None,
            anonymous: false,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AzureOptions {
    /// Storage account name (username holds it too if empty).
    pub account: String,
    /// Container name.
    pub container: String,
    /// Custom endpoint (e.g. Azurite). Empty = `https://<account>.blob.core.windows.net`.
    pub endpoint: String,
    /// SAS token instead of the account key.
    pub sas_token: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GcsOptions {
    pub bucket: String,
    /// Service account JSON (stored encrypted). Empty = application default credentials.
    pub credential_json: Option<String>,
    pub endpoint: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RcmdOptions {
    /// Connect with HTTPS.
    pub tls: bool,
    /// Pinned SHA-256 fingerprint of the peer's TLS certificate.
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ProxyKind {
    #[default]
    None,
    Socks5,
    Http,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProxyOptions {
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// Stored encrypted.
    pub password: Option<String>,
}

/// A complete connection description.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SiteConfig {
    pub id: String,
    pub name: String,
    /// Folder in the site tree, `/`-separated (e.g. `Customers/ACME`).
    pub folder: String,
    pub protocol: Protocol,
    pub host: String,
    /// `0` = protocol default.
    pub port: u16,
    pub username: String,
    /// Stored encrypted. `None` = ask when connecting.
    pub password: Option<String>,
    /// Directory opened after connecting (empty = home).
    pub remote_dir: String,
    /// Local directory opened in the other panel (empty = unchanged).
    pub local_dir: String,
    /// Connection timeout.
    pub timeout_secs: u32,
    /// Keepalive interval (0 = off).
    pub keepalive_secs: u32,
    /// UI color tag (`#rrggbb`).
    pub color: Option<String>,
    pub notes: String,
    pub ssh: SshOptions,
    pub ftp: FtpOptions,
    pub webdav: WebdavOptions,
    pub s3: S3Options,
    pub azure: AzureOptions,
    pub gcs: GcsOptions,
    pub rcmd: RcmdOptions,
    pub proxy: ProxyOptions,
}

impl Default for SiteConfig {
    fn default() -> Self {
        SiteConfig {
            id: String::new(),
            name: String::new(),
            folder: String::new(),
            protocol: Protocol::Sftp,
            host: String::new(),
            port: 0,
            username: String::new(),
            password: None,
            remote_dir: String::new(),
            local_dir: String::new(),
            timeout_secs: 20,
            keepalive_secs: 30,
            color: None,
            notes: String::new(),
            ssh: SshOptions::default(),
            ftp: FtpOptions::default(),
            webdav: WebdavOptions::default(),
            s3: S3Options::default(),
            azure: AzureOptions::default(),
            gcs: GcsOptions::default(),
            rcmd: RcmdOptions::default(),
            proxy: ProxyOptions::default(),
        }
    }
}

impl SiteConfig {
    pub fn effective_port(&self) -> u16 {
        if self.port != 0 {
            return self.port;
        }
        match self.protocol {
            Protocol::Ftp if self.ftp.encryption == FtpEncryption::Implicit => 990,
            Protocol::Webdav if !self.webdav.https => 80,
            p => p.default_port(),
        }
    }

    /// Short label like `user@host` for logs and tabs.
    pub fn display_name(&self) -> String {
        if !self.name.is_empty() {
            return self.name.clone();
        }
        if self.username.is_empty() {
            self.host.clone()
        } else {
            format!("{}@{}", self.username, self.host)
        }
    }

    /// URL form, e.g. `sftp://user@host:2222/var/www`. Never includes the password.
    pub fn to_url(&self, path: Option<&str>) -> String {
        let scheme = match self.protocol {
            Protocol::Ftp => match self.ftp.encryption {
                FtpEncryption::None => "ftp",
                FtpEncryption::Explicit => "ftpes",
                FtpEncryption::Implicit => "ftps",
            },
            Protocol::Webdav => {
                if self.webdav.https {
                    "davs"
                } else {
                    "dav"
                }
            }
            p => p.scheme(),
        };
        let mut s = format!("{scheme}://");
        if !self.username.is_empty() {
            s.push_str(&url_escape(&self.username));
            s.push('@');
        }
        if self.host.contains(':') {
            s.push_str(&format!("[{}]", self.host));
        } else {
            s.push_str(&self.host);
        }
        if self.port != 0 && self.port != self.protocol.default_port() {
            s.push_str(&format!(":{}", self.port));
        }
        let p = path.unwrap_or(&self.remote_dir);
        if !p.is_empty() {
            if !p.starts_with('/') {
                s.push('/');
            }
            s.push_str(p);
        }
        s
    }

    /// Parse URLs like `sftp://user:pass@host:22/path`, `ftpes://host`, `s3://bucket`.
    /// Returns the site and the path part.
    pub fn from_url(url: &str) -> Option<(SiteConfig, String)> {
        let (scheme, rest) = url.split_once("://")?;
        let mut site = SiteConfig::default();
        match scheme.to_ascii_lowercase().as_str() {
            "sftp" | "ssh" => site.protocol = Protocol::Sftp,
            "scp" => site.protocol = Protocol::Scp,
            "ftp" => site.protocol = Protocol::Ftp,
            "ftpes" => {
                site.protocol = Protocol::Ftp;
                site.ftp.encryption = FtpEncryption::Explicit;
            }
            "ftps" => {
                site.protocol = Protocol::Ftp;
                site.ftp.encryption = FtpEncryption::Implicit;
            }
            "dav" | "http" | "webdav" => {
                site.protocol = Protocol::Webdav;
                site.webdav.https = false;
            }
            "davs" | "https" | "webdavs" => {
                site.protocol = Protocol::Webdav;
                site.webdav.https = true;
            }
            "s3" => site.protocol = Protocol::S3,
            "rcmd" => site.protocol = Protocol::Rcmd,
            "rcmds" => {
                site.protocol = Protocol::Rcmd;
                site.rcmd.tls = true;
            }
            _ => return None,
        }
        let (authority, path) = match rest.find('/') {
            Some(i) => (&rest[..i], rest[i..].to_string()),
            None => (rest, String::new()),
        };
        let (userinfo, hostport) = match authority.rfind('@') {
            Some(i) => (Some(&authority[..i]), &authority[i + 1..]),
            None => (None, authority),
        };
        if let Some(ui) = userinfo {
            match ui.split_once(':') {
                Some((u, p)) => {
                    site.username = url_unescape(u);
                    // WinSCP-style `user:pass;fingerprint=...` — drop parameters.
                    let p = p.split(';').next().unwrap_or(p);
                    site.password = Some(url_unescape(p));
                }
                None => site.username = url_unescape(ui.split(';').next().unwrap_or(ui)),
            }
        }
        if let Some(stripped) = hostport.strip_prefix('[') {
            let end = stripped.find(']')?;
            site.host = stripped[..end].to_string();
            if let Some(port) = stripped[end + 1..].strip_prefix(':') {
                site.port = port.parse().ok()?;
            }
        } else if let Some((h, p)) = hostport.rsplit_once(':') {
            site.host = h.to_string();
            site.port = p.parse().ok()?;
        } else {
            site.host = hostport.to_string();
        }
        if site.protocol == Protocol::S3 && !site.host.contains('.') {
            // s3://bucket/path
            site.s3.bucket = std::mem::take(&mut site.host);
        }
        site.remote_dir = path.clone();
        site.name = site.display_name();
        Some((site, path))
    }
}

fn url_escape(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn url_unescape(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_roundtrip() {
        let (s, p) = SiteConfig::from_url("sftp://bob:p%40ss@example.com:2222/var/www").unwrap();
        assert_eq!(s.protocol, Protocol::Sftp);
        assert_eq!(s.username, "bob");
        assert_eq!(s.password.as_deref(), Some("p@ss"));
        assert_eq!(s.host, "example.com");
        assert_eq!(s.port, 2222);
        assert_eq!(p, "/var/www");
        assert_eq!(s.to_url(None), "sftp://bob@example.com:2222/var/www");

        let (s, _) = SiteConfig::from_url("ftpes://[::1]:2121").unwrap();
        assert_eq!(s.host, "::1");
        assert_eq!(s.port, 2121);
        assert_eq!(s.ftp.encryption, FtpEncryption::Explicit);

        let (s, p) = SiteConfig::from_url("s3://my-bucket/logs").unwrap();
        assert_eq!(s.s3.bucket, "my-bucket");
        assert_eq!(p, "/logs");
    }
}
