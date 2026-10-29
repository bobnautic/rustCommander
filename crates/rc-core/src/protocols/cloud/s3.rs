//! S3 requests OpenDAL does not cover: `ListBuckets` (for the virtual root when no
//! bucket is configured) and bucket region lookup.

use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

use crate::error::{Error, Result};

const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

#[derive(Debug, Clone)]
pub(super) struct Credentials {
    pub access_key: String,
    pub secret_key: String,
    pub session_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct BucketInfo {
    pub name: String,
    pub created: Option<i64>,
    pub region: Option<String>,
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut m = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts keys of any length");
    m.update(data.as_bytes());
    m.finalize().into_bytes().to_vec()
}

fn uri_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// AWS Signature Version 4 headers (`x-amz-*` and `Authorization`) for a request
/// without body. `Host` is signed but left for the HTTP client to send.
pub(super) fn sign_v4(
    method: &str,
    url: &reqwest::Url,
    region: &str,
    cred: &Credentials,
    now: DateTime<Utc>,
) -> Vec<(&'static str, String)> {
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date = now.format("%Y%m%d").to_string();
    let host = match url.port() {
        Some(p) => format!("{}:{p}", url.host_str().unwrap_or_default()),
        None => url.host_str().unwrap_or_default().to_string(),
    };
    let mut query: Vec<(String, String)> = url.query_pairs().map(|(k, v)| (uri_encode(&k), uri_encode(&v))).collect();
    query.sort();
    let query = query.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&");
    let mut headers =
        vec![("host", host), ("x-amz-content-sha256", EMPTY_SHA256.to_string()), ("x-amz-date", amz_date.clone())];
    if let Some(t) = &cred.session_token {
        headers.push(("x-amz-security-token", t.clone()));
    }
    let canonical_headers: String = headers.iter().map(|(k, v)| format!("{k}:{}\n", v.trim())).collect();
    let signed_headers = headers.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(";");
    let path = if url.path().is_empty() { "/" } else { url.path() };
    let canonical_request = format!("{method}\n{path}\n{query}\n{canonical_headers}\n{signed_headers}\n{EMPTY_SHA256}");
    let scope = format!("{date}/{region}/s3/aws4_request");
    let string_to_sign =
        format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}", hex::encode(Sha256::digest(canonical_request.as_bytes())));
    let mut key = hmac(format!("AWS4{}", cred.secret_key).as_bytes(), &date);
    for part in [region, "s3", "aws4_request"] {
        key = hmac(&key, part);
    }
    let signature = hex::encode(hmac(&key, &string_to_sign));
    let mut out: Vec<(&'static str, String)> = headers.into_iter().filter(|(k, _)| *k != "host").collect();
    out.push((
        "authorization",
        format!(
            "AWS4-HMAC-SHA256 Credential={}/{scope}, SignedHeaders={signed_headers}, Signature={signature}",
            cred.access_key
        ),
    ));
    out
}

fn xml_unescape(s: &str) -> String {
    s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&")
}

fn xml_tag<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&format!("</{tag}>"))? + start;
    Some(&xml[start..end])
}

pub(super) fn parse_buckets(xml: &str) -> Vec<BucketInfo> {
    let mut out = Vec::new();
    let mut rest = xml;
    while let Some(i) = rest.find("<Bucket>") {
        let block = &rest[i + 8..];
        let end = block.find("</Bucket>").unwrap_or(block.len());
        let b = &block[..end];
        if let Some(name) = xml_tag(b, "Name") {
            out.push(BucketInfo {
                name: xml_unescape(name),
                created: xml_tag(b, "CreationDate")
                    .and_then(|d| DateTime::parse_from_rfc3339(d.trim()).ok())
                    .map(|d| d.timestamp()),
                region: xml_tag(b, "BucketRegion").map(|r| xml_unescape(r.trim())).filter(|r| !r.is_empty()),
            });
        }
        rest = &block[end..];
    }
    out
}

