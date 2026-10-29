//! Rust Commander desktop app: a Tauri shell around [`rc_api`].
//!
//! The webview calls the single command `rpc(method, params)`; every backend event is
//! forwarded as the Tauri event `rc-event` (`{ name, payload }`). The same `AppState`
//! can be exposed to browsers with the embedded web server ("share this instance").

use std::sync::Arc;

use serde_json::Value;
use tauri::{Emitter, Manager};

use rc_api::server::ServerControl;
use rc_api::{dispatch, AppMode, AppState, InitOptions, Origin, RpcError};

#[tauri::command]
async fn rpc(state: tauri::State<'_, Arc<AppState>>, method: String, params: Option<Value>) -> Result<Value, RpcError> {
    dispatch(&state, &Origin::Desktop, &method, params.unwrap_or(Value::Null)).await
}

pub fn run() {
    rc_api::logs::init_tracing("info,rustls=warn,hyper=warn,tao=warn,wry=warn");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let state = tauri::async_runtime::block_on(async {
                let state = AppState::new(InitOptions { mode: AppMode::Desktop, config_dir: None }).await?;
                *state.server.write() = Some(rc_server::WebServer::new() as Arc<dyn ServerControl>);
                state.start_background().await;
                Ok::<_, rc_core::Error>(state)
            })?;

            // Backend events → webview.
            let mut rx = state.events.subscribe();
            let ev_handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    match rx.recv().await {
                        Ok(ev) => {
                            let _ = ev_handle.emit("rc-event", &ev);
                        }
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => break,
                    }
                }
            });

            // "Share this instance" on startup, if configured.
            let auto = state.settings.read().server.auto_start;
            if auto && state.server_auth.has_password() {
                let st = state.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = rc_api::dispatch::start_server(&st, None, None, None).await {
                        tracing::warn!("cannot start web access: {e}");
                    }
                });
            }
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![rpc])
        .build(tauri::generate_context!())
        .expect("error while building Rust Commander")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<Arc<AppState>>() {
                    let state = state.inner().clone();
                    tauri::async_runtime::block_on(async move { state.shutdown().await });
                }
            }
        });
}
