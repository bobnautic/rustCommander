//! HTTP client and OpenDAL operators for the individual services.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use opendal::layers::RetryLayer;
use opendal::{services, HttpTransporter, OperationContext, Operator};
use opendal_http_transport_reqwest::ReqwestTransport;

use super::map_err;
use super::s3::Credentials;
use crate::error::{Error, Result};
use crate::protocols::tls::CertTrust;
use crate::site::{ProxyKind, SiteConfig};

/// `user:pass` for URLs (percent-encoded).
fn userinfo(user: &str, pass: &str) -> String {
    let enc = |s: &str| -> String {
        s.bytes()
            .map(|b| match b {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
                _ => format!("%{b:02X}"),
            })
            .collect()
    };
    format!("{}:{}@", enc(user), enc(pass))
}

fn host_port(host: &str, port: u16) -> String {
    if host.contains(':') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// The HTTP client used for all requests of a session: our TLS verification (ring,
/// trust on first use), the site's proxy and timeouts.
pub(super) fn http_client(site: &SiteConfig, trust: &Arc<CertTrust>) -> Result<reqwest::Client> {
    let mut b = reqwest::Client::builder()
        .tls_backend_preconfigured(trust.client_config()?)
        .connect_timeout(site.timeout())
        .read_timeout(site.timeout().max(Duration::from_secs(60)))
        .pool_idle_timeout(Duration::from_secs(50))
        .user_agent(format!("RustCommander/{}", crate::VERSION));
    let p = &site.proxy;
    if p.kind != ProxyKind::None {
        let pass = p.password.as_deref().unwrap_or("");
        let proxy = match p.kind {
            ProxyKind::Socks5 => {
                let auth = if p.username.is_empty() { String::new() } else { userinfo(&p.username, pass) };
                let port = if p.port == 0 { 1080 } else { p.port };
                reqwest::Proxy::all(format!("socks5h://{auth}{}", host_port(&p.host, port)))
            }
            _ => {
                let port = if p.port == 0 { 8080 } else { p.port };
                reqwest::Proxy::all(format!("http://{}", host_port(&p.host, port))).map(|proxy| {
                    if p.username.is_empty() {
                        proxy
                    } else {
                        proxy.basic_auth(&p.username, pass)
                    }
                })
            }
        }
        .map_err(|e| Error::InvalidInput(format!("proxy: {e}")))?;
        b = b.proxy(proxy);
    }
    b.build().map_err(|e| Error::other(format!("HTTP client: {e}")))
}

/// Use our HTTP client and retry transient failures.
fn finish(op: Operator, http: &reqwest::Client) -> Operator {
    let transport = HttpTransporter::new(ReqwestTransport::new(http.clone()));
    op.with_context(OperationContext::new().with_http_transport(transport))
        .layer(RetryLayer::new().with_max_times(3).with_jitter())
}

/// Where WebDAV resources live: `{base}{root}{path}`.
#[derive(Debug, Clone)]
pub(super) struct DavTarget {
    pub base: String,
    pub root: String,
    pub authorization: Option<String>,
}

impl DavTarget {
    pub fn url(&self, rel: &str) -> String {
        format!("{}{}", self.base, opendal::raw::percent_encode_path(&format!("{}{rel}", self.root)))
    }
}

pub(super) fn dav_target(site: &SiteConfig, password: Option<&str>) -> DavTarget {
    let scheme = if site.webdav.https { "https" } else { "http" };
    let port = site.effective_port();
    let default_port = if site.webdav.https { 443 } else { 80 };
    let authority = if port != default_port {
        host_port(&site.host, port)
    } else if site.host.contains(':') {
        format!("[{}]", site.host)
    } else {
        site.host.clone()
    };
    let authorization = (!site.username.is_empty()).then(|| {
        let cred = format!("{}:{}", site.username, password.unwrap_or(""));
        format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(cred))
    });
    DavTarget {
        base: format!("{scheme}://{authority}"),
        root: opendal::raw::normalize_root(&site.webdav.root),
        authorization,
    }
}

pub(super) fn webdav(
    site: &SiteConfig,
    target: &DavTarget,
    password: Option<&str>,
    http: &reqwest::Client,
) -> Result<Operator> {
    let mut b = services::Webdav::default().endpoint(&target.base).root(&target.root);
    if !site.username.is_empty() {
        b = b.username(&site.username).password(password.unwrap_or(""));
    }
    let op = Operator::new(b).map_err(|e| map_err(e, "/"))?;
    Ok(finish(op, http))
}

#[derive(Debug, Clone)]
pub(super) struct S3Settings {
    /// Custom endpoint with scheme; `None` = AWS.
    pub endpoint: Option<String>,
    pub region: String,
    pub credentials: Option<Credentials>,
    pub anonymous: bool,
    pub virtual_host: bool,
}

