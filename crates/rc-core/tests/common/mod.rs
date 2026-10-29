//! Helpers shared by the protocol integration tests.

#![allow(dead_code)]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex;
use rc_core::prompt::{HostKeyState, PromptRequest, PromptResponse, Prompter};
use rc_core::{ConnectContext, Error, FileKind, KnownHosts, Vfs, WriteOptions};

/// Records prompts and answers them as configured.
#[derive(Default)]
pub struct TestPrompter {
    pub accept_certs: bool,
    pub remember: bool,
    pub password: Option<String>,
    pub certs: Mutex<Vec<(HostKeyState, String)>>,
    pub passwords: AtomicUsize,
}

impl TestPrompter {
    pub fn accepting() -> Arc<Self> {
        Arc::new(TestPrompter { accept_certs: true, ..Default::default() })
    }

    pub fn cert_prompts(&self) -> usize {
        self.certs.lock().len()
    }

    pub fn password_prompts(&self) -> usize {
        self.passwords.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl Prompter for TestPrompter {
    async fn prompt(&self, req: PromptRequest) -> Option<PromptResponse> {
        match req {
            PromptRequest::Certificate { state, fingerprint, .. } => {
                self.certs.lock().push((state, fingerprint));
                Some(PromptResponse { accepted: self.accept_certs, remember: self.remember, values: vec![] })
            }
            PromptRequest::Password { .. } => {
                self.passwords.fetch_add(1, Ordering::SeqCst);
                self.password.clone().map(|p| PromptResponse { accepted: true, values: vec![p], remember: false })
            }
            _ => None,
        }
    }
}

pub fn context(prompter: Arc<dyn Prompter>, known_hosts: Arc<KnownHosts>) -> ConnectContext {
    let mut ctx = ConnectContext::new(prompter, known_hosts);
    ctx.session_id = "test".into();
    ctx
}

pub fn accept_all() -> ConnectContext {
    context(Arc::new(rc_core::prompt::AcceptAllPrompter), Arc::new(KnownHosts::in_memory()))
}

/// Log to stderr according to `RUST_LOG` (e.g. `RUST_LOG=rc_core=debug,suppaftp=debug`).
pub fn init_tracing() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_test_writer()
        .try_init();
}

pub fn unique(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4().simple())
}

/// Deterministic pseudo-random content.
pub fn data(len: usize, seed: u64) -> Vec<u8> {
    let mut x = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407) | 1;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            (x >> 24) as u8
        })
        .collect()
}

/// Compare contents, reporting sizes and the first differing offset.
#[track_caller]
pub fn assert_same(got: &[u8], expected: &[u8], what: &str) {
    if got != expected {
        let first = got.iter().zip(expected).position(|(a, b)| a != b).unwrap_or(got.len().min(expected.len()));
        panic!("{what}: got {} bytes, expected {}, first difference at {first}", got.len(), expected.len());
    }
}

pub async fn write(vfs: &dyn Vfs, path: &str, content: &[u8], opts: WriteOptions) {
    let mut w = vfs.open_write(path, opts).await.unwrap_or_else(|e| panic!("open_write {path}: {e}"));
    for chunk in content.chunks(256 * 1024) {
        w.write_all(chunk).await.unwrap_or_else(|e| panic!("write {path}: {e}"));
    }
    w.finish().await.unwrap_or_else(|e| panic!("finish {path}: {e}"));
}

pub async fn put(vfs: &dyn Vfs, path: &str, content: &[u8]) {
    write(vfs, path, content, WriteOptions { size_hint: Some(content.len() as u64), ..Default::default() }).await
}

pub async fn read(vfs: &dyn Vfs, path: &str, offset: u64) -> Vec<u8> {
    let mut r = vfs.open_read(path, offset).await.unwrap_or_else(|e| panic!("open_read {path}: {e}"));
    let mut out = Vec::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = r.read(&mut buf).await.unwrap_or_else(|e| panic!("read {path}: {e}"));
        if n == 0 {
            break;
        }
        out.extend_from_slice(&buf[..n]);
    }
    out
}

