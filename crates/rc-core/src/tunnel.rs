//! Port forwarding through a session: local forwards (`-L`) and a SOCKS5 proxy (`-D`).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result};
use crate::vfs::Vfs;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TunnelKind {
    Local,
    Dynamic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelSpec {
    pub kind: TunnelKind,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub id: String,
    pub session: String,
    pub kind: TunnelKind,
    pub bind_host: String,
    pub bind_port: u16,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
    pub connections: u64,
    pub bytes_in: u64,
    pub bytes_out: u64,
    pub error: Option<String>,
}

struct Counters {
    connections: AtomicU64,
    bytes_in: AtomicU64,
    bytes_out: AtomicU64,
    error: Mutex<Option<String>>,
}

pub struct Tunnel {
    pub id: String,
    session: String,
    spec: TunnelSpec,
    counters: Arc<Counters>,
    stop: CancellationToken,
}

impl Tunnel {
    pub fn status(&self) -> TunnelStatus {
        TunnelStatus {
            id: self.id.clone(),
            session: self.session.clone(),
            kind: self.spec.kind,
            bind_host: self.spec.bind_host.clone(),
            bind_port: self.spec.bind_port,
            target_host: self.spec.target_host.clone(),
            target_port: self.spec.target_port,
            connections: self.counters.connections.load(Ordering::Relaxed),
            bytes_in: self.counters.bytes_in.load(Ordering::Relaxed),
            bytes_out: self.counters.bytes_out.load(Ordering::Relaxed),
            error: self.counters.error.lock().clone(),
        }
    }

    pub fn stop(&self) {
        self.stop.cancel();
    }
}

impl Drop for Tunnel {
    fn drop(&mut self) {
        self.stop.cancel();
    }
}

/// Bind the listener and start forwarding. The returned tunnel stops when dropped.
pub async fn start(session: &str, vfs: Arc<dyn Vfs>, mut spec: TunnelSpec) -> Result<Tunnel> {
    if spec.kind == TunnelKind::Local && (spec.target_host.is_none() || spec.target_port.is_none()) {
        return Err(Error::InvalidInput("local forwarding needs a target host and port".into()));
    }
    if spec.bind_host.is_empty() {
        spec.bind_host = "127.0.0.1".into();
    }
    let listener = TcpListener::bind((spec.bind_host.as_str(), spec.bind_port))
        .await
        .map_err(|e| Error::io_at(e, &format!("{}:{}", spec.bind_host, spec.bind_port)))?;
    spec.bind_port = listener.local_addr()?.port();
    let counters = Arc::new(Counters {
        connections: AtomicU64::new(0),
        bytes_in: AtomicU64::new(0),
        bytes_out: AtomicU64::new(0),
        error: Mutex::new(None),
    });
    let stop = CancellationToken::new();
    let t = Tunnel {
        id: uuid::Uuid::new_v4().to_string(),
        session: session.to_string(),
        spec: spec.clone(),
        counters: counters.clone(),
        stop: stop.clone(),
    };
    tracing::info!(session, "tunnel listening on {}:{}", spec.bind_host, spec.bind_port);
    tokio::spawn(async move {
        loop {
            let (sock, peer) = tokio::select! {
                _ = stop.cancelled() => break,
                r = listener.accept() => match r {
                    Ok(x) => x,
                    Err(e) => {
                        *counters.error.lock() = Some(e.to_string());
                        // Errors like EMFILE repeat at once: do not spin.
                        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                        continue;
                    }
                },
            };
            let vfs = vfs.clone();
            let spec = spec.clone();
            let counters = counters.clone();
            let stop = stop.clone();
            tokio::spawn(async move {
                counters.connections.fetch_add(1, Ordering::Relaxed);
                let r = tokio::select! {
                    _ = stop.cancelled() => Ok(()),
                    r = handle(sock, vfs, &spec, &counters) => r,
                };
                if let Err(e) = r {
                    tracing::debug!("tunnel connection from {peer}: {e}");
                    *counters.error.lock() = Some(e.to_string());
                }
            });
        }
    });
    Ok(t)
}

async fn handle(mut sock: TcpStream, vfs: Arc<dyn Vfs>, spec: &TunnelSpec, counters: &Counters) -> Result<()> {
    let (host, port) = match spec.kind {
        TunnelKind::Local => (spec.target_host.clone().unwrap_or_default(), spec.target_port.unwrap_or(0)),
        TunnelKind::Dynamic => socks5_handshake(&mut sock).await?,
    };
    let mut remote = match vfs.open_tunnel(&host, port).await {
        Ok(r) => r,
        Err(e) => {
            if spec.kind == TunnelKind::Dynamic {
                let _ = sock.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).await;
            }
            return Err(e);
        }
    };
    if spec.kind == TunnelKind::Dynamic {
        sock.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
    }
    let (a, b) = tokio::io::copy_bidirectional(&mut sock, &mut remote).await?;
    counters.bytes_out.fetch_add(a, Ordering::Relaxed);
    counters.bytes_in.fetch_add(b, Ordering::Relaxed);
    Ok(())
}

/// Minimal SOCKS5 server side: no authentication, CONNECT only.
async fn socks5_handshake(s: &mut TcpStream) -> Result<(String, u16)> {
    let mut hdr = [0u8; 2];
    s.read_exact(&mut hdr).await?;
    if hdr[0] != 5 {
        return Err(Error::protocol("not a SOCKS5 client"));
    }
    let mut methods = vec![0u8; hdr[1] as usize];
    s.read_exact(&mut methods).await?;
    if !methods.contains(&0) {
        s.write_all(&[5, 0xFF]).await?;
        return Err(Error::protocol("SOCKS5 client requires authentication"));
    }
    s.write_all(&[5, 0]).await?;
    let mut req = [0u8; 4];
    s.read_exact(&mut req).await?;
    if req[1] != 1 {
        s.write_all(&[5, 7, 0, 1, 0, 0, 0, 0, 0, 0]).await?;
        return Err(Error::protocol("only SOCKS5 CONNECT is supported"));
    }
    let host = match req[3] {
        1 => {
            let mut a = [0u8; 4];
            s.read_exact(&mut a).await?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        3 => {
            let mut len = [0u8; 1];
            s.read_exact(&mut len).await?;
            let mut name = vec![0u8; len[0] as usize];
            s.read_exact(&mut name).await?;
            String::from_utf8_lossy(&name).into_owned()
        }
        4 => {
            let mut a = [0u8; 16];
            s.read_exact(&mut a).await?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        _ => return Err(Error::protocol("bad SOCKS5 address type")),
    };
    let mut port = [0u8; 2];
    s.read_exact(&mut port).await?;
    Ok((host, u16::from_be_bytes(port)))
}
