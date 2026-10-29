//! Pool of logged-in control connections.
//!
//! A semaphore limits the connections in use to `max_connections`; idle connections are
//! kept for reuse. A connection is only returned after a successful command sequence;
//! connections that failed, timed out or were abandoned mid-command are dropped and
//! transparently replaced by the next checkout.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use super::conn::{self, Conn, LiveGuard, Shared};
use crate::error::{Error, Result};

/// Idle connections older than this are checked with `NOOP` before reuse.
const PROBE_AFTER: Duration = Duration::from_secs(15);

pub(super) struct Pool {
    shared: Arc<Shared>,
    idle: Mutex<Vec<Conn>>,
    permits: Arc<Semaphore>,
    live: Arc<AtomicUsize>,
    closed: AtomicBool,
}

/// A checked-out connection. Call [`Lease::release`] to return it; dropping a lease
/// discards the connection (its state is unknown).
pub(super) struct Lease {
    conn: Option<Conn>,
    pool: Arc<Pool>,
    reused: bool,
    _permit: OwnedSemaphorePermit,
}

impl Lease {
    pub fn conn(&mut self) -> &mut Conn {
        self.conn.as_mut().expect("a lease holds its connection until released")
    }

    /// Whether the connection came from the idle list (and may have gone stale).
    pub fn reused(&self) -> bool {
        self.reused
    }

    pub fn release(mut self) {
        if let Some(c) = self.conn.take() {
            self.pool.put_back(c);
        }
    }
}

impl Drop for Lease {
    fn drop(&mut self) {
        if self.conn.take().is_some() {
            tracing::debug!(session = %self.pool.shared.session_id, "discarding FTP connection in unknown state");
        }
    }
}

fn too_many_connections(e: &Error) -> bool {
    let msg = e.to_string().to_ascii_lowercase();
    ["too many", "maximum", "max connections", "connection limit", "limit reached"].iter().any(|w| msg.contains(w))
}

impl Pool {
    pub fn new(shared: Arc<Shared>, max: usize) -> Arc<Self> {
        Arc::new(Pool {
            shared,
            idle: Mutex::new(Vec::new()),
            permits: Arc::new(Semaphore::new(max.max(1))),
            live: Arc::new(AtomicUsize::new(0)),
            closed: AtomicBool::new(false),
        })
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Acquire)
    }

    fn closed_error() -> Error {
        Error::ConnectionLost("the FTP session has been closed".into())
    }

    /// Get a connection: an idle one (`fresh == false`) or a newly opened one. Waits
    /// while all permitted connections are busy.
    pub async fn checkout(self: &Arc<Self>, fresh: bool) -> Result<Lease> {
        if fresh {
            // Asked after a stale connection failed: the other idle ones are suspect too.
            self.idle.lock().clear();
        }
        loop {
            let permit = self.permits.clone().acquire_owned().await.map_err(|_| Self::closed_error())?;
            if self.is_closed() {
                return Err(Self::closed_error());
            }
            loop {
                let next = self.idle.lock().pop();
                let Some(mut conn) = next else { break };
                if conn.last_used.elapsed() >= PROBE_AFTER {
                    let alive = tokio::time::timeout(self.shared.timeout, conn.noop()).await;
                    if !matches!(alive, Ok(Ok(()))) {
                        tracing::debug!(session = %self.shared.session_id, "dropping stale FTP connection");
                        continue;
                    }
                }
                return Ok(Lease { conn: Some(conn), pool: self.clone(), reused: true, _permit: permit });
            }
            self.live.fetch_add(1, Ordering::AcqRel);
            match conn::open(&self.shared, LiveGuard(self.live.clone())).await {
                Ok(conn) => {
                    tracing::debug!(
                        session = %self.shared.session_id,
                        "opened FTP connection ({} live)",
                        self.live.load(Ordering::Acquire)
                    );
                    return Ok(Lease { conn: Some(conn), pool: self.clone(), reused: false, _permit: permit });
                }
                Err(e) if too_many_connections(&e) && self.live.load(Ordering::Acquire) > 0 => {
                    // The server allows fewer connections than configured: shrink the pool
                    // and wait for one of the open connections instead.
                    tracing::info!(session = %self.shared.session_id, "server connection limit reached: {e}");
                    permit.forget();
                }
                Err(e) => return Err(e),
            }
        }
    }

    fn put_back(&self, mut conn: Conn) {
        if conn.broken || self.is_closed() {
            return;
        }
        conn.last_used = Instant::now();
        self.idle.lock().push(conn);
    }

    /// Send `NOOP` on connections idle for at least `idle_for`, dropping dead ones.
    pub async fn keepalive(&self, idle_for: Duration) {
        // Holding a permit keeps the number of connections within the limit.
        let Ok(_permit) = self.permits.clone().try_acquire_owned() else { return };
        loop {
            let stale = {
                let mut idle = self.idle.lock();
                let pos = idle.iter().position(|c| c.last_used.elapsed() >= idle_for);
                pos.map(|i| idle.swap_remove(i))
            };
            let Some(mut conn) = stale else { break };
            match tokio::time::timeout(self.shared.timeout, conn.noop()).await {
                Ok(Ok(())) => self.put_back(conn),
                _ => tracing::debug!(session = %self.shared.session_id, "keepalive: dropping dead FTP connection"),
            }
        }
    }

    /// Log out of all idle connections; connections in use are closed when returned.
    pub async fn close(&self) {
        self.closed.store(true, Ordering::Release);
        self.permits.close();
        let conns = std::mem::take(&mut *self.idle.lock());
        for mut c in conns {
            c.quit().await;
        }
    }
}