pub struct SuiteOptions {
    pub big_size: usize,
    pub resume_read: bool,
    /// `Some(true)`: appending at an offset works, `Some(false)`: must be `Unsupported`.
    pub resume_write: Option<bool>,
    pub set_modified: bool,
    pub permissions: bool,
    /// Listings carry exact modification times (not so for old dates in `ls -l` format).
    pub exact_list_mtime: bool,
}

/// Exercise the common file operations below `base` (created and removed here).
pub async fn file_suite(vfs: &dyn Vfs, base: &str, o: &SuiteOptions) {
    vfs.mkdir(base).await.unwrap_or_else(|e| panic!("mkdir {base}: {e}"));
    let st = vfs.stat(base).await.expect("stat base");
    assert_eq!(st.kind, FileKind::Dir, "{st:?}");

    // small files, names with spaces
    let hello = format!("{base}/hello.txt");
    put(vfs, &hello, b"hello").await;
    let st = vfs.stat(&hello).await.expect("stat hello");
    assert_eq!((st.kind, st.size, st.name.as_str()), (FileKind::File, 5, "hello.txt"));
    assert_eq!(read(vfs, &hello, 0).await, b"hello");
    let spaced = format!("{base}/with space & ü.txt");
    put(vfs, &spaced, b"spaces").await;
    assert_eq!(read(vfs, &spaced, 0).await, b"spaces");
    put(vfs, &format!("{base}/empty"), b"").await;
    assert_eq!(vfs.stat(&format!("{base}/empty")).await.expect("stat empty").size, 0);

    // sub directory
    let sub = format!("{base}/sub dir");
    vfs.mkdir(&sub).await.expect("mkdir sub");
    put(vfs, &format!("{sub}/inner.txt"), b"inner").await;
    let mut names: Vec<(String, FileKind, u64)> =
        vfs.list(base).await.expect("list base").into_iter().map(|e| (e.name, e.kind, e.size)).collect();
    names.sort_by(|a, b| a.0.cmp(&b.0));
    assert_eq!(
        names,
        vec![
            ("empty".to_string(), FileKind::File, 0),
            ("hello.txt".to_string(), FileKind::File, 5),
            ("sub dir".to_string(), FileKind::Dir, 0),
            ("with space & ü.txt".to_string(), FileKind::File, 6),
        ]
    );
    let inner = vfs.list(&sub).await.expect("list sub");
    assert_eq!(inner.len(), 1);
    assert_eq!(inner[0].path, format!("{sub}/inner.txt"));
    assert_eq!(vfs.stat(&sub).await.expect("stat sub").kind, FileKind::Dir);

    // multi-MB file
    let big = format!("{base}/big.bin");
    let content = data(o.big_size, 7);
    put(vfs, &big, &content).await;
    let st = vfs.stat(&big).await.expect("stat big");
    assert_eq!(st.size, content.len() as u64);
    assert_same(&read(vfs, &big, 0).await, &content, "big file roundtrip");

    if o.resume_read {
        let off = 1_000_003.min(content.len() as u64 - 1);
        assert_same(&read(vfs, &big, off).await, &content[off as usize..], "resumed download");
        assert!(read(vfs, &big, content.len() as u64).await.is_empty(), "download at EOF");
    }

    let resumed = format!("{base}/resumed.bin");
    let half = content.len() / 2;
    match o.resume_write {
        Some(true) => {
            put(vfs, &resumed, &content[..half]).await;
            write(vfs, &resumed, &content[half..], WriteOptions { offset: half as u64, ..Default::default() }).await;
            assert_same(&read(vfs, &resumed, 0).await, &content, "resumed upload");
            vfs.remove_file(&resumed).await.expect("remove resumed");
        }
        Some(false) => {
            let r = vfs.open_write(&resumed, WriteOptions { offset: 10, ..Default::default() }).await;
            assert!(matches!(r, Err(Error::Unsupported(_))), "append must be unsupported");
        }
        None => {}
    }

    // rename
    let renamed = format!("{base}/renamed.txt");
    vfs.rename(&hello, &renamed).await.expect("rename");
    assert!(vfs.try_stat(&hello).await.expect("try_stat old").is_none());
    assert_eq!(vfs.stat(&renamed).await.expect("stat renamed").size, 5);

    if o.set_modified {
        vfs.set_modified(&renamed, 1_600_000_000).await.expect("set_modified");
        assert_eq!(vfs.stat(&renamed).await.expect("stat mtime").modified, Some(1_600_000_000));
        let listed = vfs.list(base).await.expect("list");
        let e = listed.iter().find(|e| e.name == "renamed.txt").expect("renamed listed");
        if o.exact_list_mtime {
            assert_eq!(e.modified, Some(1_600_000_000));
        } else {
            let m = e.modified.expect("listed mtime");
            assert!((m - 1_600_000_000).abs() <= 86_400, "listed mtime {m}");
        }
    }
    if o.permissions {
        vfs.set_permissions(&renamed, 0o640).await.expect("chmod");
        assert_eq!(vfs.stat(&renamed).await.expect("stat perms").permissions, Some(0o640));
    }

    // errors
    let missing = format!("{base}/does-not-exist");
    assert!(matches!(vfs.stat(&missing).await, Err(Error::NotFound(_))), "stat missing");
    assert!(vfs.try_stat(&missing).await.expect("try_stat missing").is_none());
    assert!(vfs.open_read(&missing, 0).await.is_err(), "read missing");

    // removal
    vfs.remove_file(&renamed).await.expect("remove_file");
    assert!(vfs.try_stat(&renamed).await.expect("try_stat removed").is_none());
    vfs.remove_dir_all(base).await.expect("remove_dir_all");
    assert!(vfs.try_stat(base).await.expect("try_stat base").is_none());
}