impl S3Settings {
    pub fn from_site(site: &SiteConfig, secret: Option<&str>) -> Self {
        let endpoint = if !site.s3.endpoint.trim().is_empty() {
            let e = site.s3.endpoint.trim().trim_end_matches('/');
            Some(if e.starts_with("http://") || e.starts_with("https://") {
                e.to_string()
            } else {
                format!("https://{e}")
            })
        } else if !site.host.is_empty() && !site.host.ends_with("amazonaws.com") {
            // s3://minio.example.com:9000/bucket
            let scheme = if site.port == 80 { "http" } else { "https" };
            let port = if site.port == 0 { 443 } else { site.port };
            Some(if port == 443 || port == 80 {
                format!("{scheme}://{}", site.host)
            } else {
                format!("{scheme}://{}", host_port(&site.host, port))
            })
        } else {
            None
        };
        let aws = endpoint.as_deref().is_none_or(|e| e.contains("amazonaws.com"));
        let credentials = (!site.s3.anonymous && !site.username.is_empty()).then(|| Credentials {
            access_key: site.username.clone(),
            secret_key: secret.unwrap_or_default().to_string(),
            session_token: site.s3.session_token.clone().filter(|t| !t.is_empty()),
        });
        let region =
            if site.s3.region.trim().is_empty() { "us-east-1".to_string() } else { site.s3.region.trim().to_string() };
        S3Settings {
            endpoint,
            region,
            credentials,
            anonymous: site.s3.anonymous,
            virtual_host: !site.s3.path_style && aws,
        }
    }

    pub fn is_aws(&self) -> bool {
        self.endpoint.as_deref().is_none_or(|e| e.contains("amazonaws.com"))
    }

    /// Endpoint for service-level requests (`ListBuckets`).
    pub fn service_endpoint(&self) -> String {
        match &self.endpoint {
            Some(e) => e.clone(),
            None => format!("https://s3.{}.amazonaws.com", self.region),
        }
    }

    pub fn operator(&self, bucket: &str, region: &str, http: &reqwest::Client) -> Result<Operator> {
        let mut b = services::S3::default().bucket(bucket).region(region).root("/");
        if let Some(e) = &self.endpoint {
            b = b.endpoint(e);
        }
        if self.anonymous {
            b = b.skip_signature().disable_config_load().disable_ec2_metadata();
        } else if let Some(c) = &self.credentials {
            b = b
                .access_key_id(&c.access_key)
                .secret_access_key(&c.secret_key)
                .disable_config_load()
                .disable_ec2_metadata();
            if let Some(t) = &c.session_token {
                b = b.session_token(t);
            }
        }
        // Otherwise: AWS default credentials (environment, profile, instance metadata).
        if self.virtual_host && !bucket.contains('.') {
            b = b.enable_virtual_host_style();
        }
        let op = Operator::new(b).map_err(|e| map_err(e, "/"))?;
        Ok(finish(op, http))
    }
}

fn azure_account(site: &SiteConfig) -> &str {
    if site.azure.account.is_empty() {
        &site.username
    } else {
        &site.azure.account
    }
}

pub(super) fn azure_endpoint(site: &SiteConfig) -> Result<String> {
    let account = azure_account(site);
    if !site.azure.endpoint.trim().is_empty() {
        Ok(site.azure.endpoint.trim().trim_end_matches('/').to_string())
    } else if !account.is_empty() {
        Ok(format!("https://{account}.blob.core.windows.net"))
    } else {
        Err(Error::InvalidInput("Azure Blob Storage: an account name or endpoint is required".into()))
    }
}

/// Operator and container name.
pub(super) fn azure(site: &SiteConfig, http: &reqwest::Client) -> Result<(Operator, String)> {
    let account = azure_account(site);
    let container = site.azure.container.trim().to_string();
    if container.is_empty() {
        return Err(Error::InvalidInput("Azure Blob Storage: a container is required".into()));
    }
    let endpoint = azure_endpoint(site)?;
    let mut b = services::Azblob::default().container(&container).endpoint(&endpoint).root("/");
    if !account.is_empty() {
        b = b.account_name(account);
    }
    match (site.azure.sas_token.as_deref().map(str::trim).filter(|s| !s.is_empty()), site.password.as_deref()) {
        (Some(sas), _) => b = b.sas_token(sas.trim_start_matches('?')),
        (None, Some(key)) if !key.is_empty() => b = b.account_key(key),
        _ => {}
    }
    let op = Operator::new(b).map_err(|e| map_err(e, "/"))?;
    Ok((finish(op, http), container))
}

pub(super) fn gcs_endpoint(site: &SiteConfig) -> String {
    match site.gcs.endpoint.trim().trim_end_matches('/') {
        "" => "https://storage.googleapis.com".to_string(),
        e => e.to_string(),
    }
}

/// Operator and bucket name.
pub(super) fn gcs(site: &SiteConfig, http: &reqwest::Client) -> Result<(Operator, String)> {
    let bucket = if site.gcs.bucket.trim().is_empty() {
        site.host.trim().to_string()
    } else {
        site.gcs.bucket.trim().to_string()
    };
    if bucket.is_empty() {
        return Err(Error::InvalidInput("Google Cloud Storage: a bucket is required".into()));
    }
    let mut b = services::Gcs::default().bucket(&bucket).root("/");
    if !site.gcs.endpoint.trim().is_empty() {
        b = b.endpoint(&gcs_endpoint(site));
    }
    match site.gcs.credential_json.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(json) => {
            let encoded = if json.starts_with('{') {
                base64::engine::general_purpose::STANDARD.encode(json)
            } else {
                json.to_string()
            };
            b = b.credential(&encoded).disable_config_load().disable_vm_metadata();
        }
        // Without a service account: an OAuth token in the password field, user name
        // `anonymous` for public buckets / emulators, otherwise application default
        // credentials.
        None => {
            if let Some(token) = site.password.as_deref().filter(|t| !t.is_empty()) {
                b = b.token(token.to_string()).disable_config_load().disable_vm_metadata();
            } else if site.username.eq_ignore_ascii_case("anonymous") {
                b = b.skip_signature().disable_config_load().disable_vm_metadata();
            }
        }
    }
    let op = Operator::new(b).map_err(|e| map_err(e, "/"))?;
    Ok((finish(op, http), bucket))
}
