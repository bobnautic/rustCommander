# Known limitations

- **Google Cloud Storage** is implemented but not tested against the real service. All
  other protocols are tested with real servers: OpenSSH, pyftpdlib with FTPS, WsgiDAV, the
  S3 API of moto and Azurite.
- **Object storage** (S3, Azure, GCS) cannot resume interrupted **uploads** and has no
  permissions. The modification time is kept as metadata of new uploads; objects uploaded
  by other tools show their upload time. Downloads can be resumed.
- The **trash** is only used for local files of the desktop app; restoring from the trash
  is done with the system's file manager.
- **WebDAV** supports Basic authentication only.
- **SSH host certificates** (CA-signed host keys) and server-enforced **password changes**
  are not supported.
- File names that are **not valid UTF-8** are displayed lossily over SFTP.
- The **Windows and macOS** builds are cross-compiled and covered by CI, but have not been
  tested manually on those systems.
