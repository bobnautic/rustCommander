//! WebDAV, S3, Azure Blob Storage and Google Cloud Storage (OpenDAL).
//!
//! Virtual paths `/a/b` map to OpenDAL paths `a/b` (files) and `a/b/` (directories).
//! Object stores have no real directories: a directory exists when an empty `dir/`
//! marker object or any object below the prefix exists. An S3 site without a bucket
//! shows the buckets as directories at `/` (`/bucket/key` paths).

mod backends;
mod io;
mod s3;

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use opendal::{ErrorKind, Metadata, Operator};
use parking_lot::Mutex;

use self::backends::{DavTarget, S3Settings};
use self::io::{DavWriter, ObjectReader, ObjectWriter};
use crate::connect::ConnectContext;
use crate::error::{Error, Result};
use crate::path as vpath;
use crate::prompt::PromptRequest;
use crate::protocols::tls::CertTrust;
use crate::site::SiteConfig;
use crate::types::*;
use crate::vfs::*;

/// Upload part size for services with multipart uploads (S3 needs at least 5 MiB).
const PART_SIZE: usize = 8 * 1024 * 1024;
const PART_CONCURRENCY: usize = 2;

pub async fn connect(site: &SiteConfig, ctx: &ConnectContext) -> Result<Arc<dyn Vfs>> {
    Ok(Arc::new(CloudVfs::connect(site, ctx).await?))
}

/// Map an OpenDAL error for `path`.
pub(crate) fn map_err(e: opendal::Error, path: &str) -> Error {
    tracing::debug!("{path}: {e}");
    let detail = || format!("{path}: {}", e.message());
    let missing_container = || {
        let m = e.message();
        ["NoSuchBucket", "ContainerNotFound", "bucket does not exist"].iter().any(|w| m.contains(w))
    };
    match e.kind() {
        ErrorKind::NotFound => Error::NotFound(path.to_string()),
        ErrorKind::ConfigInvalid if missing_container() => Error::NotFound(path.to_string()),
        ErrorKind::PermissionDenied => Error::PermissionDenied(detail()),
        ErrorKind::AlreadyExists => Error::AlreadyExists(path.to_string()),
        ErrorKind::IsADirectory => Error::IsADirectory(path.to_string()),
        ErrorKind::NotADirectory => Error::NotADirectory(path.to_string()),
        ErrorKind::Unsupported => Error::Unsupported(detail()),
        ErrorKind::ConfigInvalid => Error::InvalidInput(detail()),
        ErrorKind::IsSameFile => Error::InvalidInput(format!("{path}: source and target are the same")),
        ErrorKind::RangeNotSatisfied => Error::InvalidInput(format!("{path}: offset beyond the end of the file")),
        _ if e.is_temporary() || e.message().contains("send http request") => {
            let sources = std::error::Error::source(&e).map(error_chain).unwrap_or_default();
            Error::ConnectionLost(format!("{path}: {} {sources}", e.message()).trim_end().to_string())
        }
        k => Error::Other(format!("{path}: {k}: {}", e.message())),
    }
}

