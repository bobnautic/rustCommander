//! FTP / FTPS integration tests against real servers. Skipped unless configured:
//!
//! * `RC_TEST_FTP_URL=ftp://user:pass@127.0.0.1:2121` — plain FTP
//! * `RC_TEST_FTPES_URL=ftpes://user:pass@127.0.0.1:2122` — explicit FTPS (self-signed cert)
//! * `RC_TEST_FTPS_URL=ftps://user:pass@127.0.0.1:2990` — implicit FTPS (self-signed cert)
//! * `RC_TEST_FTP_LIMITED_URL=ftp://user:pass@127.0.0.1:2124` — server allowing only 2
//!   connections per client and closing idle connections after 3 s
//!
//! Servers (pyftpdlib, `pip install pyftpdlib pyopenssl`, self-signed `combined.pem`):
//!
//! ```text
//! openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 30 -subj /CN=localhost
//! cat cert.pem key.pem > combined.pem
//! python3 tests/servers/ftp_server.py /tmp/ftp/plain plain 2121
//! python3 tests/servers/ftp_server.py /tmp/ftp/explicit explicit 2122 combined.pem
//! python3 tests/servers/ftp_server.py /tmp/ftp/implicit implicit 2990 combined.pem
//! python3 tests/servers/ftp_server.py /tmp/ftp/limited plain 2124 - 2 3
//! ```

#![cfg(feature = "ftp")]

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::*;
use rc_core::prompt::HostKeyState;
use rc_core::protocols::ftp::FtpVfs;
use rc_core::{Error, FileKind, KnownHosts, SiteConfig, Vfs};

fn site(var: &str) -> Option<SiteConfig> {
    init_tracing();
    let url = std::env::var(var).ok().filter(|u| !u.is_empty())?;
    let (mut site, _) = SiteConfig::from_url(&url).unwrap_or_else(|| panic!("invalid {var}"));
    site.timeout_secs = 10;
    Some(site)
}

macro_rules! require {
    ($var:expr) => {
        match site($var) {
            Some(s) => s,
            None => {
                eprintln!("skipped: {} not set", $var);
                return;
            }
        }
    };
}

async fn connect(site: &SiteConfig) -> Arc<dyn Vfs> {
    rc_core::connect(site, &accept_all()).await.unwrap_or_else(|e| panic!("connect {}: {e}", site.display_name()))
}

fn base(vfs_home: &str) -> String {
    rc_core::path::join(vfs_home, &unique("rc-test"))
}

/// Keep `n` downloads open at the same time (one pooled connection each), then list.
async fn hold_connections(vfs: &Arc<dyn Vfs>, n: usize) {
    let home = vfs.home().await.expect("home");
    let file = rc_core::path::join(&home, &unique("rc-hold"));
    put(&**vfs, &file, &data(200_000, 9)).await;
    let mut readers = Vec::new();
    for _ in 0..n {
        let mut r = vfs.open_read(&file, 0).await.expect("open_read");
        let mut buf = [0u8; 1024];
        r.read(&mut buf).await.expect("read");
        readers.push(r);
    }
    vfs.list(&home).await.expect("list while downloads are open");
    drop(readers);
    vfs.remove_file(&file).await.expect("remove");
}

async fn full_suite(site: SiteConfig) {
    let vfs = connect(&site).await;
    let home = vfs.home().await.expect("home");
    let caps = vfs.capabilities();
    file_suite(
        &*vfs,
        &base(&home),
        &SuiteOptions {
            big_size: 5 * 1024 * 1024 + 17,
            resume_read: true,
            resume_write: Some(true),
            set_modified: caps.set_modified,
            permissions: caps.permissions,
            exact_list_mtime: true,
        },
    )
    .await;
    concurrency_suite(&vfs, &base(&home)).await;

    // FTP specific error mapping
    let dir = base(&home);
    vfs.mkdir(&dir).await.expect("mkdir");
    assert!(matches!(vfs.mkdir(&dir).await, Err(Error::AlreadyExists(_))), "mkdir existing");
    common::put(&*vfs, &format!("{dir}/f"), b"x").await;
    assert!(matches!(vfs.remove_dir(&dir).await, Err(Error::DirectoryNotEmpty(_))), "rmdir non-empty");
    vfs.mkdir_all(&format!("{dir}/a/b/c")).await.expect("mkdir_all");
    assert_eq!(vfs.stat(&format!("{dir}/a/b/c")).await.expect("stat").kind, FileKind::Dir);
    assert_eq!(vfs.canonicalize(&format!("{dir}/a/b/../b/c/..")).await.expect("canonicalize"), format!("{dir}/a/b"));
    vfs.remove_dir_all(&dir).await.expect("cleanup");

    let info = vfs.session_info();
    let get = |k: &str| info.items.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
    assert!(get("Protocol").is_some() && get("System").is_some(), "{info:?}");
    vfs.close().await.expect("close");
    assert!(vfs.list(&home).await.is_err(), "closed session must not reconnect");
}

#[tokio::test]
async fn ftp_plain() {
    let site = require!("RC_TEST_FTP_URL");
    full_suite(site).await;
}

