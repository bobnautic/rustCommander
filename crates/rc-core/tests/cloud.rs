//! WebDAV / S3 / Azure / GCS integration tests against real servers. Skipped unless
//! configured:
//!
//! * `RC_TEST_WEBDAV_URL=dav://user:pass@127.0.0.1:8081/dav` (path = WebDAV root)
//! * `RC_TEST_WEBDAVS_URL=davs://user:pass@localhost:8443/dav` (self-signed certificate)
//! * `RC_TEST_S3_ENDPOINT=http://127.0.0.1:5000` plus optional `RC_TEST_S3_ACCESS_KEY`,
//!   `RC_TEST_S3_SECRET_KEY` (default `test`), `RC_TEST_S3_REGION` (`us-east-1`) and
//!   `RC_TEST_S3_BUCKET` (`rc-test`; created with an unsigned `PUT` if missing, which
//!   works on moto)
//! * `RC_TEST_AZURE_ENDPOINT=http://127.0.0.1:10000/devstoreaccount1` plus optional
//!   `RC_TEST_AZURE_ACCOUNT` / `RC_TEST_AZURE_KEY` (Azurite defaults) and
//!   `RC_TEST_AZURE_CONTAINER` (`rc-test`, must exist)
//! * `RC_TEST_GCS_BUCKET` (+ `RC_TEST_GCS_ENDPOINT`, `RC_TEST_GCS_CREDENTIAL_FILE`)
//!
//! Servers:
//!
//! ```text
//! pip install wsgidav cheroot jinja2 "moto[server]"
//! python3 tests/servers/webdav_server.py /tmp/dav/http 8081
//! python3 tests/servers/webdav_server.py /tmp/dav/https 8443 cert.pem key.pem
//! moto_server -H 127.0.0.1 -p 5000
//! npx azurite-blob --blobHost 127.0.0.1 --blobPort 10000 --location /tmp/azurite --skipApiVersionCheck
//! ```

#![cfg(feature = "cloud")]

mod common;

use std::sync::Arc;

use common::*;
use rc_core::prompt::HostKeyState;
use rc_core::{Error, FileKind, KnownHosts, Protocol, SiteConfig, Vfs, WriteOptions};

fn env(var: &str) -> Option<String> {
    init_tracing();
    let _ = rustls::crypto::ring::default_provider().install_default();
    std::env::var(var).ok().filter(|v| !v.is_empty())
}

fn env_or(var: &str, default: &str) -> String {
    env(var).unwrap_or_else(|| default.to_string())
}

macro_rules! require {
    ($e:expr, $var:expr) => {
        match $e {
            Some(s) => s,
            None => {
                eprintln!("skipped: {} not set", $var);
                return;
            }
        }
    };
}

fn dav_site(var: &str) -> Option<SiteConfig> {
    let url = env(var)?;
    let (mut site, path) = SiteConfig::from_url(&url).unwrap_or_else(|| panic!("invalid {var}"));
    site.webdav.root = if path.is_empty() { "/".into() } else { path };
    site.timeout_secs = 10;
    Some(site)
}

fn s3_site(bucket: Option<&str>) -> Option<SiteConfig> {
    let endpoint = env("RC_TEST_S3_ENDPOINT")?;
    let mut site = SiteConfig { protocol: Protocol::S3, timeout_secs: 10, ..Default::default() };
    site.username = env_or("RC_TEST_S3_ACCESS_KEY", "test");
    site.password = Some(env_or("RC_TEST_S3_SECRET_KEY", "test"));
    site.s3.endpoint = endpoint;
    site.s3.region = env_or("RC_TEST_S3_REGION", "us-east-1");
    site.s3.path_style = true;
    site.s3.bucket = bucket.unwrap_or_default().to_string();
    Some(site)
}

/// Create a bucket on moto-like servers that accept unsigned requests.
async fn ensure_bucket(endpoint: &str, bucket: &str) {
    let url = format!("{}/{bucket}", endpoint.trim_end_matches('/'));
    let _ = reqwest::Client::new().put(url).send().await;
}

async fn connect(site: &SiteConfig) -> Arc<dyn Vfs> {
    rc_core::connect(site, &accept_all()).await.unwrap_or_else(|e| panic!("connect {}: {e}", site.display_name()))
}

fn options(big_size: usize) -> SuiteOptions {
    SuiteOptions {
        big_size,
        resume_read: true,
        resume_write: Some(false),
        set_modified: false,
        permissions: false,
        exact_list_mtime: true,
    }
}

