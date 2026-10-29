# Headless server

For permanent use, run `rcmd serve` as a service. Build the binary with
`cargo build --release -p rc-cli` (after building the UI, see
[Building from source](../getting-started/building.md)) or take it from a release.

## systemd

The repository ships `packaging/rust-commander.service`:

```bash
sudo cp target/release/rcmd /usr/local/bin/
sudo rcmd --config-dir /etc/rust-commander set-password
sudo cp packaging/rust-commander.service /etc/systemd/system/
sudo systemctl enable --now rust-commander
```

The unit runs:

```ini
ExecStart=/usr/local/bin/rcmd --config-dir /etc/rust-commander serve --port 8822
Restart=on-failure
Environment=RUST_LOG=info
```

It runs as **root** so it can manage the whole machine. For a restricted setup create a
dedicated user, set `User=` and `Group=` in the unit and give that user access to the
directories it should manage. Logs go to the journal: `journalctl -u rust-commander -f`.

## Docker

```bash
docker build -t rust-commander .
docker run -d -p 8822:8822 -p 47800:47800/udp -v /srv:/data \
  -e RCMD_PASSWORD=change-me --name rcmd rust-commander
```

| Path / variable | Purpose |
|---|---|
| `/data` | Working directory and `HOME` — mount the files you want to manage here |
| `/config` | Configuration directory (`RCMD_CONFIG_DIR`) — mount a volume to keep sites, keys and the TLS certificate |
| `RCMD_PASSWORD` | Login password |
| `8822/tcp` | Web UI |
| `47800/udp` | LAN discovery |

`HOME` is `/data`, so SSH keys and `~/.ssh/config` in `/data/.ssh/` are used by the
Remote Explorer and the `~/.ssh/config` import. Extra arguments are passed to `rcmd serve`, e.g.
`docker run … rust-commander --port 8822 --no-terminal`.

LAN discovery uses UDP broadcasts, which only reach other machines with
`--network host`. Without it, add the instance by address in the other instances'
**Nearby** sidebar.

## Behind a reverse proxy

`rcmd serve --bind 127.0.0.1 --no-tls` keeps the server local, so a reverse proxy can
terminate TLS in front of it. The proxy has to forward WebSocket upgrades for
`/api/events` and allow large request bodies for uploads (`/api/upload`). Note that the
login throttling then sees the proxy's address for every client. Alternatively, keep TLS on
and reach the server through an SSH tunnel (`ssh -L 8822:localhost:8822 host`).

## Checklist

- Set a strong password (`rcmd set-password`); never use `--no-auth` on a shared network.
- Keep HTTPS on, and compare the certificate fingerprint on the first visit.
- Use `--no-terminal` if web users should only manage files.
- Run the service with the least privileges that still let it do its job.

See also [Security](security.md).
