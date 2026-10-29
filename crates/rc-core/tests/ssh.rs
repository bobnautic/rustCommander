//! Integration tests for the SFTP / SCP backends against a real SSH server.
//!
//! Skipped unless these environment variables are set:
//!
//! * `RC_TEST_SSH_HOST`, `RC_TEST_SSH_PORT` (default 22), `RC_TEST_SSH_USER`
//! * `RC_TEST_SSH_PASSWORD` — the user's password
//! * `RC_TEST_SSH_KEY` — path to an unencrypted authorized private key
//!
//! Optional: `RC_TEST_SSH_KEY_ENC` + `RC_TEST_SSH_KEY_PASSPHRASE` (encrypted key),
//! `RC_TEST_SSH_KEY_RSA` (RSA key, checks rsa-sha2 signatures) and `RC_TEST_SSH_BENCH=1`
//! (200 MB throughput test; run with `--release --nocapture` to see the numbers).

#![cfg(feature = "ssh")]

use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use parking_lot::Mutex;
use rc_core::prompt::{AcceptAllPrompter, HostKeyState, PromptRequest, PromptResponse, Prompter};
use rc_core::vfs::{read_to_end, write_all};
use rc_core::*;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// Base site from the environment (`None` = tests are skipped).
fn site(protocol: Protocol) -> Option<SiteConfig> {
    let host = var("RC_TEST_SSH_HOST")?;
    let mut s = SiteConfig {
        protocol,
        host,
        port: var("RC_TEST_SSH_PORT").and_then(|p| p.parse().ok()).unwrap_or(22),
        username: var("RC_TEST_SSH_USER")?,
        password: var("RC_TEST_SSH_PASSWORD"),
        timeout_secs: 15,
        ..Default::default()
    };
    s.ssh.use_agent = false;
    s.ssh.try_default_keys = false;
    s.ssh.use_openssh_known_hosts = false;
    Some(s)
}

macro_rules! site_or_skip {
    ($p:expr) => {
        match site($p) {
            Some(s) => s,
            None => {
                eprintln!("RC_TEST_SSH_* not set, skipping");
                return;
            }
        }
    };
}

fn ctx() -> ConnectContext {
    let mut c = ConnectContext::new(Arc::new(AcceptAllPrompter), Arc::new(KnownHosts::in_memory()));
    c.session_id = "test".into();
    c
}

/// Records every prompt and answers host key questions as configured.
struct RecordingPrompter {
    log: Mutex<Vec<PromptRequest>>,
    accept_host_key: bool,
    remember: bool,
    passphrase: Option<String>,
    username: Option<String>,
    password: Option<String>,
}

impl RecordingPrompter {
    fn new(accept_host_key: bool, remember: bool) -> Self {
        RecordingPrompter {
            log: Mutex::new(Vec::new()),
            accept_host_key,
            remember,
            passphrase: None,
            username: None,
            password: None,
        }
    }

    fn host_key_prompts(&self) -> Vec<(HostKeyState, String, Option<String>, String)> {
        self.log
            .lock()
            .iter()
            .filter_map(|r| match r {
                PromptRequest::HostKey { state, fingerprint, previous_fingerprint, key_type, .. } => {
                    Some((*state, fingerprint.clone(), previous_fingerprint.clone(), key_type.clone()))
                }
                _ => None,
            })
            .collect()
    }
}

#[async_trait]
impl Prompter for RecordingPrompter {
    async fn prompt(&self, req: PromptRequest) -> Option<PromptResponse> {
        self.log.lock().push(req.clone());
        match req {
            PromptRequest::HostKey { .. } => {
                Some(PromptResponse { accepted: self.accept_host_key, remember: self.remember, values: vec![] })
            }
            PromptRequest::Passphrase { .. } => {
                self.passphrase.clone().map(|p| PromptResponse { accepted: true, remember: false, values: vec![p] })
            }
            PromptRequest::Banner { .. } => Some(PromptResponse { accepted: true, ..Default::default() }),
            PromptRequest::Username { .. } => answer(&self.username),
            PromptRequest::Password { .. } => answer(&self.password),
            PromptRequest::KeyboardInteractive { prompts, .. } if prompts.len() == 1 => answer(&self.password),
            _ => None,
        }
    }
}

fn answer(v: &Option<String>) -> Option<PromptResponse> {
    v.clone().map(|v| PromptResponse { accepted: true, remember: false, values: vec![v] })
}

fn kinds(p: &RecordingPrompter) -> Vec<&'static str> {
    p.log
        .lock()
        .iter()
        .map(|r| match r {
            PromptRequest::HostKey { .. } => "host_key",
            PromptRequest::Username { .. } => "username",
            PromptRequest::Password { .. } => "password",
            PromptRequest::Passphrase { .. } => "passphrase",
            PromptRequest::KeyboardInteractive { .. } => "keyboard_interactive",
            PromptRequest::Banner { .. } => "banner",
            _ => "other",
        })
        .collect()
}

