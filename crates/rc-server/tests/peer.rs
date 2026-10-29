//! A Rust Commander instance connects to another one (protocol `rcmd`) over HTTPS with
//! certificate pinning, and transfers files through it.

use std::sync::Arc;

use rc_api::server::ServerControl;
use rc_api::{AppMode, AppState, InitOptions};
use rc_core::prompt::AcceptAllPrompter;
use rc_core::transfer::{Endpoint, OverwriteMode, TransferOptions, TransferTask};
use rc_core::{ConnectContext, KnownHosts, LocalVfs, Protocol, SiteConfig, Vfs};

#[tokio::test(flavor = "multi_thread")]
async fn peer_file_access() {
    let cfg = tempfile::tempdir().unwrap();
    let state = AppState::new(InitOptions { mode: AppMode::Web, config_dir: Some(cfg.path().to_path_buf()) }).await.unwrap();
    state.server_auth.set_password("secret-pw").unwrap();
    let server = rc_server::WebServer::new();
    *state.server.write() = Some(server.clone() as Arc<dyn ServerControl>);
    let running = server.start(state.clone(), "127.0.0.1".into(), 0, true).await.unwrap();

    let mut site = SiteConfig { protocol: Protocol::Rcmd, host: "127.0.0.1".into(), port: running.port, ..Default::default() };
    site.rcmd.tls = true;
    let kh = Arc::new(KnownHosts::in_memory());
    let ctx = ConnectContext { prompter: Arc::new(AcceptAllPrompter), known_hosts: kh.clone(), session_id: "t".into() };

    // Wrong password.
    site.password = Some("wrong".into());
    assert!(matches!(rc_core::connect(&site, &ctx).await, Err(rc_core::Error::AuthFailed(_))));

    // Wrong pinned fingerprint is refused.
    let mut pinned = site.clone();
    pinned.password = Some("secret-pw".into());
    pinned.rcmd.fingerprint = Some("00:11".into());
    assert!(rc_core::connect(&pinned, &ctx).await.is_err());

    site.password = Some("secret-pw".into());
    let peer = rc_core::connect(&site, &ctx).await.unwrap();
    let work = tempfile::tempdir().unwrap();
    let base = rc_core::local::from_native(work.path());
    peer.mkdir_all(&format!("{base}/remote/sub")).await.unwrap();
    let data: Vec<u8> = (0..2_500_000u32).map(|i| (i * 7 % 256) as u8).collect();
    rc_core::vfs::write_all(peer.as_ref(), &format!("{base}/remote/sub/f.bin"), &data).await.unwrap();
    let list = peer.list(&format!("{base}/remote/sub")).await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].size, data.len() as u64);
    assert_eq!(rc_core::vfs::read_to_end(peer.as_ref(), &format!("{base}/remote/sub/f.bin"), 10_000_000).await.unwrap(), data);

    // Resume download through the queue.
    let local: Arc<dyn Vfs> = Arc::new(LocalVfs::new());
    std::fs::create_dir_all(work.path().join("local")).unwrap();
    std::fs::write(work.path().join("local/f.bin"), &data[..1000]).unwrap();
    let q = rc_core::jobs::JobQueue::new(1, Arc::new(|_| {}));
    let task = TransferTask {
        src: Endpoint::new("peer", peer.clone()),
        src_paths: vec![format!("{base}/remote/sub/f.bin")],
        dst: Endpoint::new("local", local.clone()),
        dst_dir: format!("{base}/local"),
        options: TransferOptions { overwrite: OverwriteMode::Resume, verify_checksum: true, ..Default::default() },
    };
    let job = q.submit(rc_core::jobs::JobKind::Transfer, Default::default(), Arc::new(task), 0);
    let done = q.wait(&job.id).await.unwrap();
    assert_eq!(done.state, rc_core::jobs::JobState::Completed, "{:?}", done.errors);
    assert_eq!(std::fs::read(work.path().join("local/f.bin")).unwrap(), data);

    peer.rename(&format!("{base}/remote/sub/f.bin"), &format!("{base}/remote/g.bin")).await.unwrap();
    peer.set_permissions(&format!("{base}/remote/g.bin"), 0o600).await.unwrap();
    assert_eq!(peer.stat(&format!("{base}/remote/g.bin")).await.unwrap().permissions, Some(0o600));
    peer.remove_dir_all(&format!("{base}/remote")).await.unwrap();
    assert!(peer.try_stat(&format!("{base}/remote")).await.unwrap().is_none());
    server.stop().await.unwrap();
}
