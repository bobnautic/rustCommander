//! Terminal prompts for interactive scripting.

use std::io::{BufRead, Write};

use async_trait::async_trait;

use rc_core::prompt::{HostKeyState, PromptRequest, PromptResponse, Prompter};

/// Asks on the terminal. `hostkey` is the `-hostkey=` switch of `open`: `*` accepts any
/// key, a fingerprint accepts exactly that key.
pub struct CliPrompter {
    pub interactive: bool,
    pub hostkey: Option<String>,
    pub password: Option<String>,
}

fn ask(question: &str) -> Option<String> {
    eprint!("{question}");
    let _ = std::io::stderr().flush();
    let mut s = String::new();
    std::io::stdin().lock().read_line(&mut s).ok()?;
    Some(s.trim().to_string())
}

#[async_trait]
impl Prompter for CliPrompter {
    async fn prompt(&self, req: PromptRequest) -> Option<PromptResponse> {
        let interactive = self.interactive;
        let hostkey = self.hostkey.clone();
        let password = self.password.clone();
        tokio::task::spawn_blocking(move || {
            let yes = |remember| Some(PromptResponse { accepted: true, values: vec![], remember });
            match req {
                PromptRequest::HostKey { host, port, key_type, fingerprint, state, previous_fingerprint } => {
                    if let Some(h) = &hostkey {
                        if h == "*" || h.eq_ignore_ascii_case(&fingerprint) {
                            return yes(false);
                        }
                    }
                    if !interactive {
                        eprintln!("Host key of {host}:{port} ({key_type}) is not trusted: {fingerprint}");
                        eprintln!("Use -hostkey=\"{fingerprint}\" with `open` to accept it.");
                        return None;
                    }
                    if state == HostKeyState::Changed {
                        eprintln!("WARNING: the host key of {host}:{port} HAS CHANGED (possible man-in-the-middle attack)!");
                        if let Some(p) = previous_fingerprint {
                            eprintln!("  previously: {p}");
                        }
                    }
                    eprintln!("Host key of {host}:{port} ({key_type}): {fingerprint}");
                    match ask("Trust this key? [y]es always / [o]nce / [N]o: ")?.to_lowercase().as_str() {
                        "y" | "yes" => yes(true),
                        "o" | "once" => yes(false),
                        _ => None,
                    }
                }
                PromptRequest::Certificate { host, port, fingerprint, subject, reason, .. } => {
                    if let Some(h) = &hostkey {
                        if h == "*" || h.eq_ignore_ascii_case(&fingerprint) {
                            return yes(false);
                        }
                    }
                    if !interactive {
                        eprintln!("Certificate of {host}:{port} is not trusted ({reason}): {fingerprint}");
                        return None;
                    }
                    eprintln!("Certificate of {host}:{port} not trusted ({reason})\n  subject: {subject}\n  SHA-256: {fingerprint}");
                    match ask("Trust it? [y]es always / [o]nce / [N]o: ")?.to_lowercase().as_str() {
                        "y" | "yes" => yes(true),
                        "o" | "once" => yes(false),
                        _ => None,
                    }
                }
                PromptRequest::Password { host, username, .. } => {
                    if let Some(p) = password {
                        return Some(PromptResponse { accepted: true, values: vec![p], remember: false });
                    }
                    if !interactive {
                        return None;
                    }
                    let p = rpassword::prompt_password(format!("Password for {username}@{host}: ")).ok()?;
                    Some(PromptResponse { accepted: true, values: vec![p], remember: false })
                }
                PromptRequest::Passphrase { key_path } => {
                    if !interactive {
                        return None;
                    }
                    let p = rpassword::prompt_password(format!("Passphrase for {key_path}: ")).ok()?;
                    Some(PromptResponse { accepted: true, values: vec![p], remember: false })
                }
                PromptRequest::Username { host } => {
                    if !interactive {
                        return None;
                    }
                    let u = ask(&format!("User name for {host}: "))?;
                    Some(PromptResponse { accepted: true, values: vec![u], remember: false })
                }
                PromptRequest::KeyboardInteractive { name, instructions, prompts, .. } => {
                    if !interactive {
                        return None;
                    }
                    if !name.is_empty() {
                        eprintln!("{name}");
                    }
                    if !instructions.is_empty() {
                        eprintln!("{instructions}");
                    }
                    let mut values = Vec::new();
                    for p in prompts {
                        let v = if p.echo { ask(&p.text)? } else { rpassword::prompt_password(&p.text).ok()? };
                        values.push(v);
                    }
                    Some(PromptResponse { accepted: true, values, remember: false })
                }
                PromptRequest::Banner { message, .. } => {
                    eprintln!("{message}");
                    yes(false)
                }
                PromptRequest::Confirm { title, message } => {
                    if !interactive {
                        return None;
                    }
                    match ask(&format!("{title}: {message} [y/N] "))?.to_lowercase().as_str() {
                        "y" | "yes" => yes(false),
                        _ => None,
                    }
                }
            }
        })
        .await
        .ok()
        .flatten()
    }
}
