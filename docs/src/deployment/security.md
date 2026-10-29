# Security

## Web mode

- The web mode grants access to the host's file system **with the rights of the user
  that runs `rcmd`** — and by default to a shell as well. `--no-terminal` (or
  **Preferences** → **Web server** → **Allow terminal access through the web UI**) turns
  shells and command execution off for web users.
- Use a **strong password** and **HTTPS**. `rcmd serve` uses HTTPS with a self-signed
  certificate by default and prints its SHA-256 fingerprint; compare it on the first visit.
- Logins are **throttled** against brute force: every wrong password is delayed, and after
  five failures an IP address has to wait a minute. Sessions use **HttpOnly** and
  **SameSite** cookies, and all state-changing requests must carry a custom header, which
  protects them against **CSRF**.
- The login password is stored as an Argon2 hash in `server.json`.
- `--no-auth` disables authentication completely — anybody who can reach the port
  controls the host. Only use it on isolated, trusted networks.

## LAN discovery

Announcements contain only the instance name, version and web UI address. They are
hints, not access: connecting to an instance always requires its password, and the
TLS certificate of an instance mounted as a panel is **pinned** by fingerprint. Discovery
can be disabled (`--no-discovery`, or **Preferences** → **Discovery**).

## Connections

- **SSH host keys** are verified on first use (TOFU) and stored; a changed key triggers a
  warning. Keys can also be checked against `~/.ssh/known_hosts`.
- **TLS certificates** (FTPS, WebDAVS, cloud storage, other instances) are verified;
  unknown certificates are only accepted after you confirm their fingerprint.
- Plain FTP and plain HTTP send passwords unencrypted; the UI warns about it.

## Stored secrets

- Passwords, keys and tokens are **always encrypted** (XChaCha20-Poly1305).
- Without a master password, the key lives in `vault.key` in the configuration directory,
  readable only by the user.
- With a **master password**, the key is derived with **Argon2id** and the vault stays
  locked until you enter it.
- Site exports never contain secrets.

## Formatters

To format code, Rust Commander only starts a fixed list of known programs (`rustfmt`,
`gofmt`, `ruff`, `black`, `shfmt`, `clang-format`, `taplo`, `stylua`) with fixed arguments,
in an empty temporary folder. The text is passed via standard input.
