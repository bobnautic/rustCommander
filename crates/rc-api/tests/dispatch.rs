//! Calls the dispatcher with the exact JSON shapes of `ui/src/api/types.ts`.

use std::sync::Arc;

use serde_json::{json, Value};

use rc_api::{dispatch, AppMode, AppState, InitOptions, Origin};

async fn state() -> (tempfile::TempDir, Arc<AppState>) {
    let dir = tempfile::tempdir().unwrap();
    let st =
        AppState::new(InitOptions { mode: AppMode::Desktop, config_dir: Some(dir.path().join("cfg")) }).await.unwrap();
    (dir, st)
}

async fn call(st: &Arc<AppState>, method: &str, params: Value) -> Value {
    match dispatch(st, &Origin::Desktop, method, params).await {
        Ok(v) => v,
        Err(e) => panic!("{method}: {e}"),
    }
}

async fn wait_job(st: &Arc<AppState>, id: &str) -> Value {
    for _ in 0..200 {
        let jobs = call(st, "jobs.list", Value::Null).await;
        let j = jobs.as_array().unwrap().iter().find(|j| j["id"] == id).cloned().unwrap();
        if ["completed", "failed", "cancelled"].contains(&j["state"].as_str().unwrap()) {
            return j;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    panic!("job {id} did not finish");
}

#[tokio::test(flavor = "multi_thread")]
async fn contract_shapes() {
    let (dir, st) = state().await;
    let base = rc_core::local::from_native(dir.path());

    let info = call(&st, "app.info", Value::Null).await;
    assert_eq!(info["mode"], "desktop");
    assert!(info["features"]["protocols"].as_array().unwrap().contains(&json!("sftp")));

    // Settings round trip (camelCase).
    let mut settings = call(&st, "settings.get", Value::Null).await;
    assert!(settings["transfer"]["preserveTimestamps"].as_bool().unwrap());
    settings["showHidden"] = json!(true);
    settings["maxConcurrentJobs"] = json!(5);
    settings["discovery"]["enabled"] = json!(false);
    let saved = call(&st, "settings.set", json!({ "settings": settings })).await;
    assert_eq!(saved["showHidden"], true);
    assert_eq!(call(&st, "discovery.peers", Value::Null).await, json!([]));

    // Sites with secrets.
    let mut site = call(&st, "sites.template", json!({ "protocol": "ftp" })).await;
    assert_eq!(site["ftp"]["passive"], true);
    site["name"] = json!("My FTP");
    site["host"] = json!("ftp.example.org");
    site["password"] = json!("pw");
    site["folder"] = json!("Work/");
    let saved = call(&st, "sites.save", json!({ "site": site })).await;
    assert_eq!(saved["password"], "<<rc:secret>>");
    assert_eq!(saved["folder"], "Work");
    let list = call(&st, "sites.list", Value::Null).await;
    assert_eq!(list.as_array().unwrap().len(), 1);
    let url = call(&st, "sites.toUrl", json!({ "site": saved, "path": "/pub" })).await;
    assert_eq!(url, "ftp://ftp.example.org/pub");
    let from = call(&st, "sites.fromUrl", json!({ "url": "user@host:2222" })).await;
    assert_eq!(from["protocol"], "sftp");
    assert_eq!(from["port"], 2222);
    let imported = call(
        &st,
        "sites.import",
        json!({ "format": "openssh", "content": "Host box\n  HostName 10.0.0.1\n  User me\n" }),
    )
    .await;
    assert_eq!(imported["imported"], 1);

    // Sessions and file operations on the local session.
    let sessions = call(&st, "session.list", Value::Null).await;
    assert_eq!(sessions[0]["id"], "local");
    let work = format!("{base}/work");
    call(&st, "fs.mkdir", json!({ "session": "local", "path": format!("{work}/a/b"), "parents": true })).await;
    call(&st, "fs.writeText", json!({ "session": "local", "path": format!("{work}/a/x.txt"), "content": "hi" })).await;
    call(&st, "fs.createFile", json!({ "session": "local", "path": format!("{work}/a/empty.txt") })).await;
    let listing = call(&st, "fs.list", json!({ "session": "local", "path": format!("{work}/a") })).await;
    assert_eq!(listing["entries"].as_array().unwrap().len(), 3);
    call(&st, "fs.rename", json!({ "session": "local", "from": format!("{work}/a/x.txt"), "to": "y.txt" })).await;
    let txt = call(&st, "fs.readText", json!({ "session": "local", "path": format!("{work}/a/y.txt") })).await;
    assert_eq!(txt["content"], "hi");
    assert_eq!(txt["binary"], false);
    call(&st, "fs.setAttributes", json!({ "session": "local", "paths": [format!("{work}/a")], "permissions": 0o640, "dirPermissions": 0o750, "recursive": true })).await;
    let stat = call(&st, "fs.stat", json!({ "session": "local", "path": format!("{work}/a/y.txt") })).await;
    if cfg!(unix) {
        assert_eq!(stat["permissions"], 0o640);
    }
    let size = call(&st, "fs.dirSize", json!({ "session": "local", "path": work.clone() })).await;
    assert_eq!(size["files"], 2);
    let sum =
        call(&st, "fs.checksum", json!({ "session": "local", "path": format!("{work}/a/y.txt"), "algo": "md5" })).await;
    assert_eq!(sum, "49f68a5c8493ec2c0bf489821c21fc3b");

    // Transfer with a conflict question answered through jobs.resolveConflict.
    let job = call(&st, "transfer.start", json!({ "srcSession": "local", "srcPaths": [format!("{work}/a")], "dstSession": "local", "dstDir": format!("{base}/copy"), "options": { "parallel": 1 } })).await;
    assert_eq!(wait_job(&st, job["id"].as_str().unwrap()).await["state"], "completed");
    let job = call(&st, "transfer.start", json!({ "srcSession": "local", "srcPaths": [format!("{work}/a/y.txt")], "dstSession": "local", "dstDir": format!("{base}/copy/a"), "options": { "overwrite": "ask" } })).await;
    let id = job["id"].as_str().unwrap().to_string();
    let mut answered = false;
    for _ in 0..200 {
        let jobs = call(&st, "jobs.list", Value::Null).await;
        let j = jobs.as_array().unwrap().iter().find(|j| j["id"] == id).cloned().unwrap();
        if j["state"] == "waiting" {
            call(&st, "jobs.resolveConflict", json!({ "id": id, "conflictId": j["conflict"]["id"], "action": "rename", "applyToAll": false, "newName": "renamed.txt" })).await;
            answered = true;
        }
        if j["state"] == "completed" {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
    assert!(answered);
    assert!(dir.path().join("copy/a/renamed.txt").exists());

    // Sync compare + execute.
    let mut params = call(&st, "sync.defaults", Value::Null).await;
    params["leftPath"] = json!(work.clone());
    params["rightPath"] = json!(format!("{base}/mirror"));
    params["rightSession"] = json!("local");
    let plan = call(&st, "sync.compare", json!({ "params": params })).await;
    let ids: Vec<Value> = plan["actions"].as_array().unwrap().iter().map(|a| a["id"].clone()).collect();
    assert_eq!(plan["actions"][0]["action"], "copyLeftToRight");
    let job = call(&st, "sync.execute", json!({ "planId": plan["id"], "actionIds": ids })).await;
    assert_eq!(wait_job(&st, job["id"].as_str().unwrap()).await["state"], "completed");
    assert!(dir.path().join("mirror/a/y.txt").exists());

    // Delete job, bookmarks, custom commands, archive.
    let job = call(&st, "fs.delete", json!({ "session": "local", "paths": [format!("{base}/mirror")] })).await;
    assert_eq!(wait_job(&st, job["id"].as_str().unwrap()).await["state"], "completed");
    let b = call(
        &st,
        "bookmarks.save",
        json!({ "bookmark": { "id": "", "name": "Work", "scope": "local", "path": work } }),
    )
    .await;
    assert_eq!(call(&st, "bookmarks.list", Value::Null).await.as_array().unwrap().len(), 1);
    call(&st, "bookmarks.delete", json!({ "id": b["id"] })).await;
    if cfg!(unix) {
        let out = call(
            &st,
            "commands.run",
            json!({ "command": "ls !&", "session": "local", "cwd": format!("{work}/a"), "names": ["y.txt"] }),
        )
        .await;
        assert_eq!(out[0]["stdout"], "y.txt\n");
    }
    let job = call(
        &st,
        "archive.create",
        json!({ "session": "local", "paths": [format!("{work}/a")], "dst": format!("{base}/a.zip"), "format": "zip" }),
    )
    .await;
    assert_eq!(wait_job(&st, job["id"].as_str().unwrap()).await["state"], "completed");
    call(&st, "jobs.clearFinished", Value::Null).await;
    assert_eq!(call(&st, "jobs.list", Value::Null).await, json!([]));

    // Search with streamed results.
    let mut rx = st.events.subscribe();
    let s = call(&st, "search.start", json!({ "params": { "session": "local", "root": base, "nameMask": "*.txt", "caseSensitive": false, "includeHidden": false, "includeDirs": false } })).await;
    let mut found = 0;
    loop {
        let ev = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv()).await.unwrap().unwrap();
        if ev.name == "search.result" && ev.payload["id"] == s["id"] {
            found += ev.payload["entries"].as_array().unwrap().len();
        }
        if ev.name == "search.done" && ev.payload["id"] == s["id"] {
            break;
        }
    }
    assert!(found >= 4, "found {found}");

    // Local terminal echo.
    if cfg!(unix) {
        let t = call(&st, "terminal.open", json!({ "session": "local", "cols": 80, "rows": 24 })).await;
        call(&st, "terminal.write", json!({ "id": t["id"], "data": "echo RC_$((6*7))\n" })).await;
        let mut out = String::new();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !out.contains("RC_42") && std::time::Instant::now() < deadline {
            if let Ok(Ok(ev)) = tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv()).await {
                if ev.name == "terminal.data" {
                    use base64::Engine;
                    let bytes =
                        base64::engine::general_purpose::STANDARD.decode(ev.payload["data"].as_str().unwrap()).unwrap();
                    out.push_str(&String::from_utf8_lossy(&bytes));
                }
            }
        }
        assert!(out.contains("RC_42"), "{out}");
        call(&st, "terminal.close", json!({ "id": t["id"] })).await;
    }

    // Remote explorer: SSH sites are targets, other protocols are not.
    let mut ssh_site = call(&st, "sites.template", json!({ "protocol": "sftp" })).await;
    ssh_site["name"] = json!("Box");
    ssh_site["host"] = json!("box.example.org");
    ssh_site["username"] = json!("me");
    let ssh_site = call(&st, "sites.save", json!({ "site": ssh_site })).await;
    let targets = call(&st, "explorer.targets", Value::Null).await;
    let targets = targets.as_array().unwrap();
    let t = targets.iter().find(|t| t["siteId"] == ssh_site["id"]).expect("ssh site is a target");
    assert_eq!(t["id"], format!("site:{}", ssh_site["id"].as_str().unwrap()));
    assert_eq!(t["source"], "site");
    assert_eq!(t["port"], 22);
    assert!(!targets.iter().any(|t| t["siteId"] == saved["id"]), "FTP sites are not explorer targets");
    let err = dispatch(&st, &Origin::Desktop, "explorer.connect", json!({ "target": "nope:1" })).await.unwrap_err();
    assert_eq!(err.code, "invalid_input");
    let err = dispatch(&st, &Origin::Desktop, "explorer.connect", json!({ "address": "ftp://x" })).await.unwrap_err();
    assert_eq!(err.code, "invalid_input");

    // Read-only preview of the beginning of a file.
    call(&st, "fs.writeText", json!({ "session": "local", "path": format!("{work}/p.txt"), "content": "grüße\nzwei" }))
        .await;
    let p = call(&st, "explorer.preview", json!({ "session": "local", "path": format!("{work}/p.txt") })).await;
    assert_eq!(p["content"], "grüße\nzwei");
    assert_eq!(p["truncated"], false);
    assert_eq!(p["binary"], false);
    let p =
        call(&st, "explorer.preview", json!({ "session": "local", "path": format!("{work}/p.txt"), "maxBytes": 4 }))
            .await;
    assert_eq!(p["content"], "grü");
    assert_eq!(p["truncated"], true);
    assert_eq!(p["size"], 12);
    std::fs::write(dir.path().join("work/bin.dat"), [1u8, 0, 2, 3]).unwrap();
    let p = call(&st, "explorer.preview", json!({ "session": "local", "path": format!("{work}/bin.dat") })).await;
    assert_eq!(p["binary"], true);
    assert_eq!(p["content"], "");
    let err = dispatch(&st, &Origin::Desktop, "explorer.preview", json!({ "session": "local", "path": work.clone() }))
        .await
        .unwrap_err();
    assert_eq!(err.code, "is_a_directory");

    // Vault with master password re-encrypts stored secrets.
    call(&st, "vault.setMasterPassword", json!({ "newPassword": "master" })).await;
    let site_id = saved["id"].as_str().unwrap();
    assert_eq!(st.sites.get_decrypted(site_id).unwrap().password.as_deref(), Some("pw"));
    call(&st, "vault.lock", Value::Null).await;
    let err = dispatch(&st, &Origin::Desktop, "session.open", json!({ "siteId": site_id })).await.unwrap_err();
    assert_eq!(err.code, "locked");
    call(&st, "vault.unlock", json!({ "password": "master" })).await;

    // Web clients cannot use desktop-only methods.
    let err = dispatch(&st, &Origin::Web { remote: None }, "app.open", json!({ "target": "/" })).await.unwrap_err();
    assert_eq!(err.code, "forbidden");
    let err = dispatch(&st, &Origin::Desktop, "no.such", Value::Null).await.unwrap_err();
    assert_eq!(err.code, "unknown_method");
}

#[tokio::test(flavor = "multi_thread")]
async fn compare_pairs_before_copy() {
    let (dir, st) = state().await;
    let base = rc_core::local::from_native(dir.path());
    let write = |rel: &str, content: &str| {
        let p = dir.path().join(rel);
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, content).unwrap();
    };
    write("src/site/index.html", "<h1>new</h1>");
    write("src/site/css/main.css", "body{}");
    write("src/site/js/app.js", "same");
    write("src/notes.txt", "hello");
    write("dst/site/index.html", "<h1>old</h1>");
    write("dst/site/js/app.js", "same");
    write("dst/site/only-at-target.txt", "x");
    write("dst/notes.txt", "hello");

    let r = call(
        &st,
        "compare.pairs",
        json!({ "srcSession": "local", "srcPaths": [format!("{base}/src/site"), format!("{base}/src/notes.txt")], "dstSession": "local", "dstDir": format!("{base}/dst") }),
    )
    .await;
    assert_eq!(r["truncated"], false);
    let pairs = r["pairs"].as_array().unwrap();
    let rels: Vec<&str> = pairs.iter().map(|p| p["rel"].as_str().unwrap()).collect();
    assert_eq!(rels, ["site/css/main.css", "site/index.html", "site/js/app.js", "notes.txt"]);
    assert!(pairs[0]["target"].is_null());
    assert_eq!(pairs[0]["targetPath"], format!("{base}/dst/site/css/main.css"));
    assert_eq!(pairs[1]["target"]["path"], format!("{base}/dst/site/index.html"));
    assert_eq!(pairs[2]["target"]["size"], 4);
    assert_eq!(pairs[3]["source"]["path"], format!("{base}/src/notes.txt"));

    // Fingerprints of a pair: the UI compares the checksums of both sides.
    let sum = |path: String| call(&st, "fs.checksum", json!({ "session": "local", "path": path, "algo": "sha256" }));
    assert_eq!(sum(format!("{base}/src/site/js/app.js")).await, sum(format!("{base}/dst/site/js/app.js")).await);
    assert_ne!(sum(format!("{base}/src/site/index.html")).await, sum(format!("{base}/dst/site/index.html")).await);

    // Single item copied under a new name, masks and the file limit.
    let r = call(
        &st,
        "compare.pairs",
        json!({ "srcSession": "local", "srcPaths": [format!("{base}/src/notes.txt")], "dstSession": "local", "dstDir": format!("{base}/dst/site"), "newName": "index.html" }),
    )
    .await;
    assert_eq!(r["pairs"][0]["rel"], "index.html");
    assert_eq!(r["pairs"][0]["target"]["name"], "index.html");
    let r = call(
        &st,
        "compare.pairs",
        json!({ "srcSession": "local", "srcPaths": [format!("{base}/src/site")], "dstSession": "local", "dstDir": format!("{base}/dst"), "fileMask": "*.js; *.css" }),
    )
    .await;
    assert_eq!(r["pairs"].as_array().unwrap().len(), 2);
    let r = call(
        &st,
        "compare.pairs",
        json!({ "srcSession": "local", "srcPaths": [format!("{base}/src/site")], "dstSession": "local", "dstDir": format!("{base}/dst"), "maxFiles": 2 }),
    )
    .await;
    assert_eq!(r["pairs"].as_array().unwrap().len(), 2);
    assert_eq!(r["truncated"], true);
    let err = dispatch(&st, &Origin::Desktop, "compare.pairs", json!({ "srcSession": "local", "srcPaths": [format!("{base}/missing")], "dstSession": "local", "dstDir": base })).await.unwrap_err();
    assert_eq!(err.code, "not_found");
}

#[tokio::test(flavor = "multi_thread")]
async fn editor_settings_and_formatters() {
    let (_dir, st) = state().await;
    let settings = call(&st, "settings.get", Value::Null).await;
    assert_eq!(settings["editor"]["lint"], true);
    assert_eq!(settings["editor"]["formatOnSave"], false);
    assert_eq!(settings["editor"]["printWidth"], 80);

    let list = call(&st, "edit.formatters", Value::Null).await;
    let ids: Vec<&str> = list.as_array().unwrap().iter().map(|f| f["id"].as_str().unwrap()).collect();
    let err = dispatch(&st, &Origin::Desktop, "edit.format", json!({ "language": "COBOL", "content": "x" }))
        .await
        .unwrap_err();
    assert_eq!(err.code, "unsupported");
    if ids.contains(&"rustfmt") {
        let r = call(
            &st,
            "edit.format",
            json!({ "language": "Rust", "fileName": "a.rs", "content": "fn f(){}", "tabSize": 2, "useTabs": false }),
        )
        .await;
        assert_eq!(r["content"], "fn f() {}\n");
        assert_eq!(r["formatter"], "rustfmt");
    }
}
