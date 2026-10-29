use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{ConnectInfo, DefaultBodyLimit, Query, Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use axum::{Json, Router};
use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::json;

use rc_api::{dispatch, AppState, Origin, RpcError};
use rc_core::path as vpath;
use rc_core::{FileKind, WriteOptions};

#[derive(RustEmbed)]
#[folder = "../../ui/dist"]
struct Assets;

const COOKIE: &str = "rc_session";

#[derive(Clone)]
struct Ctx {
    state: Arc<AppState>,
    clients: Arc<AtomicUsize>,
    tls: bool,
    failures: Arc<Mutex<HashMap<IpAddr, (u32, Instant)>>>,
}

pub fn router(state: Arc<AppState>, clients: Arc<AtomicUsize>, tls: bool) -> Router {
    let ctx = Ctx { state, clients, tls, failures: Arc::new(Mutex::new(HashMap::new())) };
    let protected = Router::new()
        .route("/api/rpc", post(rpc))
        .route("/api/events", get(events))
        .route("/api/download", get(download))
        .route("/api/upload", put(upload).layer(DefaultBodyLimit::disable()))
        .route_layer(middleware::from_fn_with_state(ctx.clone(), require_auth));
    Router::new()
        .route("/api/info", get(info))
        .route("/api/login", post(login))
        .route("/api/logout", post(logout))
        .merge(protected)
        .fallback(static_file)
        .layer(middleware::from_fn(security_headers))
        .with_state(ctx)
}

async fn security_headers(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    h.insert("x-frame-options", HeaderValue::from_static("DENY"));
    h.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    h.insert(
        "content-security-policy",
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; \
             img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' ws: wss:; \
             worker-src 'self' blob:; frame-ancestors 'none'; object-src 'none'",
        ),
    );
    res
}

fn token_from(headers: &HeaderMap) -> (Option<String>, bool) {
    if let Some(auth) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        if let Some(t) = auth.strip_prefix("Bearer ") {
            return (Some(t.trim().to_string()), true);
        }
    }
    let cookie = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|c| c.trim().split_once('='))
        .find(|(k, _)| *k == COOKIE)
        .map(|(_, v)| v.to_string());
    (cookie, false)
}

fn error(status: StatusCode, code: &str, message: impl Into<String>) -> Response {
    (status, Json(json!({ "error": { "code": code, "message": message.into() } }))).into_response()
}

fn rpc_error(e: RpcError) -> Response {
    let status = StatusCode::from_u16(rc_api::dispatch::http_status(&e.code)).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    error(status, &e.code, e.message)
}

async fn require_auth(State(ctx): State<Ctx>, req: Request, next: Next) -> Response {
    if !ctx.state.server_auth.is_disabled() {
        let (token, bearer) = token_from(req.headers());
        let valid = token.as_deref().is_some_and(|t| ctx.state.server_auth.check_token(t));
        if !valid {
            return error(StatusCode::UNAUTHORIZED, "unauthorized", "login required");
        }
        // CSRF: cookie-authenticated mutating requests must carry our custom header,
        // which cross-site forms cannot set.
        if !bearer && req.method() != Method::GET && req.headers().get("x-rc-request").is_none() {
            return error(StatusCode::FORBIDDEN, "forbidden", "missing X-RC-Request header");
        }
    }
    next.run(req).await
}

async fn info(State(ctx): State<Ctx>, headers: HeaderMap) -> Response {
    let (token, _) = token_from(&headers);
    let authenticated = ctx.state.server_auth.is_disabled() || token.as_deref().is_some_and(|t| ctx.state.server_auth.check_token(t));
    Json(json!({
        "name": ctx.state.instance_name(),
        "version": rc_core::VERSION,
        "authRequired": !ctx.state.server_auth.is_disabled(),
        "authenticated": authenticated,
        "instance": ctx.state.instance_info(),
    }))
    .into_response()
}

#[derive(Deserialize)]
struct LoginBody {
    password: String,
}

