# Installation

Rust Commander comes in two flavours that share the same interface:

| Program | What it is | Use it for |
|---|---|---|
| `rust-commander` | Desktop app (Tauri 2) | Everyday work on Windows, macOS and Linux |
| `rcmd` | Headless server and command-line tool | Serving the web UI on a host, LAN discovery, scripting |

## Release builds

Pushing a version tag (`v*`) runs the **Release** workflow
(`.github/workflows/release.yml`). It produces:

- **Desktop installers** for Linux (Ubuntu 22.04 build), Windows and macOS (universal
  binary for Apple silicon and Intel), attached to a draft GitHub release.
- **`rcmd` binaries** for `x86_64-unknown-linux-gnu`, `aarch64-unknown-linux-gnu`,
  `x86_64-pc-windows-msvc` and `aarch64-apple-darwin`, uploaded as workflow artifacts.

Download them from the [Releases page](https://github.com/bobnautic/rustcommander/releases)
or from the workflow run. If no release has been published yet,
[build from source](building.md) — it takes a few minutes.

## Docker

The repository contains a `Dockerfile` for the headless server:

```bash
docker build -t rust-commander .
docker run -d -p 8822:8822 -p 47800:47800/udp -v /srv:/data \
  -e RCMD_PASSWORD=change-me --name rcmd rust-commander
```

Open `https://<host>:8822/` and log in with the password. See
[Headless server](../deployment/headless-server.md) for details such as LAN discovery
inside containers.

## Desktop runtime requirements

- **Windows:** WebView2 (included in current Windows 10/11).
- **macOS:** no extra requirements.
- **Linux:** WebKitGTK 4.1 (`libwebkit2gtk-4.1`), which most desktop distributions ship.

Optional: install code formatters such as `rustfmt`, `gofmt`, `ruff`/`black`, `shfmt`,
`clang-format`, `taplo` or `stylua` to let the [editor](../guide/editor.md#formatting)
format those languages.
