# Installation

Rust Commander comes in two flavours that share the same interface:

| Program | What it is | Use it for |
|---|---|---|
| `rust-commander` | Desktop app (Tauri 2) | Everyday work on Windows, macOS and Linux |
| `rcmd` | Headless server and command-line tool | Serving the web UI on a host, LAN discovery, scripting |

## Downloads

Every version is published on the
[Releases page](https://github.com/bobnautic/rustcommander/releases)
([latest release](https://github.com/bobnautic/rustcommander/releases/latest)):

| System | File |
|---|---|
| macOS 10.13+ (Apple silicon and Intel) | `rustCommander-<version>-macos-universal.dmg` |
| Windows 10/11 | `rustCommander-<version>-windows-x64-setup.exe` (installer) or `rustCommander-<version>-windows-x64-portable.exe` (no installation) |
| Linux | `rustCommander-<version>-linux-x86_64.AppImage`, `-linux-amd64.deb`, `-linux-x86_64.rpm` (no `.rpm` for pre-releases) |
| Headless server and CLI | `rcmd-<version>-<platform>.tar.gz` (Linux x86_64/aarch64, macOS arm64/x86_64) or `.zip` (Windows x64) |

`SHA256SUMS.txt` in each release lists the checksums of all files.

- **macOS:** open the `.dmg` and drag **Rust Commander** to *Applications*. Unless the
  release says it is notarized, macOS refuses the first start: open
  **System Settings → Privacy & Security** and click **Open Anyway** (or run
  `xattr -dr com.apple.quarantine "/Applications/Rust Commander.app"`).
- **Windows:** run the installer (no administrator rights needed). If SmartScreen warns
  about an unknown publisher, click **More info → Run anyway**. The portable `.exe` runs
  from any folder.
- **Linux:** `chmod +x` the AppImage and start it, or install the `.deb`/`.rpm` package.

How releases are made is described in [Releasing](../development/releasing.md). To run an
unreleased version, [build from source](building.md) — it takes a few minutes.

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