#[tokio::test]
async fn ftp_list_fallback_and_active_mode() {
    let mut site = require!("RC_TEST_FTP_URL");
    site.ftp.use_mlsd = false;
    site.ftp.passive = false;
    let vfs = connect(&site).await;
    let home = vfs.home().await.expect("home");
    let caps = vfs.capabilities();
    file_suite(
        &*vfs,
        &base(&home),
        &SuiteOptions {
            big_size: 2 * 1024 * 1024,
            resume_read: true,
            resume_write: Some(true),
            set_modified: caps.set_modified,
            permissions: caps.permissions,
            exact_list_mtime: false,
        },
    )
    .await;
    let info = vfs.session_info();
    assert!(info.items.iter().any(|(k, v)| k == "Directory listing" && v == "LIST"), "{info:?}");

    // Symlinks in `ls -l` output (needs the server's directory: RC_TEST_FTP_LOCAL_ROOT).
    #[cfg(unix)]
    if let Ok(local) = std::env::var("RC_TEST_FTP_LOCAL_ROOT") {
        let name = unique("links");
        let dir = std::path::Path::new(&local).join(&name);
        std::fs::create_dir_all(dir.join("target dir")).expect("local mkdir");
        std::fs::write(dir.join("target.txt"), b"0123456789").expect("local write");
        std::os::unix::fs::symlink("target dir", dir.join("dir link")).expect("symlink");
        std::os::unix::fs::symlink("target.txt", dir.join("file link")).expect("symlink");
        let listed = vfs.list(&rc_core::path::join(&home, &name)).await.expect("list links");
        let get = |n: &str| listed.iter().find(|e| e.name == n).unwrap_or_else(|| panic!("{n} in {listed:?}")).clone();
        let d = get("dir link");
        assert_eq!(
            (d.kind, d.target_kind, d.link_target.as_deref()),
            (FileKind::Symlink, Some(FileKind::Dir), Some("target dir"))
        );
        assert!(d.is_dir());
        let f = get("file link");
        assert_eq!((f.kind, f.target_kind, f.size), (FileKind::Symlink, Some(FileKind::File), 10));
        std::fs::remove_dir_all(dir).expect("cleanup");
    }
}

#[tokio::test]
async fn ftpes_explicit() {
    let site = require!("RC_TEST_FTPES_URL");
    full_suite(site).await;
}

#[tokio::test]
async fn ftps_implicit() {
    let site = require!("RC_TEST_FTPS_URL");
    full_suite(site).await;
}

/// Trust on first use: one prompt per connect (not per pooled connection), remembered
/// certificates are not asked again, changed certificates are reported as such.
async fn certificate_flow(site: SiteConfig) {
    let known = Arc::new(KnownHosts::in_memory());

    // Rejected -> HostKeyRejected
    let reject = Arc::new(TestPrompter::default());
    let r = rc_core::connect(&site, &context(reject.clone(), known.clone())).await;
    assert!(matches!(r, Err(Error::HostKeyRejected(_))), "{:?}", r.err());
    assert_eq!(reject.cert_prompts(), 1);
    assert_eq!(reject.certs.lock()[0].0, HostKeyState::New);

    // Accepted for this session only: asked once although several connections are opened
    let once = TestPrompter::accepting();
    let vfs = rc_core::connect(&site, &context(once.clone(), known.clone())).await.expect("connect");
    let home = vfs.home().await.expect("home");
    hold_connections(&vfs, 3).await;
    assert_eq!(once.cert_prompts(), 1, "one prompt per session");
    assert!(known.list().is_empty(), "not remembered");
    vfs.close().await.expect("close");

    // Accepted and remembered -> no prompt next time
    let remember = Arc::new(TestPrompter { accept_certs: true, remember: true, ..Default::default() });
    let vfs = rc_core::connect(&site, &context(remember.clone(), known.clone())).await.expect("connect");
    vfs.close().await.expect("close");
    assert_eq!(remember.cert_prompts(), 1);
    assert_eq!(known.list().len(), 1);
    let fingerprint = remember.certs.lock()[0].1.clone();
    assert_eq!(known.list()[0].fingerprint, fingerprint);
    let quiet = TestPrompter::accepting();
    let vfs = rc_core::connect(&site, &context(quiet.clone(), known.clone())).await.expect("connect");
    vfs.list(&home).await.expect("list");
    assert_eq!(quiet.cert_prompts(), 0, "remembered certificate");
    vfs.close().await.expect("close");

    // A different stored certificate -> "changed" prompt; never accepted silently
    let changed = Arc::new(KnownHosts::in_memory());
    let key = KnownHosts::tls_key(&site.host, site.effective_port());
    changed.add(&key, "x509", &"0".repeat(64), "").expect("add");
    let mut tofu_site = site.clone();
    tofu_site.ftp.allow_invalid_certs = true;
    let reject = Arc::new(TestPrompter::default());
    let r = rc_core::connect(&tofu_site, &context(reject.clone(), changed.clone())).await;
    assert!(matches!(r, Err(Error::HostKeyRejected(_))));
    assert_eq!(reject.certs.lock()[0].0, HostKeyState::Changed);

    // allow_invalid_certs = TOFU: an accepted new certificate is stored right away
    let fresh = Arc::new(KnownHosts::in_memory());
    let accept = TestPrompter::accepting();
    let vfs = rc_core::connect(&tofu_site, &context(accept.clone(), fresh.clone())).await.expect("connect");
    vfs.close().await.expect("close");
    assert_eq!(fresh.list().len(), 1, "TOFU stores the certificate");
    let info = vfs.session_info();
    assert!(info.items.iter().any(|(k, v)| k == "Certificate SHA-256" && *v == fingerprint), "{info:?}");
}

