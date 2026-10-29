//! Import sites from OpenSSH config, WinSCP.ini, FileZilla and our own JSON export.

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
            Some((k, v)) => (k.trim().to_ascii_lowercase(), v.trim().trim_start_matches('=').trim().trim_matches('"').to_string()),
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
    let home = directories::UserDirs::new().ok_or_else(|| Error::other("no home directory"))?;
    let path = home.home_dir().join(".ssh").join("config");
    let content = std::fs::read_to_string(&path).map_err(|e| Error::io_at(e, &path.display().to_string()))?;
    Ok(from_openssh_config(&content))
}

fn url_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// WinSCP's reversible password obfuscation (used when no master password is set).
fn winscp_decrypt_password(hex: &str, key: &str) -> Option<String> {
    const MAGIC: u8 = 0xA3;
    const FLAG: u8 = 0xFF;
    let digits: Vec<u8> = hex
        .chars()
        .map(|c| c.to_digit(16).map(|d| d as u8))
        .collect::<Option<Vec<u8>>>()?;
    let mut pos = 0;
    let mut next = || -> Option<u8> {
        if pos + 1 >= digits.len() {
            return None;
        }
        let a = (digits[pos] << 4) | digits[pos + 1];
        pos += 2;
        Some(!(a ^ MAGIC))
    };
    let flag = next()?;
    let length = if flag == FLAG {
        next()?;
        next()?
    } else {
        flag
    };
    let skip = next()? as usize;
    for _ in 0..skip {
        next()?;
    }
    let mut res = Vec::with_capacity(length as usize);
    for _ in 0..length {
        res.push(next()?);
    }
    let s = String::from_utf8(res).ok()?;
    if flag == FLAG {
        s.strip_prefix(key).map(|x| x.to_string())
    } else {
        Some(s)
    }
}

/// Exported `WinSCP.ini` (`[Sessions\...]` sections) → sites.
pub fn from_winscp_ini(content: &str) -> Vec<SiteConfig> {
    let mut out = Vec::new();
    let mut cur: Option<(String, Vec<(String, String)>)> = None;
    let mut finish = |cur: Option<(String, Vec<(String, String)>)>| {
        let Some((section, kv)) = cur else { return };
        let Some(name) = section.strip_prefix("Sessions\\") else { return };
        let full = url_decode(name);
        if full == "Default Settings" {
            return;
        }
        let (folder, short) = match full.rfind('/') {
            Some(i) => (full[..i].to_string(), full[i + 1..].to_string()),
            None => (String::new(), full.clone()),
        };
        let get = |k: &str| kv.iter().find(|(kk, _)| kk.eq_ignore_ascii_case(k)).map(|(_, v)| v.clone());
        let mut s = SiteConfig {
            name: short,
            folder: if folder.is_empty() { "Imported/WinSCP".into() } else { format!("Imported/WinSCP/{folder}") },
            ..Default::default()
        };
        s.host = get("HostName").unwrap_or_default();
        s.username = url_decode(&get("UserName").unwrap_or_default());
        s.port = get("PortNumber").and_then(|p| p.parse().ok()).unwrap_or(0);
        s.protocol = match get("FSProtocol").as_deref() {
            Some("0") => Protocol::Scp,
            Some("5") => Protocol::Ftp,
            Some("6") => Protocol::Webdav,
            Some("7") => Protocol::S3,
            _ => Protocol::Sftp,
        };
        match get("Ftps").as_deref() {
            Some("1") => s.ftp.encryption = FtpEncryption::Implicit,
            Some("2") | Some("3") => s.ftp.encryption = FtpEncryption::Explicit,
            _ => {}
        }
        if s.protocol == Protocol::Webdav {
            s.webdav.https = get("Ftps").as_deref().is_some_and(|v| v != "0");
        }
        s.remote_dir = url_decode(&get("RemoteDirectory").unwrap_or_default());
        s.local_dir = url_decode(&get("LocalDirectory").unwrap_or_default());
        if let Some(k) = get("PublicKeyFile") {
            let k = url_decode(&k);
            if !k.is_empty() {
                s.ssh.private_key_path = Some(k);
            }
        }
        if let Some(p) = get("Password") {
            let key = format!("{}{}", s.username, s.host);
            s.password = winscp_decrypt_password(&p, &key);
        }
        if let Some(t) = get("Timeout").and_then(|v| v.parse().ok()) {
            s.timeout_secs = t;
        }
        if !s.host.is_empty() {
            out.push(s);
        }
    };
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with('[') && line.ends_with(']') {
            finish(cur.take());
            cur = Some((line[1..line.len() - 1].to_string(), Vec::new()));
        } else if let Some((k, v)) = line.split_once('=') {
            if let Some((_, kv)) = cur.as_mut() {
                kv.push((k.trim().to_string(), v.trim().to_string()));
            }
        }
    }
    finish(cur);
    out
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
                let name = child.children().find(|c| c.is_text()).and_then(|t| t.text()).unwrap_or("").trim().to_string();
                let sub = if folder.is_empty() { name } else { format!("{folder}/{name}") };
                walk(child, &sub, out);
            } else if child.has_tag_name("Server") {
                let mut s = SiteConfig {
                    folder: if folder.is_empty() { "Imported/FileZilla".into() } else { format!("Imported/FileZilla/{folder}") },
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
    let mut take_token = |rest: &mut &str| -> Option<String> {
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
    fn winscp() {
        let ini = "[Sessions\\My%20Folder/Server%201]\nHostName=example.org\nUserName=root\nPortNumber=2022\nFSProtocol=2\nRemoteDirectory=/var/www\n[Sessions\\ftp]\nHostName=ftp.example.org\nFSProtocol=5\nFtps=3\n";
        let s = from_winscp_ini(ini);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].name, "Server 1");
        assert_eq!(s[0].folder, "Imported/WinSCP/My Folder");
        assert_eq!(s[0].port, 2022);
        assert_eq!(s[1].protocol, Protocol::Ftp);
        assert_eq!(s[1].ftp.encryption, FtpEncryption::Explicit);
    }

    #[test]
    fn winscp_password() {
        fn enc(c: u8) -> String {
            format!("{:02X}", !c ^ 0xA3)
        }
        let key = "rootexample.org";
        let full = format!("{key}s3cr3t");
        let mut hex = enc(0xFF) + &enc(0) + &enc(full.len() as u8) + &enc(2) + &enc(7) + &enc(9);
        for b in full.bytes() {
            hex += &enc(b);
        }
        assert_eq!(winscp_decrypt_password(&hex, key).as_deref(), Some("s3cr3t"));
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
