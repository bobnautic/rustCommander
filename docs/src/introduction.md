# Introduction

<img src="images/logo.svg" alt="" width="72" align="right">

**Rust Commander** is a two-panel file manager and transfer client written entirely in
Rust, with a [Tauri](https://tauri.app) user interface. It runs as a desktop app on
Windows, macOS and Linux — and also **headless on a server**, where it serves the very same
interface to your browser. Running instances **find each other on the local network** and
can be opened straight from the app.

![Rust Commander with an SFTP session, the Nearby sidebar and a terminal](images/hero-light.png)

## What it does

| Area | Highlights |
|---|---|
| Protocols | SFTP, SCP, FTP, FTPS (explicit and implicit), WebDAV(S), Amazon S3 and S3-compatible storage (MinIO, Wasabi, R2, Ceph …), Azure Blob Storage, Google Cloud Storage, and other Rust Commander instances |
| Interface | Commander layout with two panels, session tabs, bookmarks, synchronized browsing, directory comparison, full keyboard control (F2–F8, Ins, Ctrl+…), light and dark theme, English and German |
| Transfers | Background queue with pause/resume/cancel/retry, resumable transfers, overwrite rules, **fingerprint comparison before copying**, preserved timestamps and permissions, file masks, speed limit, parallel transfers, server-to-server copies |
| Synchronization | One-way or two-way comparison by size, time or checksum, mirror mode, a **checklist** before anything runs, and "keep remote folder up to date" |
| Editor | Built-in editor for local and remote files with language detection, **linting**, **formatting**, change markers and a diff view |
| Remote Explorer | Browse every SSH target (saved sites and `~/.ssh/config`) as a tree — nothing is installed or copied on the target |
| Terminal | SSH and local shells in tabs, SSH tunnels (`-L` and SOCKS5 `-D`) |
| Web mode | `rcmd serve` runs Rust Commander without a GUI on a host and serves the full UI over HTTPS |
| LAN discovery | Instances announce themselves and appear under **Nearby**; open their web UI or mount them as a file panel |
| Security | Host-key verification with TOFU, `known_hosts` import, TLS checks, an encrypted credential vault with optional master password |
| Automation | `rcmd script` runs batch scripts (`open`, `get`, `put`, `synchronize`, `keepuptodate` …) |

## One API, three front ends

All logic lives in Rust. The interface always speaks the same API: in the desktop app via
Tauri `invoke`, in the browser via `POST /api/rpc` plus a WebSocket for events. That is why
the desktop app and the web mode behave the same. See [Architecture](development/architecture.md).

## Where to go next

- New here? Start with the [Quick tour](getting-started/quick-tour.md).
- Want to run it on a server? Read [Web mode](guide/web-mode.md) and
  [Headless server](deployment/headless-server.md).
- Looking for a key? See [Keyboard shortcuts](reference/keyboard-shortcuts.md).