#[tokio::test]
async fn ftpes_certificate_tofu() {
    let site = require!("RC_TEST_FTPES_URL");
    certificate_flow(site).await;
}

#[tokio::test]
async fn ftps_implicit_certificate_tofu() {
    let site = require!("RC_TEST_FTPS_URL");
    certificate_flow(site).await;
}

#[tokio::test]
async fn ftp_password_prompt() {
    let mut site = require!("RC_TEST_FTP_URL");
    let password = site.password.take();
    let prompter = Arc::new(TestPrompter { password: password.clone(), ..Default::default() });
    let vfs = rc_core::connect(&site, &context(prompter.clone(), Arc::new(KnownHosts::in_memory())))
        .await
        .expect("connect with prompted password");
    // more pooled connections must reuse the password
    hold_connections(&vfs, 3).await;
    assert_eq!(prompter.password_prompts(), 1);

    site.password = Some("wrong".into());
    let r = rc_core::connect(&site, &accept_all()).await;
    assert!(matches!(r, Err(Error::AuthFailed(_))), "{:?}", r.err());
}

#[tokio::test]
async fn ftp_connection_limit_and_reconnect() {
    let mut site = require!("RC_TEST_FTP_LIMITED_URL");
    site.ftp.max_connections = 5;
    site.keepalive_secs = 0;
    let vfs = connect(&site).await;
    let home = vfs.home().await.expect("home");
    let dir = base(&home);
    vfs.mkdir(&dir).await.expect("mkdir");
    // more parallel transfers than the server allows: the pool adapts
    let tasks: Vec<_> = (0..6u64)
        .map(|i| {
            let vfs = vfs.clone();
            let path = format!("{dir}/f{i}");
            tokio::spawn(async move {
                let d = data(300_000, i);
                put(&*vfs, &path, &d).await;
                assert_same(&read(&*vfs, &path, 0).await, &d, "roundtrip");
            })
        })
        .collect();
    for t in tasks {
        t.await.expect("task");
    }
    assert_eq!(vfs.list(&dir).await.expect("list").len(), 6);
    // the server drops idle connections; the next operations reconnect transparently
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert_eq!(vfs.list(&dir).await.expect("list after idle timeout").len(), 6);
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert_eq!(read(&*vfs, &format!("{dir}/f1"), 0).await, data(300_000, 1));
    tokio::time::sleep(Duration::from_secs(5)).await;
    put(&*vfs, &format!("{dir}/late"), b"late").await;
    vfs.remove_dir_all(&dir).await.expect("cleanup");
}

/// Control and (passive) data connections through a SOCKS5 proxy
/// (`RC_TEST_SOCKS5_PROXY=127.0.0.1:1080`, see `tests/servers/socks5_proxy.py`).
#[tokio::test]
async fn ftp_via_socks5_proxy() {
    let Some(proxy) = std::env::var("RC_TEST_SOCKS5_PROXY").ok() else {
        eprintln!("skipped: RC_TEST_SOCKS5_PROXY not set");
        return;
    };
    let (phost, pport) = proxy.rsplit_once(':').expect("host:port");
    for var in ["RC_TEST_FTP_URL", "RC_TEST_FTPS_URL"] {
        let Some(mut site) = site(var) else { continue };
        site.proxy.kind = rc_core::site::ProxyKind::Socks5;
        site.proxy.host = phost.to_string();
        site.proxy.port = pport.parse().expect("port");
        let vfs = connect(&site).await;
        let home = vfs.home().await.expect("home");
        let dir = base(&home);
        vfs.mkdir(&dir).await.expect("mkdir");
        let d = data(1_500_000, 5);
        put(&*vfs, &format!("{dir}/f"), &d).await;
        assert_same(&read(&*vfs, &format!("{dir}/f"), 0).await, &d, &format!("{var} via proxy"));
        assert_eq!(vfs.list(&dir).await.expect("list").len(), 1);
        hold_connections(&vfs, 2).await;
        vfs.remove_dir_all(&dir).await.expect("cleanup");
    }
}

#[tokio::test]
async fn ftp_direct_api() {
    let site = require!("RC_TEST_FTP_URL");
    let vfs = FtpVfs::connect(&site, &accept_all()).await.expect("connect");
    assert_eq!(vfs.protocol(), rc_core::Protocol::Ftp);
    vfs.ping().await.expect("ping");
    let entries = vfs.list("/").await.expect("list /");
    assert!(entries.iter().all(|e| e.name != "." && e.name != ".."));
    assert_eq!(vfs.stat("/").await.expect("stat /").kind, FileKind::Dir);
}
