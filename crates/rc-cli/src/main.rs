//! `rcmd` — headless Rust Commander.
//!
//! * `rcmd serve`    run on a target host and use the full UI from a browser
//! * `rcmd discover` list Rust Commander instances on the LAN
//! * `rcmd script`   WinSCP-style scripting (open, ls, get, put, synchronize, ...)

mod prompt;
mod script;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};

use rc_api::server::ServerControl;
use rc_api::{AppMode, AppState, InitOptions};

#[derive(Parser)]
#[command(name = "rcmd", version, about = "Rust Commander — headless server, LAN discovery and scripting")]
struct Cli {
    /// Configuration directory (default: platform config dir, or $RCMD_CONFIG_DIR).
    #[arg(long, global = true, env = "RCMD_CONFIG_DIR")]
    config_dir: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Serve the Rust Commander web UI on this host.
    Serve {
        /// Address to listen on.
        #[arg(long, default_value = "0.0.0.0")]
        bind: String,
        #[arg(long, short, default_value_t = 8822)]
        port: u16,
        /// Plain HTTP instead of HTTPS with a self-signed certificate.
        #[arg(long)]
        no_tls: bool,
        /// Login password for this run (otherwise the stored one, or a generated one).
        #[arg(long, env = "RCMD_PASSWORD", hide_env_values = true)]
        password: Option<String>,
        /// Disable authentication completely (only on trusted networks!).
        #[arg(long)]
        no_auth: bool,
        /// Name announced on the LAN (default: host name).
        #[arg(long)]
        name: Option<String>,
        /// Do not announce this instance / look for others on the LAN.
        #[arg(long)]
        no_discovery: bool,
        /// UDP port for LAN discovery.
        #[arg(long, default_value_t = rc_discovery::DEFAULT_PORT)]
        discovery_port: u16,
        /// Forbid shells and command execution on this host for web users.
        #[arg(long)]
        no_terminal: bool,
    },
    /// Store the web login password (prompts when omitted).
    SetPassword { password: Option<String> },
    /// List Rust Commander instances on the local network.
    Discover {
        /// Seconds to listen.
        #[arg(long, short, default_value_t = 3)]
        timeout: u64,
        #[arg(long, default_value_t = rc_discovery::DEFAULT_PORT)]
        port: u16,
        /// Print JSON.
        #[arg(long)]
        json: bool,
    },
    /// Run a WinSCP-style script (file, `-` for stdin) or commands given with -c.
    Script {
        file: Option<PathBuf>,
        /// Command to run (repeatable), e.g. -c "open sftp://user@host" -c "ls".
        #[arg(short = 'c', long = "command")]
        commands: Vec<String>,
        /// Continue after errors (default: abort).
        #[arg(long)]
        keep_going: bool,
    },
    /// List the sites saved in the site manager.
    Sites,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    rc_core::init_tls();
    let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build()?;
    rt.block_on(run(cli))
}