/// Directory rename, server-side copy and implicit parent directories.
async fn tree_operations(vfs: &dyn Vfs, base: &str) {
    vfs.mkdir(base).await.expect("mkdir");
    assert!(matches!(vfs.mkdir(base).await, Err(Error::AlreadyExists(_))), "mkdir existing");
    let src = format!("{base}/src");
    vfs.mkdir(&src).await.expect("mkdir src");
    vfs.mkdir(&format!("{src}/empty")).await.expect("mkdir empty");
    put(vfs, &format!("{src}/a.txt"), b"a").await;
    vfs.mkdir(&format!("{src}/deep")).await.expect("mkdir deep");
    put(vfs, &format!("{src}/deep/b.txt"), b"bb").await;

    vfs.copy_file(&format!("{src}/a.txt"), &format!("{base}/copy.txt")).await.expect("copy_file");
    assert_eq!(read(vfs, &format!("{base}/copy.txt"), 0).await, b"a");

    let dst = format!("{base}/dst");
    vfs.rename(&src, &dst).await.expect("rename dir");
    assert!(vfs.try_stat(&src).await.expect("try_stat").is_none(), "old dir gone");
    assert_eq!(read(vfs, &format!("{dst}/deep/b.txt"), 0).await, b"bb");
    assert_eq!(vfs.stat(&format!("{dst}/empty")).await.expect("stat empty dir").kind, FileKind::Dir);
    let mut names: Vec<String> = vfs.list(&dst).await.expect("list dst").into_iter().map(|e| e.name).collect();
    names.sort();
    assert_eq!(names, ["a.txt", "deep", "empty"]);

    assert!(matches!(vfs.remove_dir(&dst).await, Err(Error::DirectoryNotEmpty(_))), "rmdir non-empty");
    assert!(matches!(vfs.remove_file(&dst).await, Err(Error::IsADirectory(_))), "remove_file on dir");
    assert!(matches!(vfs.list(&format!("{base}/copy.txt")).await, Err(Error::NotADirectory(_) | Error::NotFound(_))));
    vfs.remove_dir(&format!("{dst}/empty")).await.expect("rmdir empty");
    vfs.remove_dir_all(base).await.expect("remove_dir_all");
    assert!(vfs.try_stat(base).await.expect("try_stat").is_none());
}

#[tokio::test]
async fn webdav() {
    let site = require!(dav_site("RC_TEST_WEBDAV_URL"), "RC_TEST_WEBDAV_URL");
    let vfs = connect(&site).await;
    assert_eq!(vfs.home().await.expect("home"), "/");
    file_suite(&*vfs, &format!("/{}", unique("rc-test")), &options(5 * 1024 * 1024 + 17)).await;
    concurrency_suite(&vfs, &format!("/{}", unique("rc-test"))).await;
    tree_operations(&*vfs, &format!("/{}", unique("rc-test"))).await;
    // upload without size hint (chunked transfer encoding)
    let p = format!("/{}", unique("chunked"));
    write(&*vfs, &p, &data(300_000, 4), WriteOptions::default()).await;
    assert_eq!(read(&*vfs, &p, 0).await, data(300_000, 4));
    vfs.remove_file(&p).await.expect("remove");
    let info = vfs.session_info();
    assert!(info.items.iter().any(|(k, v)| k == "Protocol" && v == "WebDAV"), "{info:?}");

    let mut wrong = site.clone();
    wrong.password = Some("wrong".into());
    let r = rc_core::connect(&wrong, &accept_all()).await;
    assert!(matches!(r, Err(Error::AuthFailed(_))), "{:?}", r.err());
}

