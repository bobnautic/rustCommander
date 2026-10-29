//! Directory listing parsers: `MLSD`/`MLST` facts (RFC 3659) and the `LIST` output of
//! Unix-like (`ls -l`) and Windows/IIS (DOS) servers.

use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, TimeZone, Utc};

use crate::path as vpath;
use crate::types::{parse_mode_string, FileEntry, FileKind};

/// Parse one `MLSD` line (or the entry line of an `MLST` reply). Returns `None` for
/// the `cdir`/`pdir` entries and for lines that cannot be parsed. `dir` is the listed
/// directory; for `MLST` the caller fixes up name and path.
pub(super) fn parse_mlsx(line: &str, dir: &str) -> Option<FileEntry> {
    let line = line.trim_end_matches(['\r', '\n']);
    // `facts SP pathname`; facts never contain spaces (RFC 3659 7.2).
    let (facts, name) = match line.strip_prefix(' ') {
        Some(name) => ("", name),
        None => line.split_once(' ')?,
    };
    if name.is_empty() {
        return None;
    }
    let mut kind = FileKind::File;
    let mut size = None;
    let mut modified = None;
    let mut mode = None;
    let mut link_target = None;
    let (mut owner_name, mut owner_id, mut group_name, mut group_id) = (None, None, None, None);
    for fact in facts.split(';').filter(|f| !f.is_empty()) {
        let Some((key, value)) = fact.split_once('=') else { continue };
        match key.to_ascii_lowercase().as_str() {
            "type" => {
                let v = value.to_ascii_lowercase();
                kind = match v.as_str() {
                    "file" => FileKind::File,
                    "dir" => FileKind::Dir,
                    "cdir" | "pdir" => return None,
                    "os.unix=symlink" | "link" | "os.unix=link" => FileKind::Symlink,
                    _ if v.starts_with("os.unix=slink") => {
                        // `OS.unix=slink:/target` (target is optional)
                        link_target = value.split_once(':').map(|(_, t)| t.to_string()).filter(|t| !t.is_empty());
                        FileKind::Symlink
                    }
                    _ if v.starts_with("os.unix=") => FileKind::Other,
                    _ => FileKind::Other,
                };
            }
            "size" | "sizd" => size = value.parse::<u64>().ok(),
            "modify" => modified = parse_mlsx_time(value),
            // `0644`, `644`, or `0o644` (pyftpdlib)
            "unix.mode" => {
                let digits = value.strip_prefix("0o").or_else(|| value.strip_prefix("0O")).unwrap_or(value);
                mode = u32::from_str_radix(digits, 8).ok().map(|m| m & 0o7777)
            }
            "unix.ownername" => owner_name = Some(value.to_string()),
            "unix.groupname" => group_name = Some(value.to_string()),
            "unix.owner" if value.parse::<u32>().is_err() => owner_name = Some(value.to_string()),
            "unix.owner" | "unix.uid" => owner_id = Some(value.to_string()),
            "unix.group" if value.parse::<u32>().is_err() => group_name = Some(value.to_string()),
            "unix.group" | "unix.gid" => group_id = Some(value.to_string()),
            _ => {}
        }
    }
    let base = vpath::file_name(name);
    let base = if base.is_empty() { name } else { base };
    if base == "." || base == ".." {
        return None;
    }
    let mut e = FileEntry::new(base, vpath::join(dir, base), kind);
    if kind != FileKind::Dir {
        e.size = size.unwrap_or(0);
    }
    e.modified = modified;
    e.permissions = mode;
    e.owner = owner_name.or(owner_id);
    e.group = group_name.or(group_id);
    e.link_target = link_target;
    Some(e)
}

/// `YYYYMMDDHHMMSS[.sss]` in UTC.
pub(super) fn parse_mlsx_time(v: &str) -> Option<i64> {
    let main = v.split('.').next()?;
    let dt = NaiveDateTime::parse_from_str(main, "%Y%m%d%H%M%S").ok()?;
    Some(dt.and_utc().timestamp())
}

/// Format a Unix timestamp as `YYYYMMDDHHMMSS` (MFMT / MDTM).
pub(super) fn format_mlsx_time(t: i64) -> Option<String> {
    Some(Utc.timestamp_opt(t, 0).single()?.format("%Y%m%d%H%M%S").to_string())
}

