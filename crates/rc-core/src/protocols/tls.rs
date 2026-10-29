//! TLS client configuration shared by FTPS and the HTTPS based backends.
//!
//! Certificates are verified against the system and Mozilla root stores first. When
//! that fails (self-signed, expired, wrong host name, ...) the SHA-256 fingerprint of the
//! leaf certificate is looked up in [`KnownHosts`]; unknown or changed certificates are
//! remembered in [`CertTrust`] so the connect code can ask the user after the handshake
//! failed and retry. Accepted fingerprints are cached per session, so the question is
//! asked once and not for every pooled connection.

use std::collections::HashSet;
use std::sync::{Arc, OnceLock};

use parking_lot::Mutex;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{CertificateError, ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};
use crate::known_hosts::{HostKeyStatus, KnownHosts};
use crate::prompt::{HostKeyState, PromptRequest, Prompter};

/// `key_type` of certificate fingerprints in [`KnownHosts`].
pub(crate) const CERT_KEY_TYPE: &str = "x509";

/// A server certificate that failed verification and is not trusted (yet).
#[derive(Debug, Clone)]
pub(crate) struct UntrustedCert {
    pub fingerprint: String,
    pub subject: String,
    pub issuer: String,
    pub reason: String,
    pub state: HostKeyState,
}

/// The certificate presented by the server in the last successful handshake.
#[derive(Debug, Clone)]
pub(crate) struct PeerCert {
    pub fingerprint: String,
    pub subject: String,
    pub issuer: String,
    pub not_after: String,
    /// Verified against a root store (`false` = trusted by the user).
    pub ca_verified: bool,
}

/// Certificate trust state of one connection (all pooled connections share it).
pub(crate) struct CertTrust {
    host: String,
    port: u16,
    known_hosts: Arc<KnownHosts>,
    /// Trust on first use: store an accepted *new* certificate even without "remember".
    tofu: bool,
    accepted: Mutex<HashSet<String>>,
    rejected: Mutex<Option<UntrustedCert>>,
    peer: Mutex<Option<PeerCert>>,
    prompt_lock: tokio::sync::Mutex<()>,
}

impl std::fmt::Debug for CertTrust {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CertTrust").field("host", &self.host).field("port", &self.port).finish_non_exhaustive()
    }
}

impl CertTrust {
    pub fn new(host: &str, port: u16, known_hosts: Arc<KnownHosts>, tofu: bool) -> Arc<Self> {
        Arc::new(CertTrust {
            host: host.to_string(),
            port,
            known_hosts,
            tofu,
            accepted: Mutex::new(HashSet::new()),
            rejected: Mutex::new(None),
            peer: Mutex::new(None),
            prompt_lock: tokio::sync::Mutex::new(()),
        })
    }

    /// A rustls client configuration (ring provider) that verifies through this trust store.
    pub fn client_config(self: &Arc<Self>) -> Result<ClientConfig> {
        install_default_provider();
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let webpki = WebPkiServerVerifier::builder_with_provider(root_store(), provider.clone()).build().ok();
        let verifier = TofuVerifier { webpki, provider: provider.clone(), trust: self.clone() };
        let config = ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|e| Error::other(format!("TLS configuration: {e}")))?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(verifier))
            .with_no_client_auth();
        Ok(config)
    }

    /// The certificate that made the last handshake fail, if any.
    pub fn take_rejected(&self) -> Option<UntrustedCert> {
        self.rejected.lock().take()
    }

    pub fn peer(&self) -> Option<PeerCert> {
        self.peer.lock().clone()
    }

    /// Ask the user whether to trust `cert`. `Ok(())` means accepted: the handshake
    /// should be retried. Concurrent callers are serialized so the user is asked once.
    pub async fn confirm(&self, prompter: &dyn Prompter, cert: UntrustedCert) -> Result<()> {
        let _guard = self.prompt_lock.lock().await;
        if self.accepted.lock().contains(&cert.fingerprint) {
            return Ok(());
        }
        let req = PromptRequest::Certificate {
            host: self.host.clone(),
            port: self.port,
            fingerprint: cert.fingerprint.clone(),
            subject: cert.subject.clone(),
            issuer: cert.issuer.clone(),
            reason: cert.reason.clone(),
            state: cert.state,
        };
        match prompter.prompt(req).await {
            Some(resp) if resp.accepted => {
                self.accepted.lock().insert(cert.fingerprint.clone());
                if resp.remember || (self.tofu && cert.state == HostKeyState::New) {
                    let key = KnownHosts::tls_key(&self.host, self.port);
                    self.known_hosts.add(&key, CERT_KEY_TYPE, &cert.fingerprint, "")?;
                }
                tracing::info!(
                    "certificate of {}:{} accepted by the user ({})",
                    self.host,
                    self.port,
                    cert.fingerprint
                );
                Ok(())
            }
            _ => Err(Error::HostKeyRejected(format!(
                "certificate of {}:{} is not trusted: {}",
                self.host, self.port, cert.reason
            ))),
        }
    }

    fn trusted(&self, fingerprint: &str) -> std::result::Result<(), HostKeyState> {
        if self.accepted.lock().contains(fingerprint) {
            return Ok(());
        }
        let key = KnownHosts::tls_key(&self.host, self.port);
        match self.known_hosts.check(&key, CERT_KEY_TYPE, fingerprint) {
            HostKeyStatus::Trusted => {
                self.accepted.lock().insert(fingerprint.to_string());
                Ok(())
            }
            HostKeyStatus::Unknown => Err(HostKeyState::New),
            HostKeyStatus::Mismatch { .. } => Err(HostKeyState::Changed),
        }
    }

    fn set_peer(&self, cert: &CertificateDer<'_>, fingerprint: String, ca_verified: bool) {
        let d = describe(cert);
        *self.peer.lock() =
            Some(PeerCert { fingerprint, subject: d.subject, issuer: d.issuer, not_after: d.not_after, ca_verified });
    }
}

