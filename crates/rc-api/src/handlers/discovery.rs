use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::Digest;

use rc_core::{Error, Result};
use rc_discovery::{InstanceInfo, Peer};

use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryStatus {
    pub enabled: bool,
    pub port: u16,
    pub instance_id: String,
    pub instance_name: String,
    pub error: Option<String>,
}

pub fn status(state: &AppState) -> DiscoveryStatus {
    let s = state.settings.read().discovery.clone();
    DiscoveryStatus {
        enabled: s.enabled && state.discovery.lock().is_some(),
        port: s.port,
        instance_id: state.instance_id.clone(),
        instance_name: state.instance_name(),
        error: state.discovery_error.lock().clone(),
    }
}

pub fn peers(state: &AppState) -> Vec<Peer> {
    match state.discovery.lock().as_ref() {
        Some(d) => d.peers(),
        None => vec![],
    }
}

/// `/api/info` of a peer.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub instance: Option<InstanceInfo>,
}

/// Fetch `/api/info` and the TLS certificate fingerprint actually presented.
pub async fn probe(host: &str, port: u16, tls: bool) -> Result<(InstanceInfo, Option<String>)> {
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(true)
        .tls_info(true)
        .timeout(Duration::from_secs(5))
        .no_proxy()
        .build()
        .map_err(Error::other)?;
    let h = if host.contains(':') { format!("[{host}]") } else { host.to_string() };
    let url = format!("{}://{h}:{port}/api/info", if tls { "https" } else { "http" });
    let resp = client.get(&url).send().await.map_err(|e| Error::ConnectionLost(format!("{url}: {e}")))?;
    let fingerprint =
        resp.extensions().get::<reqwest::tls::TlsInfo>().and_then(|i| i.peer_certificate()).map(cert_fingerprint);
    let info: RemoteInfo =
        resp.json().await.map_err(|e| Error::protocol(format!("{url}: not a Rust Commander instance ({e})")))?;
    let mut instance = info.instance.ok_or_else(|| Error::protocol("not a Rust Commander instance"))?;
    if let Some(web) = instance.web.as_mut() {
        web.tls = tls;
        web.port = port;
        if fingerprint.is_some() {
            web.fingerprint = fingerprint.clone();
        }
    } else {
        instance.web = Some(rc_discovery::WebInfo { port, tls, fingerprint: fingerprint.clone() });
    }
    Ok((instance, fingerprint))
}

/// `AA:BB:...` SHA-256 of a DER certificate.
pub fn cert_fingerprint(der: &[u8]) -> String {
    let d = sha2::Sha256::digest(der);
    d.iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

/// Parse `host`, `host:port`, `[v6]:port` or a URL.
pub fn parse_address(addr: &str) -> Result<(String, u16, Option<bool>)> {
    let a = addr.trim();
    let (scheme, rest) = match a.split_once("://") {
        Some((s, r)) => (Some(s.to_ascii_lowercase()), r),
        None => (None, a),
    };
    let rest = rest.split('/').next().unwrap_or(rest);
    let tls = scheme.as_deref().map(|s| s == "https" || s == "rcmds");
    let (host, port) = if let Some(r) = rest.strip_prefix('[') {
        let end = r.find(']').ok_or_else(|| Error::InvalidInput("bad IPv6 address".into()))?;
        let port = r[end + 1..].strip_prefix(':').and_then(|p| p.parse().ok());
        (r[..end].to_string(), port)
    } else if let Some((h, p)) = rest.rsplit_once(':') {
        (h.to_string(), Some(p.parse().map_err(|_| Error::InvalidInput(format!("bad port in {addr}")))?))
    } else {
        (rest.to_string(), None)
    };
    if host.is_empty() {
        return Err(Error::InvalidInput("empty address".into()));
    }
    Ok((host, port.unwrap_or(8822), tls))
}

pub async fn add(state: &Arc<AppState>, address: &str) -> Result<Peer> {
    let (host, port, tls) = parse_address(address)?;
    let attempts: Vec<bool> = match tls {
        Some(t) => vec![t],
        None => vec![true, false],
    };
    let mut last_err = None;
    for t in attempts {
        match probe(&host, port, t).await {
            Ok((info, _fp)) => {
                // Resolve names so the peer list shows an address we can connect to.
                let addr = tokio::net::lookup_host((host.as_str(), port))
                    .await
                    .ok()
                    .and_then(|mut it| it.next())
                    .map(|a| a.ip().to_string())
                    .unwrap_or(host.clone());
                let id = info.id.clone();
                let d = state.discovery.lock();
                let d = d.as_ref().ok_or_else(|| Error::unsupported("LAN discovery is disabled in the settings"))?;
                d.upsert_manual(info, addr, true);
                return d.peers().into_iter().find(|p| p.id == id).ok_or_else(|| Error::other("peer vanished"));
            }
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| Error::other("unreachable")))
}

pub fn remove(state: &AppState, id: &str) -> Result<()> {
    if let Some(d) = state.discovery.lock().as_ref() {
        d.remove(id);
    }
    Ok(())
}

pub async fn probe_manual_peers(state: &Arc<AppState>) {
    let manual = match state.discovery.lock().as_ref() {
        Some(d) => d.manual_peers(),
        None => return,
    };
    for (_id, addr, port, tls) in manual {
        let r = probe(&addr, port, tls).await;
        if let Some(d) = state.discovery.lock().as_ref() {
            match r {
                Ok((info, _)) => d.upsert_manual(info, addr, true),
                Err(_) => {
                    if let Some(p) = d.peers().into_iter().find(|p| p.manual && p.addresses.first() == Some(&addr)) {
                        let info = InstanceInfo {
                            id: p.id,
                            name: p.name,
                            hostname: p.hostname,
                            version: p.version,
                            os: p.os,
                            user: p.user,
                            web: p.web.map(|w| rc_discovery::WebInfo {
                                port: w.port,
                                tls: w.tls,
                                fingerprint: w.fingerprint,
                            }),
                        };
                        d.upsert_manual(info, addr, false);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn addresses() {
        assert_eq!(parse_address("10.0.0.5").unwrap(), ("10.0.0.5".into(), 8822, None));
        assert_eq!(parse_address("host:9000").unwrap(), ("host".into(), 9000, None));
        assert_eq!(parse_address("https://[::1]:8443/").unwrap(), ("::1".into(), 8443, Some(true)));
        assert_eq!(parse_address("http://box").unwrap(), ("box".into(), 8822, Some(false)));
    }
}
