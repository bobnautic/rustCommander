use std::sync::Arc;

use base64::Engine;
use serde::{Deserialize, Serialize};

use rc_core::{Error, Result, TerminalInput, TerminalOptions, TerminalOutput};

use crate::handlers::fs::check_local_shell;
use crate::state::{AppState, Origin, TerminalEntry};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenParams {
    pub session: String,
    pub cols: u16,
    pub rows: u16,
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub session: String,
    pub title: String,
}

pub async fn open(state: &Arc<AppState>, origin: &Origin, p: OpenParams) -> Result<TerminalInfo> {
    check_local_shell(state, origin, &p.session)?;
    let session = state.session(&p.session)?;
    let env = session.site.ssh.env.clone();
    let mut chan = session
        .vfs
        .open_terminal(TerminalOptions { cols: p.cols.max(10), rows: p.rows.max(3), cwd: p.cwd.clone(), env, ..Default::default() })
        .await?;
    let id = uuid::Uuid::new_v4().to_string();
    let title = if session.summary.username.is_empty() {
        session.summary.host.clone()
    } else {
        format!("{}@{}", session.summary.username, session.summary.host)
    };
    state.terminals.lock().insert(
        id.clone(),
        TerminalEntry { id: id.clone(), session: p.session.clone(), title: title.clone(), input: chan.input.clone() },
    );
    let st = state.clone();
    let tid = id.clone();
    tokio::spawn(async move {
        let b64 = base64::engine::general_purpose::STANDARD;
        let mut code = None;
        while let Some(out) = chan.output.recv().await {
            match out {
                TerminalOutput::Data(mut data) => {
                    // Coalesce bursts into fewer events.
                    while data.len() < 64 * 1024 {
                        match chan.output.try_recv() {
                            Ok(TerminalOutput::Data(more)) => data.extend_from_slice(&more),
                            Ok(TerminalOutput::Exit(c)) => {
                                code = c;
                                break;
                            }
                            Err(_) => break,
                        }
                    }
                    st.events.emit("terminal.data", serde_json::json!({ "id": tid, "data": b64.encode(&data) }));
                    if code.is_some() {
                        break;
                    }
                }
                TerminalOutput::Exit(c) => {
                    code = c;
                    break;
                }
            }
        }
        st.terminals.lock().remove(&tid);
        st.events.emit("terminal.exit", serde_json::json!({ "id": tid, "code": code }));
    });
    Ok(TerminalInfo { id, session: p.session, title })
}

pub fn list(state: &AppState) -> Vec<TerminalInfo> {
    state
        .terminals
        .lock()
        .values()
        .map(|t| TerminalInfo { id: t.id.clone(), session: t.session.clone(), title: t.title.clone() })
        .collect()
}

fn send(state: &AppState, id: &str, input: TerminalInput) -> Result<()> {
    let terms = state.terminals.lock();
    let t = terms.get(id).ok_or_else(|| Error::NotFound(format!("terminal {id}")))?;
    t.input.send(input).map_err(|_| Error::ConnectionLost("terminal closed".into()))
}

pub fn write(state: &AppState, id: &str, data: String) -> Result<()> {
    send(state, id, TerminalInput::Data(data.into_bytes()))
}

pub fn resize(state: &AppState, id: &str, cols: u16, rows: u16) -> Result<()> {
    send(state, id, TerminalInput::Resize { cols: cols.max(10), rows: rows.max(3) })
}

pub fn close(state: &AppState, id: &str) -> Result<()> {
    let _ = send(state, id, TerminalInput::Close);
    state.terminals.lock().remove(id);
    Ok(())
}
