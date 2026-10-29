//! Helpers for the virtual paths used by all file systems.
//!
//! Every [`crate::Vfs`] speaks absolute, `/`-separated paths. Local Windows paths are
//! represented as `C:/Users/me`; the virtual root `/` lists the drives there.

/// Join a directory and a name. `name` may itself be absolute, in which case it wins.
pub fn join(dir: &str, name: &str) -> String {
    if name.is_empty() {
        return dir.to_string();
    }
    if is_absolute(name) {
        return normalize(name);
    }
    if dir.is_empty() {
        return normalize(name);
    }
    if dir.ends_with('/') {
        normalize(&format!("{dir}{name}"))
    } else {
        normalize(&format!("{dir}/{name}"))
    }
}

pub fn is_absolute(p: &str) -> bool {
    p.starts_with('/') || is_drive_path(p)
}

/// `C:` or `C:/...`
pub fn is_drive_path(p: &str) -> bool {
    let b = p.as_bytes();
    b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b.len() == 2 || b[2] == b'/' || b[2] == b'\\')
}

/// Normalize separators, collapse `//`, resolve `.` and `..` lexically.
///
/// `\` is a separator only in Windows drive paths (`C:\Users`). Elsewhere it is an ordinary
/// character: POSIX servers allow it in file names (`system-systemd\x2dfsck.slice`), and
/// treating it as a separator would make `..\..\x` point to a different file.
pub fn normalize(p: &str) -> String {
    let p = if is_drive_path(p) { p.replace('\\', "/") } else { p.to_string() };
    let (prefix, rest) =
        if is_drive_path(&p) { (p[..2].to_ascii_uppercase(), &p[2..]) } else { (String::new(), p.as_str()) };
    let absolute = rest.starts_with('/') || !prefix.is_empty();
    let mut parts: Vec<&str> = Vec::new();
    for seg in rest.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|l| *l != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            s => parts.push(s),
        }
    }
    let body = parts.join("/");
    if !prefix.is_empty() {
        format!("{prefix}/{body}")
    } else if absolute {
        format!("/{body}")
    } else if body.is_empty() {
        ".".to_string()
    } else {
        body
    }
}

/// Parent directory; the parent of `/` is `/` and the parent of `C:/` is `/` (drive list).
pub fn parent(p: &str) -> String {
    let n = normalize(p);
    if n == "/" {
        return "/".into();
    }
    if is_drive_path(&n) && n.len() <= 3 {
        return "/".into();
    }
    match n.rfind('/') {
        Some(0) => "/".into(),
        Some(i) => {
            let par = &n[..i];
            if is_drive_path(par) && par.len() == 2 {
                format!("{par}/")
            } else {
                par.to_string()
            }
        }
        None => ".".into(),
    }
}

/// Last path component (`""` for the root).
pub fn file_name(p: &str) -> &str {
    let seps: &[char] = if is_drive_path(p) { &['/', '\\'] } else { &['/'] };
    let t = p.trim_end_matches(seps);
    match t.rfind(seps) {
        Some(i) => &t[i + 1..],
        None => {
            if is_drive_path(t) {
                ""
            } else {
                t
            }
        }
    }
}

/// File extension without dot, lowercase.
pub fn extension(name: &str) -> Option<String> {
    let n = file_name(name);
    let idx = n.rfind('.')?;
    if idx == 0 {
        return None;
    }
    Some(n[idx + 1..].to_ascii_lowercase())
}

/// Path of `full` relative to `base`, if `full` lies inside `base`.
pub fn relative_to(full: &str, base: &str) -> Option<String> {
    let full = normalize(full);
    let base = normalize(base);
    if full == base {
        return Some(String::new());
    }
    let base_slash = if base.ends_with('/') { base.clone() } else { format!("{base}/") };
    full.strip_prefix(&base_slash).map(|s| s.to_string())
}

/// Characters that are invalid in file names on the target system.
pub fn is_valid_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.contains('/') && !name.contains('\0')
}

/// Produce `name (1).ext`, `name (2).ext`, ... for collision-free renames.
pub fn numbered_name(name: &str, n: u32) -> String {
    match name.rfind('.') {
        Some(i) if i > 0 => format!("{} ({}){}", &name[..i], n, &name[i..]),
        _ => format!("{name} ({n})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_and_normalize() {
        assert_eq!(join("/home/a", "b"), "/home/a/b");
        assert_eq!(join("/home/a/", "b"), "/home/a/b");
        assert_eq!(join("/home/a", "/etc"), "/etc");
        assert_eq!(join("/", "x"), "/x");
        assert_eq!(normalize("/a/./b/../c//d"), "/a/c/d");
        assert_eq!(normalize("/.."), "/");
        assert_eq!(normalize("c:\\Users\\me"), "C:/Users/me");
        assert_eq!(normalize("C:"), "C:/");
        assert_eq!(join("C:/", "Windows"), "C:/Windows");
    }

    #[test]
    fn parents() {
        assert_eq!(parent("/a/b"), "/a");
        assert_eq!(parent("/a"), "/");
        assert_eq!(parent("/"), "/");
        assert_eq!(parent("C:/Users"), "C:/");
        assert_eq!(parent("C:/"), "/");
    }

    #[test]
    fn names() {
        assert_eq!(file_name("/a/b.txt"), "b.txt");
        assert_eq!(file_name("/a/b/"), "b");
        assert_eq!(file_name("/"), "");
        assert_eq!(extension("x.TAR.GZ"), Some("gz".into()));
        assert_eq!(extension(".bashrc"), None);
        assert_eq!(relative_to("/a/b/c", "/a"), Some("b/c".into()));
        assert_eq!(relative_to("/ab", "/a"), None);
        assert_eq!(numbered_name("f.txt", 2), "f (2).txt");
        assert_eq!(file_name("C:\\Users\\me"), "me");
    }

    #[test]
    fn backslashes_in_posix_names() {
        assert_eq!(join("/run/systemd", "a\\x2db.slice"), "/run/systemd/a\\x2db.slice");
        assert_eq!(join("/home/u/dir", "..\\..\\x"), "/home/u/dir/..\\..\\x");
        assert_eq!(file_name("/home/u/dir/..\\..\\x"), "..\\..\\x");
        assert_eq!(parent("/home/u/a\\b"), "/home/u");
    }
}