/// A unique scratch directory below the remote home.
async fn scratch(vfs: &dyn Vfs, tag: &str) -> String {
    let home = vfs.home().await.unwrap();
    let dir = path::join(&home, &format!("rc-test-{tag}-{}", uuid::Uuid::new_v4().simple()));
    vfs.mkdir(&dir).await.unwrap();
    dir
}

async fn read_string(vfs: &dyn Vfs, p: &str) -> String {
    String::from_utf8(read_to_end(vfs, p, 1 << 20).await.unwrap()).unwrap()
}

async fn write_at(vfs: &dyn Vfs, p: &str, offset: u64, data: &[u8]) {
    let mut w = vfs.open_write(p, WriteOptions { offset, ..Default::default() }).await.unwrap();
    w.write_all(data).await.unwrap();
    w.finish().await.unwrap();
}

#[tokio::test]
async fn password_auth() {
    let s = site_or_skip!(Protocol::Sftp);
    if s.password.is_none() {
        return;
    }
    let mut s = s;
    s.ssh.try_keyboard_interactive = false;
    let vfs = connect(&s, &ctx()).await.expect("password login");
    assert!(vfs.home().await.unwrap().starts_with('/'));
    vfs.close().await.unwrap();

    let mut bad = s.clone();
    bad.password = Some("definitely-wrong".into());
    match connect(&bad, &ctx()).await {
        Err(Error::AuthFailed(msg)) => assert!(msg.contains("password"), "{msg}"),
        Err(e) => panic!("expected AuthFailed, got {e:?}"),
        Ok(_) => panic!("login with a wrong password succeeded"),
    }
}

#[tokio::test]
async fn keyboard_interactive_auth() {
    let mut s = site_or_skip!(Protocol::Sftp);
    if s.password.is_none() {
        return;
    }
    // Only keyboard-interactive: the known password answers the single "Password:" prompt.
    s.ssh.try_password = false;
    s.ssh.try_keyboard_interactive = true;
    let vfs = connect(&s, &ctx()).await.expect("keyboard-interactive login");
    vfs.ping().await.unwrap();
}

#[tokio::test]
async fn key_auth() {
    let mut s = site_or_skip!(Protocol::Sftp);
    let Some(key) = var("RC_TEST_SSH_KEY") else { return };
    s.password = None;
    s.ssh.try_password = false;
    s.ssh.try_keyboard_interactive = false;
    s.ssh.private_key_path = Some(key.clone());
    let vfs = connect(&s, &ctx()).await.expect("key login (path)");
    vfs.ping().await.unwrap();

    // Key content instead of a path.
    s.ssh.private_key_path = None;
    s.ssh.private_key = Some(std::fs::read_to_string(&key).unwrap());
    let vfs = connect(&s, &ctx()).await.expect("key login (content)");
    vfs.ping().await.unwrap();

    // Without any usable method.
    s.ssh.private_key = None;
    match connect(&s, &ctx()).await {
        Err(Error::AuthFailed(_)) => {}
        other => panic!("expected AuthFailed, got {:?}", other.err()),
    }

    if let Some(rsa) = var("RC_TEST_SSH_KEY_RSA") {
        // OpenSSH >= 8.8 rejects SHA-1 signatures, so this needs rsa-sha2-256/512.
        s.ssh.private_key_path = Some(rsa);
        let vfs = connect(&s, &ctx()).await.expect("RSA key login");
        vfs.ping().await.unwrap();
    }

    if let (Some(enc), Some(pass)) = (var("RC_TEST_SSH_KEY_ENC"), var("RC_TEST_SSH_KEY_PASSPHRASE")) {
        s.ssh.private_key_path = Some(enc.clone());
        let mut p = RecordingPrompter::new(true, false);
        p.passphrase = Some(pass.clone());
        let p = Arc::new(p);
        let c = ConnectContext::new(p.clone(), Arc::new(KnownHosts::in_memory()));
        let vfs = connect(&s, &c).await.expect("encrypted key login (prompted passphrase)");
        vfs.ping().await.unwrap();
        assert!(p.log.lock().iter().any(|r| matches!(r, PromptRequest::Passphrase { .. })));

        // Stored passphrase: no prompt.
        s.ssh.passphrase = Some(pass);
        let p = Arc::new(RecordingPrompter::new(true, false));
        let c = ConnectContext::new(p.clone(), Arc::new(KnownHosts::in_memory()));
        connect(&s, &c).await.expect("encrypted key login (stored passphrase)");
        assert!(!p.log.lock().iter().any(|r| matches!(r, PromptRequest::Passphrase { .. })));
    }
}

