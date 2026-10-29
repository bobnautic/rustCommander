# Configuration files

## Configuration directory

| Platform | Default location |
|---|---|
| Linux | `~/.config/rust-commander/` (or `$XDG_CONFIG_HOME/rust-commander/`) |
| macOS | `~/Library/Application Support/dev.RustCommander.rust-commander/` |
| Windows | `%APPDATA%\RustCommander\rust-commander\config\` |

`RCMD_CONFIG_DIR` or `rcmd --config-dir <DIR>` overrides the location — useful for the
[headless server](../deployment/headless-server.md) (`/etc/rust-commander`) and in
containers (`/config`).

## Files

| File | Contents |
|---|---|
| `settings.json` | Preferences |
| `sites.json` | Saved sites; secrets are stored encrypted |
| `known_hosts.json` | Trusted SSH host keys and TLS certificates |
| `bookmarks.json` | Bookmarks |
| `commands.json` | Custom commands |
| `vault.json` | Master password settings (when a master password has been set) |
| `vault.key` | Vault key when no master password is set (readable only by the user) |
| `server.json` | Web login password (Argon2 hash) |
| `instance.json` | Random instance ID used by LAN discovery |
| `tls/cert.pem`, `tls/key.pem` | Self-signed TLS certificate for the web server |

The JSON files are written by the app; edit them only while Rust Commander is not running.

### Using your own TLS certificate

The web server loads `tls/cert.pem` and `tls/key.pem` if both exist and creates a
self-signed certificate (valid for the host name, `localhost` and the loopback addresses)
otherwise. To use a certificate from your own CA, replace both files with PEM files and
restart the server. The fingerprint shown in the app and by `rcmd serve` changes
accordingly.

### Temporary files

Files opened with an external application are stored in `rust-commander/` inside the
system's temporary folder.

## Preferences

**Preferences** (Ctrl+,) are stored in `settings.json`:

| Tab | Settings |
|---|---|
| General | Language, theme, hidden files, size format, what double-click / Enter does on a file (edit, open with the default application, copy to the other panel), confirmations before deleting and overwriting, whether the copy/move dialog is shown |
| Transfer | Default transfer settings, number of parallel jobs |
| Editor | Show problems, format when saving, line width for formatting, tab width, word wrap |
| Terminal | Font family, font size, scrollback lines |
| Discovery | Announce/discover on the LAN, instance name and ID, UDP port, announce interval |
| Web server | Listen address and port, HTTPS, start the web server automatically, allow terminal access through the web UI |
| Security | Master password, known hosts |

In the [web mode](../guide/web-mode.md), preferences belong to the instance you are
connected to.
