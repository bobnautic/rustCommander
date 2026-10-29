//! POSIX shell helpers: quoting, error mapping and parsers for `ls -l` / `df -P` output.

use crate::error::Error;
use crate::types::{parse_mode_string, ChecksumAlgo, DiskInfo, FileKind};

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

/// Map the stderr of a failed shell command to an error kind.
pub(crate) fn command_error(stderr: &str, exit: Option<i32>, path: &str) -> Error {
    let msg = stderr.trim();
    let l = msg.to_ascii_lowercase();
    if l.contains("no such file") {
        Error::NotFound(path.to_string())
    } else if l.contains("permission denied") || l.contains("operation not permitted") {
        Error::PermissionDenied(path.to_string())
    } else if l.contains("file exists") {
        Error::AlreadyExists(path.to_string())
    } else if l.contains("not a directory") {
        Error::NotADirectory(path.to_string())
    } else if l.contains("is a directory") {
        Error::IsADirectory(path.to_string())
    } else if l.contains("not empty") {
        Error::DirectoryNotEmpty(path.to_string())
    } else if l.contains("command not found") || l.contains(": not found") {
        Error::Unsupported(msg.to_string())
    } else if msg.is_empty() {
        match exit {
            Some(c) => Error::Other(format!("{path}: command failed with exit code {c}")),
            None => Error::Other(format!("{path}: command was terminated")),
        }
    } else {
        Error::Other(format!("{path}: {}", msg.lines().last().unwrap_or(msg)))
    }
}

/// One parsed line of `ls -l` output.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LsEntry {
    pub name: String,
    pub kind: FileKind,
    pub permissions: Option<u32>,
    pub owner: String,
    pub group: String,
    pub size: u64,
    pub modified: Option<i64>,
    pub link_target: Option<String>,
}

fn tokens(line: &str) -> Vec<(usize, &str)> {
    let mut out = Vec::new();
    let mut start = None;
    for (i, c) in line.char_indices() {
        if c == ' ' || c == '\t' {
            if let Some(s) = start.take() {
                out.push((s, &line[s..i]));
            }
        } else if start.is_none() {
            start = Some(i);
        }
    }
    if let Some(s) = start {
        out.push((s, &line[s..]));
    }
    out
}

fn month_number(s: &str) -> Option<u32> {
    const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    let l = s.to_ascii_lowercase();
    MONTHS.iter().position(|m| *m == l).map(|i| i as u32 + 1)
}

fn utc_timestamp(year: i32, month: u32, day: u32, h: u32, m: u32, s: u32) -> Option<i64> {
    Some(chrono::NaiveDate::from_ymd_opt(year, month, day)?.and_hms_opt(h, m, s)?.and_utc().timestamp())
}

fn iso_timestamp(date: &str, time: &str, tz: Option<&str>) -> Option<i64> {
    let d: Vec<u32> = date.split('-').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    let [y, mo, day] = d.as_slice() else {
        return None;
    };
    let time = time.split('.').next()?;
    let t: Vec<u32> = time.split(':').map(|p| p.parse().ok()).collect::<Option<_>>()?;
    let [h, mi, sec] = t.as_slice() else {
        return None;
    };
    let ts = utc_timestamp(i32::try_from(*y).ok()?, *mo, *day, *h, *mi, *sec)?;
    let offset = match tz {
        Some(z) => {
            let sign = if z.starts_with('-') { -1 } else { 1 };
            let digits = z.get(1..)?;
            let v: i64 = digits.parse().ok()?;
            sign * ((v / 100) * 3600 + (v % 100) * 60)
        }
        None => 0,
    };
    Some(ts - offset)
}

fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10 && b[4] == b'-' && b[7] == b'-' && s.bytes().filter(|c| c.is_ascii_digit()).count() == 8
}

fn is_tz_offset(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 5 && (b[0] == b'+' || b[0] == b'-') && b[1..].iter().all(u8::is_ascii_digit)
}

