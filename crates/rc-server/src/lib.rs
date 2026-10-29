//! Rust Commander web server.
//!
//! Serves the embedded web UI and the API (`/api/rpc`, `/api/events` WebSocket,
//! `/api/download`, `/api/upload`) for one [`AppState`]. Used by `rcmd serve` (headless)
//! and by the desktop app's "share this instance" feature.

mod routes;
pub mod tls;

use std::net::SocketAddr;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::Mutex;

use rc_api::server::{RunningServer, ServerControl};
use rc_api::AppState;
use rc_core::{Error, Result};

pub use routes::router;

struct Running {
    info: RunningServer,
    handle: axum_server::Handle<SocketAddr>,
}

/// Starts/stops the server; installed into [`AppState::server`].
#[derive(Default)]
pub struct WebServer {
    running: Mutex<Option<Running>>,
    clients: Arc<AtomicUsize>,
}

impl WebServer {
    pub fn new() -> Arc<Self> {
        Arc::new(WebServer::default())
    }

    /// Wait until the server stops (headless mode).
    pub async fn wait(&self) {
        loop {
            if self.running.lock().is_none() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
}

fn install_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

#[async_trait]
impl ServerControl for WebServer {
    async fn start(&self, state: Arc<AppState>, bind: String, port: u16, tls: bool) -> Result<RunningServer> {
        install_crypto_provider();
        let ip: std::net::IpAddr = bind.parse().map_err(|_| Error::InvalidInput(format!("invalid bind address {bind}")))?;
        let addr = SocketAddr::new(ip, port);
        // Bind first so errors (port in use) are reported synchronously.
        let std_listener = std::net::TcpListener::bind(addr).map_err(|e| Error::io_at(e, &addr.to_string()))?;
        std_listener.set_nonblocking(true)?;
        let actual = std_listener.local_addr()?;
        let app = routes::router(state.clone(), self.clients.clone(), tls);
        let handle: axum_server::Handle<SocketAddr> = axum_server::Handle::new();
        let mut fingerprint = None;
        if tls {
            let pair = tls::load_or_create(&state.config_dir)?;
            fingerprint = Some(pair.fingerprint.clone());
            let config = axum_server::tls_rustls::RustlsConfig::from_pem(pair.cert_pem.into_bytes(), pair.key_pem.into_bytes())
                .await
                .map_err(|e| Error::other(format!("TLS configuration: {e}")))?;
            let server = axum_server::tls_rustls::from_tcp_rustls(std_listener, config)
                .map_err(|e| Error::other(e.to_string()))?
                .handle(handle.clone());
            tokio::spawn(async move {
                if let Err(e) = server.serve(app.into_make_service_with_connect_info::<SocketAddr>()).await {
                    tracing::error!("web server: {e}");
                }
            });
        } else {
            let server = axum_server::from_tcp(std_listener).map_err(|e| Error::other(e.to_string()))?.handle(handle.clone());
            tokio::spawn(async move {
                if let Err(e) = server.serve(app.into_make_service_with_connect_info::<SocketAddr>()).await {
                    tracing::error!("web server: {e}");
                }
            });
        }
        let info = RunningServer { bind: bind.clone(), port: actual.port(), tls, fingerprint };
        tracing::info!(
            "web interface listening on {}://{}:{}/",
            if tls { "https" } else { "http" },
            bind,
            actual.port()
        );
        *self.running.lock() = Some(Running { info: info.clone(), handle });
        Ok(info)
    }

    async fn stop(&self) -> Result<()> {
        if let Some(r) = self.running.lock().take() {
            r.handle.graceful_shutdown(Some(Duration::from_secs(2)));
            tracing::info!("web interface stopped");
        }
        Ok(())
    }

    fn running(&self) -> Option<RunningServer> {
        self.running.lock().as_ref().map(|r| r.info.clone())
    }

    fn clients(&self) -> usize {
        self.clients.load(Ordering::Relaxed)
    }
}
