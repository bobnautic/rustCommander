//! LAN discovery of Rust Commander instances.
//!
//! Every instance periodically announces itself with a small JSON datagram sent to the
//! IPv4 limited broadcast address, to the directed broadcast address of every interface
//! and to the multicast group [`MULTICAST_GROUP`] — all on the same UDP port (default
//! [`DEFAULT_PORT`]). New instances send a `query`, which makes everybody announce
//! immediately. All traffic is broadcast/multicast, so several instances on one machine
//! can share the port (`SO_REUSEADDR`/`SO_REUSEPORT`).
//!
//! Announcements are unauthenticated hints only: connecting to a peer always requires
//! logging in to its web API, and TLS peers publish their certificate fingerprint so the
//! client can pin it.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use socket2::{Domain, Protocol, Socket, Type};
use tokio::net::UdpSocket;
use tokio::sync::Notify;

pub const DEFAULT_PORT: u16 = 47800;
pub const MULTICAST_GROUP: Ipv4Addr = Ipv4Addr::new(239, 255, 77, 77);
const MAGIC: &str = "rust-commander/1";
const MAX_PACKET: usize = 4096;

/// What an instance tells the network about itself.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceInfo {
    pub id: String,
    pub name: String,
    pub hostname: String,
    pub version: String,
    pub os: String,
    #[serde(default)]
    pub user: Option<String>,
    /// Present when the web UI is reachable.
    #[serde(default)]
    pub web: Option<WebInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebInfo {
    pub port: u16,
    pub tls: bool,
    #[serde(default)]
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Packet {
    magic: String,
    #[serde(rename = "type")]
    kind: PacketKind,
    info: InstanceInfo,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum PacketKind {
    Announce,
    Query,
    Bye,
}

/// A discovered (or manually added) instance, as shown in the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub id: String,
    pub name: String,
    pub hostname: String,
    pub version: String,
    pub os: String,
    pub user: Option<String>,
    pub addresses: Vec<String>,
    pub web: Option<PeerWeb>,
    /// Unix milliseconds.
    pub last_seen: i64,
    pub manual: bool,
    #[serde(rename = "self")]
    pub is_self: bool,
    pub online: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerWeb {
    pub port: u16,
    pub tls: bool,
    pub fingerprint: Option<String>,
    pub url: String,
}

impl Peer {
    fn from_info(info: &InstanceInfo, addresses: Vec<String>, last_seen: i64, manual: bool, is_self: bool, online: bool) -> Peer {
        let web = info.web.as_ref().map(|w| {
            let host = addresses.first().cloned().unwrap_or_else(|| "127.0.0.1".into());
            let host = if host.contains(':') { format!("[{host}]") } else { host };
            PeerWeb {
                port: w.port,
                tls: w.tls,
                fingerprint: w.fingerprint.clone(),
                url: format!("{}://{}:{}/", if w.tls { "https" } else { "http" }, host, w.port),
            }
        });
        Peer {
            id: info.id.clone(),
            name: info.name.clone(),
            hostname: info.hostname.clone(),
            version: info.version.clone(),
            os: info.os.clone(),
            user: info.user.clone(),
            addresses,
            web,
            last_seen,
            manual,
            is_self,
            online,
        }
    }
}

#[derive(Debug, Clone)]
pub struct DiscoveryConfig {
    pub port: u16,
    pub interval: Duration,
    /// Announce this instance (false = only listen, e.g. `rcmd discover`).
    pub announce: bool,
}

impl Default for DiscoveryConfig {
    fn default() -> Self {
        DiscoveryConfig { port: DEFAULT_PORT, interval: Duration::from_secs(5), announce: true }
    }
}

struct Entry {
    info: InstanceInfo,
    addresses: Vec<IpAddr>,
    last_seen: Instant,
    last_seen_ms: i64,
    manual: bool,
    /// Manual peers carry their own reachability flag (probed over HTTP).
    manual_online: bool,
}

struct Inner {
    config: DiscoveryConfig,
    info: Mutex<InstanceInfo>,
    peers: Mutex<HashMap<String, Entry>>,
    listener: Arc<dyn Fn(Vec<Peer>) + Send + Sync>,
    wake: Notify,
    stop: tokio_util_like::Stop,
    last_reply: Mutex<Option<Instant>>,
}

mod tokio_util_like {
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::Notify;

    /// Minimal cancellation flag (avoids pulling tokio-util into this crate).
    #[derive(Default)]
    pub struct Stop {
        flag: AtomicBool,
        notify: Notify,
    }

    impl Stop {
        pub fn cancel(&self) {
            self.flag.store(true, Ordering::SeqCst);
            self.notify.notify_waiters();
        }
        pub fn is_cancelled(&self) -> bool {
            self.flag.load(Ordering::SeqCst)
        }
        pub async fn cancelled(&self) {
            loop {
                let n = self.notify.notified();
                if self.is_cancelled() {
                    return;
                }
                n.await;
            }
        }
    }
}

/// Running discovery service. Dropping it sends a goodbye and stops.
pub struct Discovery {
    inner: Arc<Inner>,
}

fn ipv4_interfaces() -> Vec<if_addrs::Ifv4Addr> {
    if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| i.is_oper_up() || cfg!(windows))
        .filter_map(|i| match i.addr {
            if_addrs::IfAddr::V4(a) => Some(a),
            _ => None,
        })
        .collect()
}

fn bind_listener(port: u16) -> std::io::Result<UdpSocket> {
    let s = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    s.set_reuse_address(true)?;
    #[cfg(all(unix, not(target_os = "solaris"), not(target_os = "illumos")))]
    s.set_reuse_port(true)?;
    s.set_broadcast(true)?;
    s.set_nonblocking(true)?;
    s.bind(&SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port)).into())?;
    let mut joined = false;
    for iface in ipv4_interfaces() {
        if s.join_multicast_v4(&MULTICAST_GROUP, &iface.ip).is_ok() {
            joined = true;
        }
    }
    if !joined {
        let _ = s.join_multicast_v4(&MULTICAST_GROUP, &Ipv4Addr::UNSPECIFIED);
    }
    UdpSocket::from_std(s.into())
}

