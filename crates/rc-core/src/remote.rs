//! Server-side shortcuts over `exec`.
//!
//! On SSH hosts a recursive operation can run as one shell command (`rm -rf`, `find -exec
//! chmod`, `find | awk` for sizes, `find -printf` for searches, `grep -l` for content)
//! instead of one protocol request per file, which is orders of magnitude faster on
//! high-latency links. Every function here answers `Ok(None)` / `Ok(false)` when the
//! shortcut is not available (no POSIX shell, GNU find missing, partial failure, the shell
//! sees another file system than SFTP); callers then fall back to the generic way, which
//! also reports precise per-file errors.

use std::collections::HashSet;

use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result};
use crate::ops::DirSize;
use crate::path as vpath;
use crate::types::*;
use crate::vfs::Vfs;

/// Exit code of the probe that tells "GNU find is missing" from real results.
const NO_GNU_FIND: i32 = 97;
/// Limit for the file list of one `grep` command (the whole command line goes through SSH).
const GREP_BATCH_BYTES: usize = 48 * 1024;

/// Quote a string for a POSIX shell (`'...'`).
pub(crate) fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// Quote a path; a leading `-` is protected with `./` so commands do not take it as an option.
pub(crate) fn quote_path(p: &str) -> String {
    if p.starts_with('-') {
        quote(&format!("./{p}"))
    } else {
        quote(p)
    }
}

/// The session runs commands in a POSIX shell on the server that holds its files.
pub fn available(vfs: &dyn Vfs) -> bool {
    vfs.capabilities().exec && matches!(vfs.protocol(), Protocol::Sftp | Protocol::Scp)
}

/// Shortcuts and the file protocol must see the same files: an SFTP server may be chrooted
/// or virtual while `exec` runs a normal shell. The shell starts in the home directory,
/// which must be the directory the file protocol calls home.
pub async fn same_view(vfs: &dyn Vfs) -> bool {
    if !available(vfs) {
        return false;
    }
    let Ok(home) = vfs.home().await else { return false };
    match vfs.exec("pwd -P 2>/dev/null || pwd", None).await {
        Ok(out) if out.exit_code == Some(0) => {
            let pwd = vpath::normalize(out.stdout.trim());
            let home = vpath::normalize(&home);
            if pwd == home {
                return true;
            }
            // The home directory may be reached through a symlink.
            match vfs.canonicalize(&home).await {
                Ok(c) => vpath::normalize(&c) == pwd,
                Err(_) => false,
            }
        }
        _ => false,
    }
}

/// A path the shortcuts may be used on: absolute, normalized, not the root.
fn usable_path(path: &str) -> Option<String> {
    let p = vpath::normalize(path);
    let deep_enough = p.starts_with('/') && p.len() > 1 && vpath::parent(&p) != p;
    (deep_enough && !p.contains('\0')).then_some(p)
}

/// Run a command; connection errors propagate, any other failure means "not available".
async fn run(vfs: &dyn Vfs, command: &str) -> Result<Option<ExecOutput>> {
    match vfs.exec(command, None).await {
        Ok(out) => Ok(Some(out)),
        Err(e) if e.is_connection_error() || matches!(e, Error::Cancelled) => Err(e),
        Err(e) => {
            tracing::debug!("server-side shortcut not available: {e}");
            Ok(None)
        }
    }
}

/// `rm -rf` of a directory tree. `Ok(true)` when the tree is gone.
pub async fn remove_tree(vfs: &dyn Vfs, path: &str) -> Result<bool> {
    let Some(p) = usable_path(path) else { return Ok(false) };
    if !same_view(vfs).await {
        return Ok(false);
    }
    let Some(out) = run(vfs, &format!("rm -rf -- {}", quote(&p))).await? else { return Ok(false) };
    if out.exit_code != Some(0) {
        tracing::debug!("rm -rf {p} failed: {}", out.stderr.trim());
        return Ok(false);
    }
    Ok(vfs.try_stat(&p).await?.is_none())
}

/// What a recursive attribute change sets.
#[derive(Debug, Clone, Default)]
pub struct TreeAttributes<'a> {
    /// Mode for files (and everything else that is neither a directory nor a symlink).
    pub file_mode: Option<u32>,
    pub dir_mode: Option<u32>,
    pub owner: Option<&'a str>,
    pub group: Option<&'a str>,
}