#[tokio::test]
async fn host_key_flow() {
    let s = site_or_skip!(Protocol::Sftp);
    let kh = Arc::new(KnownHosts::in_memory());

    // Unknown key, rejected.
    let p = Arc::new(RecordingPrompter::new(false, false));
    match connect(&s, &ConnectContext::new(p.clone(), kh.clone())).await {
        Err(Error::HostKeyRejected(_)) => {}
        other => panic!("expected HostKeyRejected, got {:?}", other.err()),
    }
    assert_eq!(p.host_key_prompts().len(), 1);
    assert!(kh.list().is_empty());

    // Unknown key, accepted and remembered.
    let p = Arc::new(RecordingPrompter::new(true, true));
    connect(&s, &ConnectContext::new(p.clone(), kh.clone())).await.expect("accept new key");
    let prompts = p.host_key_prompts();
    assert_eq!(prompts.len(), 1);
    let (state, fp, prev, key_type) = prompts[0].clone();
    assert_eq!(state, HostKeyState::New);
    assert!(prev.is_none());
    assert!(fp.starts_with("SHA256:") && !fp.ends_with('='), "{fp}");
    let key = KnownHosts::ssh_key(&s.host, s.port);
    assert_eq!(kh.check(&key, &key_type, &fp), HostKeyStatus::Trusted);

    // Trusted now: no prompt.
    let p = Arc::new(RecordingPrompter::new(false, false));
    connect(&s, &ConnectContext::new(p.clone(), kh.clone())).await.expect("trusted key");
    assert!(p.host_key_prompts().is_empty());

    // Changed key: always asked, with the previous fingerprint.
    kh.add(&key, &key_type, "SHA256:previousfingerprint", "").unwrap();
    let p = Arc::new(RecordingPrompter::new(false, false));
    match connect(&s, &ConnectContext::new(p.clone(), kh.clone())).await {
        Err(Error::HostKeyRejected(_)) => {}
        other => panic!("expected HostKeyRejected, got {:?}", other.err()),
    }
    let prompts = p.host_key_prompts();
    assert_eq!(prompts.len(), 1);
    assert_eq!(prompts[0].0, HostKeyState::Changed);
    assert_eq!(prompts[0].2.as_deref(), Some("SHA256:previousfingerprint"));

    // Accepting the changed key replaces the stored one.
    let p = Arc::new(RecordingPrompter::new(true, true));
    connect(&s, &ConnectContext::new(p.clone(), kh.clone())).await.expect("accept changed key");
    assert_eq!(p.host_key_prompts()[0].0, HostKeyState::Changed);
    assert_eq!(kh.check(&key, &key_type, &fp), HostKeyStatus::Trusted);
}