/// Make ring the process-wide rustls provider unless the application chose one: reqwest
/// is built without a default provider, so `reqwest::Client::new()` needs it.
pub(crate) fn install_default_provider() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// Lower-case hex SHA-256 of a DER certificate.
pub(crate) fn fingerprint(cert: &[u8]) -> String {
    hex::encode(Sha256::digest(cert))
}

fn root_store() -> Arc<RootCertStore> {
    static ROOTS: OnceLock<Arc<RootCertStore>> = OnceLock::new();
    ROOTS
        .get_or_init(|| {
            let mut roots = RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let native = rustls_native_certs::load_native_certs();
            let (added, _ignored) = roots.add_parsable_certificates(native.certs);
            tracing::debug!("TLS root store: {} certificates ({} from the system)", roots.len(), added);
            Arc::new(roots)
        })
        .clone()
}

struct CertDescription {
    subject: String,
    issuer: String,
    not_after: String,
}

fn describe(cert: &CertificateDer<'_>) -> CertDescription {
    use x509_cert::der::Decode;
    match x509_cert::Certificate::from_der(cert.as_ref()) {
        Ok(c) => CertDescription {
            subject: c.tbs_certificate.subject.to_string(),
            issuer: c.tbs_certificate.issuer.to_string(),
            not_after: c.tbs_certificate.validity.not_after.to_string(),
        },
        Err(e) => CertDescription {
            subject: format!("(unparsable certificate: {e})"),
            issuer: String::new(),
            not_after: String::new(),
        },
    }
}

fn describe_error(err: &rustls::Error, host: &str) -> String {
    match err {
        rustls::Error::InvalidCertificate(ce) => match ce {
            CertificateError::UnknownIssuer => {
                "the certificate is not signed by a trusted authority (self-signed or unknown CA)".into()
            }
            CertificateError::Expired | CertificateError::ExpiredContext { .. } => "the certificate has expired".into(),
            CertificateError::NotValidYet | CertificateError::NotValidYetContext { .. } => {
                "the certificate is not valid yet".into()
            }
            CertificateError::NotValidForName | CertificateError::NotValidForNameContext { .. } => {
                format!("the certificate is not valid for the host name {host}")
            }
            CertificateError::Revoked => "the certificate has been revoked".into(),
            other => format!("invalid certificate: {other:?}"),
        },
        other => other.to_string(),
    }
}

#[derive(Debug)]
struct TofuVerifier {
    webpki: Option<Arc<WebPkiServerVerifier>>,
    provider: Arc<CryptoProvider>,
    trust: Arc<CertTrust>,
}

impl ServerCertVerifier for TofuVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> std::result::Result<ServerCertVerified, rustls::Error> {
        let fp = fingerprint(end_entity.as_ref());
        let err = match &self.webpki {
            Some(v) => match v.verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now) {
                Ok(ok) => {
                    self.trust.set_peer(end_entity, fp, true);
                    return Ok(ok);
                }
                Err(e) => e,
            },
            None => rustls::Error::InvalidCertificate(CertificateError::UnknownIssuer),
        };
        match self.trust.trusted(&fp) {
            Ok(()) => {
                self.trust.set_peer(end_entity, fp, false);
                Ok(ServerCertVerified::assertion())
            }
            Err(state) => {
                let d = describe(end_entity);
                let reason = describe_error(&err, &self.trust.host);
                tracing::warn!("TLS certificate of {}:{} rejected: {reason} ({fp})", self.trust.host, self.trust.port);
                *self.trust.rejected.lock() =
                    Some(UntrustedCert { fingerprint: fp, subject: d.subject, issuer: d.issuer, reason, state });
                Err(err)
            }
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> std::result::Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}