fn valid_account(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-@$".contains(&b))
}

/// The shell command for [`set_tree_attributes`] (symlinks are never touched, like the
/// generic walk does).
fn tree_attributes_command(root: &str, a: &TreeAttributes) -> Option<String> {
    let r = quote(root);
    let mut parts = Vec::new();
    if let Some(m) = a.dir_mode {
        parts.push(format!("find {r} -type d -exec chmod {:o} {{}} +", m & 0o7777));
    }
    if let Some(m) = a.file_mode {
        parts.push(format!("find {r} ! -type d ! -type l -exec chmod {:o} {{}} +", m & 0o7777));
    }
    match (a.owner, a.group) {
        (Some(o), Some(g)) => {
            parts.push(format!("find {r} ! -type l -exec chown {} {{}} +", quote(&format!("{o}:{g}"))))
        }
        (Some(o), None) => parts.push(format!("find {r} ! -type l -exec chown {} {{}} +", quote(o))),
        (None, Some(g)) => parts.push(format!("find {r} ! -type l -exec chgrp {} {{}} +", quote(g))),
        (None, None) => {}
    }
    (!parts.is_empty()).then(|| parts.join(" && "))
}

/// `chmod`/`chown` of a whole tree (the root included). `Ok(true)` when everything was set.
pub async fn set_tree_attributes(vfs: &dyn Vfs, root: &str, attrs: &TreeAttributes<'_>) -> Result<bool> {
    let Some(p) = usable_path(root) else { return Ok(false) };
    if attrs.owner.is_some_and(|o| !valid_account(o)) || attrs.group.is_some_and(|g| !valid_account(g)) {
        return Ok(false);
    }
    let Some(cmd) = tree_attributes_command(&p, attrs) else { return Ok(true) };
    if !same_view(vfs).await {
        return Ok(false);
    }
    let Some(out) = run(vfs, &cmd).await? else { return Ok(false) };
    if out.exit_code != Some(0) {
        tracing::debug!("recursive attribute change of {p} failed: {}", out.stderr.trim());
        return Ok(false);
    }
    Ok(true)
}

/// Probe for GNU find (and the existence of `root`) before the real command.
fn gnu_find_probe(root: &str) -> String {
    format!("find {} -maxdepth 0 -printf '' >/dev/null 2>&1 || exit {NO_GNU_FIND}; ", quote(root))
}

fn dir_size_command(root: &str) -> String {
    format!(
        "{}LC_ALL=C find {} -mindepth 1 -printf '%y %s\\n' 2>/dev/null | awk '{{ if ($1 == \"d\") d++; else {{ f++; s += $2 }} }} END {{ printf \"%.0f %d %d\\n\", s, f, d }}'",
        gnu_find_probe(root),
        quote(root)
    )
}

fn parse_dir_size(out: &str) -> Option<DirSize> {
    let mut it = out.split_whitespace();
    let size = it.next()?.parse::<f64>().ok()?;
    let files = it.next()?.parse().ok()?;
    let dirs = it.next()?.parse().ok()?;
    Some(DirSize { size: size.max(0.0) as u64, files, dirs })
}

/// Size of a directory tree computed on the server (same counting as [`crate::ops::dir_size`]).
pub async fn dir_size(vfs: &dyn Vfs, path: &str) -> Result<Option<DirSize>> {
    let p = vpath::normalize(path);
    if !p.starts_with('/') || !same_view(vfs).await {
        return Ok(None);
    }
    let Some(out) = run(vfs, &dir_size_command(&p)).await? else { return Ok(None) };
    if out.exit_code != Some(0) {
        return Ok(None);
    }
    Ok(parse_dir_size(&out.stdout))
}

fn find_entries_command(root: &str, max_depth: Option<usize>, include_hidden: bool) -> String {
    let depth = max_depth.map(|d| format!(" -maxdepth {}", d.max(1))).unwrap_or_default();
    let prune = if include_hidden { "" } else { " -name '.*' -prune -o" };
    format!(
        "{}LC_ALL=C find {} -mindepth 1{depth}{prune} -printf '%y %Y %s %T@ %m %u %g\\0%p\\0%l\\0' 2>/dev/null; exit 0",
        gnu_find_probe(root),
        quote(root)
    )
}

