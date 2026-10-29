//! TCP connection helpers with timeout and proxy (SOCKS5 / HTTP CONNECT) support.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::error::{Error, Result};
use crate::site::{ProxyKind, ProxyOptions};

/// Connect to `host:port`, optionally through a proxy.
pub async fn connect_tcp(host: &str, port: u16, proxy: &ProxyOptions, timeout: Duration) -> Result<TcpStream> {
    let fut = async {
        match proxy.kind {
            ProxyKind::None => {
                let s = TcpStream::connect((host, port)).await.map_err(|e| connect_error(host, port, e))?;
                Ok(s)
            }
            ProxyKind::Socks5 => socks5(host, port, proxy).await,
            ProxyKind::Http => http_connect(host, port, proxy).await,
        }
    };
    let stream = tokio::time::timeout(timeout, fut)
        .await
        .map_err(|_| Error::Timeout(format!("connecting to {host}:{port}")))??;
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

fn connect_error(host: &str, port: u16, e: std::io::Error) -> Error {
    match e.kind() {
        std::io::ErrorKind::ConnectionRefused => Error::ConnectionLost(format!("connection to {host}:{port} refused")),
        std::io::ErrorKind::TimedOut => Error::Timeout(format!("connecting to {host}:{port}")),
        _ => Error::ConnectionLost(format!("cannot connect to {host}:{port}: {e}")),
    }
}

async fn socks5(host: &str, port: u16, proxy: &ProxyOptions) -> Result<TcpStream> {
    let proxy_addr = (proxy.host.as_str(), if proxy.port == 0 { 1080 } else { proxy.port });
    let target = (host, port);
    let s = if proxy.username.is_empty() {
        tokio_socks::tcp::Socks5Stream::connect(proxy_addr, target).await
    } else {
        tokio_socks::tcp::Socks5Stream::connect_with_password(
            proxy_addr,
            target,
            &proxy.username,
            proxy.password.as_deref().unwrap_or(""),
        )
        .await
    }
    .map_err(|e| Error::ConnectionLost(format!("SOCKS5 proxy {}: {e}", proxy.host)))?;
    Ok(s.into_inner())
}

async fn http_connect(host: &str, port: u16, proxy: &ProxyOptions) -> Result<TcpStream> {
    let pport = if proxy.port == 0 { 8080 } else { proxy.port };
    let mut s =
        TcpStream::connect((proxy.host.as_str(), pport)).await.map_err(|e| connect_error(&proxy.host, pport, e))?;
    let authority = if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") };
    let mut req = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if !proxy.username.is_empty() {
        use base64::Engine;
        let cred = format!("{}:{}", proxy.username, proxy.password.as_deref().unwrap_or(""));
        req.push_str(&format!(
            "Proxy-Authorization: Basic {}\r\n",
            base64::engine::general_purpose::STANDARD.encode(cred)
        ));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).await?;
    // Read the response header one byte at a time: the target may speak first (SSH and FTP
    // banners), and its first bytes can arrive in the same packet as the proxy's reply.
    let mut head = Vec::new();
    while !(head.ends_with(b"\r\n\r\n") || head.ends_with(b"\n\n")) {
        if head.len() > 64 * 1024 {
            return Err(Error::protocol("HTTP proxy sent an overlong CONNECT response"));
        }
        if s.read_u8().await.map(|b| head.push(b)).is_err() {
            break;
        }
    }
    let head = String::from_utf8_lossy(&head);
    let status = head.lines().next().unwrap_or("").to_string();
    let ok = status.split_whitespace().nth(1).map(|c| c.starts_with('2')).unwrap_or(false);
    if !ok {
        return Err(Error::ConnectionLost(format!("HTTP proxy refused CONNECT: {}", status.trim())));
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn http_connect_keeps_the_banner_that_follows_the_reply() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = s.read(&mut buf).await.unwrap();
            // Proxy reply and the server's banner in a single packet.
            s.write_all(b"HTTP/1.1 200 Connection established\r\n\r\nSSH-2.0-Test\r\n").await.unwrap();
        });
        let proxy = ProxyOptions { kind: ProxyKind::Http, host: "127.0.0.1".into(), port, ..Default::default() };
        let mut s = connect_tcp("example.org", 22, &proxy, Duration::from_secs(5)).await.unwrap();
        let mut banner = vec![0u8; 14];
        s.read_exact(&mut banner).await.unwrap();
        assert_eq!(banner, b"SSH-2.0-Test\r\n");
    }
}