#[tokio::test]
async fn webdav_https_certificate_tofu() {
    let site = require!(dav_site("RC_TEST_WEBDAVS_URL"), "RC_TEST_WEBDAVS_URL");
    let known = Arc::new(KnownHosts::in_memory());

    let reject = Arc::new(TestPrompter::default());
    let r = rc_core::connect(&site, &context(reject.clone(), known.clone())).await;
    assert!(matches!(r, Err(Error::HostKeyRejected(_))), "{:?}", r.err());
    assert_eq!(reject.cert_prompts(), 1);
    assert_eq!(reject.certs.lock()[0].0, HostKeyState::New);

    let accept = TestPrompter::accepting();
    let vfs = rc_core::connect(&site, &context(accept.clone(), known.clone())).await.expect("connect");
    let base = format!("/{}", unique("rc-test"));
    vfs.mkdir(&base).await.expect("mkdir");
    put(&*vfs, &format!("{base}/x"), &data(100_000, 2)).await;
    assert_eq!(read(&*vfs, &format!("{base}/x"), 0).await, data(100_000, 2));
    vfs.remove_dir_all(&base).await.expect("cleanup");
    assert_eq!(accept.cert_prompts(), 1, "asked once per session");
    assert!(known.list().is_empty());
    let info = vfs.session_info();
    assert!(info.items.iter().any(|(k, v)| k == "Certificate trust" && v == "accepted by the user"), "{info:?}");

    // allow_invalid_certs: trust on first use stores the certificate
    let mut tofu = site.clone();
    tofu.webdav.allow_invalid_certs = true;
    let accept = TestPrompter::accepting();
    rc_core::connect(&tofu, &context(accept.clone(), known.clone())).await.expect("connect");
    assert_eq!(known.list().len(), 1);
    let quiet = TestPrompter::accepting();
    rc_core::connect(&site, &context(quiet.clone(), known.clone())).await.expect("connect");
    assert_eq!(quiet.cert_prompts(), 0, "remembered certificate");
}

#[tokio::test]
async fn s3_bucket() {
    let bucket = env_or("RC_TEST_S3_BUCKET", "rc-test");
    let site = require!(s3_site(Some(&bucket)), "RC_TEST_S3_ENDPOINT");
    ensure_bucket(&site.s3.endpoint, &bucket).await;
    let vfs = connect(&site).await;
    file_suite(&*vfs, &format!("/{}", unique("rc-test")), &options(12 * 1024 * 1024 + 5)).await;
    concurrency_suite(&vfs, &format!("/{}", unique("rc-test"))).await;
    tree_operations(&*vfs, &format!("/{}", unique("rc-test"))).await;

    // implicit directories (prefixes without marker objects)
    let base = format!("/{}", unique("implicit"));
    put(&*vfs, &format!("{base}/x/y/z.txt"), b"z").await;
    let listed = vfs.list(&base).await.expect("list implicit");
    assert_eq!(listed.len(), 1);
    assert_eq!((listed[0].name.as_str(), listed[0].kind), ("x", FileKind::Dir));
    assert_eq!(vfs.stat(&format!("{base}/x/y")).await.expect("stat implicit").kind, FileKind::Dir);
    assert!(matches!(vfs.list(&format!("{base}/nope")).await, Err(Error::NotFound(_))));
    vfs.remove_dir_all(&base).await.expect("cleanup");
    assert!(vfs.try_stat(&base).await.expect("try_stat").is_none());

    let caps = vfs.capabilities();
    assert!(caps.server_copy && caps.resume_download && !caps.resume_upload);
    let info = vfs.session_info();
    assert!(info.items.iter().any(|(k, v)| k == "Bucket" && *v == bucket), "{info:?}");
}

#[tokio::test]
async fn s3_bucket_list_at_root() {
    let site = require!(s3_site(None), "RC_TEST_S3_ENDPOINT");
    let buckets = [unique("rc-a"), unique("rc-b")];
    for b in &buckets {
        ensure_bucket(&site.s3.endpoint, b).await;
    }
    let vfs = connect(&site).await;
    let root = vfs.list("/").await.expect("list buckets");
    for b in &buckets {
        let e = root.iter().find(|e| &e.name == b).unwrap_or_else(|| panic!("bucket {b} listed: {root:?}"));
        assert_eq!(e.kind, FileKind::Dir);
        assert_eq!(e.path, format!("/{b}"));
    }
    assert_eq!(vfs.stat("/").await.expect("stat /").kind, FileKind::Dir);
    let b0 = format!("/{}", buckets[0]);
    assert_eq!(vfs.stat(&b0).await.expect("stat bucket").kind, FileKind::Dir);
    let missing = vfs.stat(&format!("/{}", unique("missing"))).await;
    assert!(matches!(missing, Err(Error::NotFound(_))), "{missing:?}");
    assert!(matches!(vfs.mkdir(&format!("/{}", unique("new"))).await, Err(Error::Unsupported(_))));

    put(&*vfs, &format!("{b0}/dir/file.txt"), b"in bucket").await;
    assert_eq!(read(&*vfs, &format!("{b0}/dir/file.txt"), 0).await, b"in bucket");
    let listed = vfs.list(&b0).await.expect("list bucket");
    assert_eq!(listed.len(), 1);
    assert_eq!((listed[0].path.as_str(), listed[0].kind), (format!("{b0}/dir").as_str(), FileKind::Dir));
    let b1 = format!("/{}", buckets[1]);
    assert!(matches!(
        vfs.rename(&format!("{b0}/dir/file.txt"), &format!("{b1}/file.txt")).await,
        Err(Error::Unsupported(_))
    ));
    vfs.rename(&format!("{b0}/dir/file.txt"), &format!("{b0}/file.txt")).await.expect("rename in bucket");
    file_suite(&*vfs, &format!("{b1}/{}", unique("suite")), &options(1024 * 1024)).await;
    vfs.remove_file(&format!("{b0}/file.txt")).await.expect("remove");
    assert!(vfs.list(&b0).await.expect("list").is_empty());
}

