# LAN discovery and sharing

Rust Commander instances find each other on the local network. You can open another
instance's web UI with one click or mount it as a file panel.

![Nearby sidebar](../images/nearby.png)

## How discovery works

Every instance announces itself via **UDP broadcast and multicast on port 47800**. Only the
name, version and web UI address are announced — announcements are hints, not access:
using another instance always requires its password, and its TLS certificate is pinned.

## The Nearby sidebar

**Ctrl+B** (or *View* → **Nearby**) shows:

- **This instance** — its name and whether it is shared.
- **On your network** — every other instance with its host name, user, address,
  operating system, version and web UI status.

Actions for each instance (buttons and **…** menu):

| Action | What it does |
|---|---|
| **Open web UI** | Opens the instance's interface in the browser |
| **Connect as panel** | Mounts its file system as a session via the `rcmd` protocol (asks for its web UI password) |
| **Save as site** | Stores it in the Site Manager (folder *Nearby*) with the pinned fingerprint |
| **Copy address** / **Copy TLS fingerprint** | For use elsewhere |

Instances in other subnets, or behind firewalls that block UDP broadcasts, can be added
with the **+** button (**Add by address…**): host name, IP[:port] or the URL of a web UI.

The same list is available on the command line:

```bash
rcmd discover            # listen for 3 seconds and print a table
rcmd discover --json     # machine-readable
```

## Share this instance

The desktop app can offer its own interface on the network, just like `rcmd serve`. Open
**Start sharing** in the Nearby sidebar, or *Session* → **Share this instance**.

![Share this instance](../images/share.png)

- **Listen on** all network interfaces or **this computer only (127.0.0.1)**, on a port of
  your choice (default 8822).
- **Use HTTPS (self-signed certificate)** — the dialog shows the certificate's SHA-256
  fingerprint so others can verify it.
- **Access password** — set one before sharing; without it anyone on the network could use
  this instance.
- The dialog lists the URLs to open and the number of connected clients.
- **Preferences** → **Web server** → **Start the web server automatically** shares the
  instance every time the app starts.

## Settings

**Preferences** → **Discovery**:

- **Announce this instance and discover others on the LAN** (on/off)
- **Instance name** — how this instance appears to others
- **UDP port** and **announce interval**

## Containers

Inside Docker, UDP broadcasts only reach other machines with `--network host`. Without
it, add instances by address instead.
