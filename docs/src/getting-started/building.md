# Building from source

## Prerequisites

- **Rust** (stable, 1.91 or newer)
- **Node.js** 20 or newer
- **Linux only:** the [Tauri prerequisites](https://tauri.app/start/prerequisites/):

  ```bash
  sudo apt-get install libwebkit2gtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev libxdo-dev
  ```

The headless server (`rcmd`) does not need any GUI libraries.

## User interface

The UI (React + TypeScript + Vite) is built once and then embedded into both the desktop
app and the server:

```bash
npm --prefix ui ci
npm --prefix ui run build      # -> ui/dist/
```

If `ui/dist/` is missing when the server is compiled, it serves a placeholder page that
explains how to build the UI.

## Desktop app

```bash
npm ci
npm run dev       # tauri dev: hot-reloading development build
npm run build     # tauri build: installers in src-tauri/target/release/bundle/
```

## Headless server and CLI

```bash
cargo build --release -p rc-cli     # -> target/release/rcmd
```

## Trying the UI without a backend

The UI ships with an in-memory demo backend with sample files, sites, peers and a fake
shell. It is handy for UI work and screenshots:

```bash
npm --prefix ui run dev
# then open http://localhost:5173/?mock=1
```

Useful query parameters for the demo backend:

| Parameter | Effect |
|---|---|
| `mock=1` | Use the demo backend |
| `mode=web` | Simulate the browser UI (upload/download buttons, no desktop-only features) |
| `login=1` | Show the web login screen first (password `demo`) |
| `locked=1` | Start with a locked credential vault (password `demo`) |
| `fast=1` | Make jobs and delays very short (used by the tests) |

## Checks before a pull request

CI runs the same commands:

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm --prefix ui run build
npm --prefix ui run test:unit
```

See [Testing](../development/testing.md) for the protocol integration tests and the UI
smoke test.
