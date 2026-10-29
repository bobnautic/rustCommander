# Testing

## Rust

```bash
cargo test --workspace
```

Unit tests run everywhere. The **protocol integration tests** need real servers and are
enabled with environment variables:

| Protocol | Variables |
|---|---|
| SSH (SFTP/SCP) | `RC_TEST_SSH_HOST`, `RC_TEST_SSH_PORT`, `RC_TEST_SSH_USER`, `RC_TEST_SSH_PASSWORD`, `RC_TEST_SSH_KEY` |
| Remote Explorer | additionally `RC_TEST_SSH_NO_SFTP_PORT` — a second SSH server without `Subsystem sftp` (see the header of `crates/rc-api/tests/explorer.rs`) |
| FTP / FTPS | `RC_TEST_FTP_URL`, `RC_TEST_FTPES_URL`, `RC_TEST_FTPS_URL` |
| Cloud | `RC_TEST_WEBDAV_URL`, `RC_TEST_S3_ENDPOINT`, `RC_TEST_AZURE_ENDPOINT` … |

Matching test servers (Python scripts) are in `crates/rc-core/tests/servers/`; the header
comments of `crates/rc-core/tests/ftp.rs` and `crates/rc-core/tests/cloud.rs` explain how
to start them.

The protocols have been tested against OpenSSH, pyftpdlib with FTPS, WsgiDAV, the S3 API of
moto and Azurite. Google Cloud Storage is implemented but not tested against the real
service.

## UI

```bash
npm --prefix ui run typecheck
npm --prefix ui run test:unit     # language detection, JSON checks, formatters
npm --prefix ui test              # unit tests + Playwright smoke test
```

The smoke test (`ui/tests/smoke.mjs`) builds the UI if needed, starts `vite preview` and
drives the app against the demo backend (`?mock=1`): navigation, copying, the Site
Manager and host-key prompt, synchronization, conflicts, properties, Nearby, the Remote
Explorer, terminal, editor, fingerprints, drag and drop, web login and the mobile layout.
Its screenshots end up in `ui/tests/screenshots/`.

```bash
BASE_URL=http://127.0.0.1:5173 node ui/tests/smoke.mjs   # against a running dev server
HEADED=1 node ui/tests/smoke.mjs                          # watch it run
```

## Documentation screenshots

`npm --prefix ui run screenshots:docs` regenerates every image in `docs/src/images/` from
the demo backend — run it after UI changes that affect the screenshots. See
`docs/README.md`.

## Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests:

1. UI: `npm ci`, build, unit tests
2. Rust on Linux, Windows and macOS: `cargo fmt --check`, `cargo clippy -D warnings`,
   `cargo test --workspace`, release build of `rcmd`

`.github/workflows/release.yml` builds the desktop installers and `rcmd` binaries for
tags `v*`.