/// The file operations shared by the SFTP and SCP tests.
async fn file_ops(vfs: &dyn Vfs, tag: &str) {
    let dir = scratch(vfs, tag).await;
    let sub = path::join(&dir, "sub dir");
    vfs.mkdir(&sub).await.unwrap();
    assert!(matches!(vfs.mkdir(&sub).await, Err(Error::AlreadyExists(_))), "mkdir on existing dir");
    vfs.mkdir_all(&path::join(&dir, "a/b/c")).await.unwrap();

    // write / read / stat
    let f = path::join(&sub, "it's a file.txt");
    write_all(vfs, &f, b"hello").await.unwrap();
    assert_eq!(read_string(vfs, &f).await, "hello");
    let st = vfs.stat(&f).await.unwrap();
    assert_eq!(st.kind, FileKind::File);
    assert_eq!(st.size, 5);
    assert_eq!(st.name, "it's a file.txt");
    assert!(st.modified.is_some());
    assert!(st.owner.is_some());

    // resume upload: append at offset, and truncate a longer file to the offset first
    write_at(vfs, &f, 5, b" world").await;
    assert_eq!(read_string(vfs, &f).await, "hello world");
    write_at(vfs, &f, 5, b"!!").await;
    assert_eq!(read_string(vfs, &f).await, "hello!!");
    write_at(vfs, &f, 0, b"hello world").await;
    // resume download
    let mut r = vfs.open_read(&f, 6).await.unwrap();
    let mut buf = [0u8; 64];
    let mut got = Vec::new();
    loop {
        let n = r.read(&mut buf).await.unwrap();
        if n == 0 {
            break;
        }
        got.extend_from_slice(&buf[..n]);
    }
    assert_eq!(got, b"world");
    drop(r);

    // writes without a size hint, empty files
    let e = path::join(&dir, "empty");
    let w = vfs.open_write(&e, WriteOptions { mode: Some(0o600), ..Default::default() }).await.unwrap();
    w.finish().await.unwrap();
    let st = vfs.stat(&e).await.unwrap();
    assert_eq!(st.size, 0);
    assert_eq!(st.permissions, Some(0o600));
    assert!(read_to_end(vfs, &e, 10).await.unwrap().is_empty());
    let mut w = vfs.open_write(&e, WriteOptions::default()).await.unwrap();
    for _ in 0..100 {
        w.write_all(&[b'x'; 1000]).await.unwrap();
    }
    w.finish().await.unwrap();
    assert_eq!(vfs.stat(&e).await.unwrap().size, 100_000);

    // listing
    let list = vfs.list(&dir).await.unwrap();
    let names: Vec<&str> = list.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains(&"sub dir") && names.contains(&"a") && names.contains(&"empty"), "{names:?}");
    assert!(!names.contains(&".") && !names.contains(&".."));
    let d = list.iter().find(|e| e.name == "sub dir").unwrap();
    assert_eq!(d.kind, FileKind::Dir);
    assert_eq!(d.path, sub);
    assert!(d.permissions.is_some() && d.owner.is_some() && d.group.is_some());
    assert!(vfs.list(&path::join(&dir, "missing")).await.is_err());

    // chmod / set_modified
    vfs.set_permissions(&f, 0o640).await.unwrap();
    assert_eq!(vfs.stat(&f).await.unwrap().permissions, Some(0o640));
    vfs.set_modified(&f, 1_000_000_000).await.unwrap();
    assert_eq!(vfs.stat(&f).await.unwrap().modified, Some(1_000_000_000));
    let listed = vfs.list(&sub).await.unwrap();
    assert_eq!(listed[0].modified, Some(1_000_000_000));

    // set_owner to ourselves (by name and by number)
    let me = vfs.stat(&f).await.unwrap();
    vfs.set_owner(&f, me.owner.as_deref(), me.group.as_deref()).await.unwrap();

    // symlinks: file and directory targets, dangling
    let link = path::join(&dir, "link");
    vfs.symlink(&f, &link).await.unwrap();
    assert_eq!(vfs.read_link(&link).await.unwrap(), f);
    let st = vfs.stat(&link).await.unwrap();
    assert_eq!(st.kind, FileKind::Symlink);
    assert_eq!(st.target_kind, Some(FileKind::File));
    assert_eq!(st.size, 11);
    assert_eq!(st.link_target.as_deref(), Some(f.as_str()));
    assert_eq!(read_string(vfs, &link).await, "hello world");
    vfs.symlink("sub dir", &path::join(&dir, "dirlink")).await.unwrap();
    vfs.symlink("nowhere", &path::join(&dir, "dangling")).await.unwrap();
    let list = vfs.list(&dir).await.unwrap();
    let get = |n: &str| list.iter().find(|e| e.name == n).unwrap().clone();
    assert_eq!(get("link").target_kind, Some(FileKind::File));
    assert_eq!(get("dirlink").target_kind, Some(FileKind::Dir));
    assert!(get("dirlink").is_dir());
    assert_eq!(get("dirlink").link_target.as_deref(), Some("sub dir"));
    assert_eq!(get("dangling").kind, FileKind::Symlink);
    assert_eq!(get("dangling").target_kind, None);
    assert_eq!(vfs.list(&path::join(&dir, "dirlink")).await.unwrap().len(), 1);

    // rename (overwrites an existing file), copy
    let g = path::join(&dir, "renamed.txt");
    vfs.rename(&f, &g).await.unwrap();
    assert!(vfs.try_stat(&f).await.unwrap().is_none());
    assert_eq!(read_string(vfs, &g).await, "hello world");
    write_all(vfs, &f, b"other").await.unwrap();
    match vfs.rename(&f, &g).await {
        Ok(()) => assert_eq!(read_string(vfs, &g).await, "other"),
        Err(Error::AlreadyExists(_)) => {}
        Err(e) => panic!("rename over existing file: {e:?}"),
    }
    let c = path::join(&dir, "copy.txt");
    vfs.copy_file(&g, &c).await.unwrap();
    assert_eq!(read_string(vfs, &c).await, read_string(vfs, &g).await);

    // canonicalize, checksum, disk info
    assert_eq!(vfs.canonicalize(&path::join(&sub, "..")).await.unwrap(), dir);
    let sum = vfs.checksum(&c, ChecksumAlgo::Sha256).await.unwrap().expect("sha256sum");
    assert_eq!(sum, hex::encode(Sha256::digest(read_to_end(vfs, &c, 1024).await.unwrap())));
    assert_eq!(vfs.checksum(&path::join(&dir, "missing"), ChecksumAlgo::Md5).await.unwrap(), None);
    let di = vfs.disk_info(&dir).await.unwrap().expect("disk info");
    assert!(di.total > 0 && di.available <= di.total);

    // errors
    assert!(matches!(vfs.stat(&path::join(&dir, "missing")).await, Err(Error::NotFound(_))));
    assert!(matches!(vfs.open_read(&path::join(&dir, "missing"), 0).await, Err(Error::NotFound(_))));
    assert!(vfs.remove_dir(&dir).await.is_err());

    // remove
    vfs.remove_file(&c).await.unwrap();
    assert!(vfs.try_stat(&c).await.unwrap().is_none());
    vfs.remove_dir(&path::join(&dir, "a/b/c")).await.unwrap();
    vfs.remove_dir_all(&dir).await.unwrap();
    assert!(vfs.try_stat(&dir).await.unwrap().is_none());
}