/// Transfers in progress must not block browsing, and abandoned readers must not break
/// the file system.
pub async fn concurrency_suite(vfs: &Arc<dyn Vfs>, base: &str) {
    vfs.mkdir(base).await.expect("mkdir");
    let big = format!("{base}/big.bin");
    let content = data(3 * 1024 * 1024, 3);
    put(&**vfs, &big, &content).await;

    // list / stat / upload / download while a download is open
    let mut r = vfs.open_read(&big, 0).await.expect("open_read");
    let mut got = vec![0u8; 64 * 1024];
    let n = r.read(&mut got).await.expect("read");
    got.truncate(n);
    let listed = vfs.list(base).await.expect("list during transfer");
    assert_eq!(listed.len(), 1);
    assert_eq!(vfs.stat(&big).await.expect("stat during transfer").size, content.len() as u64);
    put(&**vfs, &format!("{base}/side.txt"), b"side").await;
    assert_eq!(read(&**vfs, &format!("{base}/side.txt"), 0).await, b"side");
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = r.read(&mut buf).await.expect("read rest");
        if n == 0 {
            break;
        }
        got.extend_from_slice(&buf[..n]);
    }
    assert_same(&got, &content, "download interleaved with other operations");
    drop(r);

    // parallel uploads and downloads
    let mut tasks = Vec::new();
    for i in 0..6u64 {
        let vfs = vfs.clone();
        let path = format!("{base}/par-{i}.bin");
        tasks.push(tokio::spawn(async move {
            let d = data(512 * 1024 + i as usize, i);
            put(&*vfs, &path, &d).await;
            assert_same(&read(&*vfs, &path, 0).await, &d, &format!("parallel roundtrip {path}"));
            vfs.list(&rc_core::path::parent(&path)).await.expect("parallel list");
        }));
    }
    for t in tasks {
        t.await.expect("task");
    }

    // abandoned download: the connection is aborted/recycled, the session keeps working
    for _ in 0..3 {
        let mut r = vfs.open_read(&big, 0).await.expect("open_read");
        let mut buf = vec![0u8; 32 * 1024];
        r.read(&mut buf).await.expect("partial read");
        drop(r);
    }
    // abandoned upload
    {
        let mut w = vfs.open_write(&format!("{base}/partial.bin"), WriteOptions::default()).await.expect("open_write");
        w.write_all(&data(100_000, 1)).await.expect("partial write");
    }
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    vfs.ping().await.expect("ping after aborts");
    assert_same(&read(&**vfs, &big, 0).await, &content, "download after aborts");
    assert!(vfs.list(base).await.expect("list after aborts").len() >= 8);
    vfs.remove_dir_all(base).await.expect("cleanup");
}
