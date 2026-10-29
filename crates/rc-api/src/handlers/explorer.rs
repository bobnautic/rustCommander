//! Remote explorer: browse SSH targets read-only.
//!
//! Targets are the saved SFTP/SCP sites plus the hosts of `~/.ssh/config` (no import
//! needed). Nothing is installed on or copied to the target: listings come from SFTP, or
//! from shell commands when the server has no SFTP server.

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use rc_core::path as vpath;
use rc_core::store::import;
use rc_core::{Error, FileKind, Protocol, Result, SiteConfig};

use crate::handlers::sessions;
use crate::state::{AppState, SessionSummary};

/// Default and maximum number of bytes returned by [`preview`].
const PREVIEW_DEFAULT: u64 = 64 * 1024;
const PREVIEW_MAX: u64 = 1024 * 1024;
/// Longest ProxyJump chain followed for `~/.ssh/config` hosts.
const MAX_JUMPS: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TargetSource {
    Site,
    SshConfig,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExplorerTarget {
    /// `site:<site id>` or `ssh:<Host alias>`.
    pub id: String,
    pub source: TargetSource,
    pub name: String,
    pub folder: String,
    pub protocol: Protocol,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub site_id: Option<String>,
    /// Name of the jump host (ProxyJump), if any.
    pub jump: Option<String>,
    pub color: Option<String>,
}

fn is_ssh(p: Protocol) -> bool {
    matches!(p, Protocol::Sftp | Protocol::Scp)
}

/// `~/.ssh/config` hosts with OpenSSH's default user (the local one).
fn ssh_config_hosts(config: &str) -> Vec<SiteConfig> {
    let mut hosts = import::from_openssh_config(config);
    let me = crate::state::username();
    for h in &mut hosts {
        if h.username.is_empty() {
            h.username = me.clone();
        }
    }
    hosts
}

/// The first `ProxyJump` hop of every Host alias as written (`[user@]host[:port]`). The
/// importer keeps only the host part, which is enough to link sites but loses user and port.
fn proxy_jump_hops(config: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let mut aliases: Vec<String> = Vec::new();
    for line in config.lines().map(str::trim).filter(|l| !l.starts_with('#')) {
        let Some((key, value)) = line.split_once(|c: char| c.is_whitespace() || c == '=') else {
            continue;
        };
        let value = value.trim().trim_start_matches('=').trim().trim_matches('"');
        match key.to_ascii_lowercase().as_str() {
            "host" => aliases = value.split_whitespace().map(String::from).collect(),
            "match" => aliases.clear(),
            "proxyjump" => {
                let first = value.split(',').next().unwrap_or("").trim();
                if !first.is_empty() && first != "none" {
                    // OpenSSH uses the first value it finds for an option.
                    for a in &aliases {
                        out.entry(a.clone()).or_insert_with(|| first.to_string());
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// `[user@]host[:port]` (IPv6 as `[addr]:port`).
fn parse_hop(hop: &str) -> (Option<String>, String, Option<u16>) {
    let (user, rest) = match hop.rsplit_once('@') {
        Some((u, r)) => (Some(u.to_string()), r),
        None => (None, hop),
    };
    if let Some(v6) = rest.strip_prefix('[') {
        if let Some((host, tail)) = v6.split_once(']') {
            return (user, host.to_string(), tail.strip_prefix(':').and_then(|p| p.parse().ok()));
        }
    }
    match rest.rsplit_once(':') {
        Some((host, port)) if !host.contains(':') && port.parse::<u16>().is_ok() => {
            (user, host.to_string(), port.parse().ok())
        }
        _ => (user, rest.to_string(), None),
    }
}

fn read_ssh_config() -> String {
    import::read_openssh_config_text().unwrap_or_default()
}

fn same_endpoint(a: &SiteConfig, b: &SiteConfig) -> bool {
    a.host.eq_ignore_ascii_case(&b.host) && a.effective_port() == b.effective_port() && a.username == b.username
}

pub fn targets(state: &AppState) -> Vec<ExplorerTarget> {
    let sites: Vec<SiteConfig> = state.sites.list_masked().into_iter().filter(|s| is_ssh(s.protocol)).collect();
    let site_name = |id: &str| sites.iter().find(|s| s.id == id).map(|s| s.display_name());
    let mut out: Vec<ExplorerTarget> = sites
        .iter()
        .map(|s| ExplorerTarget {
            id: format!("site:{}", s.id),
            source: TargetSource::Site,
            name: s.display_name(),
            folder: s.folder.clone(),
            protocol: s.protocol,
            host: s.host.clone(),
            port: s.effective_port(),
            username: s.username.clone(),
            site_id: Some(s.id.clone()),
            jump: s.ssh.jump_site_id.as_deref().filter(|j| !j.is_empty()).map(|j| site_name(j).unwrap_or(j.into())),
            color: s.color.clone(),
        })
        .collect();
    // Hosts already saved as a site are listed once.
    for h in ssh_config_hosts(&read_ssh_config()) {
        if sites.iter().any(|s| same_endpoint(s, &h)) {
            continue;
        }
        out.push(ExplorerTarget {
            id: format!("ssh:{}", h.name),
            source: TargetSource::SshConfig,
            name: h.name.clone(),
            folder: String::new(),
            protocol: h.protocol,
            host: h.host.clone(),
            port: h.effective_port(),
            username: h.username.clone(),
            site_id: None,
            jump: h.ssh.jump_site_id.clone(),
            color: None,
        });
    }
    out
}

/// The `~/.ssh/config` host `alias`, with its ProxyJump chain resolved.
fn ssh_config_site(config: &str, alias: &str) -> Result<SiteConfig> {
    let hosts = ssh_config_hosts(config);
    let hops = proxy_jump_hops(config);
    let find = |name: &str| hosts.iter().find(|h| h.name == name).cloned();
    let mut site = find(alias).ok_or_else(|| Error::NotFound(format!("host {alias} in ~/.ssh/config")))?;
    let mut chain: Vec<SiteConfig> = vec![];
    let mut from = alias.to_string();
    while let Some(raw) = hops.get(&from) {
        let (user, name, port) = parse_hop(raw);
        if chain.len() >= MAX_JUMPS || name == alias || chain.iter().any(|j| j.name == name) {
            return Err(Error::InvalidInput(format!("ProxyJump loop or chain too long at {name}")));
        }
        // A hop is a Host alias of its own or a plain host name; user and port given in
        // the ProxyJump value win.
        let mut hop = find(&name).unwrap_or_else(|| SiteConfig {
            name: name.clone(),
            host: name.clone(),
            protocol: Protocol::Sftp,
            username: crate::state::username(),
            ..Default::default()
        });
        if let Some(u) = user {
            hop.username = u;
        }
        if let Some(p) = port {
            hop.port = p;
        }
        hop.ssh.jump_site_id = None;
        from = name;
        chain.push(hop);
    }
    // Nest the chain: site.jump = jump1, jump1.jump = jump2, ... (jump2 is dialed first).
    let mut via: Option<Box<SiteConfig>> = None;
    for mut hop in chain.into_iter().rev() {
        hop.ssh.jump = via.take();
        via = Some(Box::new(hop));
    }
    site.ssh.jump_site_id = None;
    site.ssh.jump = via;
    site.folder.clear();
    Ok(site)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectParams {
    /// An [`ExplorerTarget::id`].
    pub target: Option<String>,
    /// Ad-hoc target: `user@host[:port][/path]` or an `sftp://` / `scp://` URL.
    pub address: Option<String>,
    pub password: Option<String>,
}

pub async fn connect(state: &Arc<AppState>, p: ConnectParams) -> Result<SessionSummary> {
    let mut site = if let Some(t) = p.target.as_deref().filter(|t| !t.is_empty()) {
        if let Some(id) = t.strip_prefix("site:") {
            state.sites.get_decrypted(id)?
        } else if let Some(alias) = t.strip_prefix("ssh:") {
            ssh_config_site(&read_ssh_config(), alias)?
        } else {
            return Err(Error::InvalidInput(format!("unknown explorer target {t}")));
        }
    } else if let Some(addr) = p.address.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
        let url = if addr.contains("://") { addr.to_string() } else { format!("sftp://{addr}") };
        let (site, _) =
            SiteConfig::from_url(&url).ok_or_else(|| Error::InvalidInput(format!("cannot parse address {addr}")))?;
        if site.host.is_empty() {
            return Err(Error::InvalidInput("host name is required".into()));
        }
        site
    } else {
        return Err(Error::InvalidInput("target or address required".into()));
    };
    if !is_ssh(site.protocol) {
        return Err(Error::InvalidInput(format!("{} is not an SSH target", site.display_name())));
    }
    if let Some(pw) = p.password.filter(|p| !p.is_empty()) {
        site.password = Some(pw);
    }
    sessions::connect_site_opts(state, site, true).await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewParams {
    pub session: String,
    pub path: String,
    pub max_bytes: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub path: String,
    /// Text of the first `maxBytes` bytes (empty for binary files).
    pub content: String,
    pub size: u64,
    pub binary: bool,
    /// Only the beginning of the file is shown.
    pub truncated: bool,
}

/// Read the beginning of a file into memory for display. Nothing is written anywhere.
pub async fn preview(state: &AppState, p: PreviewParams) -> Result<Preview> {
    let vfs = state.vfs(&p.session)?;
    let path = vpath::normalize(&p.path);
    let st = vfs.stat(&path).await?;
    let kind = if st.kind == FileKind::Symlink { st.target_kind.unwrap_or(FileKind::File) } else { st.kind };
    match kind {
        FileKind::Dir => return Err(Error::IsADirectory(path)),
        // Devices and FIFOs may never end (or block forever).
        FileKind::Other => return Err(Error::InvalidInput(format!("{path} is not a regular file"))),
        _ => {}
    }
    let limit = p.max_bytes.unwrap_or(PREVIEW_DEFAULT).clamp(1, PREVIEW_MAX) as usize;
    let mut data = vec![0u8; limit];
    let mut n = 0;
    {
        let mut r = vfs.open_read(&path, 0).await?;
        while n < limit {
            let k = r.read(&mut data[n..]).await?;
            if k == 0 {
                break;
            }
            n += k;
        }
    }
    data.truncate(n);
    let truncated = (n as u64) < st.size || (st.size == 0 && n == limit);
    let binary = data.iter().take(8192).any(|b| *b == 0);
    let content = if binary { String::new() } else { decode_head(data, truncated) };
    Ok(Preview { path, content, size: st.size, binary, truncated })
}

/// UTF-8 (a character cut off at the end of a truncated read is dropped), else Latin-1.
fn decode_head(mut data: Vec<u8>, truncated: bool) -> String {
    if truncated {
        if let Err(e) = std::str::from_utf8(&data) {
            if e.error_len().is_none() {
                data.truncate(e.valid_up_to());
            }
        }
    }
    match String::from_utf8(data) {
        Ok(s) => s,
        Err(e) => e.into_bytes().iter().map(|&b| b as char).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_jump_chain() {
        let cfg = "Host app\n  HostName 10.0.0.5\n  User deploy\n  ProxyJump ops@bastion:2222,other\n\n\
                   Host bastion\n  HostName bastion.example.org\n  User nobody\n  ProxyJump edge\n\n\
                   Host direct\n  ProxyJump none\n";
        let s = ssh_config_site(cfg, "app").unwrap();
        assert_eq!((s.host.as_str(), s.username.as_str()), ("10.0.0.5", "deploy"));
        let b = s.ssh.jump.as_deref().expect("first hop");
        // Host alias with user and port from the ProxyJump value.
        assert_eq!((b.host.as_str(), b.username.as_str(), b.port), ("bastion.example.org", "ops", 2222));
        // Plain host name behind it.
        let e = b.ssh.jump.as_deref().expect("second hop");
        assert_eq!((e.host.as_str(), e.port), ("edge", 0));
        assert!(e.ssh.jump.is_none());
        assert!(ssh_config_site(cfg, "direct").unwrap().ssh.jump.is_none());
        assert!(ssh_config_site(cfg, "missing").is_err());
        let looped = "Host a\n  ProxyJump b\nHost b\n  ProxyJump a\n";
        assert!(ssh_config_site(looped, "a").is_err());
    }

    #[test]
    fn hops() {
        assert_eq!(parse_hop("me@h:2200"), (Some("me".into()), "h".into(), Some(2200)));
        assert_eq!(parse_hop("h"), (None, "h".into(), None));
        assert_eq!(parse_hop("[fe80::1]:22"), (None, "fe80::1".into(), Some(22)));
        assert_eq!(parse_hop("fe80::1"), (None, "fe80::1".into(), None));
    }

    #[test]
    fn decode_cut_utf8() {
        let s = "grüße".as_bytes().to_vec();
        // Cut inside 'ü' (2 bytes): the partial character is dropped.
        assert_eq!(decode_head(s[..3].to_vec(), true), "gr");
        assert_eq!(decode_head(s.clone(), false), "grüße");
        // Invalid UTF-8 in the middle -> Latin-1.
        assert_eq!(decode_head(vec![b'a', 0xe9, b'b'], true), "aéb");
    }
}