/// Parse one line of `ls -l` output. Understands GNU `--time-style=+%s` (epoch seconds),
/// `--full-time` (`YYYY-MM-DD HH:MM:SS[.nnn] [+zzzz]`, GNU and busybox), BSD `-T`
/// (`Mon DD HH:MM:SS YYYY`) and the classic `Mon DD HH:MM` / `Mon DD YYYY` formats
/// (interpreted as UTC; `now` resolves the year of recent files).
pub(crate) fn parse_ls_line(line: &str, now: i64) -> Option<LsEntry> {
    let line = line.trim_end_matches(['\r', '\n']);
    let toks = tokens(line);
    if toks.len() < 6 {
        return None;
    }
    let perms = toks[0].1;
    let type_char = perms.chars().next()?;
    if perms.len() < 10 || !"-dlcbpsD".contains(type_char) {
        return None;
    }
    let permissions = parse_mode_string(perms.get(1..10)?);
    toks[1].1.parse::<u64>().ok()?;
    let owner = toks[2].1.to_string();
    let group = toks[3].1.to_string();
    let mut i = 4;
    let mut size = 0;
    if type_char == 'c' || type_char == 'b' {
        // Device numbers: "major, minor" or "major,minor".
        i += if toks.get(i)?.1.ends_with(',') { 2 } else { 1 };
    } else {
        size = toks.get(i)?.1.parse().ok()?;
        i += 1;
    }
    let t = *toks.get(i)?;
    let (modified, time_end) = if is_iso_date(t.1) {
        let tt = *toks.get(i + 1)?;
        match toks.get(i + 2).filter(|z| is_tz_offset(z.1)) {
            Some(z) => (iso_timestamp(t.1, tt.1, Some(z.1)), z.0 + z.1.len()),
            None => (iso_timestamp(t.1, tt.1, None), tt.0 + tt.1.len()),
        }
    } else if let Some(month) = month_number(t.1) {
        let day: u32 = toks.get(i + 1)?.1.parse().ok()?;
        let tt = *toks.get(i + 2)?;
        if tt.1.contains(':') {
            let parts: Vec<u32> = tt.1.split(':').map(|p| p.parse().ok()).collect::<Option<_>>()?;
            let (h, m, s) = match parts.as_slice() {
                [h, m] => (*h, *m, 0),
                [h, m, s] => (*h, *m, *s),
                _ => return None,
            };
            let explicit_year = if parts.len() == 3 {
                toks.get(i + 3)
                    .and_then(|y| y.1.parse::<i32>().ok().filter(|y| (1900..3000).contains(y)).map(|v| (v, y)))
            } else {
                None
            };
            match explicit_year {
                Some((year, ytok)) => (utc_timestamp(year, month, day, h, m, s), ytok.0 + ytok.1.len()),
                None => {
                    use chrono::Datelike;
                    let year = chrono::DateTime::from_timestamp(now, 0).map(|d| d.year()).unwrap_or(1970);
                    let mut ts = utc_timestamp(year, month, day, h, m, s);
                    if ts.is_some_and(|v| v > now + 31 * 86400) {
                        ts = utc_timestamp(year - 1, month, day, h, m, s);
                    }
                    (ts, tt.0 + tt.1.len())
                }
            }
        } else {
            let year: i32 = tt.1.parse().ok()?;
            (utc_timestamp(year, month, day, 0, 0, 0), tt.0 + tt.1.len())
        }
    } else {
        (Some(t.1.parse::<i64>().ok()?), t.0 + t.1.len())
    };
    let rest = line.get(time_end + 1..)?;
    if rest.is_empty() {
        return None;
    }
    let (name, link_target) = match (type_char, rest.split_once(" -> ")) {
        ('l', Some((n, target))) => (n.to_string(), Some(target.to_string())),
        _ => (rest.to_string(), None),
    };
    let kind = match type_char {
        '-' => FileKind::File,
        'd' => FileKind::Dir,
        'l' => FileKind::Symlink,
        _ => FileKind::Other,
    };
    Some(LsEntry { name, kind, permissions, owner, group, size, modified, link_target })
}

/// Parse `df -Pk` output.
pub(crate) fn parse_df(out: &str) -> Option<DiskInfo> {
    let line = out.lines().skip(1).find(|l| !l.trim().is_empty())?;
    let toks: Vec<&str> = line.split_whitespace().collect();
    let cap = toks.iter().rposition(|t| t.ends_with('%'))?;
    if cap < 3 {
        return None;
    }
    let total: u64 = toks[cap - 3].parse().ok()?;
    let used: u64 = toks[cap - 2].parse().ok()?;
    let avail: u64 = toks[cap - 1].parse().ok()?;
    Some(DiskInfo { total: total * 1024, free: total.saturating_sub(used) * 1024, available: avail * 1024 })
}

/// Command printing the checksum of `path` (GNU coreutils, with BSD/macOS fallbacks).
pub(crate) fn checksum_command(path: &str, algo: ChecksumAlgo) -> String {
    let p = quote_path(path);
    let fallback = match algo {
        ChecksumAlgo::Md5 => format!("md5 -q {p}"),
        ChecksumAlgo::Sha1 => format!("shasum -a 1 {p}"),
        ChecksumAlgo::Sha256 => format!("shasum -a 256 {p}"),
    };
    format!("{} {p} 2>/dev/null || {fallback}", algo.command())
}