async fn login(State(ctx): State<Ctx>, ConnectInfo(addr): ConnectInfo<SocketAddr>, Json(body): Json<LoginBody>) -> Response {
    let ip = addr.ip();
    {
        let mut f = ctx.failures.lock();
        f.retain(|_, (_, t)| t.elapsed() < Duration::from_secs(600));
        if let Some((n, t)) = f.get(&ip) {
            if *n >= 5 && t.elapsed() < Duration::from_secs(60) {
                return error(StatusCode::TOO_MANY_REQUESTS, "forbidden", "too many failed logins, wait a minute");
            }
        }
    }
    if !ctx.state.server_auth.verify_password(&body.password) {
        // Slow down guessing.
        tokio::time::sleep(Duration::from_millis(700)).await;
        let mut f = ctx.failures.lock();
        let e = f.entry(ip).or_insert((0, Instant::now()));
        e.0 += 1;
        e.1 = Instant::now();
        tracing::warn!("failed web login from {ip}");
        return error(StatusCode::UNAUTHORIZED, "unauthorized", "wrong password");
    }
    ctx.failures.lock().remove(&ip);
    let token = ctx.state.server_auth.create_token();
    tracing::info!("web login from {ip}");
    let cookie = format!(
        "{COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800{}",
        if ctx.tls { "; Secure" } else { "" }
    );
    let mut res = Json(json!({ "token": token })).into_response();
    if let Ok(v) = HeaderValue::from_str(&cookie) {
        res.headers_mut().insert(header::SET_COOKIE, v);
    }
    res
}

async fn logout(State(ctx): State<Ctx>, headers: HeaderMap) -> Response {
    if let (Some(t), _) = token_from(&headers) {
        ctx.state.server_auth.revoke(&t);
    }
    let mut res = Json(json!({})).into_response();
    res.headers_mut()
        .insert(header::SET_COOKIE, HeaderValue::from_static("rc_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"));
    res
}

#[derive(Deserialize)]
struct RpcBody {
    method: String,
    #[serde(default)]
    params: serde_json::Value,
}

async fn rpc(State(ctx): State<Ctx>, ConnectInfo(addr): ConnectInfo<SocketAddr>, Json(body): Json<RpcBody>) -> Response {
    let origin = Origin::Web { remote: Some(addr.to_string()) };
    match dispatch(&ctx.state, &origin, &body.method, body.params).await {
        Ok(result) => Json(json!({ "result": result })).into_response(),
        Err(e) => rpc_error(e),
    }
}

async fn events(State(ctx): State<Ctx>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| event_loop(ctx, socket))
}

async fn event_loop(ctx: Ctx, socket: WebSocket) {
    ctx.clients.fetch_add(1, Ordering::Relaxed);
    let st = ctx.state.clone();
    let mut rx = st.events.subscribe();
    st.events.emit("server.status", rc_api::dispatch::server_status(&st));
    let (mut tx, mut incoming) = socket.split();
    let mut ping = tokio::time::interval(Duration::from_secs(25));
    loop {
        tokio::select! {
            ev = rx.recv() => match ev {
                Ok(ev) => {
                    let Ok(text) = serde_json::to_string(&ev) else { continue };
                    if tx.send(Message::Text(text.into())).await.is_err() { break; }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!("web client lagged behind by {n} events");
                    let resync = json!({ "name": "resync", "payload": null }).to_string();
                    if tx.send(Message::Text(resync.into())).await.is_err() { break; }
                }
                Err(_) => break,
            },
            msg = incoming.next() => match msg {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                _ => {}
            },
            _ = ping.tick() => {
                if tx.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
            }
            _ = st.shutdown.cancelled() => break,
        }
    }
    ctx.clients.fetch_sub(1, Ordering::Relaxed);
    st.events.emit("server.status", rc_api::dispatch::server_status(&st));
}

fn content_disposition(name: &str, inline: bool) -> String {
    let ascii: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || "._- ()".contains(c) { c } else { '_' }).collect();
    let encoded = percent_encoding::utf8_percent_encode(name, percent_encoding::NON_ALPHANUMERIC).to_string();
    format!("{}; filename=\"{ascii}\"; filename*=UTF-8''{encoded}", if inline { "inline" } else { "attachment" })
}