#[tokio::test]
async fn sftp_file_ops() {
    let s = site_or_skip!(Protocol::Sftp);
    let vfs = connect(&s, &ctx()).await.unwrap();
    assert_eq!(vfs.protocol(), Protocol::Sftp);
    let info = vfs.session_info();
    let get = |k: &str| info.items.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    assert!(get("Server software").unwrap_or_default().starts_with("SSH-2.0-"), "{info:?}");
    assert!(get("Cipher").is_some() && get("Host key").is_some());
    assert!(get("SFTP extensions").unwrap_or_default().contains("posix-rename@openssh.com"));
    file_ops(vfs.as_ref(), "sftp").await;
    vfs.close().await.unwrap();
    assert!(vfs.ping().await.is_err());
}

#[tokio::test]
async fn sftp_custom_server_command() {
    let mut s = site_or_skip!(Protocol::Sftp);
    s.ssh.sftp_server = Some("/usr/lib/openssh/sftp-server".into());
    let vfs = match connect(&s, &ctx()).await {
        Ok(v) => v,
        Err(e) => {
            eprintln!("no /usr/lib/openssh/sftp-server? {e}");
            return;
        }
    };
    let dir = scratch(vfs.as_ref(), "exec").await;
    write_all(vfs.as_ref(), &path::join(&dir, "x"), b"via exec").await.unwrap();
    assert_eq!(read_string(vfs.as_ref(), &path::join(&dir, "x")).await, "via exec");
    vfs.remove_dir_all(&dir).await.unwrap();
}

#[tokio::test]
async fn scp_file_ops() {
    let s = site_or_skip!(Protocol::Scp);
    let vfs = connect(&s, &ctx()).await.unwrap();
    assert_eq!(vfs.protocol(), Protocol::Scp);
    file_ops(vfs.as_ref(), "scp").await;

    // A larger file through the real SCP protocol in both directions.
    let dir = scratch(vfs.as_ref(), "scpbig").await;
    let p = path::join(&dir, "big.bin");
    let data: Vec<u8> = (0..3_000_000u32).map(|i| (i.wrapping_mul(2654435761) >> 13) as u8).collect();
    write_all(vfs.as_ref(), &p, &data).await.unwrap();
    assert_eq!(read_to_end(vfs.as_ref(), &p, 10_000_000).await.unwrap(), data);
    assert!(matches!(vfs.open_read(&dir, 0).await, Err(Error::IsADirectory(_))));
    vfs.remove_dir_all(&dir).await.unwrap();
}

/// Wait until the terminal printed `needle` (`None`) or exited (`Some(code)`).
async fn wait_for(t: &mut TerminalChannel, needle: &str) -> Option<Option<i32>> {
    let mut seen = String::new();
    let fut = async {
        loop {
            match t.output.recv().await {
                Some(TerminalOutput::Data(d)) => {
                    seen.push_str(&String::from_utf8_lossy(&d));
                    if seen.contains(needle) {
                        return None;
                    }
                }
                Some(TerminalOutput::Exit(code)) => return Some(code),
                None => panic!("terminal closed while waiting for {needle:?}"),
            }
        }
    };
    match tokio::time::timeout(Duration::from_secs(10), fut).await {
        Ok(r) => r,
        Err(_) => panic!("timeout waiting for {needle:?}, got: {seen}"),
    }
}

async fn exec_terminal_tunnel(vfs: &dyn Vfs) {
    // exec
    let out = vfs.exec("echo out; echo err >&2; exit 7", None).await.unwrap();
    assert_eq!(out.stdout, "out\n");
    assert_eq!(out.stderr, "err\n");
    assert_eq!(out.exit_code, Some(7));
    let out = vfs.exec("pwd", Some("/tmp")).await.unwrap();
    assert_eq!(out.stdout.trim(), "/tmp");

    // terminal
    let mut t = vfs
        .open_terminal(TerminalOptions {
            cwd: Some("/tmp".into()),
            env: vec![("RC_TEST".into(), "1".into())],
            ..Default::default()
        })
        .await
        .unwrap();
    t.input.send(TerminalInput::Data(b"echo rc_$((40+2)); pwd; echo env_$RC_TEST\n".to_vec())).unwrap();
    assert_eq!(wait_for(&mut t, "rc_42\r\n/tmp\r\nenv_1\r\n").await, None, "echo round trip, cwd and env");
    t.input.send(TerminalInput::Resize { cols: 100, rows: 40 }).unwrap();
    t.input.send(TerminalInput::Data(b"stty size\n".to_vec())).unwrap();
    assert_eq!(wait_for(&mut t, "40 100").await, None, "window change");
    t.input.send(TerminalInput::Data(b"exit 3\n".to_vec())).unwrap();
    assert_eq!(wait_for(&mut t, "never printed").await, Some(Some(3)), "terminal exit code");

    // tunnel to a local echo server (the SSH server runs on this machine)
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            tokio::spawn(async move {
                let (mut r, mut w) = sock.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });
    let mut tun = vfs.open_tunnel("127.0.0.1", port).await.unwrap();
    let payload: Vec<u8> = (0..200_000u32).map(|i| i as u8).collect();
    let (mut rd, mut wr) = tokio::io::split(&mut tun);
    let send = async {
        wr.write_all(&payload).await.unwrap();
        wr.flush().await.unwrap();
    };
    let recv = async {
        let mut got = vec![0u8; payload.len()];
        rd.read_exact(&mut got).await.unwrap();
        got
    };
    let (_, got) = tokio::time::timeout(Duration::from_secs(20), async { tokio::join!(send, recv) }).await.unwrap();
    assert_eq!(got, payload);
    assert!(vfs.open_tunnel("127.0.0.1", 1).await.is_err());
}