#[tokio::test]
async fn s3_wrong_credentials() {
    let mut site = require!(s3_site(None), "RC_TEST_S3_ENDPOINT");
    site.password = None;
    // A cancelled secret key prompt aborts the connection.
    let r = rc_core::connect(&site, &accept_all()).await;
    assert!(matches!(r, Err(Error::Cancelled)), "{:?}", r.err());
    // anonymous access needs a bucket
    site.s3.anonymous = true;
    let r = rc_core::connect(&site, &accept_all()).await;
    assert!(matches!(r, Err(Error::InvalidInput(_))), "{:?}", r.err());
}

/// HTTP backends through a SOCKS5 proxy (`RC_TEST_SOCKS5_PROXY=127.0.0.1:1080`).
#[tokio::test]
async fn cloud_via_socks5_proxy() {
    let proxy = require!(env("RC_TEST_SOCKS5_PROXY"), "RC_TEST_SOCKS5_PROXY");
    let (phost, pport) = proxy.rsplit_once(':').expect("host:port");
    let bucket = env_or("RC_TEST_S3_BUCKET", "rc-test");
    let sites = [dav_site("RC_TEST_WEBDAV_URL"), s3_site(Some(&bucket))];
    for mut site in sites.into_iter().flatten() {
        site.proxy.kind = rc_core::site::ProxyKind::Socks5;
        site.proxy.host = phost.to_string();
        site.proxy.port = pport.parse().expect("port");
        let vfs = connect(&site).await;
        let base = format!("/{}", unique("proxied"));
        vfs.mkdir(&base).await.expect("mkdir");
        put(&*vfs, &format!("{base}/f"), &data(700_000, 3)).await;
        assert_eq!(read(&*vfs, &format!("{base}/f"), 0).await, data(700_000, 3));
        assert_eq!(vfs.list(&base).await.expect("list").len(), 1);
        vfs.remove_dir_all(&base).await.expect("cleanup");
    }
}

#[tokio::test]
async fn azure_blob() {
    let endpoint = require!(env("RC_TEST_AZURE_ENDPOINT"), "RC_TEST_AZURE_ENDPOINT");
    let mut site = SiteConfig { protocol: Protocol::Azure, timeout_secs: 10, ..Default::default() };
    site.azure.endpoint = endpoint;
    site.azure.account = env_or("RC_TEST_AZURE_ACCOUNT", "devstoreaccount1");
    site.azure.container = env_or("RC_TEST_AZURE_CONTAINER", "rc-test");
    site.password = Some(env_or(
        "RC_TEST_AZURE_KEY",
        "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==",
    ));
    let vfs = connect(&site).await;
    file_suite(&*vfs, &format!("/{}", unique("rc-test")), &options(9 * 1024 * 1024)).await;
    concurrency_suite(&vfs, &format!("/{}", unique("rc-test"))).await;
    tree_operations(&*vfs, &format!("/{}", unique("rc-test"))).await;
}

#[tokio::test]
async fn gcs() {
    let bucket = require!(env("RC_TEST_GCS_BUCKET"), "RC_TEST_GCS_BUCKET");
    let mut site = SiteConfig { protocol: Protocol::Gcs, timeout_secs: 20, ..Default::default() };
    site.gcs.bucket = bucket;
    site.gcs.endpoint = env_or("RC_TEST_GCS_ENDPOINT", "");
    site.gcs.credential_json =
        env("RC_TEST_GCS_CREDENTIAL_FILE").map(|f| std::fs::read_to_string(f).expect("credential file"));
    let vfs = connect(&site).await;
    file_suite(&*vfs, &format!("/{}", unique("rc-test")), &options(9 * 1024 * 1024)).await;
}
