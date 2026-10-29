//! Self-signed TLS certificate, created once per installation.

use std::path::Path;

use sha2::Digest;

use rc_core::{Error, Result};

pub struct CertPair {
    pub cert_pem: String,
    pub key_pem: String,
    /// `AA:BB:...` SHA-256 of the DER certificate (shown to users, announced on the LAN).
    pub fingerprint: String,
}

pub fn fingerprint_of_pem(cert_pem: &str) -> Option<String> {
    let start = cert_pem.find("-----BEGIN CERTIFICATE-----")?;
    let body: String = cert_pem[start..]
        .lines()
        .skip(1)
        .take_while(|l| !l.starts_with("-----END"))
        .collect();
    use base64::Engine;
    let der = base64::engine::general_purpose::STANDARD.decode(body).ok()?;
    Some(fingerprint_of_der(&der))
}

pub fn fingerprint_of_der(der: &[u8]) -> String {
    sha2::Sha256::digest(der).iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join(":")
}

/// Load `tls/cert.pem` + `tls/key.pem` from the config dir, or create them.
pub fn load_or_create(config_dir: &Path) -> Result<CertPair> {
    let dir = config_dir.join("tls");
    let cert_path = dir.join("cert.pem");
    let key_path = dir.join("key.pem");
    if let (Ok(cert_pem), Ok(key_pem)) = (std::fs::read_to_string(&cert_path), std::fs::read_to_string(&key_path)) {
        if let Some(fingerprint) = fingerprint_of_pem(&cert_pem) {
            return Ok(CertPair { cert_pem, key_pem, fingerprint });
        }
    }
    let host = rc_api::state::hostname();
    let mut names = vec![host.clone(), "localhost".to_string(), "127.0.0.1".to_string(), "::1".to_string()];
    if !host.contains('.') {
        names.push(format!("{host}.local"));
    }
    let mut params = rcgen::CertificateParams::new(names).map_err(|e| Error::other(format!("certificate: {e}")))?;
    params.distinguished_name.push(rcgen::DnType::CommonName, format!("Rust Commander on {host}"));
    params.distinguished_name.push(rcgen::DnType::OrganizationName, "Rust Commander");
    params.not_before = rcgen::date_time_ymd(2024, 1, 1);
    params.not_after = rcgen::date_time_ymd(2124, 1, 1);
    let key = rcgen::KeyPair::generate().map_err(|e| Error::other(format!("key generation: {e}")))?;
    let cert = params.self_signed(&key).map_err(|e| Error::other(format!("certificate: {e}")))?;
    let cert_pem = cert.pem();
    let key_pem = key.serialize_pem();
    std::fs::create_dir_all(&dir)?;
    std::fs::write(&cert_path, &cert_pem)?;
    std::fs::write(&key_path, &key_pem)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600));
    }
    let fingerprint = fingerprint_of_der(cert.der());
    tracing::info!("created TLS certificate {fingerprint}");
    Ok(CertPair { cert_pem, key_pem, fingerprint })
}