async fn download(State(ctx): State<Ctx>, Query(q): Query<Vec<(String, String)>>, headers: HeaderMap) -> Response {
    let session = q.iter().find(|(k, _)| k == "session").map(|(_, v)| v.clone()).unwrap_or_default();
    let paths: Vec<String> = q.iter().filter(|(k, _)| k == "path").map(|(_, v)| v.clone()).collect();
    let inline = q.iter().any(|(k, v)| k == "inline" && v == "1");
    let vfs = match ctx.state.vfs(&session) {
        Ok(v) => v,
        Err(e) => return rpc_error(e.into()),
    };
    if paths.is_empty() {
        return error(StatusCode::BAD_REQUEST, "invalid_input", "path required");
    }
    if paths.len() == 1 {
        let entry = match vfs.stat(&paths[0]).await {
            Ok(e) => e,
            Err(e) => return rpc_error(e.into()),
        };
        if !entry.is_dir() {
            return stream_file(vfs, entry, &headers, inline).await;
        }
    }
    zip_download(ctx, vfs, paths).await
}

async fn stream_file(vfs: Arc<dyn rc_core::Vfs>, entry: rc_core::FileEntry, headers: &HeaderMap, inline: bool) -> Response {
    // Only "bytes=N-" ranges (resume) are supported.
    let mut offset = 0u64;
    if let Some(r) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
        if let Some(start) = r.strip_prefix("bytes=").and_then(|s| s.strip_suffix('-')) {
            offset = start.parse().unwrap_or(0);
        }
    }
    if offset > entry.size {
        offset = 0;
    }
    let mut reader = match vfs.open_read(&entry.path, offset).await {
        Ok(r) => r,
        Err(e) => return rpc_error(e.into()),
    };
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(8);
    tokio::spawn(async move {
        let mut buf = vec![0u8; 256 * 1024];
        loop {
            match reader.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(Ok(bytes::Bytes::copy_from_slice(&buf[..n]))).await.is_err() {
                        break;
                    }
                }
                Err(e) => {
                    let _ = tx.send(Err(std::io::Error::other(e.to_string()))).await;
                    break;
                }
            }
        }
    });
    let body = Body::from_stream(tokio_stream_from(rx));
    let mut res = Response::new(body);
    let h = res.headers_mut();
    let mime = mime_guess::from_path(&entry.name).first_or_octet_stream();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(mime.as_ref()).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(entry.size - offset));
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    if let Ok(v) = HeaderValue::from_str(&content_disposition(&entry.name, inline)) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    if offset > 0 {
        *res.status_mut() = StatusCode::PARTIAL_CONTENT;
        if let Ok(v) = HeaderValue::from_str(&format!("bytes {offset}-{}/{}", entry.size.saturating_sub(1), entry.size)) {
            res.headers_mut().insert(header::CONTENT_RANGE, v);
        }
    }
    res
}

fn tokio_stream_from<T: Send + 'static>(mut rx: tokio::sync::mpsc::Receiver<T>) -> impl futures::Stream<Item = T> + Send {
    futures::stream::poll_fn(move |cx| rx.poll_recv(cx))
}

