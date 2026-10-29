//! Remote explorer against real SSH servers.
//!
//! Skipped unless these environment variables are set:
//!
//! * `RC_TEST_SSH_HOST`, `RC_TEST_SSH_PORT` (default 22), `RC_TEST_SSH_USER`
//! * `RC_TEST_SSH_PASSWORD` — the user's password
//! * `RC_TEST_SSH_KEY` — path to an unencrypted authorized private key
//! * `RC_TEST_SSH_NO_SFTP_PORT` — a second server for the same user without an SFTP
//!   subsystem (OpenSSH without a `Subsystem sftp` line)
//!
//! The user's home must contain `projects/README.md` with the text `hello explorer\n`.
//! The test replaces `HOME` to provide its own `~/.ssh/config`, so it is the only test here.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use rc_api::{dispatch, AppMode, AppState, InitOptions, Origin};
use rc_core::prompt::PromptResponse;

fn var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

async fn call(st: &Arc<AppState>, method: &str, params: Value) -> Value {
    match dispatch(st, &Origin::Desktop, method, params).await {
        Ok(v) => v,
        Err(e) => panic!("{method}: {e}"),
    }
}

/// Accepts host keys (the user would click "Accept" in the UI).
fn answer_prompts(st: &Arc<AppState>) {
    let st = st.clone();
    tokio::spawn(async move {
        loop {
            for p in st.prompts.pending() {
                let response = PromptResponse { accepted: true, values: vec![], remember: true };
                st.prompts.respond(&p.id, Some(response));
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    });
}

async fn names(st: &Arc<AppState>, session: &Value, path: &str) -> Vec<String> {
    let l = call(st, "fs.list", json!({ "session": session, "path": path })).await;
    l["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap().to_string()).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn explore_ssh_targets() {
    let (Some(host), Some(user), Some(password), Some(key), Some(no_sftp_port)) = (
        var("RC_TEST_SSH_HOST"),
        var("RC_TEST_SSH_USER"),
        var("RC_TEST_SSH_PASSWORD"),
        var("RC_TEST_SSH_KEY"),
        var("RC_TEST_SSH_NO_SFTP_PORT"),
    ) else {
        eprintln!("RC_TEST_SSH_* not set, skipping");
        return;
    };
    let port = var("RC_TEST_SSH_PORT").unwrap_or_else(|| "22".into());

    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(home.join(".ssh")).unwrap();
    std::fs::write(
        home.join(".ssh/config"),
        format!(
            "Host rc-direct\n  HostName {host}\n  Port {port}\n  User {user}\n  IdentityFile {key}\n\n\
             Host rc-behind\n  HostName {host}\n  Port {no_sftp_port}\n  User {user}\n  IdentityFile {key}\n  ProxyJump {user}@rc-direct\n\n\
             Host *\n  ServerAliveInterval 30\n"
        ),
    )
    .unwrap();
    std::env::set_var("HOME", &home);
    let st =
        AppState::new(InitOptions { mode: AppMode::Desktop, config_dir: Some(dir.path().join("cfg")) }).await.unwrap();
    answer_prompts(&st);

    // ~/.ssh/config hosts are targets without importing them; wildcards are not.
    let targets = call(&st, "explorer.targets", Value::Null).await;
    let by_id = |id: &str| targets.as_array().unwrap().iter().find(|t| t["id"] == id).cloned();
    let direct = by_id("ssh:rc-direct").expect("rc-direct listed");
    assert_eq!(direct["source"], "sshConfig");
    assert_eq!(direct["port"].to_string(), port);
    assert_eq!(by_id("ssh:rc-behind").unwrap()["jump"], "rc-direct");
    assert!(by_id("ssh:*").is_none());

    // SFTP target: list, follow a symlink-free path, preview text and binary files.
    let s = call(&st, "explorer.connect", json!({ "target": "ssh:rc-direct" })).await;
    assert_eq!(s["protocol"], "sftp");
    let home_dir = s["home"].as_str().unwrap().to_string();
    assert!(names(&st, &s["id"], &home_dir).await.contains(&"projects".to_string()));
    let readme = format!("{home_dir}/projects/README.md");
    let p = call(&st, "explorer.preview", json!({ "session": s["id"], "path": readme })).await;
    assert_eq!(p["content"], "hello explorer\n");
    assert_eq!(p["truncated"], false);
    let p = call(&st, "explorer.preview", json!({ "session": s["id"], "path": readme, "maxBytes": 5 })).await;
    assert_eq!(p["content"], "hello");
    assert_eq!(p["truncated"], true);
    let err = dispatch(&st, &Origin::Desktop, "explorer.preview", json!({ "session": s["id"], "path": "/dev/null" }))
        .await
        .unwrap_err();
    assert_eq!(err.code, "invalid_input", "devices are not previewed");

    // Through the jump host to a server without SFTP: shell commands instead.
    let b = call(&st, "explorer.connect", json!({ "target": "ssh:rc-behind" })).await;
    assert_eq!(b["protocol"], "scp", "falls back to shell commands");
    assert!(names(&st, &b["id"], &home_dir).await.contains(&"projects".to_string()));
    let p = call(&st, "explorer.preview", json!({ "session": b["id"], "path": readme })).await;
    assert_eq!(p["content"], "hello explorer\n");
    let info = call(&st, "session.info", json!({ "id": b["id"] })).await;
    assert!(info["items"].to_string().contains("Jump host"), "{info}");
    // A reconnect keeps using shell commands.
    let b2 = call(&st, "session.reconnect", json!({ "id": b["id"] })).await;
    assert_eq!(b2["protocol"], "scp");
    assert!(names(&st, &b2["id"], &home_dir).await.contains(&"projects".to_string()));

    // Ad-hoc address with a password.
    let a = call(
        &st,
        "explorer.connect",
        json!({ "address": format!("{user}@{host}:{no_sftp_port}"), "password": password }),
    )
    .await;
    assert_eq!(a["protocol"], "scp");
    assert!(names(&st, &a["id"], "/").await.contains(&"etc".to_string()));

    // A saved site for the same endpoint replaces the ~/.ssh/config entry.
    let mut site = call(&st, "sites.template", json!({ "protocol": "sftp" })).await;
    site["name"] = json!("Saved direct");
    site["host"] = json!(host);
    site["port"] = json!(port.parse::<u16>().unwrap());
    site["username"] = json!(user);
    site["ssh"]["privateKeyPath"] = json!(key);
    let site = call(&st, "sites.save", json!({ "site": site })).await;
    let targets = call(&st, "explorer.targets", Value::Null).await;
    let ids: Vec<&str> = targets.as_array().unwrap().iter().map(|t| t["id"].as_str().unwrap()).collect();
    assert!(ids.contains(&format!("site:{}", site["id"].as_str().unwrap()).as_str()), "{ids:?}");
    assert!(!ids.contains(&"ssh:rc-direct"), "{ids:?}");
    let c = call(&st, "explorer.connect", json!({ "target": format!("site:{}", site["id"].as_str().unwrap()) })).await;
    assert_eq!(c["siteId"], site["id"]);
    assert_eq!(c["protocol"], "sftp");

    for s in [&s, &b2, &a, &c] {
        call(&st, "session.close", json!({ "id": s["id"] })).await;
    }
}
