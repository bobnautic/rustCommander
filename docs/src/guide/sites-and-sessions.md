# Sites and sessions

A **site** is a saved connection. A **session** is an open connection; it gets a tab and
can be shown in either panel.

## Site Manager

Open it with **Ctrl+N**, the **+** button in the toolbar or *Session* → **Site Manager**.

![Site Manager](../images/site-manager.png)

- **Folders** group sites (for example *Production*, *Staging*, *Customers/ACME*).
  Sites can be duplicated and searched.
- A **color** marks the site's session tab and panel, so production servers stand out.
- **Notes** keep anything worth remembering about a server.
- **Local folder** opens in the other panel after login; **Remote folder** is the start
  folder on the server (empty = home folder).
- **Quick connect** accepts URLs: `sftp://user@host:22/path`, `ftps://…`, `s3://bucket`,
  `davs://…`. **Edit** fills the form from the URL so you can save it as a site.

The tabs of the site form are *Session*, *Advanced*, *Proxy* and *Notes*; which fields
appear depends on the [protocol](protocols.md).

### Import and export

**Import…** reads:

- **FileZilla** `sitemanager.xml`
- **OpenSSH** `~/.ssh/config` (leave the field empty to read the file on the backend host,
  or paste the content)
- **Rust Commander JSON** (from an earlier export)

**Export** writes all sites or one folder as JSON. Secrets — passwords, keys and tokens —
are never exported.

## SSH authentication

SFTP and SCP sites support:

| Method | Notes |
|---|---|
| Password | Can be stored in the vault or asked for at login |
| Private key | OpenSSH, PEM or PuTTY `.ppk`, also encrypted keys (passphrase); load from a file or paste it |
| Default keys | Tries `~/.ssh/id_*` |
| SSH agent | `ssh-agent` on Linux/macOS, Pageant on Windows |
| Keyboard-interactive | For 2FA and one-time passwords |

Further SSH options:

- **Jump host** (ProxyJump): connect through another saved SSH site.
- **Proxy**: SOCKS5 or HTTP proxy.
- **SFTP server command**: run a custom SFTP server, for example
  `sudo -n /usr/lib/openssh/sftp-server` to work as root.
- **Compression**, **keep-alive interval**, **connection timeout** and **environment
  variables**; for SCP also the **shell** used to run commands (default `/bin/sh`).

## Host keys and certificates

The first connection to an SSH server shows its host key fingerprint
(trust on first use). You can accept it **once** or **save** it.

![Unknown host key prompt](../images/host-key-prompt.png)

- If a saved key **changes**, Rust Commander warns you and only continues if you accept the new key.
- **Also use `~/.ssh/known_hosts`** checks keys against your OpenSSH file as well.
- Saved keys can be reviewed and removed under *Tools* → **Known hosts**.
- FTPS, WebDAVS and the cloud protocols verify TLS certificates. **Accept invalid TLS
  certificates** exists per site for test servers — leave it off otherwise.

## Credential vault

Stored passwords, keys and tokens are always encrypted (XChaCha20-Poly1305).

- **Without a master password** the vault key is stored in `vault.key` in the
  [configuration directory](../reference/configuration.md), readable only by your user.
- **With a master password** the key is derived with Argon2id and the vault starts
  locked; Rust Commander asks for the password when it starts. Set, change or remove it
  under **Preferences** → **Security**. *Session* → **Lock the credential vault** locks it
  immediately.

## Sessions

- Every open connection gets a **session tab**; the colored dot shows the site color.
  Drag files onto a tab to copy them into that session.
- *Session* → **Session information** shows details such as the server, user, server
  software, host key, protocol version and jump host.
- **Reconnect** and **Close** are in the *Session* menu and the tab's context menu.
- Dropped connections are re-established **transparently**, and the interrupted
  operation is retried.
