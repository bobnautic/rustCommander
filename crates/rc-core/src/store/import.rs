//! Import sites from OpenSSH config, FileZilla and our own JSON export.

use base64::Engine;

use crate::error::{Error, Result};
use crate::site::{FtpEncryption, SiteConfig};
use crate::types::Protocol;

/// `~/.ssh/config` → sites. Wildcard hosts are skipped; `ProxyJump` refers to other
/// imported sites by name.
pub fn from_openssh_config(content: &str) -> Vec<SiteConfig> {
    let mut out: Vec<SiteConfig> = Vec::new();
    let mut current: Vec<SiteConfig> = Vec::new();
    let flush = |current: &mut Vec<SiteConfig>, out: &mut Vec<SiteConfig>| {
        for mut s in current.drain(..) {
            if s.host.is_empty() {
                s.host = s.name.clone();
            }
            out.push(s);
        }
    };
    for line in content.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => {
                (k.trim().to_ascii_lowercase(), v.trim().trim_start_matches('=').trim().trim_matches('"').to_string())
            }
            None => continue,
        };
        match key.as_str() {
            "host" => {
                flush(&mut current, &mut out);
                for alias in value.split_whitespace() {
                    if alias.contains(['*', '?', '!']) {
                        continue;
                    }
                    current.push(SiteConfig {
                        name: alias.to_string(),
                        folder: "Imported/OpenSSH".into(),
                        protocol: Protocol::Sftp,
                        ..Default::default()
                    });
                }
            }
            "match" => flush(&mut current, &mut out),
            "hostname" => current.iter_mut().for_each(|s| s.host = value.clone()),
            "user" => current.iter_mut().for_each(|s| s.username = value.clone()),
            "port" => {
                let p = value.parse().unwrap_or(0);
                current.iter_mut().for_each(|s| s.port = p);
            }
            "identityfile" => current.iter_mut().for_each(|s| {
                if s.ssh.private_key_path.is_none() {
                    s.ssh.private_key_path = Some(value.clone());
                }
            }),
            "proxyjump" => {
                // Only the first hop, and only `host` or `user@host` forms we can map.
                let first = value.split(',').next().unwrap_or("").trim();
                if first != "none" && !first.is_empty() {
                    let name = first.rsplit('@').next().unwrap_or(first).split(':').next().unwrap_or(first).to_string();
                    current.iter_mut().for_each(|s| s.ssh.jump_site_id = Some(name.clone()));
                }
            }
            "compression" => current.iter_mut().for_each(|s| s.ssh.compression = value.eq_ignore_ascii_case("yes")),
            "serveraliveinterval" => {
                let v = value.parse().unwrap_or(30);
                current.iter_mut().for_each(|s| s.keepalive_secs = v);
            }
            "connecttimeout" => {
                let v = value.parse().unwrap_or(20);
                current.iter_mut().for_each(|s| s.timeout_secs = v);
            }
            _ => {}
        }
    }
    flush(&mut current, &mut out);
    out
}

/// Read `~/.ssh/config`.
pub fn read_openssh_config() -> Result<Vec<SiteConfig>> {
    Ok(from_openssh_config(&read_openssh_config_text()?))
}

/// The text of `~/.ssh/config`.
pub fn read_openssh_config_text() -> Result<String> {
    let home = directories::UserDirs::new().ok_or_else(|| Error::other("no home directory"))?;
    let path = home.home_dir().join(".ssh").join("config");
    std::fs::read_to_string(&path).map_err(|e| Error::io_at(e, &path.display().to_string()))
}