#[tokio::test]
async fn sftp_exec_terminal_tunnel() {
    let s = site_or_skip!(Protocol::Sftp);
    let vfs = connect(&s, &ctx()).await.unwrap();
    exec_terminal_tunnel(vfs.as_ref()).await;
}

#[tokio::test]
async fn scp_exec_terminal_tunnel() {
    let s = site_or_skip!(Protocol::Scp);
    let vfs = connect(&s, &ctx()).await.unwrap();
    exec_terminal_tunnel(vfs.as_ref()).await;
}

#[tokio::test]
async fn jump_host() {
    let s = site_or_skip!(Protocol::Sftp);
    let mut target = s.clone();
    // The jump host connects to the target by name, as seen from the jump host.
    target.ssh.jump = Some(Box::new(s.clone()));
    let p = Arc::new(RecordingPrompter::new(true, true));
    let kh = Arc::new(KnownHosts::in_memory());
    let vfs = connect(&target, &ConnectContext::new(p.clone(), kh)).await.expect("connect via jump host");
    // Host keys of both hops are verified: one prompt for the jump host, then the target is trusted.
    assert_eq!(p.host_key_prompts().len(), 1);
    let dir = scratch(vfs.as_ref(), "jump").await;
    write_all(vfs.as_ref(), &path::join(&dir, "f"), b"through the jump host").await.unwrap();
    assert_eq!(read_string(vfs.as_ref(), &path::join(&dir, "f")).await, "through the jump host");
    let info = vfs.session_info();
    assert!(info.items.iter().any(|(k, _)| k == "Jump host"));
    vfs.remove_dir_all(&dir).await.unwrap();

    let mut scp = target.clone();
    scp.protocol = Protocol::Scp;
    let vfs = connect(&scp, &ctx()).await.expect("SCP via jump host");
    assert!(!vfs.list(&vfs.home().await.unwrap()).await.unwrap().is_empty() || vfs.ping().await.is_ok());
}

#[tokio::test]
async fn concurrent_use() {
    let s = site_or_skip!(Protocol::Sftp);
    let vfs = connect(&s, &ctx()).await.unwrap();
    let dir = scratch(vfs.as_ref(), "conc").await;
    let mut tasks = Vec::new();
    for i in 0..8u8 {
        let vfs = vfs.clone();
        let p = path::join(&dir, &format!("f{i}"));
        tasks.push(tokio::spawn(async move {
            let data = vec![i; 1_500_000 + i as usize * 1000];
            write_all(vfs.as_ref(), &p, &data).await.unwrap();
            assert_eq!(read_to_end(vfs.as_ref(), &p, 10_000_000).await.unwrap(), data);
        }));
    }
    let mut sums = Vec::new();
    for _ in 0..12 {
        let vfs = vfs.clone();
        sums.push(tokio::spawn(async move { vfs.exec("echo hi", None).await.unwrap().stdout }));
    }
    for _ in 0..20 {
        vfs.list(&dir).await.unwrap();
    }
    for t in sums {
        assert_eq!(t.await.unwrap(), "hi\n");
    }
    for t in tasks {
        t.await.unwrap();
    }
    assert_eq!(vfs.list(&dir).await.unwrap().len(), 8);
    vfs.remove_dir_all(&dir).await.unwrap();
}

/// Deterministic pseudo-random data.
fn fill(buf: &mut [u8], seed: &mut u64) {
    for chunk in buf.chunks_mut(8) {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        let b = seed.to_le_bytes();
        chunk.copy_from_slice(&b[..chunk.len()]);
    }
}

