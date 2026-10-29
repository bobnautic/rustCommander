//! Code formatters installed on the machine running Rust Commander (rustfmt, gofmt, ruff, ...).
//! The editor formats web languages itself; these cover the rest. Content goes through
//! stdin/stdout, and the programs run with fixed arguments in an empty temp directory so
//! that no project configuration of the host is picked up.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use rc_core::{Error, Result};

const MAX_INPUT: usize = 8 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(20);

struct Formatter {
    id: &'static str,
    program: &'static str,
    /// Editor language names (CodeMirror `LanguageDescription.name`).
    languages: &'static [&'static str],
}

/// In order of preference: the first available formatter of a language wins.
const FORMATTERS: &[Formatter] = &[
    Formatter { id: "rustfmt", program: "rustfmt", languages: &["Rust"] },
    Formatter { id: "gofmt", program: "gofmt", languages: &["Go"] },
    Formatter { id: "ruff", program: "ruff", languages: &["Python"] },
    Formatter { id: "black", program: "black", languages: &["Python"] },
    Formatter { id: "shfmt", program: "shfmt", languages: &["Shell"] },
    Formatter {
        id: "clang-format",
        program: "clang-format",
        languages: &["C", "C++", "Objective-C", "Objective-C++", "Java", "C#", "Protobuf"],
    },
    Formatter { id: "taplo", program: "taplo", languages: &["TOML"] },
    Formatter { id: "stylua", program: "stylua", languages: &["Lua"] },
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatterInfo {
    pub id: String,
    pub languages: Vec<String>,
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatParams {
    pub language: String,
    /// Used for the file extension only (clang-format picks its language from it).
    #[serde(default)]
    pub file_name: String,
    pub content: String,
    #[serde(default = "default_tab_size")]
    pub tab_size: u32,
    #[serde(default)]
    pub use_tabs: bool,
}

fn default_tab_size() -> u32 {
    4
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Formatted {
    pub content: String,
    pub formatter: String,
}

/// Directories GUI apps often lack in `PATH` (macOS launches apps with a minimal one).
fn extra_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = directories::UserDirs::new().map(|u| u.home_dir().to_path_buf()) {
        for sub in [".cargo/bin", "go/bin", ".local/bin"] {
            dirs.push(home.join(sub));
        }
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/local/go/bin", "/usr/bin"] {
        dirs.push(PathBuf::from(d));
    }
    dirs
}

fn find_program(program: &str) -> Option<PathBuf> {
    let path_dirs = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default();
    let names: Vec<String> = if cfg!(windows) {
        vec![format!("{program}.exe"), format!("{program}.cmd"), format!("{program}.bat")]
    } else {
        vec![program.to_string()]
    };
    path_dirs
        .into_iter()
        .chain(extra_dirs())
        .flat_map(|d| names.iter().map(move |n| d.join(n)))
        .find(|p| is_executable(p))
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    p.is_file()
}

/// The formatters found on this machine.
pub fn available() -> Vec<FormatterInfo> {
    FORMATTERS
        .iter()
        .filter_map(|f| {
            find_program(f.program).map(|path| FormatterInfo {
                id: f.id.into(),
                languages: f.languages.iter().map(|l| l.to_string()).collect(),
                path: path.display().to_string(),
            })
        })
        .collect()
}

/// A file extension safe to put into a file name we make up.
fn extension(file_name: &str) -> String {
    let ext = file_name.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    if !ext.is_empty() && ext.len() <= 10 && ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        ext.to_ascii_lowercase()
    } else {
        "txt".into()
    }
}

fn args(id: &str, p: &FormatParams) -> Vec<String> {
    let tab = p.tab_size.clamp(1, 16);
    match id {
        "rustfmt" => vec![
            "--edition".into(),
            "2021".into(),
            "--config".into(),
            // the editor sends LF text; rustfmt would otherwise fall back to CRLF on Windows
            format!("tab_spaces={tab},hard_tabs={},newline_style=Unix", p.use_tabs),
        ],
        "gofmt" => vec![],
        "ruff" => vec!["format".into(), "--isolated".into(), "--stdin-filename".into(), "input.py".into(), "-".into()],
        "black" => vec!["--quiet".into(), "-".into()],
        "shfmt" => vec!["-i".into(), if p.use_tabs { "0".into() } else { tab.to_string() }],
        "clang-format" => vec![format!("--assume-filename=input.{}", extension(&p.file_name))],
        "taplo" => vec!["fmt".into(), "-".into()],
        "stylua" => {
            let indent = if p.use_tabs { "Tabs" } else { "Spaces" };
            vec!["--indent-type".into(), indent.into(), "--indent-width".into(), tab.to_string(), "-".into()]
        }
        _ => vec![],
    }
}

/// Format `content` with the preferred available formatter for its language.
pub async fn format(p: FormatParams) -> Result<Formatted> {
    if p.content.len() > MAX_INPUT {
        return Err(Error::InvalidInput("file is too large to format".into()));
    }
    let (f, program) = FORMATTERS
        .iter()
        .filter(|f| f.languages.contains(&p.language.as_str()))
        .find_map(|f| find_program(f.program).map(|path| (f, path)))
        .ok_or_else(|| Error::Unsupported(format!("no formatter for {} is installed", p.language)))?;

    let dir = rc_core::store::temp_dir().join("format");
    std::fs::create_dir_all(&dir)?;
    let mut child = tokio::process::Command::new(&program)
        .args(args(f.id, &p))
        .current_dir(&dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| Error::other(format!("cannot run {}: {e}", program.display())))?;
    let mut stdin = child.stdin.take().ok_or_else(|| Error::other("no stdin"))?;
    let input = p.content.into_bytes();
    let writer = tokio::spawn(async move {
        // A formatter that rejects the input may exit before reading all of it.
        let _ = stdin.write_all(&input).await;
    });
    let out = tokio::time::timeout(TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| Error::Timeout(format!("{} did not finish", f.id)))??;
    let _ = writer.await;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let msg: String = err.trim().chars().take(4000).collect();
        return Err(Error::InvalidInput(if msg.is_empty() {
            format!("{} failed ({})", f.id, out.status)
        } else {
            format!("{}: {msg}", f.id)
        }));
    }
    let content =
        String::from_utf8(out.stdout).map_err(|_| Error::other(format!("{} returned invalid UTF-8", f.id)))?;
    Ok(Formatted { content, formatter: f.id.into() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensions_are_sanitized() {
        assert_eq!(extension("main.CPP"), "cpp");
        assert_eq!(extension("x.h"), "h");
        assert_eq!(extension("Makefile"), "txt");
        assert_eq!(extension("a.../../etc"), "txt");
        assert_eq!(extension("evil.c --style=file"), "txt");
    }

    #[tokio::test]
    async fn rustfmt_when_installed() {
        if find_program("rustfmt").is_none() {
            return;
        }
        let r = format(FormatParams {
            language: "Rust".into(),
            file_name: "lib.rs".into(),
            content: "fn  main( ){let x=1;}".into(),
            tab_size: 4,
            use_tabs: false,
        })
        .await
        .unwrap();
        assert_eq!(r.formatter, "rustfmt");
        assert_eq!(r.content, "fn main() {\n    let x = 1;\n}\n");
        let err = format(FormatParams {
            language: "Rust".into(),
            file_name: String::new(),
            content: "fn main( {".into(),
            tab_size: 4,
            use_tabs: false,
        })
        .await
        .unwrap_err();
        assert!(matches!(err, Error::InvalidInput(_)), "{err}");
        let none = format(FormatParams {
            language: "COBOL".into(),
            file_name: String::new(),
            content: String::new(),
            tab_size: 4,
            use_tabs: false,
        })
        .await
        .unwrap_err();
        assert!(matches!(none, Error::Unsupported(_)));
    }
}
