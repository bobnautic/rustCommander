# Protocols

Every panel can show any session, so you can copy between any two protocols — SFTP → S3,
FTP → SFTP, one Rust Commander instance to another — without a detour over your local disk.

| Protocol | URL scheme | Notes |
|---|---|---|
| SFTP | `sftp://`, `ssh://` | Full feature set: permissions, owners, symlinks, resume, server-side checksums |
| SCP | `scp://` | Uses shell commands over SSH; for servers without the SFTP subsystem |
| FTP | `ftp://` | Plain FTP — sends the password unencrypted |
| FTPES | `ftpes://` | FTP with explicit TLS |
| FTPS | `ftps://` | FTP with implicit TLS (port 990) |
| WebDAV | `dav://`, `webdav://`, `http://` | |
| WebDAVS | `davs://`, `webdavs://`, `https://` | WebDAV over HTTPS |
| Amazon S3 & compatible | `s3://bucket/path` | AWS, MinIO, Wasabi, Cloudflare R2, Ceph … |
| Azure Blob Storage | — (Site Manager) | Account key or SAS token |
| Google Cloud Storage | — (Site Manager) | Service account JSON or application default credentials |
| Rust Commander | `rcmd://`, `rcmds://` | Another instance as a file panel, TLS with a pinned certificate |

URLs may contain a user name, port and path: `sftp://deploy@web-01.example.com:22/var/www`.

## SFTP and SCP

Both run over SSH (pure Rust, no OpenSSH client needed) and share the
[authentication options](sites-and-sessions.md#ssh-authentication): password, keys,
agent, keyboard-interactive, jump hosts and proxies.

- **SFTP** is the default and supports everything: resuming, permissions and owners,
  symlinks, timestamps. Checksums are calculated on the server with `sha256sum` and friends
  when the shell allows it, so files don't have to be downloaded for a
  [fingerprint comparison](fingerprints.md).
- **SFTP server command** lets you start a different server binary, for example
  `sudo -n /usr/lib/openssh/sftp-server` to work as root.
- **SCP** lists and manages files with shell commands. Use it for routers and appliances
  that only offer a shell (for example Dropbear without SFTP).

## FTP and FTPS

- **Encryption:** none, explicit TLS (FTPES) or implicit TLS (FTPS, port 990).
- **Passive mode**, **MLSD listings** and the **maximum number of parallel connections**
  can be set per site.
- Servers that support the `HASH` command calculate checksums themselves.
- **Accept invalid TLS certificates** is available for test servers.

## WebDAV

- **Use HTTPS** switches to WebDAVS.
- **Root path** is the base path of the share — for Nextcloud for example
  `/remote.php/dav/files/<user>`.
- Authentication: HTTP Basic.

## Amazon S3 and S3-compatible storage

| Field | Meaning |
|---|---|
| Access key ID / Secret access key | Credentials |
| Session token (STS) | For temporary credentials |
| Region | For example `eu-central-1` |
| Endpoint | For S3-compatible storage; empty = AWS |
| Bucket | Empty = list all buckets |
| Path-style addressing | Needed by some S3-compatible servers |
| Anonymous access | For public buckets |

## Azure Blob Storage

Enter the **storage account** and either the **account key** or a **SAS token**. The
endpoint defaults to `https://<account>.blob.core.windows.net`; set it for Azurite or
other emulators.

## Google Cloud Storage

Paste or load a **service account JSON**, or leave it empty to use the application default
credentials of the host Rust Commander runs on.

## Object storage limitations

S3, Azure and GCS store objects, not files. Rust Commander therefore cannot resume
interrupted **uploads** there and cannot set timestamps or permissions. Downloads can be
resumed. See [Known limitations](../limitations.md).

## Rust Commander instances (`rcmd`)

Another running instance — a desktop app sharing itself or `rcmd serve` on a server —
can be mounted as a file panel. Its TLS certificate is **pinned** by its SHA-256
fingerprint, which is filled in automatically when you connect from the
[Nearby](lan-discovery.md) sidebar. Authentication uses the instance's web UI password.
Terminals work on connected instances, too.