async fn throughput(vfs: &dyn Vfs, label: &str) {
    const SIZE: usize = 200 * 1024 * 1024;
    const BLOCK: usize = 1024 * 1024;
    let dir = scratch(vfs, "bench").await;
    let p = path::join(&dir, "big.bin");
    let mut seed = 0x9E37_79B9_7F4A_7C15u64;
    let mut data = vec![0u8; SIZE];
    fill(&mut data, &mut seed);
    let expected = hex::encode(Sha256::digest(&data));

    let t = Instant::now();
    let mut w = vfs.open_write(&p, WriteOptions { size_hint: Some(SIZE as u64), ..Default::default() }).await.unwrap();
    for block in data.chunks(BLOCK) {
        w.write_all(block).await.unwrap();
    }
    w.finish().await.unwrap();
    let up = SIZE as f64 / 1048576.0 / t.elapsed().as_secs_f64();

    let t = Instant::now();
    let mut r = vfs.open_read(&p, 0).await.unwrap();
    let mut got = Vec::with_capacity(SIZE);
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = r.read(&mut buf).await.unwrap();
        if n == 0 {
            break;
        }
        got.extend_from_slice(&buf[..n]);
    }
    let down = SIZE as f64 / 1048576.0 / t.elapsed().as_secs_f64();
    assert_eq!(got.len(), SIZE);
    assert_eq!(hex::encode(Sha256::digest(&got)), expected);
    assert_eq!(vfs.checksum(&p, ChecksumAlgo::Sha256).await.unwrap().as_deref(), Some(expected.as_str()));
    println!("{label}: 200 MB upload {up:.1} MB/s, download {down:.1} MB/s");
    vfs.remove_dir_all(&dir).await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn transfer_throughput() {
    let s = site_or_skip!(Protocol::Sftp);
    if var("RC_TEST_SSH_BENCH").is_none() {
        eprintln!("RC_TEST_SSH_BENCH not set, skipping the 200 MB transfer");
        return;
    }
    let vfs = connect(&s, &ctx()).await.unwrap();
    let cipher = vfs.session_info().items.into_iter().find(|(k, _)| k == "Cipher").map(|(_, v)| v).unwrap_or_default();
    throughput(vfs.as_ref(), &format!("SFTP ({cipher})")).await;
    let mut scp = s.clone();
    scp.protocol = Protocol::Scp;
    let vfs = connect(&scp, &ctx()).await.unwrap();
    throughput(vfs.as_ref(), &format!("SCP ({cipher})")).await;
}

#[tokio::test]
async fn compression() {
    let mut s = site_or_skip!(Protocol::Sftp);
    s.ssh.compression = true;
    let vfs = connect(&s, &ctx()).await.unwrap();
    let info = vfs.session_info();
    let c = info.items.iter().find(|(k, _)| k == "Compression").map(|(_, v)| v.as_str());
    assert!(matches!(c, Some("zlib@openssh.com") | Some("zlib")), "{c:?}");
    let dir = scratch(vfs.as_ref(), "zlib").await;
    let p = path::join(&dir, "text");
    let data = "compressible text line\n".repeat(200_000).into_bytes();
    write_all(vfs.as_ref(), &p, &data).await.unwrap();
    assert_eq!(read_to_end(vfs.as_ref(), &p, 10_000_000).await.unwrap(), data);
    vfs.remove_dir_all(&dir).await.unwrap();
}

#[tokio::test]
async fn connection_loss() {
    for protocol in [Protocol::Sftp, Protocol::Scp] {
        let s = site_or_skip!(protocol);
        let vfs = connect(&s, &ctx()).await.unwrap();
        let home = vfs.home().await.unwrap();
        // Kill this connection's sshd process on the server.
        let _ = tokio::time::timeout(Duration::from_secs(10), vfs.exec("kill -9 $PPID", None)).await;
        let r = tokio::time::timeout(Duration::from_secs(10), vfs.list(&home))
            .await
            .expect("list hangs after connection loss");
        match r {
            Err(e) => assert!(e.is_connection_error(), "{protocol:?}: {e:?}"),
            Ok(_) => panic!("{protocol:?}: list succeeded on a dead connection"),
        }
        let r = tokio::time::timeout(Duration::from_secs(10), vfs.ping()).await.expect("ping hangs");
        assert!(r.is_err());
        let r = tokio::time::timeout(Duration::from_secs(10), vfs.open_read(&home, 0)).await.expect("open_read hangs");
        assert!(r.is_err());
    }
}

#[tokio::test]
async fn prompted_credentials() {
    let s = site_or_skip!(Protocol::Sftp);
    let Some(password) = s.password.clone() else { return };
    let kh = Arc::new(KnownHosts::in_memory());

    // Username and password asked interactively.
    let mut site = s.clone();
    site.username.clear();
    site.password = None;
    site.ssh.try_keyboard_interactive = false;
    let mut p = RecordingPrompter::new(true, true);
    p.username = Some(s.username.clone());
    p.password = Some(password.clone());
    let p = Arc::new(p);
    connect(&site, &ConnectContext::new(p.clone(), kh.clone())).await.expect("prompted password");
    assert_eq!(kinds(&p), ["host_key", "username", "password"]);

    // Keyboard-interactive without a known password: the challenge is forwarded.
    let mut site = s.clone();
    site.password = None;
    site.ssh.try_password = false;
    let mut p = RecordingPrompter::new(true, true);
    p.password = Some(password.clone());
    let p = Arc::new(p);
    connect(&site, &ConnectContext::new(p.clone(), kh.clone())).await.expect("prompted keyboard-interactive");
    assert_eq!(kinds(&p), ["keyboard_interactive"]);

    // Cancelling the password prompt aborts.
    let mut site = s.clone();
    site.password = None;
    let p = Arc::new(RecordingPrompter::new(true, true));
    match connect(&site, &ConnectContext::new(p.clone(), kh.clone())).await {
        Err(Error::Cancelled) => {}
        other => panic!("expected Cancelled, got {:?}", other.err()),
    }
}