/// Parse one line of `LIST` output (Unix or DOS format). Returns `None` for `total`
/// lines, `.`/`..` and lines that cannot be parsed.
pub(super) fn parse_list_line(line: &str, dir: &str, now: DateTime<Utc>) -> Option<FileEntry> {
    let line = line.trim_end_matches(['\r', '\n']);
    if line.trim().is_empty() || line.starts_with("total ") {
        return None;
    }
    let entry = parse_unix(line, dir, now).or_else(|| parse_dos(line, dir))?;
    if entry.name == "." || entry.name == ".." || entry.name.is_empty() {
        return None;
    }
    Some(entry)
}

/// Whitespace separated tokens with their byte ranges.
fn tokens(line: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start = None;
    for (i, c) in line.char_indices() {
        if c.is_whitespace() {
            if let Some(s) = start.take() {
                out.push((s, i));
            }
        } else if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(s) = start {
        out.push((s, line.len()));
    }
    out
}

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

fn month(s: &str) -> Option<u32> {
    let l = s.to_ascii_lowercase();
    MONTHS.iter().position(|m| l.starts_with(m) && l.len() <= 4).map(|i| i as u32 + 1)
}

fn hm(s: &str) -> Option<(u32, u32, u32)> {
    let mut it = s.split(':');
    let h = it.next()?.parse().ok()?;
    let m = it.next()?.parse().ok()?;
    let sec = match it.next() {
        Some(x) => x.split('.').next()?.parse().ok()?,
        None => 0,
    };
    if it.next().is_some() || h > 23 || m > 59 || sec > 60 {
        return None;
    }
    Some((h, m, sec))
}

fn parse_unix(line: &str, dir: &str, now: DateTime<Utc>) -> Option<FileEntry> {
    let toks = tokens(line);
    let first = &line[toks.first()?.0..toks.first()?.1];
    let type_char = first.chars().next()?;
    if !"-dlpcbsDn".contains(type_char) || first.len() < 10 {
        return None;
    }
    let perms = &first[1..10];
    if !perms.chars().all(|c| "rwxsStTlL-".contains(c)) {
        return None;
    }
    // Find the date (`Mon DD HH:MM|YYYY` or `YYYY-MM-DD HH:MM[:SS]`), preceded by the size
    // and followed by the name.
    let text = |i: usize| &line[toks[i].0..toks[i].1];
    let tok = |i: usize| (i < toks.len()).then(|| text(i));
    let date_at = |i: usize| -> Option<(usize, i64)> {
        if let Some(mo) = month(text(i)) {
            let day = tok(i + 1)?.trim_end_matches(',').parse::<u32>().ok()?;
            let t = tok(i + 2)?;
            if !(1..=31).contains(&day) {
                return None;
            }
            if let Some((h, m, s)) = hm(t) {
                let mk = |y: i32| NaiveDate::from_ymd_opt(y, mo, day).and_then(|d| d.and_hms_opt(h, m, s));
                let mut dt = mk(now.year())?;
                // Without a year the date lies within the last 6 months.
                if dt.and_utc() > now + chrono::Duration::days(2) {
                    dt = mk(now.year() - 1)?;
                }
                return Some((i + 2, dt.and_utc().timestamp()));
            }
            let year = t.parse::<i32>().ok().filter(|y| (1900..=9999).contains(y))?;
            return Some((i + 2, NaiveDate::from_ymd_opt(year, mo, day)?.and_hms_opt(0, 0, 0)?.and_utc().timestamp()));
        }
        let d = NaiveDate::parse_from_str(text(i), "%Y-%m-%d").ok()?;
        let (h, m, s) = hm(tok(i + 1)?)?;
        Some((i + 1, d.and_hms_opt(h, m, s)?.and_utc().timestamp()))
    };
    let (date_idx, last_idx, mtime, size) = (2..toks.len()).find_map(|i| {
        let size = text(i - 1).parse::<u64>().ok()?;
        let (last, time) = date_at(i)?;
        (last + 1 < toks.len()).then_some((i, last, time, size))
    })?;
    let name_part = line[toks[last_idx].1..].trim_start();
    if name_part.is_empty() {
        return None;
    }
    let kind = match type_char {
        '-' => FileKind::File,
        'd' => FileKind::Dir,
        'l' => FileKind::Symlink,
        _ => FileKind::Other,
    };
    let (name, target) = match (kind, name_part.split_once(" -> ")) {
        (FileKind::Symlink, Some((n, t))) => (n, Some(t.to_string())),
        _ => (name_part, None),
    };
    // Owner/group sit between the link count and the size.
    let first_meta = if text(1).parse::<u64>().is_ok() { 2 } else { 1 };
    let meta: Vec<&str> = (first_meta..date_idx - 1).map(text).collect();
    let mut e = FileEntry::new(name, vpath::join(dir, name), kind);
    e.size = if kind == FileKind::Dir { 0 } else { size };
    e.modified = Some(mtime);
    e.permissions = parse_mode_string(perms);
    e.owner = meta.first().map(|s| s.to_string());
    e.group = meta.get(1).map(|s| s.to_string());
    e.link_target = target;
    Some(e)
}

/// `MM-DD-YY  HH:MM[AP]M  <DIR>|size  name` (IIS / Windows servers).
fn parse_dos(line: &str, dir: &str) -> Option<FileEntry> {
    let toks = tokens(line);
    if toks.len() < 4 {
        return None;
    }
    let text = |i: usize| &line[toks[i].0..toks[i].1];
    let date = text(0);
    let parts: Vec<&str> = date.split(['-', '/']).collect();
    if parts.len() != 3 {
        return None;
    }
    let mo: u32 = parts[0].parse().ok()?;
    let day: u32 = parts[1].parse().ok()?;
    let mut year: i32 = parts[2].parse().ok()?;
    if parts[2].len() == 2 {
        year += if year < 70 { 2000 } else { 1900 };
    }
    // Time may be `03:19PM`, `03:19 PM` or `15:19`.
    let mut idx = 1;
    let mut t = text(idx).to_ascii_uppercase();
    if idx + 1 < toks.len() && matches!(text(idx + 1).to_ascii_uppercase().as_str(), "AM" | "PM") {
        t.push_str(&text(idx + 1).to_ascii_uppercase());
        idx += 1;
    }
    let (clock, pm) = if let Some(c) = t.strip_suffix("PM") {
        (c, Some(true))
    } else if let Some(c) = t.strip_suffix("AM") {
        (c, Some(false))
    } else {
        (t.as_str(), None)
    };
    let (mut h, m, _) = hm(clock)?;
    match pm {
        Some(true) if h < 12 => h += 12,
        Some(false) if h == 12 => h = 0,
        _ => {}
    }
    let mtime = NaiveDate::from_ymd_opt(year, mo, day)?.and_hms_opt(h, m, 0)?.and_utc().timestamp();
    idx += 1;
    if idx >= toks.len() {
        return None;
    }
    let size_tok = text(idx);
    let (kind, size) = if size_tok.eq_ignore_ascii_case("<DIR>") {
        (FileKind::Dir, 0)
    } else {
        (FileKind::File, size_tok.replace(',', "").parse::<u64>().ok()?)
    };
    let name = line.get(toks[idx].1..)?.trim_start();
    if name.is_empty() {
        return None;
    }
    let mut e = FileEntry::new(name, vpath::join(dir, name), kind);
    e.size = size;
    e.modified = Some(mtime);
    Some(e)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2024, 3, 10, 12, 0, 0).unwrap()
    }

    #[test]
    fn mlsd() {
        let e = parse_mlsx(
            "type=file;size=1234;modify=20201019151930.123;UNIX.mode=0644;UNIX.uid=1000;UNIX.gid=100; my file.txt",
            "/home",
        )
        .unwrap();
        assert_eq!(e.name, "my file.txt");
        assert_eq!(e.path, "/home/my file.txt");
        assert_eq!(e.kind, FileKind::File);
        assert_eq!(e.size, 1234);
        assert_eq!(e.modified, Some(1603120770));
        assert_eq!(e.permissions, Some(0o644));
        assert_eq!(e.owner.as_deref(), Some("1000"));

        let d = parse_mlsx("type=dir;modify=20201019151930;UNIX.owner=bob;UNIX.group=staff; sub", "/").unwrap();
        assert_eq!(d.kind, FileKind::Dir);
        assert_eq!(d.path, "/sub");
        assert_eq!(d.owner.as_deref(), Some("bob"));
        assert_eq!(d.group.as_deref(), Some("staff"));

        assert!(parse_mlsx("type=cdir;modify=20201019151930; .", "/").is_none());
        assert!(parse_mlsx("type=pdir;modify=20201019151930; ..", "/").is_none());

        let l = parse_mlsx("type=OS.unix=slink:/etc/hosts;size=10; hosts", "/x").unwrap();
        assert_eq!(l.kind, FileKind::Symlink);
        assert_eq!(l.link_target.as_deref(), Some("/etc/hosts"));

        let m = parse_mlsx("type=file;size=5;modify=20240101000000; /abs/path/f.txt", "/").unwrap();
        assert_eq!(m.name, "f.txt");
        let semi = parse_mlsx("type=file;size=1; a;b c", "/").unwrap();
        assert_eq!(semi.name, "a;b c");
        let py = parse_mlsx("modify=20261029163405;size=4096;type=dir;unix.mode=0o755;unix.uid=0; d", "/").unwrap();
        assert_eq!(py.permissions, Some(0o755));
    }

    #[test]
    fn unix_list() {
        let e =
            parse_list_line("-rw-r--r--   1 owner    group        5 Oct 29 15:53 file name.txt", "/d", now()).unwrap();
        assert_eq!(e.name, "file name.txt");
        assert_eq!(e.size, 5);
        assert_eq!(e.permissions, Some(0o644));
        assert_eq!(e.owner.as_deref(), Some("owner"));
        assert_eq!(e.group.as_deref(), Some("group"));
        // Oct 29 lies after "now" (March) -> previous year
        assert_eq!(e.modified, Some(Utc.with_ymd_and_hms(2023, 10, 29, 15, 53, 0).unwrap().timestamp()));

        let d = parse_list_line("drwxr-sr-x+  2 1000 1000 4096 Jan  5  2021 sub dir", "/", now()).unwrap();
        assert_eq!(d.kind, FileKind::Dir);
        assert_eq!(d.name, "sub dir");
        assert_eq!(d.permissions, Some(0o2755));
        assert_eq!(d.modified, Some(Utc.with_ymd_and_hms(2021, 1, 5, 0, 0, 0).unwrap().timestamp()));

        let l = parse_list_line("lrwxrwxrwx 1 root root 11 Mar  1 09:15 link -> target dir", "/", now()).unwrap();
        assert_eq!(l.kind, FileKind::Symlink);
        assert_eq!(l.name, "link");
        assert_eq!(l.link_target.as_deref(), Some("target dir"));
        assert_eq!(l.modified, Some(Utc.with_ymd_and_hms(2024, 3, 1, 9, 15, 0).unwrap().timestamp()));

        let iso = parse_list_line("-rwxr-xr-x 1 a b 42 2023-07-01 08:30 run.sh", "/", now()).unwrap();
        assert_eq!(iso.size, 42);
        assert_eq!(iso.permissions, Some(0o755));

        let nogroup = parse_list_line("-rw-r--r-- 1 ftp 100 Feb 2 10:00 x", "/", now()).unwrap();
        assert_eq!(nogroup.owner.as_deref(), Some("ftp"));
        assert_eq!(nogroup.group, None);
        assert_eq!(nogroup.size, 100);

        assert!(parse_list_line("total 12", "/", now()).is_none());
        assert!(parse_list_line("drwxr-xr-x 2 a b 4096 Jan 1 2020 .", "/", now()).is_none());
        let dev = parse_list_line("crw-rw---- 1 root disk 8, 0 Jan 1 2020 sda", "/", now()).unwrap();
        assert_eq!(dev.kind, FileKind::Other);
    }

    #[test]
    fn dos_list() {
        let d = parse_list_line("10-19-20  03:19PM       <DIR>          pub", "/", now()).unwrap();
        assert_eq!(d.kind, FileKind::Dir);
        assert_eq!(d.name, "pub");
        assert_eq!(d.modified, Some(Utc.with_ymd_and_hms(2020, 10, 19, 15, 19, 0).unwrap().timestamp()));
        let f = parse_list_line("04-08-2014  12:09AM            1,403 read me.txt", "/x", now()).unwrap();
        assert_eq!(f.kind, FileKind::File);
        assert_eq!(f.size, 1403);
        assert_eq!(f.path, "/x/read me.txt");
        assert_eq!(f.modified, Some(Utc.with_ymd_and_hms(2014, 4, 8, 0, 9, 0).unwrap().timestamp()));
    }

    #[test]
    fn mlsx_time() {
        assert_eq!(format_mlsx_time(1603120770).as_deref(), Some("20201019151930"));
        assert_eq!(parse_mlsx_time("20201019151930"), Some(1603120770));
    }
}
