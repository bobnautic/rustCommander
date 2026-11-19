//! User skins: one JSON file per skin in `<config dir>/skins/`.
//!
//! The skin format (colors, fonts, shapes) is interpreted by the user interface, which
//! validates every value before it applies it (see `ui/src/lib/skins/`). The backend only
//! stores the files: it checks that a skin is a JSON object with a usable `id` and `name`,
//! keeps them small, and makes sure an id can never name a file outside the skins folder.
//!
//! Files may also be dropped into the folder by hand. Their `id` decides which skin they
//! are; a file without one uses its file name (`ocean.json` → `ocean`).

use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

use rc_core::store::save_json;
use rc_core::{Error, Result};

/// Larger files are not skins (and would slow down every start of the UI).
pub const MAX_SKIN_BYTES: u64 = 256 * 1024;
/// At most this many skins are loaded.
pub const MAX_SKINS: usize = 200;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinFile {
    /// File name inside the skins folder.
    pub file: String,
    /// The skin as stored (`id` is always set).
    pub skin: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinFileError {
    pub file: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinList {
    /// The skins folder (native path), for "open folder" and the documentation.
    pub dir: String,
    pub skins: Vec<SkinFile>,
    /// Files that could not be loaded.
    pub errors: Vec<SkinFileError>,
}

pub fn skins_dir(config_dir: &Path) -> PathBuf {
    config_dir.join("skins")
}

/// `a-z`, `0-9`, `-` and `_`, starting with a letter or digit, at most 64 characters.
pub fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-' || *c == b'_')
}

fn read_skin(path: &Path) -> std::result::Result<Value, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_SKIN_BYTES {
        return Err(format!("larger than {} KiB", MAX_SKIN_BYTES / 1024));
    }
    let data = std::fs::read(path).map_err(|e| e.to_string())?;
    let mut v: Value = serde_json::from_slice(&data).map_err(|e| format!("invalid JSON: {e}"))?;
    let obj = v.as_object_mut().ok_or("not a JSON object")?;
    let id = match obj.get("id") {
        Some(Value::String(id)) => id.clone(),
        None => path.file_stem().and_then(|s| s.to_str()).unwrap_or_default().to_ascii_lowercase(),
        Some(_) => return Err("\"id\" is not a string".into()),
    };
    if !valid_id(&id) {
        return Err(format!("invalid id {id:?} (use a-z, 0-9, - and _)"));
    }
    obj.insert("id".into(), Value::String(id));
    Ok(v)
}

/// All skins in `dir`, sorted by file name. A missing folder is an empty list.
pub fn list(dir: &Path) -> SkinList {
    let mut out = SkinList { dir: dir.display().to_string(), skins: Vec::new(), errors: Vec::new() };
    let Ok(rd) = std::fs::read_dir(dir) else {
        return out;
    };
    let mut files: Vec<PathBuf> = rd
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("json")))
        .collect();
    files.sort();
    for path in files {
        let file = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if out.skins.len() >= MAX_SKINS {
            out.errors.push(SkinFileError { file, message: format!("more than {MAX_SKINS} skins") });
            continue;
        }
        match read_skin(&path) {
            Ok(skin) => {
                let id = skin["id"].as_str().unwrap_or_default();
                if let Some(first) = out.skins.iter().find(|s| s.skin["id"] == id) {
                    let message = format!("id {id:?} is already used by {}", first.file);
                    out.errors.push(SkinFileError { file, message });
                } else {
                    out.skins.push(SkinFile { file, skin });
                }
            }
            Err(message) => out.errors.push(SkinFileError { file, message }),
        }
    }
    out
}