/// Extract the hex digest from `md5sum`-style output.
pub(crate) fn parse_checksum(out: &str, algo: ChecksumAlgo) -> Option<String> {
    let len = match algo {
        ChecksumAlgo::Md5 => 32,
        ChecksumAlgo::Sha1 => 40,
        ChecksumAlgo::Sha256 => 64,
    };
    let tok = out.split_whitespace().next()?.trim_start_matches('\\').to_ascii_lowercase();
    (tok.len() == len && tok.bytes().all(|b| b.is_ascii_hexdigit())).then_some(tok)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_700_000_000; // 2023-11-14

    #[test]
    fn quoting() {
        assert_eq!(quote("a b"), "'a b'");
        assert_eq!(quote("it's"), r"'it'\''s'");
        assert_eq!(quote_path("-rf"), "'./-rf'");
    }

    #[test]
    fn gnu_ls() {
        let e = parse_ls_line("-rw-r--r-- 1 bob staff 1234 1698765432 my file.txt", NOW).unwrap();
        assert_eq!(e.name, "my file.txt");
        assert_eq!(e.kind, FileKind::File);
        assert_eq!(e.size, 1234);
        assert_eq!(e.modified, Some(1698765432));
        assert_eq!(e.permissions, Some(0o644));
        assert_eq!((e.owner.as_str(), e.group.as_str()), ("bob", "staff"));

        let e = parse_ls_line("lrwxrwxrwx 1 root root 7 1698765432 bin -> usr/bin", NOW).unwrap();
        assert_eq!(e.kind, FileKind::Symlink);
        assert_eq!(e.name, "bin");
        assert_eq!(e.link_target.as_deref(), Some("usr/bin"));

        let e = parse_ls_line("crw-rw-rw- 1 root root 1, 3 1698765432 null", NOW).unwrap();
        assert_eq!(e.kind, FileKind::Other);
        assert_eq!(e.name, "null");

        let e = parse_ls_line("drwxr-sr-x+ 2 a b 4096 1698765432  leading space", NOW).unwrap();
        assert_eq!(e.name, " leading space");
        assert_eq!(e.permissions, Some(0o2755));
        assert!(parse_ls_line("total 12", NOW).is_none());
    }

    #[test]
    fn classic_ls() {
        // Recent file: year inferred.
        let e = parse_ls_line("-rw-r--r--    1 root     root          5 Oct 31 12:34 a.txt", NOW).unwrap();
        assert_eq!(e.modified, utc_timestamp(2023, 10, 31, 12, 34, 0));
        // A date "in the future" belongs to the previous year.
        let e = parse_ls_line("-rw-r--r--    1 root     root          5 Dec 24 08:00 x", NOW).unwrap();
        assert_eq!(e.modified, utc_timestamp(2022, 12, 24, 8, 0, 0));
        let e = parse_ls_line("drwxr-xr-x    2 root     root       4096 Jan  5  2019 old dir", NOW).unwrap();
        assert_eq!(e.modified, utc_timestamp(2019, 1, 5, 0, 0, 0));
        assert_eq!(e.name, "old dir");
        assert_eq!(e.kind, FileKind::Dir);
        // BSD ls -T
        let e = parse_ls_line("-rw-r--r--  1 me  staff  10 Mar  3 04:05:06 2021 t", NOW).unwrap();
        assert_eq!(e.modified, utc_timestamp(2021, 3, 3, 4, 5, 6));
        assert_eq!(e.name, "t");
        // busybox device
        let e = parse_ls_line("crw-rw-rw-    1 root     root        1,   3 Oct 31 12:34 null", NOW).unwrap();
        assert_eq!(e.name, "null");
    }

    #[test]
    fn full_time_ls() {
        let e =
            parse_ls_line("-rw-r--r--    1 root     root             5 2001-09-09 01:46:40 +0000 a b", NOW).unwrap();
        assert_eq!(e.modified, Some(1_000_000_000));
        assert_eq!(e.name, "a b");
        let e = parse_ls_line("-rw-r--r-- 1 u g 5 2001-09-09 03:46:40.123456789 +0200 x", NOW).unwrap();
        assert_eq!(e.modified, Some(1_000_000_000));
        assert_eq!(e.name, "x");
    }

    #[test]
    fn df_and_checksum() {
        let out = "Filesystem     1024-blocks      Used Available Capacity Mounted on\n/dev/sda1 1000 400 500 45% /\n";
        let d = parse_df(out).unwrap();
        assert_eq!((d.total, d.free, d.available), (1000 * 1024, 600 * 1024, 500 * 1024));
        assert_eq!(
            parse_checksum("d41d8cd98f00b204e9800998ecf8427e  /tmp/x\n", ChecksumAlgo::Md5).as_deref(),
            Some("d41d8cd98f00b204e9800998ecf8427e")
        );
        assert!(parse_checksum("md5sum: x: No such file", ChecksumAlgo::Md5).is_none());
    }
}
