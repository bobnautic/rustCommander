//! WinSCP-style file masks: `*.txt; *.log | tmp/; *.bak`.
//!
//! * Patterns are separated by `;` (or `,`); the part after `|` lists exclusions.
//! * `*`, `?` and `[abc]` wildcards; matching is case-insensitive.
//! * A pattern ending in `/` applies to directories only (`node_modules/`).
//! * A pattern containing `/` elsewhere is matched against the path relative to the
//!   transfer root (`src/*.rs`), otherwise against the bare name.
//! * Size and age conditions: `>100K`, `<=1G`, `<7D` (modified within 7 days), `>2024-01-31`.

use globset::{GlobBuilder, GlobMatcher};

#[derive(Debug, Clone)]
enum Cond {
    Glob { m: GlobMatcher, dir_only: bool, full_path: bool },
    Size { op: Op, bytes: u64 },
    /// Compare modification time with an absolute timestamp.
    Time { op: Op, ts: i64 },
}

#[derive(Debug, Clone, Copy)]
enum Op {
    Lt,
    Le,
    Gt,
    Ge,
    Eq,
}

impl Op {
    fn cmp<T: PartialOrd>(self, a: T, b: T) -> bool {
        match self {
            Op::Lt => a < b,
            Op::Le => a <= b,
            Op::Gt => a > b,
            Op::Ge => a >= b,
            Op::Eq => a == b,
        }
    }
}

/// A parsed file mask. The empty mask matches everything.
#[derive(Debug, Clone, Default)]
pub struct FileMask {
    include: Vec<Cond>,
    exclude: Vec<Cond>,
    source: String,
}

/// What the mask is tested against.
pub struct MaskTarget<'a> {
    pub name: &'a str,
    /// Path relative to the operation root (`/`-separated, no leading slash).
    pub rel_path: &'a str,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<i64>,
}

impl FileMask {
    pub fn parse(mask: &str) -> Result<FileMask, String> {
        let mask = mask.trim();
        let (inc, exc) = match mask.find('|') {
            Some(i) => (&mask[..i], &mask[i + 1..]),
            None => (mask, ""),
        };
        Ok(FileMask { include: parse_list(inc)?, exclude: parse_list(exc)?, source: mask.to_string() })
    }

    pub fn is_empty(&self) -> bool {
        self.include.is_empty() && self.exclude.is_empty()
    }

    pub fn as_str(&self) -> &str {
        &self.source
    }

    /// Should this entry be processed? Directories are matched only by directory patterns
    /// and exclusions (so `*.txt` still descends into sub-directories).
    pub fn matches(&self, t: &MaskTarget) -> bool {
        if self.exclude.iter().any(|c| cond_matches(c, t, true)) {
            return false;
        }
        if t.is_dir {
            let dir_includes: Vec<&Cond> =
                self.include.iter().filter(|c| matches!(c, Cond::Glob { dir_only: true, .. })).collect();
            if dir_includes.is_empty() {
                return true;
            }
            return dir_includes.iter().any(|c| cond_matches(c, t, false));
        }
        let file_includes: Vec<&Cond> =
            self.include.iter().filter(|c| !matches!(c, Cond::Glob { dir_only: true, .. })).collect();
        if file_includes.is_empty() {
            return true;
        }
        // Name patterns are alternatives; size/time conditions must all hold.
        let globs: Vec<&&Cond> = file_includes.iter().filter(|c| matches!(c, Cond::Glob { .. })).collect();
        let others: Vec<&&Cond> = file_includes.iter().filter(|c| !matches!(c, Cond::Glob { .. })).collect();
        (globs.is_empty() || globs.iter().any(|c| cond_matches(c, t, false)))
            && others.iter().all(|c| cond_matches(c, t, false))
    }

    /// Convenience for name-only checks (e.g. text-mode masks).
    pub fn matches_name(&self, name: &str) -> bool {
        self.matches(&MaskTarget { name, rel_path: name, is_dir: false, size: 0, modified: None })
    }
}

fn cond_matches(c: &Cond, t: &MaskTarget, excluding: bool) -> bool {
    match c {
        Cond::Glob { m, dir_only, full_path } => {
            if *dir_only && !t.is_dir {
                return false;
            }
            if !*dir_only && t.is_dir && !excluding {
                return false;
            }
            let subject = if *full_path { t.rel_path } else { t.name };
            m.is_match(subject)
        }
        Cond::Size { op, bytes } => !t.is_dir && op.cmp(t.size, *bytes),
        Cond::Time { op, ts } => match t.modified {
            Some(m) => op.cmp(m, *ts),
            None => false,
        },
    }
}

fn parse_list(s: &str) -> Result<Vec<Cond>, String> {
    let mut out = Vec::new();
    for raw in s.split([';', ',']) {
        let p = raw.trim();
        if p.is_empty() {
            continue;
        }
        out.push(parse_cond(p)?);
    }
    Ok(out)
}

