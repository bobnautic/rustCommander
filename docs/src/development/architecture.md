# Architecture

All logic lives in Rust. The interface is a single React application that talks to the
backend through one RPC API — in the desktop app via Tauri, in the browser via HTTP and a
WebSocket. That is why the desktop app and the web mode behave the same.

```text
                    ui/  React + TypeScript + Vite
                    api/client.ts: call(method, params), on(event)
                                   │
          ┌────────────────────────┼─────────────────────────┐
   Tauri invoke("rpc")      POST /api/rpc              ?mock=1
   event "rc-event"         WS /api/events             in-memory demo backend
          │                        │                   (ui/src/api/mock.ts)
     src-tauri                 rc-server ◄── rcmd serve (rc-cli)
     desktop app                   │         "Share this instance" (desktop)
          │                        │
          └───────────┬────────────┘
                      ▼
                   rc-api        AppState + dispatch()
                      │
           ┌──────────┴──────────┐
        rc-core             rc-discovery
        Vfs + protocols     LAN announcements
```

## Workspace

| Path | Contents |
|---|---|
| `crates/rc-core` | File system abstraction (`Vfs`) and all protocols, transfer queue, synchronization, search, credential vault, site store, importers, SSH tunnels, archives, file masks, folder watching |
| `crates/rc-discovery` | LAN discovery over UDP broadcast and multicast |
| `crates/rc-api` | Application state and the RPC dispatcher — one API for desktop and web |
| `crates/rc-server` | HTTP(S) server: embedded UI, `/api/rpc`, WebSocket events, upload/download, login, self-signed TLS certificate |
| `crates/rc-cli` | `rcmd`: `serve`, `discover`, `script`, `set-password`, `sites` |
| `src-tauri` | Desktop app (Tauri 2): the command `rpc` and the event `rc-event` |
| `ui` | User interface (React + TypeScript + Vite), identical for desktop and web |
| `packaging` | systemd unit |
| `docs` | This documentation |

## rc-core

- **`Vfs`** is the trait every protocol implements: local, SFTP, SCP, FTP/FTPS, WebDAV,
  S3, Azure, GCS and Rust Commander peers (`rcmd`). Capabilities (resume, permissions,
  server-side checksums …) are reported per protocol, so the higher layers can adapt.
- **`connect()`** opens a `Vfs` for a `SiteConfig`.
- Protocols: `protocols/ssh` (russh + russh-sftp), `protocols/ftp` (suppaftp, with a
  connection pool), `protocols/cloud` (WebDAV, S3, Azure, GCS via OpenDAL),
  `protocols/rcmd.rs` (another instance over its HTTP API with a pinned certificate).
- Jobs (`jobs.rs`, `transfer.rs`, `sync.rs`) run in a queue with progress events, pause,
  resume, cancel and retry. Dropped sessions reconnect transparently (`reconnect.rs`).
- Credentials are kept in the vault (`store/vault.rs`): XChaCha20-Poly1305, with an
  Argon2id-derived key when a master password is set.

## rc-api

`AppState` holds sessions, jobs, settings and services; `dispatch()` implements the RPC
methods. The method names, parameters and results are described in
**`ui/src/api/types.ts`** — the contract between frontend and backend, which is tested
from both sides. Events (job progress, log entries, discovery updates, prompts such as
host-key questions) are pushed to all connected front ends.

## rc-discovery

Every instance periodically sends a small JSON datagram to the IPv4 broadcast address,
the directed broadcast address of each interface and a multicast group — all on the same
UDP port (default 47800). New instances send a query, which makes everybody announce
immediately. Several instances on one machine can share the port. Announcements are
unauthenticated hints; TLS peers publish their certificate fingerprint so clients can
pin it.

## UI

- `ui/src/api/` — transport (`client.ts`), the backends `desktop.ts`, `web.ts` and the
  demo backend `mock.ts`, and the shared types.
- `ui/src/store/` — Zustand stores for panels, sessions, jobs, editors, dialogs …
- `ui/src/components/` — panels, dock, sidebar, editor (CodeMirror 6), terminal
  (xterm.js) and dialogs.
- `ui/src/i18n/` — English and German strings.

The same build (`ui/dist`) is bundled into the desktop app and embedded into
`rc-server`.
