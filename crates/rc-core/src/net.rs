//! TCP connection helpers with timeout and proxy (SOCKS5 / HTTP CONNECT) support.

use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
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
    // Read the response header byte-wise-buffered, then hand back the raw stream.
    let mut reader = BufReader::new(&mut s);
    let mut status = String::new();
    reader.read_line(&mut status).await?;
    let ok = status.split_whitespace().nth(1).map(|c| c.starts_with('2')).unwrap_or(false);
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line).await?;
        if n == 0 || line == "\r\n" || line == "\n" {
            break;
        }
    }
    if !reader.buffer().is_empty() {
        return Err(Error::protocol("HTTP proxy sent unexpected data after CONNECT response"));
    }
    drop(reader);
    if !ok {
        return Err(Error::ConnectionLost(format!("HTTP proxy refused CONNECT: {}", status.trim())));
    }
    Ok(s)
}