fn parse_cond(p: &str) -> Result<Cond, String> {
    let (op, rest) = if let Some(r) = p.strip_prefix(">=") {
        (Some(Op::Ge), r)
    } else if let Some(r) = p.strip_prefix("<=") {
        (Some(Op::Le), r)
    } else if let Some(r) = p.strip_prefix('>') {
        (Some(Op::Gt), r)
    } else if let Some(r) = p.strip_prefix('<') {
        (Some(Op::Lt), r)
    } else if let Some(r) = p.strip_prefix('=') {
        (Some(Op::Eq), r)
    } else {
        (None, p)
    };
    if let Some(op) = op {
        let rest = rest.trim();
        if let Some(bytes) = parse_size(rest) {
            return Ok(Cond::Size { op, bytes });
        }
        if let Some(age) = parse_age(rest) {
            // "<7D" = newer than 7 days = mtime > now-7d, so the operator flips.
            let ts = chrono::Utc::now().timestamp() - age;
            let flipped = match op {
                Op::Lt => Op::Gt,
                Op::Le => Op::Ge,
                Op::Gt => Op::Lt,
                Op::Ge => Op::Le,
                Op::Eq => Op::Eq,
            };
            return Ok(Cond::Time { op: flipped, ts });
        }
        if let Ok(d) = chrono::NaiveDate::parse_from_str(rest, "%Y-%m-%d") {
            let ts = d.and_hms_opt(0, 0, 0).map(|dt| dt.and_utc().timestamp()).unwrap_or(0);
            return Ok(Cond::Time { op, ts });
        }
        return Err(format!("invalid condition: {p}"));
    }
    let dir_only = p.ends_with('/') || p.ends_with('\\');
    let pat = p.trim_end_matches(['/', '\\']).replace('\\', "/");
    let full_path = pat.contains('/');
    let pat = pat.trim_start_matches('/').to_string();
    let glob = GlobBuilder::new(&pat)
        .case_insensitive(true)
        .literal_separator(full_path)
        .backslash_escape(false)
        .build()
        .map_err(|e| format!("invalid mask {p}: {e}"))?;
    Ok(Cond::Glob { m: glob.compile_matcher(), dir_only, full_path })
}

fn parse_size(s: &str) -> Option<u64> {
    let s = s.trim();
    let (num, mult) = match s.chars().last()? {
        'K' | 'k' => (&s[..s.len() - 1], 1024u64),
        'M' | 'm' => (&s[..s.len() - 1], 1024 * 1024),
        'G' | 'g' => (&s[..s.len() - 1], 1024 * 1024 * 1024),
        'T' | 't' => (&s[..s.len() - 1], 1024u64.pow(4)),
        c if c.is_ascii_digit() => (s, 1),
        _ => return None,
    };
    num.trim().parse::<f64>().ok().map(|n| (n * mult as f64) as u64)
}

/// `7D`, `12H`, `30N` (minutes), `1Y`, `2W` → seconds.
fn parse_age(s: &str) -> Option<i64> {
    let s = s.trim();
    let unit = s.chars().last()?.to_ascii_uppercase();
    let n: i64 = s[..s.len() - 1].trim().parse().ok()?;
    let secs = match unit {
        'S' => 1,
        'N' => 60,
        'H' => 3600,
        'D' => 86400,
        'W' => 7 * 86400,
        'Y' => 365 * 86400,
        _ => return None,
    };
    Some(n * secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file<'a>(name: &'a str, rel: &'a str, size: u64) -> MaskTarget<'a> {
        MaskTarget { name, rel_path: rel, is_dir: false, size, modified: Some(chrono::Utc::now().timestamp()) }
    }
    fn dir<'a>(name: &'a str, rel: &'a str) -> MaskTarget<'a> {
        MaskTarget { name, rel_path: rel, is_dir: true, size: 0, modified: None }
    }

    #[test]
    fn masks() {
        let m = FileMask::parse("*.txt; *.LOG | node_modules/; secret*").unwrap();
        assert!(m.matches(&file("a.txt", "a.txt", 1)));
        assert!(m.matches(&file("b.log", "x/b.log", 1)));
        assert!(!m.matches(&file("c.rs", "c.rs", 1)));
        assert!(!m.matches(&file("secret.txt", "secret.txt", 1)));
        assert!(m.matches(&dir("src", "src")));
        assert!(!m.matches(&dir("node_modules", "a/node_modules")));
        assert!(FileMask::parse("").unwrap().matches(&file("x", "x", 0)));

        let m = FileMask::parse("src/*.rs").unwrap();
        assert!(m.matches(&file("a.rs", "src/a.rs", 1)));
        assert!(!m.matches(&file("a.rs", "lib/a.rs", 1)));

        let m = FileMask::parse("*.iso; >1M").unwrap();
        assert!(m.matches(&file("a.iso", "a.iso", 2 * 1024 * 1024)));
        assert!(!m.matches(&file("a.iso", "a.iso", 10)));

        let m = FileMask::parse("<1D").unwrap();
        assert!(m.matches(&file("new", "new", 1)));
        let old = MaskTarget { name: "o", rel_path: "o", is_dir: false, size: 0, modified: Some(0) };
        assert!(!m.matches(&old));

        let m = FileMask::parse("| *.tmp; .git/").unwrap();
        assert!(m.matches(&file("a.c", "a.c", 1)));
        assert!(!m.matches(&file("a.tmp", "a.tmp", 1)));
        assert!(!m.matches(&dir(".git", ".git")));
    }
}
