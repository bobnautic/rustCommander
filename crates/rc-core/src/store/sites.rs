//! The site manager's storage (`sites.json`), with secrets encrypted by the [`Vault`].

use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;

use crate::error::{Error, Result};
use crate::site::SiteConfig;
use crate::store::vault::{decrypt_with, encrypt_with, is_encrypted, Vault};
use crate::store::{load_json, save_json};

/// Returned instead of stored secrets; sending it back keeps the stored value.
pub const SECRET_PLACEHOLDER: &str = "<<rc:secret>>";

fn secret_fields(s: &mut SiteConfig) -> [&mut Option<String>; 7] {
    [
        &mut s.password,
        &mut s.ssh.private_key,
        &mut s.ssh.passphrase,
        &mut s.s3.session_token,
        &mut s.azure.sas_token,
        &mut s.gcs.credential_json,
        &mut s.proxy.password,
    ]
}

pub struct SiteStore {
    path: Option<PathBuf>,
    sites: RwLock<Vec<SiteConfig>>,
    vault: Arc<Vault>,
}

impl SiteStore {
    pub fn in_memory(vault: Arc<Vault>) -> Self {
        SiteStore { path: None, sites: RwLock::new(Vec::new()), vault }
    }

    pub fn load(path: PathBuf, vault: Arc<Vault>) -> Self {
        let sites: Vec<SiteConfig> = load_json(&path).unwrap_or_default();
        SiteStore { path: Some(path), sites: RwLock::new(sites), vault }
    }

    pub fn vault(&self) -> &Arc<Vault> {
        &self.vault
    }

    fn persist(&self) -> Result<()> {
        if let Some(p) = &self.path {
            save_json(p, &*self.sites.read())?;
        }
        Ok(())
    }

    fn masked(mut s: SiteConfig) -> SiteConfig {
        for f in secret_fields(&mut s) {
            if f.as_deref().is_some_and(|v| !v.is_empty()) {
                *f = Some(SECRET_PLACEHOLDER.to_string());
            }
        }
        s.ssh.jump = None;
        s
    }

    /// All sites with secrets replaced by [`SECRET_PLACEHOLDER`].
    pub fn list_masked(&self) -> Vec<SiteConfig> {
        let mut v: Vec<SiteConfig> = self.sites.read().iter().cloned().map(Self::masked).collect();
        v.sort_by(|a, b| (a.folder.to_lowercase(), a.name.to_lowercase()).cmp(&(b.folder.to_lowercase(), b.name.to_lowercase())));
        v
    }

    pub fn exists(&self, id: &str) -> bool {
        self.sites.read().iter().any(|s| s.id == id)
    }

    /// A site with decrypted secrets and resolved jump host, ready for connecting.
    pub fn get_decrypted(&self, id: &str) -> Result<SiteConfig> {
        self.resolve(id, 0)
    }

    fn resolve(&self, id: &str, depth: usize) -> Result<SiteConfig> {
        if depth > 5 {
            return Err(Error::InvalidInput("jump host chain too long (cycle?)".into()));
        }
        let mut s = self
            .sites
            .read()
            .iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or_else(|| Error::NotFound(format!("site {id}")))?;
        for f in secret_fields(&mut s) {
            if let Some(v) = f.as_deref() {
                *f = Some(self.vault.decrypt(v)?);
            }
        }
        if let Some(jid) = s.ssh.jump_site_id.clone().filter(|j| !j.is_empty()) {
            s.ssh.jump = Some(Box::new(self.resolve(&jid, depth + 1)?));
        }
        Ok(s)
    }

    /// Merge secrets of an incoming site (placeholder = keep, plaintext = encrypt).
    fn prepare(&self, mut incoming: SiteConfig, existing: Option<&SiteConfig>) -> Result<SiteConfig> {
        let mut old = existing.cloned().unwrap_or_default();
        let old_fields = secret_fields(&mut old);
        let new_fields = secret_fields(&mut incoming);
        for (n, o) in new_fields.into_iter().zip(old_fields) {
            match n.as_deref() {
                Some(SECRET_PLACEHOLDER) => *n = o.clone(),
                Some("") | None => *n = None,
                Some(v) if is_encrypted(v) => {}
                Some(v) => *n = Some(self.vault.encrypt(v)?),
            }
        }
        incoming.ssh.jump = None;
        Ok(incoming)
    }

    /// Insert or update. Returns the masked site.
    pub fn save(&self, site: SiteConfig) -> Result<SiteConfig> {
        let mut site = site;
        if site.name.trim().is_empty() {
            site.name = site.display_name();
        }
        site.folder = site.folder.trim_matches('/').to_string();
        let stored = {
            let mut sites = self.sites.write();
            let idx = if site.id.is_empty() { None } else { sites.iter().position(|s| s.id == site.id) };
            let existing = idx.map(|i| sites[i].clone());
            let mut prepared = self.prepare(site, existing.as_ref())?;
            if prepared.id.is_empty() {
                prepared.id = uuid::Uuid::new_v4().to_string();
            }
            match idx {
                Some(i) => sites[i] = prepared.clone(),
                None => sites.push(prepared.clone()),
            }
            prepared
        };
        self.persist()?;
        Ok(Self::masked(stored))
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        {
            let mut sites = self.sites.write();
            let before = sites.len();
            sites.retain(|s| s.id != id);
            if sites.len() == before {
                return Err(Error::NotFound(format!("site {id}")));
            }
            for s in sites.iter_mut() {
                if s.ssh.jump_site_id.as_deref() == Some(id) {
                    s.ssh.jump_site_id = None;
                }
            }
        }
        self.persist()
    }