fn bind_sender() -> std::io::Result<Socket> {
    let s = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    s.set_broadcast(true)?;
    s.set_multicast_loop_v4(true)?;
    s.set_multicast_ttl_v4(1)?;
    s.bind(&SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, 0)).into())?;
    Ok(s)
}

impl Discovery {
    /// Start listening (and announcing). `listener` is called with the full peer list
    /// whenever it changes.
    pub async fn start(
        config: DiscoveryConfig,
        info: InstanceInfo,
        listener: Arc<dyn Fn(Vec<Peer>) + Send + Sync>,
    ) -> std::io::Result<Discovery> {
        let socket = bind_listener(config.port)?;
        let sender = bind_sender()?;
        let inner = Arc::new(Inner {
            config,
            info: Mutex::new(info),
            peers: Mutex::new(HashMap::new()),
            listener,
            wake: Notify::new(),
            stop: Default::default(),
            last_reply: Mutex::new(None),
        });
        tracing::info!("LAN discovery on UDP port {}", inner.config.port);

        // Receiver.
        let rx_inner = inner.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; MAX_PACKET];
            loop {
                let r = tokio::select! {
                    _ = rx_inner.stop.cancelled() => break,
                    r = socket.recv_from(&mut buf) => r,
                };
                let (n, from) = match r {
                    Ok(x) => x,
                    Err(e) => {
                        tracing::debug!("discovery recv: {e}");
                        tokio::time::sleep(Duration::from_millis(200)).await;
                        continue;
                    }
                };
                rx_inner.handle(&buf[..n], from.ip());
            }
        });

        // Sender: periodic announcements, queries, expiry.
        let tx_inner = inner.clone();
        tokio::spawn(async move {
            let send = |kind: PacketKind, inner: &Inner| {
                let packet = Packet { magic: MAGIC.into(), kind, info: inner.info.lock().clone() };
                let Ok(data) = serde_json::to_vec(&packet) else { return };
                send_everywhere(&sender, &data, inner.config.port);
            };
            send(PacketKind::Query, &tx_inner);
            if tx_inner.config.announce {
                send(PacketKind::Announce, &tx_inner);
            }
            let mut tick = tokio::time::interval(tx_inner.config.interval);
            tick.tick().await;
            loop {
                tokio::select! {
                    _ = tx_inner.stop.cancelled() => {
                        if tx_inner.config.announce {
                            send(PacketKind::Bye, &tx_inner);
                        }
                        break;
                    }
                    _ = tick.tick() => {
                        if tx_inner.config.announce {
                            send(PacketKind::Announce, &tx_inner);
                        }
                    }
                    _ = tx_inner.wake.notified() => {
                        send(PacketKind::Query, &tx_inner);
                        if tx_inner.config.announce {
                            send(PacketKind::Announce, &tx_inner);
                        }
                    }
                }
                tx_inner.expire();
            }
        });
        Ok(Discovery { inner })
    }

    pub fn port(&self) -> u16 {
        self.inner.config.port
    }

    pub fn info(&self) -> InstanceInfo {
        self.inner.info.lock().clone()
    }

    /// Update what this instance announces (e.g. web server started) and re-announce.
    pub fn set_info(&self, info: InstanceInfo) {
        *self.inner.info.lock() = info;
        self.inner.wake.notify_one();
        self.inner.notify_listener();
    }

    /// Ask everybody to announce now.
    pub fn refresh(&self) {
        self.inner.wake.notify_one();
    }

    /// Current list: this instance first, then peers sorted by name.
    pub fn peers(&self) -> Vec<Peer> {
        self.inner.peer_list()
    }

    /// Add or update a peer found by address (HTTP probe done by the caller).
    pub fn upsert_manual(&self, info: InstanceInfo, address: String, online: bool) {
        {
            let mut peers = self.inner.peers.lock();
            let ip: Option<IpAddr> = address.parse().ok();
            let e = peers.entry(info.id.clone()).or_insert_with(|| Entry {
                info: info.clone(),
                addresses: vec![],
                last_seen: Instant::now(),
                last_seen_ms: now_ms(),
                manual: true,
                manual_online: online,
            });
            e.info = info;
            e.manual = true;
            e.manual_online = online;
            if online {
                e.last_seen = Instant::now();
                e.last_seen_ms = now_ms();
            }
            if let Some(ip) = ip {
                if !e.addresses.contains(&ip) {
                    e.addresses.insert(0, ip);
                }
            }
        }
        self.inner.notify_listener();
    }

    /// Manual peers as `(id, first address, web port, tls)` for periodic probing.
    pub fn manual_peers(&self) -> Vec<(String, String, u16, bool)> {
        self.inner
            .peers
            .lock()
            .values()
            .filter(|e| e.manual)
            .filter_map(|e| {
                let web = e.info.web.as_ref()?;
                Some((e.info.id.clone(), e.addresses.first()?.to_string(), web.port, web.tls))
            })
            .collect()
    }

    pub fn remove(&self, id: &str) {
        self.inner.peers.lock().remove(id);
        self.inner.notify_listener();
    }

    pub fn stop(&self) {
        self.inner.stop.cancel();
    }
}