fn kind_of(c: &str) -> FileKind {
    match c {
        "f" => FileKind::File,
        "d" => FileKind::Dir,
        "l" => FileKind::Symlink,
        _ => FileKind::Other,
    }
}

/// Parse the NUL separated records of [`find_entries_command`].
fn parse_find_entries(out: &str) -> Vec<FileEntry> {
    let mut fields = out.split('\0');
    let mut entries = Vec::new();
    while let (Some(meta), Some(path), Some(link)) = (fields.next(), fields.next(), fields.next()) {
        let m: Vec<&str> = meta.trim_start_matches('\n').split(' ').collect();
        let [y, ty, size, mtime, mode, owner, group] = m.as_slice() else { continue };
        let path = vpath::normalize(path);
        let name = vpath::file_name(&path).to_string();
        if name.is_empty() {
            continue;
        }
        let kind = kind_of(y);
        let mut e = FileEntry::new(name, path, kind);
        e.size = size.parse().unwrap_or(0);
        e.modified = mtime.split('.').next().and_then(|s| s.parse().ok());
        e.permissions = u32::from_str_radix(mode, 8).ok();
        e.owner = Some(owner.to_string());
        e.group = Some(group.to_string());
        if kind == FileKind::Symlink {
            e.link_target = Some(link.to_string());
            e.target_kind = match *ty {
                "N" | "L" | "?" => None,
                t => Some(kind_of(t)),
            };
        }
        entries.push(e);
    }
    entries
}

/// Every entry below `root` (not the root itself), listed by GNU find on the server.
/// Hidden entries are skipped and not descended into unless `include_hidden`.
pub async fn find_entries(
    vfs: &dyn Vfs,
    root: &str,
    max_depth: Option<usize>,
    include_hidden: bool,
    cancel: &CancellationToken,
) -> Result<Option<Vec<FileEntry>>> {
    let p = vpath::normalize(root);
    if !p.starts_with('/') || !same_view(vfs).await {
        return Ok(None);
    }
    let cmd = find_entries_command(&p, max_depth, include_hidden);
    let out = tokio::select! {
        r = run(vfs, &cmd) => r?,
        _ = cancel.cancelled() => return Ok(Some(Vec::new())),
    };
    match out {
        Some(o) if o.exit_code == Some(0) => Ok(Some(parse_find_entries(&o.stdout))),
        _ => Ok(None),
    }
}

/// Split `files` into `grep` commands whose file list stays below the batch size.
fn grep_commands(needle: &str, case_sensitive: bool, files: &[String]) -> Vec<String> {
    let head = format!("LC_ALL=C grep -l -s -F{} -e {} --", if case_sensitive { "" } else { " -i" }, quote(needle));
    let mut cmds = Vec::new();
    let mut cur = String::new();
    for f in files {
        let q = quote_path(f);
        if !cur.is_empty() && cur.len() + q.len() > GREP_BATCH_BYTES {
            cmds.push(format!("{head}{cur}"));
            cur.clear();
        }
        cur.push(' ');
        cur.push_str(&q);
    }
    if !cur.is_empty() {
        cmds.push(format!("{head}{cur}"));
    }
    cmds
}