/// Stream several files/directories as one ZIP archive (zip64, stored).
async fn zip_download(ctx: Ctx, vfs: Arc<dyn rc_core::Vfs>, paths: Vec<String>) -> Response {
    use async_zip::base::write::ZipFileWriter;
    use async_zip::{Compression, ZipDateTime, ZipEntryBuilder};
    use futures::AsyncWriteExt as _;

    let name = if paths.len() == 1 {
        format!("{}.zip", vpath::file_name(&paths[0]))
    } else {
        format!("{}.zip", ctx.state.instance_name())
    };
    let (writer, reader) = tokio::io::duplex(256 * 1024);
    tokio::spawn(async move {
        let mut zip = ZipFileWriter::with_tokio(writer).force_zip64();
        let mut buf = vec![0u8; 256 * 1024];
        for root in paths {
            let base = vpath::parent(&root);
            let mut items: Vec<rc_core::FileEntry> = Vec::new();
            match vfs.stat(&root).await {
                Ok(e) => items.push(e),
                Err(e) => {
                    tracing::warn!("zip download {root}: {e}");
                    continue;
                }
            }
            if items[0].is_dir() {
                let _ = rc_core::ops::walk(vfs.as_ref(), &root, &rc_core::ops::WalkOptions::default(), |w| {
                    items.push(w.entry);
                    Ok(true)
                })
                .await;
            }
            for e in items {
                let rel = vpath::relative_to(&e.path, &base).unwrap_or_else(|| e.name.clone());
                let date = e
                    .modified
                    .and_then(|m| chrono::DateTime::from_timestamp(m, 0))
                    .map(|d| ZipDateTime::from_chrono(&d))
                    .unwrap_or_default();
                if e.kind == FileKind::Dir {
                    let b = ZipEntryBuilder::new(format!("{rel}/").into(), Compression::Stored).last_modification_date(date);
                    if zip.write_entry_whole(b, &[]).await.is_err() {
                        return;
                    }
                    continue;
                }
                if e.is_dir() {
                    continue;
                }
                let mut b = ZipEntryBuilder::new(rel.clone().into(), Compression::Stored).last_modification_date(date);
                if let Some(p) = e.permissions {
                    b = b.unix_permissions(p as u16);
                }
                let Ok(mut r) = vfs.open_read(&e.path, 0).await else { continue };
                let Ok(mut w) = zip.write_entry_stream(b).await else { return };
                loop {
                    match r.read(&mut buf).await {
                        Ok(0) => break,
                        Ok(n) => {
                            if w.write_all(&buf[..n]).await.is_err() {
                                return;
                            }
                        }
                        Err(err) => {
                            tracing::warn!("zip download {}: {err}", e.path);
                            break;
                        }
                    }
                }
                if w.close().await.is_err() {
                    return;
                }
            }
        }
        let _ = zip.close().await;
    });
    let stream = tokio_util::io::ReaderStream::new(reader);
    let mut res = Response::new(Body::from_stream(stream));
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/zip"));
    if let Ok(v) = HeaderValue::from_str(&content_disposition(&name, false)) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    res
}

#[derive(Deserialize)]
struct UploadQuery {
    session: String,
    path: String,
    #[serde(default)]
    offset: u64,
}

async fn upload(State(ctx): State<Ctx>, Query(q): Query<UploadQuery>, body: Body) -> Response {
    let vfs = match ctx.state.vfs(&q.session) {
        Ok(v) => v,
        Err(e) => return rpc_error(e.into()),
    };
    if vpath::file_name(&q.path).is_empty() {
        return error(StatusCode::BAD_REQUEST, "invalid_input", "target file name required");
    }
    let mut writer = match vfs.open_write(&q.path, WriteOptions { offset: q.offset, ..Default::default() }).await {
        Ok(w) => w,
        Err(e) => return rpc_error(e.into()),
    };
    let mut stream = body.into_data_stream();
    let mut total = q.offset;
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => return error(StatusCode::BAD_REQUEST, "io", format!("upload interrupted: {e}")),
        };
        if let Err(e) = writer.write_all(&chunk).await {
            return rpc_error(e.into());
        }
        total += chunk.len() as u64;
    }
    if let Err(e) = writer.finish().await {
        return rpc_error(e.into());
    }
    tracing::info!(session = %q.session, "uploaded {} ({} bytes) from browser", q.path, total);
    ctx.state.emit_changed(&q.session, &vpath::parent(&q.path));
    Json(json!({ "size": total })).into_response()
}

async fn static_file(req: Request) -> Response {
    let path = req.uri().path().trim_start_matches('/');
    if path.starts_with("api/") {
        return error(StatusCode::NOT_FOUND, "not_found", "no such endpoint");
    }
    let (file, name) = match Assets::get(path) {
        Some(f) if !path.is_empty() => (f, path.to_string()),
        // SPA: everything else is the app shell.
        _ => match Assets::get("index.html") {
            Some(f) => (f, "index.html".to_string()),
            None => return (StatusCode::NOT_FOUND, "UI not built").into_response(),
        },
    };
    let mime = mime_guess::from_path(&name).first_or_octet_stream();
    let cache = if name == "index.html" { "no-cache" } else if name.starts_with("assets/") { "public, max-age=31536000, immutable" } else { "public, max-age=3600" };
    let mut res = Response::new(Body::from(file.data.into_owned()));
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(mime.as_ref()).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    res
}
