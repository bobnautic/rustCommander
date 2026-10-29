# Known limitations

- **Google Cloud Storage** is implemented but not tested against the real service. All
  other protocols are tested with real servers: OpenSSH, pyftpdlib with FTPS, WsgiDAV, the
  S3 API of moto and Azurite.
- **Object storage** (S3, Azure, GCS) cannot resume interrupted **uploads** and cannot set
  timestamps or permissions. Downloads can be resumed.
- **WebDAV** supports Basic authentication only.
- **SSH host certificates** (CA-signed host keys) and server-enforced **password changes**
  are not supported.
- File names that are **not valid UTF-8** are displayed lossily over SFTP.
- The **Windows and macOS** builds are cross-compiled and covered by CI, but have not been
  tested manually on those systems.