/// Store a skin (create or replace). A skin that came from a hand-named file is written
/// back to that file.
pub fn save(dir: &Path, mut skin: Value) -> Result<SkinFile> {
    let obj = skin.as_object_mut().ok_or_else(|| Error::InvalidInput("a skin must be a JSON object".into()))?;
    let id = obj.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    if !valid_id(&id) {
        return Err(Error::InvalidInput(format!("invalid skin id {id:?} (use a-z, 0-9, - and _)")));
    }
    let name_ok = obj.get("name").and_then(Value::as_str).is_some_and(|n| !n.trim().is_empty());
    if !name_ok {
        return Err(Error::InvalidInput("a skin needs a name".into()));
    }
    let size = serde_json::to_vec_pretty(&skin)?.len() as u64;
    if size > MAX_SKIN_BYTES {
        return Err(Error::InvalidInput(format!("skin is larger than {} KiB", MAX_SKIN_BYTES / 1024)));
    }
    let existing = list(dir).skins.into_iter().find(|s| s.skin["id"] == id.as_str());
    let file = existing.map(|s| s.file).unwrap_or_else(|| format!("{id}.json"));
    save_json(&dir.join(&file), &skin)?;
    Ok(SkinFile { file, skin })
}

/// Remove the file(s) of a skin. Unknown ids are not an error.
pub fn delete(dir: &Path, id: &str) -> Result<()> {
    if !valid_id(id) {
        return Err(Error::InvalidInput(format!("invalid skin id {id:?}")));
    }
    for s in list(dir).skins.into_iter().filter(|s| s.skin["id"] == id) {
        let path = dir.join(&s.file);
        std::fs::remove_file(&path).map_err(|e| Error::io_at(e, &path.display().to_string()))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ids_cannot_leave_the_folder() {
        for bad in ["", "../x", "a/b", "a\\b", "A", "-x", ".hidden", "x.json", &"x".repeat(65)] {
            assert!(!valid_id(bad), "{bad:?} accepted");
        }
        for good in ["default", "nord-2", "my_skin", "9lives"] {
            assert!(valid_id(good), "{good:?} rejected");
        }
    }

    #[test]
    fn save_list_delete() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("skins");
        assert!(list(&dir).skins.is_empty());

        let saved = save(&dir, json!({ "id": "ocean", "name": "Ocean", "dark": { "accent": "#0af" } })).unwrap();
        assert_eq!(saved.file, "ocean.json");
        let l = list(&dir);
        assert_eq!(l.skins.len(), 1);
        assert_eq!(l.skins[0].skin["dark"]["accent"], "#0af");

        // replaced, not duplicated
        save(&dir, json!({ "id": "ocean", "name": "Ocean 2" })).unwrap();
        let l = list(&dir);
        assert_eq!(l.skins.len(), 1);
        assert_eq!(l.skins[0].skin["name"], "Ocean 2");

        delete(&dir, "ocean").unwrap();
        assert!(list(&dir).skins.is_empty());
        delete(&dir, "ocean").unwrap();
    }

    #[test]
    fn rejects_invalid_skins() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        assert!(save(dir, json!([1, 2])).is_err());
        assert!(save(dir, json!({ "id": "../evil", "name": "x" })).is_err());
        assert!(save(dir, json!({ "id": "ok" })).is_err());
        assert!(save(dir, json!({ "id": "ok", "name": "   " })).is_err());
        let huge = "x".repeat(MAX_SKIN_BYTES as usize);
        assert!(save(dir, json!({ "id": "big", "name": "Big", "description": huge })).is_err());
        assert!(std::fs::read_dir(dir).unwrap().next().is_none(), "nothing may be written");
    }

    #[test]
    fn hand_written_files() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("My Theme.json"), r#"{ "id": "mine", "name": "Mine" }"#).unwrap();
        std::fs::write(dir.join("sunset.json"), r#"{ "name": "Sunset" }"#).unwrap();
        std::fs::write(dir.join("broken.json"), "{ nope").unwrap();
        std::fs::write(dir.join("twice.json"), r#"{ "id": "mine", "name": "Again" }"#).unwrap();
        std::fs::write(dir.join("notes.txt"), "ignored").unwrap();

        let l = list(dir);
        let ids: Vec<_> = l.skins.iter().map(|s| s.skin["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, ["mine", "sunset"]);
        let bad: Vec<_> = l.errors.iter().map(|e| e.file.as_str()).collect();
        assert_eq!(bad, ["broken.json", "twice.json"]);

        // saving keeps the user's file name
        let s = save(dir, json!({ "id": "mine", "name": "Mine 2" })).unwrap();
        assert_eq!(s.file, "My Theme.json");
        delete(dir, "mine").unwrap();
        assert!(!dir.join("My Theme.json").exists());
    }
}
