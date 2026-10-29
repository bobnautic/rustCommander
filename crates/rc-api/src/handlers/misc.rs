use std::sync::Arc;

use serde::{Deserialize, Serialize};

use rc_core::{Error, ExecOutput, Protocol, Result};

use crate::state::{AppMode, AppState, Bookmark, CustomCommand, Origin, LOCAL_SESSION};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Features {
    pub terminal: bool,
    pub local_exec: bool,
    pub external_edit: bool,
    pub open_local: bool,
    pub protocols: Vec<Protocol>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: &'static str,
    pub mode: &'static str,
    pub hostname: String,
    pub os: &'static str,
    pub arch: &'static str,
    pub user: String,
    pub home_dir: String,
    pub instance_id: String,
    pub instance_name: String,
    pub features: Features,
}

pub async fn app_info(state: &AppState, origin: &Origin) -> AppInfo {
    let web = matches!(origin, Origin::Web { .. });
    let shell = !web || state.settings.read().server.allow_terminal;
    AppInfo {
        version: rc_core::VERSION,
        mode: if web || state.mode == AppMode::Web { "web" } else { "desktop" },
        hostname: crate::state::hostname(),
        os: std::env::consts::OS,
        arch: std::env::consts::ARCH,
        user: crate::state::username(),
        home_dir: state.session(LOCAL_SESSION).map(|s| s.summary.home.clone()).unwrap_or_default(),
        instance_id: state.instance_id.clone(),
        instance_name: state.instance_name(),
        features: Features {
            terminal: shell,
            local_exec: shell,
            external_edit: !web,
            open_local: !web,
            protocols: rc_core::connect::available_protocols(),
        },
    }
}

// ------------------------------------------------------------------ bookmarks

pub fn bookmark_save(state: &AppState, mut b: Bookmark) -> Result<Bookmark> {
    if b.id.is_empty() {
        b.id = uuid::Uuid::new_v4().to_string();
    }
    {
        let mut list = state.bookmarks.lock();
        match list.iter_mut().find(|x| x.id == b.id) {
            Some(x) => *x = b.clone(),
            None => list.push(b.clone()),
        }
    }
    state.save_bookmarks()?;
    Ok(b)
}

pub fn bookmark_delete(state: &AppState, id: &str) -> Result<()> {
    state.bookmarks.lock().retain(|b| b.id != id);
    state.save_bookmarks()
}

// ------------------------------------------------------------------ custom commands

pub fn command_save(state: &AppState, mut c: CustomCommand) -> Result<CustomCommand> {
    if c.name.trim().is_empty() || c.command.trim().is_empty() {
        return Err(Error::InvalidInput("name and command are required".into()));
    }
    if c.id.is_empty() {
        c.id = uuid::Uuid::new_v4().to_string();
    }
    {
        let mut list = state.commands.lock();
        match list.iter_mut().find(|x| x.id == c.id) {
            Some(x) => *x = c.clone(),
            None => list.push(c.clone()),
        }
    }
    state.save_commands()?;
    Ok(c)
}

pub fn command_delete(state: &AppState, id: &str) -> Result<()> {
    state.commands.lock().retain(|c| c.id != id);
    state.save_commands()
}

fn shell_quote(s: &str) -> String {
    if cfg!(windows) {
        format!("\"{}\"", s.replace('"', "\\\""))
    } else {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\"").replace('$', "\\$").replace('`', "\\`"))
    }
}

/// Expand the `!` patterns (`!`, `!&`, `!/`, `!@`, `!U`, ...) in a custom command.
pub fn expand(cmd: &str, name: Option<&str>, names: &[String], cwd: &str, host: &str, user: &str) -> String {
    let mut out = String::with_capacity(cmd.len() + 32);
    let mut chars = cmd.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '!' {
            out.push(c);
            continue;
        }
        match chars.peek().copied() {
            Some('!') => {
                chars.next();
                out.push('!');
            }
            Some('&') => {
                chars.next();
                out.push_str(&names.iter().map(|n| shell_quote(n)).collect::<Vec<_>>().join(" "));
            }
            Some('/') => {
                chars.next();
                out.push_str(cwd);
                if !cwd.ends_with('/') {
                    out.push('/');
                }
            }
            Some('@') => {
                chars.next();
                out.push_str(host);
            }
            Some('U') => {
                chars.next();
                out.push_str(user);
            }
            _ => out.push_str(name.unwrap_or("")),
        }
    }
    out
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCommandParams {
    pub id: Option<String>,
    pub command: Option<String>,
    pub session: String,
    pub cwd: String,
    #[serde(default)]
    pub names: Vec<String>,
}

pub async fn command_run(state: &Arc<AppState>, origin: &Origin, p: RunCommandParams) -> Result<Vec<ExecOutput>> {
    let (cmd, per_file, local) = match (&p.id, &p.command) {
        (Some(id), _) if !id.is_empty() => {
            let c = state
                .commands
                .lock()
                .iter()
                .find(|c| &c.id == id)
                .cloned()
                .ok_or_else(|| Error::NotFound(format!("command {id}")))?;
            (c.command, c.per_file, c.target == "local")
        }
        (_, Some(c)) if !c.trim().is_empty() => (c.clone(), false, false),
        _ => return Err(Error::InvalidInput("command required".into())),
    };
    let session_id = if local { LOCAL_SESSION.to_string() } else { p.session.clone() };
    crate::handlers::fs::check_local_shell(state, origin, &session_id)?;
    let session = state.session(&session_id)?;
    // A local command started from a remote panel runs in the local home directory.
    let cwd = if local && p.session != LOCAL_SESSION { session.summary.home.clone() } else { p.cwd.clone() };
    let host = &session.summary.host;
    let user = &session.summary.username;
    let mut outputs = Vec::new();
    if per_file && !p.names.is_empty() {
        for n in &p.names {
            let c = expand(&cmd, Some(n), &p.names, &cwd, host, user);
            tracing::info!(session = %session_id, "custom command: {c}");
            outputs.push(session.vfs.exec(&c, Some(&cwd)).await?);
        }
    } else {
        let c = expand(&cmd, p.names.first().map(|s| s.as_str()), &p.names, &cwd, host, user);
        tracing::info!(session = %session_id, "custom command: {c}");
        outputs.push(session.vfs.exec(&c, Some(&cwd)).await?);
    }
    state.emit_changed(&p.session, &p.cwd);
    Ok(outputs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn patterns() {
        let names = vec!["a b.txt".to_string(), "c.txt".to_string()];
        assert_eq!(expand("cat \"!\"", Some("a b.txt"), &names, "/x", "h", "u"), "cat \"a b.txt\"");
        if !cfg!(windows) {
            assert_eq!(expand("du !&", None, &names, "/x", "h", "u"), "du \"a b.txt\" \"c.txt\"");
        }
        assert_eq!(expand("echo !/ !@ !U !!", None, &names, "/x", "h", "u"), "echo /x/ h u !");
    }
}
