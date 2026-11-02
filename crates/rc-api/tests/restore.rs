//! Sessions and jobs survive a restart: a real SSH connection is opened again under its old
//! id, and an interrupted upload to it continues.
//!
//! Skipped unless `RC_TEST_SSH_HOST`, `RC_TEST_SSH_PORT` (default 22), `RC_TEST_SSH_USER`,
//! `RC_TEST_SSH_PASSWORD` and `RC_TEST_SSH_KEY` (an unencrypted authorized key) are set.

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

/// Accepts host keys and remembers them (the user would click "Accept" in the UI).
fn answer_prompts(st: &Arc<AppState>) {
    let st = st.clone();
    tokio::spawn(async move {
        loop {
            for p in st.prompts.pending() {
                st.prompts.respond(&p.id, Some(PromptResponse { accepted: true, values: vec![], remember: true }));
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    });
}

async fn state(cfg: &std::path::Path) -> Arc<AppState> {
    AppState::new(InitOptions { mode: AppMode::Desktop, config_dir: Some(cfg.to_path_buf()) }).await.unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn ssh_session_and_upload_come_back_after_a_restart() {
    let (Some(host), Some(user), Some(_password), Some(key)) =
        (var("RC_TEST_SSH_HOST"), var("RC_TEST_SSH_USER"), var("RC_TEST_SSH_PASSWORD"), var("RC_TEST_SSH_KEY"))
    else {
        eprintln!("RC_TEST_SSH_* not set, skipping");
        return;
    };
    let port: u16 = var("RC_TEST_SSH_PORT").and_then(|p| p.parse().ok()).unwrap_or(22);
    let dir = tempfile::tempdir().unwrap();
    let cfg = dir.path().join("cfg");
    let src = dir.path().join("upload");
    std::fs::create_dir_all(&src).unwrap();
    for i in 0..20 {
        std::fs::write(src.join(format!("f{i}.bin")), vec![i as u8; 64 * 1024]).unwrap();
    }

    // First run: connect (ad-hoc, key authentication), start an upload, quit while paused.
    let st = state(&cfg).await;
    answer_prompts(&st);
    let mut site = call(&st, "sites.template", json!({ "protocol": "sftp" })).await;
    site["name"] = json!("restore test");
    site["host"] = json!(host);
    site["port"] = json!(port);
    site["username"] = json!(user);
    site["ssh"]["privateKeyPath"] = json!(key);
    site["ssh"]["useAgent"] = json!(false);
    site["ssh"]["tryDefaultKeys"] = json!(false);
    site["ssh"]["tryPassword"] = json!(false);
    site["ssh"]["useOpensshKnownHosts"] = json!(false);
    let s = call(&st, "session.open", json!({ "site": site })).await;
    let sid = s["id"].as_str().unwrap().to_string();
    let home = s["home"].as_str().unwrap().to_string();
    let target = format!("{home}/rc-restore-{}", uuid::Uuid::new_v4().simple());
    call(&st, "fs.mkdir", json!({ "session": sid, "path": target })).await;
    let job = call(
        &st,
        "transfer.start",
        json!({ "srcSession": "local", "srcPaths": [rc_core::local::from_native(&src)], "dstSession": sid, "dstDir": target,
                "options": { "overwrite": "overwrite", "speedLimit": 256 * 1024, "parallel": 1 } }),
    )
    .await;
    let job_id = job["id"].as_str().unwrap().to_string();
    // Let it copy some files, then pause and quit.
    for _ in 0..100 {
        let j = call(&st, "jobs.list", Value::Null).await;
        let done =
            j.as_array().unwrap().iter().find(|x| x["id"] == job_id.as_str()).unwrap()["filesDone"].as_u64().unwrap();
        if done >= 3 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    call(&st, "jobs.pause", json!({ "id": job_id })).await;
    st.shutdown().await;
    drop(st);

    // Second run: the session is connected again with the same id, the job continues.
    let st = state(&cfg).await;
    answer_prompts(&st);
    st.start_background().await;
    let mut back = false;
    for _ in 0..200 {
        if call(&st, "session.list", Value::Null).await.as_array().unwrap().iter().any(|x| x["id"] == sid.as_str()) {
            back = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(back, "session {sid} was not restored");
    let jobs = call(&st, "jobs.list", Value::Null).await;
    let j = jobs.as_array().unwrap().iter().find(|x| x["id"] == job_id.as_str()).cloned().expect("restored job");
    assert_eq!(j["state"], "paused");
    call(&st, "jobs.setSpeedLimit", json!({ "id": job_id, "bytesPerSec": 0 })).await;
    call(&st, "jobs.resume", json!({ "id": job_id })).await;
    let mut finished = Value::Null;
    for _ in 0..400 {
        let jobs = call(&st, "jobs.list", Value::Null).await;
        let j = jobs.as_array().unwrap().iter().find(|x| x["id"] == job_id.as_str()).cloned().unwrap();
        if ["completed", "failed", "cancelled"].contains(&j["state"].as_str().unwrap()) {
            finished = j;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(finished["state"], "completed", "{finished}");
    let listing = call(&st, "fs.list", json!({ "session": sid, "path": format!("{target}/upload") })).await;
    let entries = listing["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 20);
    assert!(entries.iter().all(|e| e["size"] == 64 * 1024));

    // Clean up with the server-side shortcut (rm -rf) through the delete job.
    let del = call(&st, "fs.delete", json!({ "session": sid, "paths": [target] })).await;
    for _ in 0..200 {
        let jobs = call(&st, "jobs.list", Value::Null).await;
        let j = jobs.as_array().unwrap().iter().find(|x| x["id"] == del["id"]).cloned().unwrap();
        if j["state"] == "completed" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    call(&st, "session.close", json!({ "id": sid })).await;
    let saved: Value = serde_json::from_slice(&std::fs::read(cfg.join("sessions.json")).unwrap()).unwrap();
    assert_eq!(saved, json!([]), "a closed session is not opened again");
    st.shutdown().await;
}