/// Which of `files` contain `needle` (byte-wise, ASCII case folding like the generic
/// search), decided by `grep -l` on the server. `on_batch` receives the matches of every
/// batch as soon as it is done. `Ok(None)` when grep cannot be used.
pub async fn grep_files(
    vfs: &dyn Vfs,
    needle: &str,
    case_sensitive: bool,
    files: &[String],
    cancel: &CancellationToken,
    mut on_batch: impl FnMut(Vec<String>),
) -> Result<Option<usize>> {
    if needle.is_empty() || needle.contains(['\n', '\r', '\0']) || !same_view(vfs).await {
        return Ok(None);
    }
    if files.iter().any(|f| !f.starts_with('/') || f.contains(['\n', '\0'])) {
        return Ok(None);
    }
    let wanted: HashSet<&str> = files.iter().map(String::as_str).collect();
    let mut found = 0;
    for (i, cmd) in grep_commands(needle, case_sensitive, files).iter().enumerate() {
        if cancel.is_cancelled() {
            break;
        }
        let out = tokio::select! {
            r = run(vfs, cmd) => r?,
            _ = cancel.cancelled() => break,
        };
        // 0: matches, 1: no match, 2: some files could not be read (the others are listed).
        let Some(out) = out.filter(|o| matches!(o.exit_code, Some(0..=2))) else {
            if i == 0 {
                return Ok(None);
            }
            return Err(Error::Other("grep failed on the server".into()));
        };
        let hits: Vec<String> = out.stdout.lines().filter(|l| wanted.contains(l)).map(str::to_string).collect();
        found += hits.len();
        if !hits.is_empty() {
            on_batch(hits);
        }
    }
    Ok(Some(found))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_for_shortcuts() {
        assert_eq!(usable_path("/home/u/x/../y").as_deref(), Some("/home/u/y"));
        assert_eq!(usable_path("/"), None);
        assert_eq!(usable_path("/a/.."), None);
        assert_eq!(usable_path("C:/Users"), None);
        assert_eq!(usable_path(""), None);
    }

    #[test]
    fn attribute_commands() {
        let a =
            TreeAttributes { file_mode: Some(0o644), dir_mode: Some(0o755), owner: Some("www"), group: Some("web") };
        assert_eq!(
            tree_attributes_command("/srv/it's", &a).unwrap(),
            r"find '/srv/it'\''s' -type d -exec chmod 755 {} + && find '/srv/it'\''s' ! -type d ! -type l -exec chmod 644 {} + && find '/srv/it'\''s' ! -type l -exec chown 'www:web' {} +"
        );
        let a = TreeAttributes { group: Some("staff"), ..Default::default() };
        assert_eq!(tree_attributes_command("/x", &a).unwrap(), "find '/x' ! -type l -exec chgrp 'staff' {} +");
        assert!(tree_attributes_command("/x", &TreeAttributes::default()).is_none());
        assert!(valid_account("www-data") && valid_account("1000") && !valid_account("a b") && !valid_account("x;rm"));
    }

    #[test]
    fn dir_size_output() {
        let d = parse_dir_size("12345 3 2\n").unwrap();
        assert_eq!((d.size, d.files, d.dirs), (12345, 3, 2));
        assert!(parse_dir_size("").is_none());
        assert!(dir_size_command("/data").starts_with("find '/data' -maxdepth 0 -printf ''"));
    }

    #[test]
    fn find_output() {
        let out = "f f 5 1698765432.1234567890 644 bob staff\0/home/bob/a b.txt\0\0\
                   d d 4096 1698765400.0000000000 755 bob staff\0/home/bob/dir\0\0\
                   l d 3 1698765401.5 777 bob staff\0/home/bob/link\0dir\0\
                   l N 7 1698765401.5 777 bob staff\0/home/bob/dangling\0missing\0";
        let e = parse_find_entries(out);
        assert_eq!(e.len(), 4);
        assert_eq!((e[0].name.as_str(), e[0].kind, e[0].size), ("a b.txt", FileKind::File, 5));
        assert_eq!(e[0].modified, Some(1698765432));
        assert_eq!(e[0].permissions, Some(0o644));
        assert_eq!(e[1].kind, FileKind::Dir);
        assert_eq!(
            (e[2].kind, e[2].target_kind, e[2].link_target.as_deref()),
            (FileKind::Symlink, Some(FileKind::Dir), Some("dir"))
        );
        assert!(e[2].is_dir());
        assert_eq!(e[3].target_kind, None);
        let cmd = find_entries_command("/r", Some(2), false);
        assert!(cmd.contains("-mindepth 1 -maxdepth 2 -name '.*' -prune -o -printf"), "{cmd}");
        assert!(!find_entries_command("/r", None, true).contains("prune"));
    }

    #[test]
    fn grep_batches() {
        let files: Vec<String> = (0..5000).map(|i| format!("/data/some/longer/path/file-{i}.log")).collect();
        let cmds = grep_commands("it's", false, &files);
        assert!(cmds.len() > 1);
        assert!(cmds.iter().all(|c| c.len() < GREP_BATCH_BYTES + 200));
        assert!(cmds[0].starts_with(r"LC_ALL=C grep -l -s -F -i -e 'it'\''s' -- '/data/"));
        let total: usize = cmds.iter().map(|c| c.matches("/data/").count()).sum();
        assert_eq!(total, files.len());
        assert!(!grep_commands("x", true, &files[..1])[0].contains(" -i"));
    }
}