async fn run(cli: Cli) -> Result<()> {
    match cli.command {
        Command::Serve { bind, port, no_tls, password, no_auth, name, no_discovery, discovery_port, no_terminal } => {
            rc_api::logs::init_tracing("info,rustls=warn,hyper=warn");
            serve(
                cli.config_dir,
                bind,
                port,
                !no_tls,
                password,
                no_auth,
                name,
                !no_discovery,
                discovery_port,
                !no_terminal,
            )
            .await
        }
        Command::SetPassword { password } => {
            let pw = match password {
                Some(p) => p,
                None => {
                    let a = rpassword::prompt_password("New web password: ")?;
                    let b = rpassword::prompt_password("Repeat: ")?;
                    if a != b {
                        bail!("passwords do not match");
                    }
                    a
                }
            };
            let dir = cli.config_dir.unwrap_or_else(rc_core::store::config_dir);
            let auth = rc_api::server::ServerAuth::load(Some(dir.join("server.json")));
            auth.set_password(&pw)?;
            println!("Password stored in {}", dir.join("server.json").display());
            Ok(())
        }
        Command::Discover { timeout, port, json } => {
            let peers = rc_discovery::scan(port, Duration::from_secs(timeout))
                .await
                .context("cannot listen for announcements")?;
            if json {
                println!("{}", serde_json::to_string_pretty(&peers)?);
                return Ok(());
            }
            if peers.is_empty() {
                println!("No Rust Commander instances found (UDP port {port}).");
                return Ok(());
            }
            println!("{:<24} {:<20} {:<10} {:<9} WEB UI", "NAME", "HOST", "OS", "VERSION");
            for p in peers {
                let web = p.web.map(|w| w.url).unwrap_or_else(|| "-".into());
                println!(
                    "{:<24} {:<20} {:<10} {:<9} {}",
                    p.name,
                    p.addresses.first().cloned().unwrap_or_default(),
                    p.os,
                    p.version,
                    web
                );
            }
            Ok(())
        }
        Command::Script { file, commands, keep_going } => {
            rc_api::logs::init_tracing("warn");
            let mut lines: Vec<String> = Vec::new();
            if let Some(f) = file {
                let text = if f.as_os_str() == "-" {
                    let mut s = String::new();
                    std::io::Read::read_to_string(&mut std::io::stdin(), &mut s)?;
                    s
                } else {
                    std::fs::read_to_string(&f).with_context(|| format!("reading {}", f.display()))?
                };
                lines.extend(text.lines().map(|l| l.to_string()));
            }
            lines.extend(commands);
            if lines.is_empty() {
                script::interactive(cli.config_dir).await
            } else {
                script::run_lines(cli.config_dir, &lines, keep_going).await
            }
        }
        Command::Sites => {
            let dir = cli.config_dir.unwrap_or_else(rc_core::store::config_dir);
            let vault = Arc::new(rc_core::store::Vault::open(dir.clone())?);
            let store = rc_core::store::SiteStore::load(dir.join("sites.json"), vault);
            for s in store.list_masked() {
                let folder = if s.folder.is_empty() { String::new() } else { format!("{}/", s.folder) };
                println!("{folder}{:<30} {}", s.name, s.to_url(None));
            }
            Ok(())
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn serve(
    config_dir: Option<PathBuf>,
    bind: String,
    port: u16,
    tls: bool,
    password: Option<String>,
    no_auth: bool,
    name: Option<String>,
    discovery: bool,
    discovery_port: u16,
    terminal: bool,
) -> Result<()> {
    let state = AppState::new(InitOptions { mode: AppMode::Web, config_dir }).await?;
    {
        let mut s = state.settings.write();
        s.discovery.enabled = discovery;
        s.discovery.port = discovery_port;
        if let Some(n) = name {
            s.discovery.instance_name = n;
        }
        s.server.allow_terminal = terminal;
        s.server.bind = bind.clone();
        s.server.port = port;
        s.server.tls = tls;
    }
    let mut generated = None;
    if no_auth {
        state.server_auth.set_disabled(true);
        eprintln!("WARNING: authentication is disabled — anybody who can reach this port controls this host.");
    } else if let Some(pw) = password {
        state.server_auth.set_ephemeral(Some(pw));
    } else if !state.server_auth.has_password() {
        let pw = rc_api::server::generate_password();
        state.server_auth.set_ephemeral(Some(pw.clone()));
        generated = Some(pw);
    }
    let server = rc_server::WebServer::new();
    *state.server.write() = Some(server.clone() as Arc<dyn ServerControl>);
    let running = server.start(state.clone(), bind, port, tls).await?;
    state.start_background().await;

    let status = rc_api::dispatch::server_status(&state);
    println!();
    println!("  Rust Commander {} — \"{}\"", rc_core::VERSION, state.instance_name());
    println!();
    for u in &status.urls {
        println!("    {u}");
    }
    if let Some(fp) = &running.fingerprint {
        println!();
        println!("  TLS certificate (self-signed) SHA-256:");
        println!("    {fp}");
    }
    if let Some(pw) = generated {
        println!();
        println!("  Login password for this session: {pw}");
        println!("  (store a permanent one with `rcmd set-password`)");
    }
    if discovery {
        println!();
        println!("  Announcing on the LAN (UDP {discovery_port}).");
    }
    println!();

    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate() => {}
    }
    println!("Shutting down…");
    state.shutdown().await;
    Ok(())
}

#[cfg(unix)]
async fn terminate() {
    if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
        s.recv().await;
    } else {
        std::future::pending::<()>().await;
    }
}

#[cfg(not(unix))]
async fn terminate() {
    std::future::pending::<()>().await;
}
