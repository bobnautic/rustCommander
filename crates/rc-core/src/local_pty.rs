//! Local interactive shell through a pseudo terminal.

use std::io::{Read, Write};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tokio::sync::mpsc;

use crate::error::{Error, Result};
use crate::vfs::{TerminalChannel, TerminalInput, TerminalOptions, TerminalOutput};

pub fn open(opts: TerminalOptions) -> Result<TerminalChannel> {
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize { rows: opts.rows.max(1), cols: opts.cols.max(1), pixel_width: 0, pixel_height: 0 })
        .map_err(|e| Error::other(format!("openpty: {e}")))?;
    let mut cmd = CommandBuilder::new_default_prog();
    cmd.env("TERM", &opts.term);
    cmd.env("COLORTERM", "truecolor");
    for (k, v) in &opts.env {
        cmd.env(k, v);
    }
    if let Some(cwd) = &opts.cwd {
        let native = crate::local::to_native(cwd);
        if native.is_dir() {
            cmd.cwd(native);
        }
    } else if let Some(home) = directories::UserDirs::new() {
        cmd.cwd(home.home_dir());
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| Error::other(format!("spawn shell: {e}")))?;
    drop(pair.slave);
    let mut killer = child.clone_killer();
    let mut reader = pair.master.try_clone_reader().map_err(|e| Error::other(e.to_string()))?;
    let mut writer = pair.master.take_writer().map_err(|e| Error::other(e.to_string()))?;
    let master = pair.master;

    let (in_tx, mut in_rx) = mpsc::unbounded_channel::<TerminalInput>();
    let (out_tx, out_rx) = mpsc::unbounded_channel::<TerminalOutput>();

    std::thread::Builder::new()
        .name("pty-reader".into())
        .spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if out_tx.send(TerminalOutput::Data(buf[..n].to_vec())).is_err() {
                            break;
                        }
                    }
                }
            }
            let code = child.wait().ok().map(|s| s.exit_code() as i32);
            let _ = out_tx.send(TerminalOutput::Exit(code));
        })
        .map_err(Error::Io)?;

    std::thread::Builder::new()
        .name("pty-writer".into())
        .spawn(move || {
            while let Some(msg) = in_rx.blocking_recv() {
                match msg {
                    TerminalInput::Data(d) => {
                        if writer.write_all(&d).is_err() {
                            break;
                        }
                        let _ = writer.flush();
                    }
                    TerminalInput::Resize { cols, rows } => {
                        let _ = master.resize(PtySize {
                            rows: rows.max(1),
                            cols: cols.max(1),
                            pixel_width: 0,
                            pixel_height: 0,
                        });
                    }
                    TerminalInput::Close => {
                        let _ = killer.kill();
                        break;
                    }
                }
            }
            let _ = killer.kill();
        })
        .map_err(Error::Io)?;

    Ok(TerminalChannel { input: in_tx, output: out_rx })
}