/// An OpenDAL error with its sources (TLS or connection details live there).
fn error_chain(e: &(dyn std::error::Error + 'static)) -> String {
    let mut s = e.to_string();
    let mut src = e.source();
    while let Some(c) = src {
        let t = c.to_string();
        if !s.contains(&t) {
            s.push_str(": ");
            s.push_str(&t);
        }
        src = c.source();
    }
    s
}

pub(crate) fn reqwest_error(e: &reqwest::Error) -> String {
    error_chain(e)
}

fn map_io_err(e: std::io::Error, path: &str) -> Error {
    match e.into_inner() {
        Some(inner) => match inner.downcast::<opendal::Error>() {
            Ok(oe) => map_err(*oe, path),
            Err(other) => Error::ConnectionLost(format!("{path}: {other}")),
        },
        None => Error::ConnectionLost(format!("{path}: I/O error")),
    }
}

fn http_status_error(status: u16, path: &str, body: &str) -> Error {
    let snippet: String = body.chars().take(200).collect();
    let msg = format!("{path}: HTTP {status} {}", snippet.trim());
    match status {
        401 => Error::AuthFailed(msg),
        403 | 423 => Error::PermissionDenied(msg),
        404 | 409 => Error::NotFound(path.to_string()),
        405 => Error::IsADirectory(path.to_string()),
        412 => Error::AlreadyExists(path.to_string()),
        _ => Error::Protocol(msg),
    }
}

/// Credentials errors that make connecting pointless (vs. missing list permissions).
fn is_auth_failure(e: &opendal::Error) -> bool {
    let s = e.to_string();
    [
        "InvalidAccessKeyId",
        "SignatureDoesNotMatch",
        "InvalidToken",
        "ExpiredToken",
        "AuthorizationHeaderMalformed",
        "AuthenticationFailed",
        "InvalidAuthenticationInfo",
        "Invalid Credentials",
        "invalid_grant",
        "status: 401",
    ]
    .iter()
    .any(|w| s.contains(w))
}

/// List one entry of the root: fails for missing buckets / containers and bad
/// credentials (unlike `Operator::check`, which ignores `NotFound`).
async fn check_root(op: &Operator, what: &str) -> Result<()> {
    match op.list_with("/").limit(1).await {
        Ok(_) => Ok(()),
        Err(e) if is_auth_failure(&e) => Err(Error::AuthFailed(e.message().to_string())),
        Err(e) => Err(map_err(e, what)),
    }
}

fn entry_from(name: &str, path: String, meta: &Metadata) -> FileEntry {
    let kind = if meta.is_dir() { FileKind::Dir } else { FileKind::File };
    let mut e = FileEntry::new(name, path, kind);
    if kind == FileKind::File {
        e.size = meta.content_length();
    }
    e.modified = meta.last_modified().map(|t| t.into_inner().as_second());
    e
}

fn dir_key(rel: &str) -> String {
    if rel.is_empty() {
        "/".to_string()
    } else {
        format!("{rel}/")
    }
}

enum Backend {
    Single(Operator),
    /// S3 without a bucket: `/` lists the buckets; operators per bucket are cached.
    Buckets {
        settings: S3Settings,
        ops: Mutex<HashMap<String, Operator>>,
        regions: Mutex<HashMap<String, String>>,
    },
}

/// A virtual path resolved to an operator and an OpenDAL path (no leading `/`).
enum Target {
    /// The bucket list (`/` of an S3 site without bucket).
    Buckets,
    Object {
        op: Operator,
        rel: String,
        bucket_root: bool,
    },
}

pub struct CloudVfs {
    protocol: Protocol,
    backend: Backend,
    http: reqwest::Client,
    trust: Arc<CertTrust>,
    dav: Option<DavTarget>,
    /// Service endpoint (WebDAV root URL) for connectivity checks.
    endpoint: String,
    caps: Capabilities,
    info: Vec<(String, String)>,
    session_id: String,
}

impl CloudVfs {
    pub async fn connect(site: &SiteConfig, ctx: &ConnectContext) -> Result<Self> {
        let protocol = site.protocol;
        if protocol == Protocol::Webdav && site.host.trim().is_empty() {
            return Err(Error::InvalidInput("WebDAV: no host name".into()));
        }
        // The URL used for connectivity checks; its host is the one whose certificate
        // is verified and remembered.
        let endpoint = match protocol {
            Protocol::Webdav => backends::dav_target(site, None).url(""),
            Protocol::S3 => S3Settings::from_site(site, None).service_endpoint(),
            Protocol::Azure => backends::azure_endpoint(site)?,
            Protocol::Gcs => backends::gcs_endpoint(site),
            p => return Err(Error::unsupported(format!("{p:?} is not a cloud protocol"))),
        };
        let url = reqwest::Url::parse(&endpoint).map_err(|e| Error::InvalidInput(format!("{endpoint}: {e}")))?;
        let host = url.host_str().unwrap_or_default().trim_start_matches('[').trim_end_matches(']').to_string();
        let tofu = protocol == Protocol::Webdav && site.webdav.allow_invalid_certs;
        let trust = CertTrust::new(&host, url.port_or_known_default().unwrap_or(443), ctx.known_hosts.clone(), tofu);
        let http = backends::http_client(site, &trust)?;

        // Ask for a missing password / secret key.
        let mut password = site.password.clone();
        let needs_secret =
            matches!(protocol, Protocol::Webdav | Protocol::S3) && !site.username.is_empty() && !site.s3.anonymous;
        if password.is_none() && needs_secret {
            let req = PromptRequest::Password {
                host: host.clone(),
                username: site.username.clone(),
                message: if protocol == Protocol::S3 { "Secret access key".into() } else { String::new() },
            };
            let resp = ctx.prompter.prompt(req).await.filter(|r| r.accepted).ok_or(Error::Cancelled)?;
            password = Some(resp.value(0).unwrap_or_default().to_string());
        }

        let mut info: Vec<(String, String)> = Vec::new();
        let mut dav = None;
        let backend = match protocol {
            Protocol::Webdav => {
                let target = backends::dav_target(site, password.as_deref());
                let op = backends::webdav(site, &target, password.as_deref(), &http)?;
                info.push(("Protocol".into(), "WebDAV".into()));
                info.push(("Server".into(), target.base.clone()));
                info.push(("Root".into(), target.root.clone()));
                dav = Some(target);
                Backend::Single(op)
            }
            Protocol::S3 => {
                let settings = S3Settings::from_site(site, password.as_deref());
                info.push(("Protocol".into(), "Amazon S3 (compatible)".into()));
                info.push(("Endpoint".into(), endpoint.clone()));
                info.push((
                    "Addressing".into(),
                    if settings.virtual_host { "virtual-host style" } else { "path style" }.into(),
                ));
                let bucket = site.s3.bucket.trim().to_string();
                if bucket.is_empty() {
                    if settings.anonymous || settings.credentials.is_none() {
                        return Err(Error::InvalidInput("S3: a bucket is required for anonymous access".into()));
                    }
                    info.push(("Bucket".into(), "(all buckets)".into()));
                    info.push(("Region".into(), settings.region.clone()));
                    Backend::Buckets { settings, ops: Mutex::new(HashMap::new()), regions: Mutex::new(HashMap::new()) }
                } else {
                    let region = if site.s3.region.trim().is_empty() && settings.is_aws() {
                        s3::bucket_region(&http, &bucket).await.unwrap_or_else(|| settings.region.clone())
                    } else {
                        settings.region.clone()
                    };
                    info.push(("Bucket".into(), bucket.clone()));
                    info.push(("Region".into(), region.clone()));
                    Backend::Single(settings.operator(&bucket, &region, &http)?)
                }
            }
            Protocol::Azure => {
                let (op, container) = backends::azure(site, &http)?;
                info.push(("Protocol".into(), "Azure Blob Storage".into()));
                info.push(("Endpoint".into(), endpoint.clone()));
                info.push(("Container".into(), container));
                Backend::Single(op)
            }
            _ => {
                let (op, bucket) = backends::gcs(site, &http)?;
                info.push(("Protocol".into(), "Google Cloud Storage".into()));
                info.push(("Endpoint".into(), endpoint.clone()));
                info.push(("Bucket".into(), bucket));
                Backend::Single(op)
            }
        };
        let caps = match &backend {
            Backend::Single(op) => {
                let c = op.info().capability();
                Capabilities { server_copy: c.copy, resume_download: c.read, ..Default::default() }
            }
            Backend::Buckets { .. } => Capabilities { server_copy: true, resume_download: true, ..Default::default() },
        };
        let vfs =
            CloudVfs { protocol, backend, http, trust, dav, endpoint, caps, info, session_id: ctx.session_id.clone() };

        // A plain request first: TLS and connection problems show up at once instead of
        // after OpenDAL's retries; untrusted certificates are confirmed by the user.
        let mut asked = false;
        let status = loop {
            match vfs.preflight().await {
                Ok(status) => break status,
                Err(e) => match vfs.trust.take_rejected() {
                    Some(cert) if !asked => {
                        vfs.trust.confirm(&*ctx.prompter, cert).await?;
                        asked = true;
                    }
                    Some(cert) => return Err(Error::HostKeyRejected(cert.reason)),
                    None => return Err(e),
                },
            }
        };
        // Credentials, bucket / container / WebDAV root.
        let checked = if vfs.is_webdav() { vfs.dav_status(status) } else { vfs.probe().await };
        match checked {
            Ok(()) => {}
            Err(Error::PermissionDenied(msg)) if protocol != Protocol::Webdav => {
                tracing::warn!(session = %ctx.session_id, "listing the root is not permitted: {msg}");
            }
            Err(e) => return Err(e),
        }
        tracing::info!(session = %ctx.session_id, "connected to {} ({:?})", host, protocol);
        Ok(vfs)
    }

    /// Interpret the status of the WebDAV root `PROPFIND`.
    fn dav_status(&self, status: u16) -> Result<()> {
        match status {
            200..=299 => Ok(()),
            401 => Err(Error::AuthFailed(format!("{}: invalid user name or password", self.endpoint))),
            403 => Err(Error::PermissionDenied(self.endpoint.clone())),
            404 => Err(Error::NotFound(format!("WebDAV root {}", self.endpoint))),
            s => Err(Error::Protocol(format!("{}: HTTP status {s} (is this a WebDAV server?)", self.endpoint))),
        }
    }

    /// `PROPFIND` (depth 0) of the WebDAV root, `HEAD` of other service endpoints.
    async fn preflight(&self) -> Result<u16> {
        let req = match &self.dav {
            Some(dav) => {
                let method = reqwest::Method::from_bytes(b"PROPFIND").map_err(Error::other)?;
                let mut r = self.http.request(method, &self.endpoint).header("Depth", "0");
                if let Some(a) = &dav.authorization {
                    r = r.header(reqwest::header::AUTHORIZATION, a);
                }
                r
            }
            None => self.http.head(&self.endpoint),
        };
        match req.send().await {
            Ok(resp) => Ok(resp.status().as_u16()),
            Err(e) if e.is_timeout() => Err(Error::Timeout(format!("{}: {}", self.endpoint, reqwest_error(&e)))),
            Err(e) => Err(Error::ConnectionLost(format!("{}: {}", self.endpoint, reqwest_error(&e)))),
        }
    }

    async fn probe(&self) -> Result<()> {
        match &self.backend {
            Backend::Single(_) if self.is_webdav() => {
                let status = self.preflight().await?;
                self.dav_status(status)
            }
            Backend::Single(op) => {
                let what = self
                    .info
                    .iter()
                    .find(|(k, _)| k == "Bucket" || k == "Container")
                    .map(|(k, v)| format!("{} {v}", k.to_ascii_lowercase()))
                    .unwrap_or_else(|| "/".into());
                check_root(op, &what).await
            }
            Backend::Buckets { settings, .. } => self.list_buckets(settings).await.map(|_| ()),
        }
    }

    async fn list_buckets(&self, settings: &S3Settings) -> Result<Vec<s3::BucketInfo>> {
        let cred =
            settings.credentials.as_ref().ok_or_else(|| Error::InvalidInput("S3: credentials required".into()))?;
        let buckets = s3::list_buckets(&self.http, &settings.service_endpoint(), &settings.region, cred).await?;
        if let Backend::Buckets { regions, .. } = &self.backend {
            let mut r = regions.lock();
            for b in &buckets {
                if let Some(region) = &b.region {
                    r.insert(b.name.clone(), region.clone());
                }
            }
        }
        Ok(buckets)
    }

    async fn bucket_op(&self, bucket: &str) -> Result<Operator> {
        let Backend::Buckets { settings, ops, regions } = &self.backend else {
            return Err(Error::other("not a multi-bucket session"));
        };
        if let Some(op) = ops.lock().get(bucket) {
            return Ok(op.clone());
        }
        let known = regions.lock().get(bucket).cloned();
        let region = match known {
            Some(r) => r,
            None if settings.is_aws() => {
                s3::bucket_region(&self.http, bucket).await.unwrap_or_else(|| settings.region.clone())
            }
            None => settings.region.clone(),
        };
        let op = settings.operator(bucket, &region, &self.http)?;
        ops.lock().insert(bucket.to_string(), op.clone());
        Ok(op)
    }

    /// Normalized absolute virtual path.
    fn norm(path: &str) -> Result<String> {
        if path.contains('\0') {
            return Err(Error::InvalidInput(format!("invalid path {path:?}")));
        }
        Ok(vpath::normalize(&format!("/{}", path.trim_start_matches('/'))))
    }

    async fn resolve(&self, path: &str) -> Result<(String, Target)> {
        let norm = Self::norm(path)?;
        let rel = norm.trim_start_matches('/').to_string();
        let target = match &self.backend {
            Backend::Single(op) => Target::Object { op: op.clone(), bucket_root: rel.is_empty(), rel },
            Backend::Buckets { .. } if rel.is_empty() => Target::Buckets,
            Backend::Buckets { .. } => {
                let (bucket, key) = rel.split_once('/').unwrap_or((rel.as_str(), ""));
                Target::Object { op: self.bucket_op(bucket).await?, rel: key.to_string(), bucket_root: key.is_empty() }
            }
        };
        Ok((norm, target))
    }

    /// Resolve a path that must name an object (not a bucket or the root).
    async fn resolve_object(&self, path: &str) -> Result<(String, Operator, String)> {
        match self.resolve(path).await? {
            (norm, Target::Object { op, rel, bucket_root: false }) => Ok((norm, op, rel)),
            (norm, _) => Err(Error::IsADirectory(norm)),
        }
    }

    /// Metadata of `rel` as file or directory, `None` if neither exists.
    async fn lookup(&self, op: &Operator, rel: &str, norm: &str) -> Result<Option<Metadata>> {
        match op.stat(rel).await {
            Ok(m) => return Ok(Some(m)),
            Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::IsADirectory | ErrorKind::NotADirectory) => {}
            Err(e) => return Err(map_err(e, norm)),
        }
        match op.stat(&dir_key(rel)).await {
            Ok(m) => Ok(Some(m)),
            Err(e) if matches!(e.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => Ok(None),
            Err(e) => Err(map_err(e, norm)),
        }
    }

    fn is_webdav(&self) -> bool {
        self.protocol == Protocol::Webdav
    }

    /// Rename a directory: `MOVE` on WebDAV, copy + delete of every object elsewhere.
    async fn rename_dir(&self, op: &Operator, from: &str, to: &str, norm_from: &str) -> Result<()> {
        if let Some(dav) = &self.dav {
            let method = reqwest::Method::from_bytes(b"MOVE").map_err(Error::other)?;
            let mut req = self
                .http
                .request(method, dav.url(&dir_key(from)))
                .header("Destination", dav.url(&dir_key(to)))
                .header("Overwrite", "F");
            if let Some(a) = &dav.authorization {
                req = req.header(reqwest::header::AUTHORIZATION, a);
            }
            let resp =
                req.send().await.map_err(|e| Error::ConnectionLost(format!("{norm_from}: {}", reqwest_error(&e))))?;
            let status = resp.status().as_u16();
            // 207 Multi-Status reports members that could not be moved (RFC 4918, 9.9.4).
            if (200..300).contains(&status) && status != 207 {
                return Ok(());
            }
            let body = resp.text().await.unwrap_or_default();
            return Err(http_status_error(status, norm_from, &body));
        }
        let src = dir_key(from);
        let dst = dir_key(to);
        let entries = op.list_with(&src).recursive(true).await.map_err(|e| map_err(e, norm_from))?;
        for e in &entries {
            let Some(suffix) = e.path().strip_prefix(&src) else { continue };
            let target = format!("{dst}{suffix}");
            if e.metadata().is_dir() {
                op.create_dir(&target).await.map_err(|e| map_err(e, norm_from))?;
            } else {
                op.copy(e.path(), &target).await.map_err(|e| map_err(e, norm_from))?;
            }
        }
        if !entries.iter().any(|e| e.path() == src) {
            // Keep (now possibly empty) target directory visible.
            op.create_dir(&dst).await.map_err(|e| map_err(e, norm_from))?;
        }
        op.delete_with(&src).recursive(true).await.map_err(|e| map_err(e, norm_from))
    }
}

#[async_trait]
impl Vfs for CloudVfs {
    fn protocol(&self) -> Protocol {
        self.protocol
    }

    fn capabilities(&self) -> Capabilities {
        self.caps.clone()
    }

    fn session_info(&self) -> SessionInfo {
        let mut i = SessionInfo::default();
        for (k, v) in &self.info {
            i.push(k.clone(), v.clone());
        }
        if let Some(cert) = self.trust.peer() {
            i.push("Certificate subject", cert.subject);
            i.push("Certificate issuer", cert.issuer);
            i.push("Certificate valid until", cert.not_after);
            i.push("Certificate SHA-256", cert.fingerprint);
            i.push(
                "Certificate trust",
                if cert.ca_verified { "verified by a trusted authority" } else { "accepted by the user" },
            );
        }
        i
    }

    async fn home(&self) -> Result<String> {
        Ok("/".into())
    }

    async fn list(&self, path: &str) -> Result<Vec<FileEntry>> {
        let (norm, target) = self.resolve(path).await?;
        let (op, rel) = match (target, &self.backend) {
            (Target::Object { op, rel, .. }, _) => (op, rel),
            (Target::Buckets, Backend::Buckets { settings, .. }) => {
                let buckets = self.list_buckets(settings).await?;
                return Ok(buckets
                    .into_iter()
                    .map(|b| {
                        let mut e = FileEntry::new(b.name.clone(), vpath::join("/", &b.name), FileKind::Dir);
                        e.modified = b.created;
                        e
                    })
                    .collect());
            }
            (Target::Buckets, Backend::Single(_)) => return Err(Error::other("bucket list without S3 bucket mode")),
        };
        let dir = dir_key(&rel);
        if self.is_webdav() && !rel.is_empty() {
            // Listing a file as `file/` trips an assertion in OpenDAL's WebDAV lister.
            match op.stat(&dir).await {
                Ok(_) => {}
                Err(e) if e.kind() == ErrorKind::NotFound => {
                    return Err(match op.stat(&rel).await {
                        Ok(m) if m.is_file() => Error::NotADirectory(norm),
                        _ => Error::NotFound(norm),
                    });
                }
                Err(e) => return Err(map_err(e, &norm)),
            }
        }
        let entries = op.list(&dir).await.map_err(|e| map_err(e, &norm))?;
        let found = !entries.is_empty();
        let mut out = Vec::with_capacity(entries.len());
        for e in entries {
            let p = e.path();
            if p == dir || p == "/" || p.is_empty() {
                continue;
            }
            let name = e.name().trim_end_matches('/');
            if name.is_empty() {
                continue;
            }
            out.push(entry_from(name, vpath::join(&norm, name), e.metadata()));
        }
        if !found && !rel.is_empty() {
            // An empty prefix: tell a missing directory from a file.
            match op.stat(&rel).await {
                Ok(m) if m.is_file() => return Err(Error::NotADirectory(norm)),
                _ => return Err(Error::NotFound(norm)),
            }
        }
        Ok(out)
    }

    async fn stat(&self, path: &str) -> Result<FileEntry> {
        let (norm, target) = self.resolve(path).await?;
        let name = vpath::file_name(&norm).to_string();
        let name = if name.is_empty() { "/".to_string() } else { name };
        match target {
            Target::Buckets => Ok(FileEntry::new("/", "/", FileKind::Dir)),
            Target::Object { op, bucket_root: true, .. } => {
                if matches!(self.backend, Backend::Buckets { .. }) {
                    // Does the bucket exist?
                    check_root(&op, &norm).await?;
                }
                Ok(FileEntry::new(name, norm, FileKind::Dir))
            }
            Target::Object { op, rel, .. } => match self.lookup(&op, &rel, &norm).await? {
                Some(m) => Ok(entry_from(&name, norm, &m)),
                None => Err(Error::NotFound(norm)),
            },
        }
    }

    async fn mkdir(&self, path: &str) -> Result<()> {
        let (norm, op, rel) = match self.resolve(path).await? {
            (norm, Target::Object { op, rel, bucket_root: false }) => (norm, op, rel),
            (norm, Target::Object { bucket_root: true, .. }) if norm != "/" => {
                return Err(Error::unsupported("creating buckets"));
            }
            (norm, _) => return Err(Error::AlreadyExists(norm)),
        };
        if self.lookup(&op, &rel, &norm).await?.is_some() {
            return Err(Error::AlreadyExists(norm));
        }
        op.create_dir(&dir_key(&rel)).await.map_err(|e| map_err(e, &norm))
    }

    async fn remove_file(&self, path: &str) -> Result<()> {
        let (norm, op, rel) = self.resolve_object(path).await?;
        match op.stat(&rel).await {
            Ok(m) if m.is_dir() => return Err(Error::IsADirectory(norm)),
            Ok(_) => {}
            Err(e) if e.kind() == ErrorKind::NotFound => {
                return Err(match op.stat(&dir_key(&rel)).await {
                    Ok(_) => Error::IsADirectory(norm),
                    Err(_) => Error::NotFound(norm),
                });
            }
            Err(e) => return Err(map_err(e, &norm)),
        }
        op.delete(&rel).await.map_err(|e| map_err(e, &norm))
    }

    async fn remove_dir(&self, path: &str) -> Result<()> {
        let (norm, op, rel) =
            self.resolve_object(path).await.map_err(|_| Error::unsupported("removing the root or a bucket"))?;
        let dir = dir_key(&rel);
        match self.lookup(&op, &rel, &norm).await? {
            None => return Err(Error::NotFound(norm)),
            Some(m) if m.is_file() => return Err(Error::NotADirectory(norm)),
            Some(_) => {}
        }
        let children = op.list_with(&dir).limit(2).await.map_err(|e| map_err(e, &norm))?;
        if children.iter().any(|e| e.path() != dir) {
            return Err(Error::DirectoryNotEmpty(norm));
        }
        op.delete(&dir).await.map_err(|e| map_err(e, &norm))
    }

    async fn remove_dir_all(&self, path: &str) -> Result<()> {
        let (norm, op, rel) =
            self.resolve_object(path).await.map_err(|_| Error::unsupported("removing the root or a bucket"))?;
        match self.lookup(&op, &rel, &norm).await? {
            None => return Err(Error::NotFound(norm)),
            Some(m) if m.is_file() => return Err(Error::NotADirectory(norm)),
            Some(_) => {}
        }
        let dir = dir_key(&rel);
        if self.is_webdav() {
            // DELETE on a collection is recursive.
            op.delete(&dir).await.map_err(|e| map_err(e, &norm))
        } else {
            op.delete_with(&dir).recursive(true).await.map_err(|e| map_err(e, &norm))
        }
    }

    async fn rename(&self, from: &str, to: &str) -> Result<()> {
        let (norm_from, op, rel_from) = self.resolve_object(from).await?;
        let (norm_to, op_to, rel_to) = self.resolve_object(to).await?;
        if op.info().name() != op_to.info().name() {
            return Err(Error::unsupported("moving between buckets"));
        }
        if norm_from == norm_to {
            // Copy + delete onto itself would delete the object.
            return Ok(());
        }
        if vpath::relative_to(&norm_to, &norm_from).is_some() {
            // The copies would land below the source prefix and be deleted with it.
            return Err(Error::InvalidInput(format!("cannot move {norm_from} into itself")));
        }
        let meta = self.lookup(&op, &rel_from, &norm_from).await?.ok_or_else(|| Error::NotFound(norm_from.clone()))?;
        if meta.is_dir() {
            if self.lookup(&op, &rel_to, &norm_to).await?.is_some() {
                return Err(Error::AlreadyExists(norm_to));
            }
            return self.rename_dir(&op, &rel_from, &rel_to, &norm_from).await;
        }
        let cap = op.info().capability();
        if cap.rename {
            op.rename(&rel_from, &rel_to).await.map_err(|e| map_err(e, &norm_from))
        } else if cap.copy {
            op.copy(&rel_from, &rel_to).await.map_err(|e| map_err(e, &norm_from))?;
            op.delete(&rel_from).await.map_err(|e| map_err(e, &norm_from))
        } else {
            Err(Error::unsupported("renaming"))
        }
    }

    async fn copy_file(&self, from: &str, to: &str) -> Result<()> {
        let (norm_from, op, rel_from) = self.resolve_object(from).await?;
        let (_, op_to, rel_to) = self.resolve_object(to).await?;
        if op.info().name() != op_to.info().name() {
            return Err(Error::unsupported("copying between buckets"));
        }
        if !op.info().capability().copy {
            return Err(Error::unsupported("server-side copy"));
        }
        op.copy(&rel_from, &rel_to).await.map(|_| ()).map_err(|e| map_err(e, &norm_from))
    }

    async fn open_read(&self, path: &str, offset: u64) -> Result<Box<dyn FileReader>> {
        let (norm, op, rel) = self.resolve_object(path).await?;
        let meta = match op.stat(&rel).await {
            Ok(m) => m,
            Err(e) if e.kind() == ErrorKind::NotFound => {
                return Err(match op.stat(&dir_key(&rel)).await {
                    Ok(_) => Error::IsADirectory(norm),
                    Err(_) => Error::NotFound(norm),
                });
            }
            Err(e) => return Err(map_err(e, &norm)),
        };
        if meta.is_dir() {
            return Err(Error::IsADirectory(norm));
        }
        if offset >= meta.content_length() {
            return Ok(Box::new(ObjectReader::new(None, norm)));
        }
        let reader = op.reader(&rel).await.map_err(|e| map_err(e, &norm))?;
        let stream = match reader.into_bytes_stream(offset..).await {
            Ok(s) => Some(s),
            Err(e) if e.kind() == ErrorKind::RangeNotSatisfied => None,
            Err(e) => return Err(map_err(e, &norm)),
        };
        Ok(Box::new(ObjectReader::new(stream, norm)))
    }

    async fn open_write(&self, path: &str, opts: WriteOptions) -> Result<Box<dyn FileWriter>> {
        let (norm, op, rel) = self.resolve_object(path).await?;
        let cap = op.info().capability();
        if opts.offset > 0 {
            // Uploads are atomic (no partial files to resume). OpenDAL's "append" only
            // works on Azure append blobs / S3 Express buckets, which normal uploads
            // never create.
            return Err(Error::unsupported(format!("resuming uploads on {}", op.info().scheme())));
        }
        if let Some(dav) = &self.dav {
            return Ok(Box::new(DavWriter::start(
                &self.http,
                dav.url(&rel),
                dav.authorization.as_deref(),
                opts.size_hint,
                norm,
            )));
        }
        let w = if cap.write_can_multi {
            op.writer_with(&rel).chunk(PART_SIZE).concurrent(PART_CONCURRENCY).await
        } else {
            op.writer(&rel).await
        }
        .map_err(|e| map_err(e, &norm))?;
        Ok(Box::new(ObjectWriter::new(w, norm)))
    }

    async fn ping(&self) -> Result<()> {
        match self.probe().await {
            Err(Error::PermissionDenied(_)) => Ok(()),
            r => r,
        }
    }

    async fn close(&self) -> Result<()> {
        tracing::debug!(session = %self.session_id, "cloud session closed");
        Ok(())
    }
}