impl Drop for Discovery {
    fn drop(&mut self) {
        self.inner.stop.cancel();
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn send_everywhere(sender: &Socket, data: &[u8], port: u16) {
    let mut targets: Vec<Ipv4Addr> = vec![Ipv4Addr::BROADCAST];
    let ifaces = ipv4_interfaces();
    for i in &ifaces {
        if let Some(b) = i.broadcast {
            if !targets.contains(&b) {
                targets.push(b);
            }
        }
    }
    for t in targets {
        let addr = SocketAddr::V4(SocketAddrV4::new(t, port));
        if let Err(e) = sender.send_to(data, &addr.into()) {
            tracing::trace!("discovery send to {t}: {e}");
        }
    }
    let group = SocketAddr::V4(SocketAddrV4::new(MULTICAST_GROUP, port));
    let mut sent_mc = false;
    for i in &ifaces {
        if sender.set_multicast_if_v4(&i.ip).is_ok() && sender.send_to(data, &group.into()).is_ok() {
            sent_mc = true;
        }
    }
    if !sent_mc {
        let _ = sender.send_to(data, &group.into());
    }
}

impl Inner {
    fn handle(&self, data: &[u8], from: IpAddr) {
        let Ok(p) = serde_json::from_slice::<Packet>(data) else { return };
        if p.magic != MAGIC || p.info.id.is_empty() || p.info.id.len() > 64 || p.info.name.len() > 256 {
            return;
        }
        let self_id = self.info.lock().id.clone();
        if p.info.id == self_id {
            return;
        }
        match p.kind {
            PacketKind::Query => {
                // Answer at most once per second, regardless of how many queries arrive.
                let mut last = self.last_reply.lock();
                if self.config.announce && last.is_none_or(|t| t.elapsed() > Duration::from_secs(1)) {
                    *last = Some(Instant::now());
                    self.wake.notify_one();
                }
                drop(last);
                self.upsert(p.info, from);
            }
            PacketKind::Announce => self.upsert(p.info, from),
            PacketKind::Bye => {
                let changed = {
                    let mut peers = self.peers.lock();
                    match peers.get(&p.info.id) {
                        Some(e) if e.manual => false,
                        Some(_) => peers.remove(&p.info.id).is_some(),
                        None => false,
                    }
                };
                if changed {
                    self.notify_listener();
                }
            }
        }
    }

    fn upsert(&self, info: InstanceInfo, from: IpAddr) {
        let changed = {
            let mut peers = self.peers.lock();
            let offline_before = self.is_offline_entry(peers.get(&info.id));
            let e = peers.entry(info.id.clone()).or_insert_with(|| Entry {
                info: info.clone(),
                addresses: vec![],
                last_seen: Instant::now(),
                last_seen_ms: now_ms(),
                manual: false,
                manual_online: false,
            });
            let mut changed = offline_before || e.info != info;
            e.info = info;
            e.last_seen = Instant::now();
            e.last_seen_ms = now_ms();
            if e.manual {
                e.manual_online = true;
            }
            if !e.addresses.contains(&from) {
                // Prefer non-loopback addresses for URLs.
                if from.is_loopback() {
                    e.addresses.push(from);
                } else {
                    e.addresses.insert(0, from);
                }
                e.addresses.truncate(8);
                changed = true;
            }
            changed
        };
        if changed {
            self.notify_listener();
        }
    }

    fn timeout(&self) -> Duration {
        self.config.interval * 3 + Duration::from_secs(2)
    }

    fn is_offline_entry(&self, e: Option<&Entry>) -> bool {
        match e {
            None => true,
            Some(e) if e.manual => !e.manual_online,
            Some(e) => e.last_seen.elapsed() > self.timeout(),
        }
    }

    fn expire(&self) {
        let mut changed = false;
        {
            let mut peers = self.peers.lock();
            let timeout = self.timeout();
            peers.retain(|_, e| e.manual || e.last_seen.elapsed() < Duration::from_secs(600));
            for e in peers.values() {
                let el = e.last_seen.elapsed();
                // Report the transition to offline once.
                if !e.manual && el > timeout && el < timeout + self.config.interval {
                    changed = true;
                }
            }
        }
        if changed {
            self.notify_listener();
        }
    }

    fn peer_list(&self) -> Vec<Peer> {
        let me = self.info.lock().clone();
        let mut own_addrs: Vec<String> =
            ipv4_interfaces().into_iter().filter(|i| !i.ip.is_loopback()).map(|i| i.ip.to_string()).collect();
        if own_addrs.is_empty() {
            own_addrs.push("127.0.0.1".into());
        }
        let mut out = vec![Peer::from_info(&me, own_addrs, now_ms(), false, true, true)];
        let peers = self.peers.lock();
        let mut others: Vec<Peer> = peers
            .values()
            .map(|e| {
                let online = !self.is_offline_entry(Some(e));
                Peer::from_info(&e.info, e.addresses.iter().map(|a| a.to_string()).collect(), e.last_seen_ms, e.manual, false, online)
            })
            .collect();
        others.sort_by(|a, b| b.online.cmp(&a.online).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        out.extend(others);
        out
    }

    fn notify_listener(&self) {
        (self.listener)(self.peer_list());
    }
}

/// Listen for `wait` and return the peers found (used by `rcmd discover`).
pub async fn scan(port: u16, wait: Duration) -> std::io::Result<Vec<Peer>> {
    let info = InstanceInfo {
        id: uuid::Uuid::new_v4().to_string(),
        name: "scanner".into(),
        hostname: String::new(),
        version: String::new(),
        os: String::new(),
        user: None,
        web: None,
    };
    let d = Discovery::start(DiscoveryConfig { port, interval: Duration::from_secs(1), announce: false }, info, Arc::new(|_| {})).await?;
    tokio::time::sleep(wait).await;
    let peers = d.peers().into_iter().filter(|p| !p.is_self).collect();
    d.stop();
    Ok(peers)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(id: &str, name: &str) -> InstanceInfo {
        InstanceInfo {
            id: id.into(),
            name: name.into(),
            hostname: "host".into(),
            version: "0.1.0".into(),
            os: "linux".into(),
            user: None,
            web: Some(WebInfo { port: 8822, tls: true, fingerprint: Some("ab:cd".into()) }),
        }
    }

    #[tokio::test]
    async fn two_instances_find_each_other() {
        // Random high port so parallel test runs don't interfere.
        let port = 40000 + (std::process::id() % 20000) as u16;
        let cfg = DiscoveryConfig { port, interval: Duration::from_millis(300), announce: true };
        let a = Discovery::start(cfg.clone(), info("a", "Alpha"), Arc::new(|_| {})).await.unwrap();
        let b = Discovery::start(cfg.clone(), info("b", "Beta"), Arc::new(|_| {})).await.unwrap();
        let mut found = false;
        for _ in 0..40 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let pa = a.peers();
            let pb = b.peers();
            if pa.iter().any(|p| p.id == "b" && p.online) && pb.iter().any(|p| p.id == "a" && p.online) {
                found = true;
                let beta = pa.iter().find(|p| p.id == "b").unwrap();
                assert!(beta.web.as_ref().unwrap().url.starts_with("https://"));
                assert!(pa[0].is_self);
                break;
            }
        }
        assert!(found, "instances did not discover each other: {:?}", a.peers());
        // Goodbye removes the peer.
        b.stop();
        let mut gone = false;
        for _ in 0..30 {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if !a.peers().iter().any(|p| p.id == "b") {
                gone = true;
                break;
            }
        }
        assert!(gone);
    }
}