    pub fn duplicate(&self, id: &str) -> Result<SiteConfig> {
        let mut s = self
            .sites
            .read()
            .iter()
            .find(|s| s.id == id)
            .cloned()
            .ok_or_else(|| Error::NotFound(format!("site {id}")))?;
        s.id = uuid::Uuid::new_v4().to_string();
        s.name = format!("{} (copy)", s.name);
        self.sites.write().push(s.clone());
        self.persist()?;
        Ok(Self::masked(s))
    }

    pub fn rename_folder(&self, from: &str, to: &str) -> Result<()> {
        let from = from.trim_matches('/');
        let to = to.trim_matches('/');
        {
            let mut sites = self.sites.write();
            for s in sites.iter_mut() {
                if s.folder == from {
                    s.folder = to.to_string();
                } else if let Some(rest) = s.folder.strip_prefix(&format!("{from}/")) {
                    s.folder = if to.is_empty() { rest.to_string() } else { format!("{to}/{rest}") };
                }
            }
        }
        self.persist()
    }

    /// Add imported sites (secrets in plaintext get encrypted). Returns them masked.
    pub fn import(&self, sites: Vec<SiteConfig>) -> Result<Vec<SiteConfig>> {
        let mut out = Vec::new();
        // Jump references in imports use names; map them to the new ids.
        let mut name_to_id = std::collections::HashMap::new();
        let mut prepared = Vec::new();
        for mut s in sites {
            s.id = uuid::Uuid::new_v4().to_string();
            name_to_id.insert(s.name.clone(), s.id.clone());
            prepared.push(s);
        }
        for mut s in prepared {
            if let Some(j) = s.ssh.jump_site_id.take() {
                s.ssh.jump_site_id = name_to_id.get(&j).cloned().or_else(|| {
                    self.sites.read().iter().find(|x| x.name == j || x.id == j).map(|x| x.id.clone())
                });
            }
            let p = self.prepare(s, None)?;
            out.push(Self::masked(p.clone()));
            self.sites.write().push(p);
        }
        self.persist()?;
        Ok(out)
    }

    /// JSON export without any secrets.
    pub fn export(&self, ids: Option<&[String]>) -> Result<String> {
        let sites: Vec<SiteConfig> = self
            .sites
            .read()
            .iter()
            .filter(|s| ids.is_none_or(|ids| ids.contains(&s.id)))
            .cloned()
            .map(|mut s| {
                for f in secret_fields(&mut s) {
                    *f = None;
                }
                s
            })
            .collect();
        Ok(serde_json::to_string_pretty(&sites)?)
    }

    /// Re-encrypt every stored secret after the vault key changed.
    pub fn reencrypt(&self, old_key: &[u8; 32], new_key: &[u8; 32]) -> Result<()> {
        {
            let mut sites = self.sites.write();
            for s in sites.iter_mut() {
                for f in secret_fields(s) {
                    if let Some(v) = f.as_deref() {
                        if is_encrypted(v) {
                            let plain = decrypt_with(old_key, v)?;
                            *f = Some(encrypt_with(new_key, &plain)?);
                        }
                    }
                }
            }
        }
        self.persist()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_masked_and_kept() {
        let store = SiteStore::in_memory(Arc::new(Vault::ephemeral()));
        let mut s = SiteConfig { host: "h".into(), username: "u".into(), password: Some("pw".into()), ..Default::default() };
        let saved = store.save(s.clone()).unwrap();
        assert_eq!(saved.password.as_deref(), Some(SECRET_PLACEHOLDER));
        assert!(!saved.id.is_empty());
        assert_eq!(store.get_decrypted(&saved.id).unwrap().password.as_deref(), Some("pw"));
        // Save again with placeholder keeps the password.
        s = saved.clone();
        s.host = "h2".into();
        store.save(s.clone()).unwrap();
        let d = store.get_decrypted(&saved.id).unwrap();
        assert_eq!(d.host, "h2");
        assert_eq!(d.password.as_deref(), Some("pw"));
        // null removes it
        s.password = None;
        store.save(s).unwrap();
        assert_eq!(store.get_decrypted(&saved.id).unwrap().password, None);
        assert!(!store.export(None).unwrap().contains("enc:"));
    }

    #[test]
    fn jump_hosts_resolve() {
        let store = SiteStore::in_memory(Arc::new(Vault::ephemeral()));
        let j = store.save(SiteConfig { name: "jump".into(), host: "j".into(), ..Default::default() }).unwrap();
        let mut t = SiteConfig { name: "target".into(), host: "t".into(), ..Default::default() };
        t.ssh.jump_site_id = Some(j.id.clone());
        let t = store.save(t).unwrap();
        let d = store.get_decrypted(&t.id).unwrap();
        assert_eq!(d.ssh.jump.unwrap().host, "j");
    }
}