/// FileZilla `sitemanager.xml` → sites.
pub fn from_filezilla_xml(content: &str) -> Result<Vec<SiteConfig>> {
    let doc = roxmltree::Document::parse(content).map_err(|e| Error::InvalidInput(format!("invalid XML: {e}")))?;
    let mut out = Vec::new();
    fn text(node: roxmltree::Node, tag: &str) -> Option<String> {
        node.children().find(|c| c.has_tag_name(tag)).and_then(|c| c.text()).map(|s| s.trim().to_string())
    }
    fn walk(node: roxmltree::Node, folder: &str, out: &mut Vec<SiteConfig>) {
        for child in node.children().filter(|c| c.is_element()) {
            if child.has_tag_name("Folder") {
                let name =
                    child.children().find(|c| c.is_text()).and_then(|t| t.text()).unwrap_or("").trim().to_string();
                let sub = if folder.is_empty() { name } else { format!("{folder}/{name}") };
                walk(child, &sub, out);
            } else if child.has_tag_name("Server") {
                let mut s = SiteConfig {
                    folder: if folder.is_empty() {
                        "Imported/FileZilla".into()
                    } else {
                        format!("Imported/FileZilla/{folder}")
                    },
                    ..Default::default()
                };
                s.host = text(child, "Host").unwrap_or_default();
                s.port = text(child, "Port").and_then(|p| p.parse().ok()).unwrap_or(0);
                s.username = text(child, "User").unwrap_or_default();
                s.name = text(child, "Name").unwrap_or_else(|| s.host.clone());
                s.protocol = match text(child, "Protocol").as_deref() {
                    Some("1") => Protocol::Sftp,
                    Some("3") => {
                        s.ftp.encryption = FtpEncryption::Implicit;
                        Protocol::Ftp
                    }
                    Some("4") => {
                        s.ftp.encryption = FtpEncryption::Explicit;
                        Protocol::Ftp
                    }
                    Some("7") => Protocol::S3,
                    Some("10") | Some("11") => Protocol::Webdav,
                    _ => Protocol::Ftp,
                };
                if let Some(pass) = child.children().find(|c| c.has_tag_name("Pass")) {
                    let raw = pass.text().unwrap_or("").trim();
                    let decoded = if pass.attribute("encoding") == Some("base64") {
                        base64::engine::general_purpose::STANDARD
                            .decode(raw)
                            .ok()
                            .and_then(|b| String::from_utf8(b).ok())
                    } else if pass.attribute("encoding") == Some("crypt") {
                        None
                    } else {
                        Some(raw.to_string())
                    };
                    s.password = decoded.filter(|p| !p.is_empty());
                }
                if let Some(rd) = text(child, "RemoteDir") {
                    s.remote_dir = parse_filezilla_path(&rd);
                }
                if let Some(ld) = text(child, "LocalDir") {
                    s.local_dir = ld;
                }
                if let Some(k) = text(child, "Keyfile") {
                    s.ssh.private_key_path = Some(k);
                }
                if text(child, "PasvMode").as_deref() == Some("MODE_ACTIVE") {
                    s.ftp.passive = false;
                }
                if !s.host.is_empty() {
                    out.push(s);
                }
            }
        }
    }
    let root = doc.root_element();
    if let Some(servers) = root.descendants().find(|n| n.has_tag_name("Servers")) {
        walk(servers, "", &mut out);
    }
    Ok(out)
}

/// FileZilla serializes paths as `1 0 3 var 3 www` (type, prefix, then length-prefixed segments).
fn parse_filezilla_path(s: &str) -> String {
    let mut rest = s.trim();
    let take_token = |rest: &mut &str| -> Option<String> {
        let r = rest.trim_start();
        let end = r.find(' ').unwrap_or(r.len());
        let tok = r[..end].to_string();
        *rest = &r[end..];
        if tok.is_empty() {
            None
        } else {
            Some(tok)
        }
    };
    let _kind = take_token(&mut rest);
    let _prefix = take_token(&mut rest);
    let mut segments = Vec::new();
    while let Some(len) = take_token(&mut rest) {
        let Ok(n) = len.parse::<usize>() else { break };
        let r = rest.strip_prefix(' ').unwrap_or(rest);
        if r.len() < n {
            break;
        }
        segments.push(r[..n].to_string());
        rest = &r[n..];
    }
    format!("/{}", segments.join("/"))
}

pub fn from_json(content: &str) -> Result<Vec<SiteConfig>> {
    let v: Vec<SiteConfig> = serde_json::from_str(content)?;
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn openssh() {
        let cfg = "Host *\n  User def\nHost web prod\n  HostName example.com\n  User deploy\n  Port 2222\n  IdentityFile ~/.ssh/id_web\n  ProxyJump bastion\nHost bastion\n  HostName 1.2.3.4\n";
        let s = from_openssh_config(cfg);
        assert_eq!(s.len(), 3);
        assert_eq!(s[0].name, "web");
        assert_eq!(s[0].host, "example.com");
        assert_eq!(s[1].name, "prod");
        assert_eq!(s[0].port, 2222);
        assert_eq!(s[0].ssh.jump_site_id.as_deref(), Some("bastion"));
        assert_eq!(s[2].host, "1.2.3.4");
    }

    #[test]
    fn filezilla() {
        let xml = r#"<?xml version="1.0"?><FileZilla3><Servers><Folder expanded="1">Work<Server><Host>ftp.x.org</Host><Port>21</Port><Protocol>4</Protocol><User>bob</User><Pass encoding="base64">c2VjcmV0</Pass><Name>X</Name><RemoteDir>1 0 3 var 3 www</RemoteDir></Server></Folder><Server><Host>s.y.org</Host><Protocol>1</Protocol><Name>Y</Name></Server></Servers></FileZilla3>"#;
        let s = from_filezilla_xml(xml).unwrap();
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].folder, "Imported/FileZilla/Work");
        assert_eq!(s[0].password.as_deref(), Some("secret"));
        assert_eq!(s[0].ftp.encryption, FtpEncryption::Explicit);
        assert_eq!(s[0].remote_dir, "/var/www");
        assert_eq!(s[1].protocol, Protocol::Sftp);
    }
}