/// Needs a running ssh-agent (`SSH_AUTH_SOCK`) holding `RC_TEST_SSH_KEY`; enabled with `RC_TEST_SSH_AGENT=1`.
#[tokio::test]
async fn agent_auth() {
    let mut s = site_or_skip!(Protocol::Sftp);
    if var("RC_TEST_SSH_AGENT").is_none() {
        return;
    }
    s.password = None;
    s.ssh.try_password = false;
    s.ssh.try_keyboard_interactive = false;
    s.ssh.use_agent = true;
    let vfs = connect(&s, &ctx()).await.expect("agent login");
    vfs.ping().await.unwrap();
}

/// Run with `HOME` pointing to a directory whose `.ssh` holds an authorized `id_ed25519`
/// and a `known_hosts` with the server's key; enabled with `RC_TEST_SSH_FAKE_HOME=1`.
#[tokio::test]
async fn default_keys_and_openssh_known_hosts() {
    let mut s = site_or_skip!(Protocol::Sftp);
    if var("RC_TEST_SSH_FAKE_HOME").is_none() {
        return;
    }
    s.password = None;
    s.ssh.try_password = false;
    s.ssh.try_keyboard_interactive = false;
    s.ssh.try_default_keys = true;
    s.ssh.use_openssh_known_hosts = true;
    // Rejects every host key question: the key must come from ~/.ssh/known_hosts.
    let p = Arc::new(RecordingPrompter::new(false, false));
    let vfs = connect(&s, &ConnectContext::new(p.clone(), Arc::new(KnownHosts::in_memory())))
        .await
        .expect("default key login");
    vfs.ping().await.unwrap();
    assert!(kinds(&p).is_empty(), "{:?}", kinds(&p));

    // `RC_TEST_SSH_ALT_PORT`: the same server with another host key, listed in
    // ~/.ssh/known_hosts with the wrong key -> asked as a changed key.
    if let Some(port) = var("RC_TEST_SSH_ALT_PORT").and_then(|p| p.parse().ok()) {
        s.port = port;
        let p = Arc::new(RecordingPrompter::new(false, false));
        match connect(&s, &ConnectContext::new(p.clone(), Arc::new(KnownHosts::in_memory()))).await {
            Err(Error::HostKeyRejected(_)) => {}
            other => panic!("expected HostKeyRejected, got {:?}", other.err()),
        }
        let prompts = p.host_key_prompts();
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0].0, HostKeyState::Changed);
        assert!(prompts[0].2.as_deref().is_some_and(|f| f.starts_with("SHA256:") && *f != prompts[0].1));
    }
}

/// More parallel operations than OpenSSH's default `MaxSessions` (10) allows channels.
#[tokio::test]
async fn scp_concurrent_use() {
    let s = site_or_skip!(Protocol::Scp);
    let vfs = connect(&s, &ctx()).await.unwrap();
    let dir = scratch(vfs.as_ref(), "scpconc").await;
    let mut term = vfs.open_terminal(TerminalOptions::default()).await.unwrap();
    let mut tasks = Vec::new();
    for i in 0..16u8 {
        let vfs = vfs.clone();
        let p = path::join(&dir, &format!("f{i}"));
        tasks.push(tokio::spawn(async move {
            let data = vec![i; 300_000 + i as usize];
            write_all(vfs.as_ref(), &p, &data).await.unwrap();
            assert_eq!(read_to_end(vfs.as_ref(), &p, 10_000_000).await.unwrap(), data);
            assert_eq!(vfs.stat(&p).await.unwrap().size, data.len() as u64);
        }));
    }
    for t in tasks {
        t.await.unwrap();
    }
    assert_eq!(vfs.list(&dir).await.unwrap().len(), 16);
    term.input.send(TerminalInput::Data(b"echo still_$((1+1))\n".to_vec())).unwrap();
    assert_eq!(wait_for(&mut term, "still_2").await, None);
    vfs.remove_dir_all(&dir).await.unwrap();
}

/// SCP mode with a non-GNU `ls`: `RC_TEST_SSH_BUSYBOX_BIN` is a directory on the server
/// whose `ls` is busybox (it is put first in `PATH` through the shell setting).
#[tokio::test]
async fn scp_busybox_ls() {
    let mut s = site_or_skip!(Protocol::Scp);
    let Some(bin) = var("RC_TEST_SSH_BUSYBOX_BIN") else { return };
    s.ssh.shell = Some(format!("PATH={bin}:$PATH /bin/sh"));
    let vfs = connect(&s, &ctx()).await.unwrap();
    let info = vfs.session_info();
    let style = info.items.iter().find(|(k, _)| k == "Directory listing").map(|(_, v)| v.clone());
    assert_eq!(style.as_deref(), Some("ls --full-time"));
    file_ops(vfs.as_ref(), "busybox").await;
}