/// `Code` and `Message` of an S3 error response.
pub(super) fn parse_error(xml: &str) -> (String, String) {
    (
        xml_tag(xml, "Code").map(xml_unescape).unwrap_or_default(),
        xml_tag(xml, "Message").map(xml_unescape).unwrap_or_default(),
    )
}

/// `ListBuckets` (`GET /` on the service endpoint).
pub(super) async fn list_buckets(
    client: &reqwest::Client,
    endpoint: &str,
    region: &str,
    cred: &Credentials,
) -> Result<Vec<BucketInfo>> {
    let url = reqwest::Url::parse(&format!("{}/", endpoint.trim_end_matches('/')))
        .map_err(|e| Error::InvalidInput(format!("invalid S3 endpoint {endpoint}: {e}")))?;
    let mut req = client.get(url.clone());
    for (k, v) in sign_v4("GET", &url, region, cred, Utc::now()) {
        req = req.header(k, v);
    }
    let resp =
        req.send().await.map_err(|e| Error::ConnectionLost(format!("{endpoint}: {}", super::reqwest_error(&e))))?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| Error::ConnectionLost(format!("{endpoint}: {e}")))?;
    if status.is_success() {
        return Ok(parse_buckets(&body));
    }
    let (code, message) = parse_error(&body);
    let msg = format!("listing buckets: {code} {message}").trim().to_string();
    Err(match (status.as_u16(), code.as_str()) {
        (
            _,
            "InvalidAccessKeyId"
            | "SignatureDoesNotMatch"
            | "InvalidToken"
            | "ExpiredToken"
            | "AuthorizationHeaderMalformed",
        ) => Error::AuthFailed(msg),
        (401 | 403, _) => Error::PermissionDenied(msg),
        (404 | 405 | 501, _) => Error::Unsupported(msg),
        (s, _) => Error::Protocol(format!("{msg} (HTTP {s})")),
    })
}

/// The region of an AWS bucket (`x-amz-bucket-region` of an unsigned `HEAD`).
pub(super) async fn bucket_region(client: &reqwest::Client, bucket: &str) -> Option<String> {
    let url = format!("https://s3.amazonaws.com/{}", uri_encode(bucket));
    let resp = client.head(url).send().await.ok()?;
    resp.headers().get("x-amz-bucket-region")?.to_str().ok().map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn sigv4_matches_aws_example() {
        // "GET Bucket (List Objects)" example of the AWS SigV4 documentation.
        let cred = Credentials {
            access_key: "AKIAIOSFODNN7EXAMPLE".into(),
            secret_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".into(),
            session_token: None,
        };
        let url = reqwest::Url::parse("https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J").unwrap();
        let now = Utc.with_ymd_and_hms(2013, 5, 24, 0, 0, 0).unwrap();
        let headers = sign_v4("GET", &url, "us-east-1", &cred, now);
        let auth = headers.iter().find(|(k, _)| *k == "authorization").unwrap();
        assert_eq!(
            auth.1,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, \
             SignedHeaders=host;x-amz-content-sha256;x-amz-date, \
             Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"
        );
    }

    #[test]
    fn bucket_list_xml() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>x</ID></Owner>
<Buckets><Bucket><Name>alpha</Name><CreationDate>2024-01-02T03:04:05.000Z</CreationDate></Bucket>
<Bucket><Name>b&amp;c</Name><CreationDate>2024-01-02T03:04:05Z</CreationDate><BucketRegion>eu-central-1</BucketRegion></Bucket></Buckets>
</ListAllMyBucketsResult>"#;
        let b = parse_buckets(xml);
        assert_eq!(b.len(), 2);
        assert_eq!(b[0].name, "alpha");
        assert_eq!(b[0].created, Some(1704164645));
        assert_eq!(b[0].region, None);
        assert_eq!(b[1].name, "b&c");
        assert_eq!(b[1].region.as_deref(), Some("eu-central-1"));
        let (code, msg) = parse_error("<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>");
        assert_eq!((code.as_str(), msg.as_str()), ("AccessDenied", "Access Denied"));
    }
}
