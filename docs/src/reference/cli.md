# Command line (`rcmd`)

`rcmd` is the headless part of Rust Commander: web server, LAN discovery and scripting.

```text
rcmd [--config-dir <DIR>] <COMMAND>
```

| Global option | Description |
|---|---|
| `--config-dir <DIR>` | Configuration directory. Default: the platform's config directory, or `$RCMD_CONFIG_DIR`. See [Configuration files](configuration.md). |
| `-h`, `--help` | Help for `rcmd` or a subcommand |
| `-V`, `--version` | Print the version |

## `rcmd serve`

Serves the Rust Commander web UI on this host. See [Web mode](../guide/web-mode.md).

| Option | Default | Description |
|---|---|---|
| `--bind <ADDR>` | `0.0.0.0` | Address to listen on |
| `-p`, `--port <PORT>` | `8822` | TCP port |
| `--no-tls` | | Plain HTTP instead of HTTPS with a self-signed certificate — only on trusted networks |
| `--password <PW>` | | Login password for this run (env: `RCMD_PASSWORD`). Otherwise the stored password is used, or a one-time password is generated and printed |
| `--no-auth` | | Disable authentication completely — only on trusted networks! |
| `--name <NAME>` | host name | Name announced on the LAN |
| `--no-discovery` | | Do not announce this instance or look for others |
| `--discovery-port <PORT>` | `47800` | UDP port for LAN discovery |
| `--no-terminal` | | Forbid shells and command execution for web users |

Examples:

```bash
rcmd serve                                   # https://<host>:8822/
rcmd serve --port 9000 --no-tls              # plain HTTP, trusted networks only
rcmd serve --bind 127.0.0.1                  # only reachable locally (e.g. behind a reverse proxy or SSH tunnel)
rcmd serve --no-terminal --name "NAS"        # file access only
RCMD_PASSWORD=change-me rcmd serve           # password from the environment
```

`rcmd serve` stops on **Ctrl+C** or `SIGTERM`.

## `rcmd set-password`

```text
rcmd set-password [PASSWORD]
```

Stores the web login password in `server.json` in the configuration directory. Without
an argument it prompts twice (input hidden), which keeps the password out of your shell
history.

## `rcmd discover`

Lists Rust Commander instances on the local network.

| Option | Default | Description |
|---|---|---|
| `-t`, `--timeout <SECONDS>` | `3` | How long to listen |
| `--port <PORT>` | `47800` | UDP discovery port |
| `--json` | | Print JSON instead of a table |

```text
$ rcmd discover
NAME                     HOST                 OS         VERSION   WEB UI
atlas                    192.168.1.31         linux      0.1.0     https://192.168.1.31:8822/
nas-01                   192.168.1.10         freebsd    0.1.0     https://192.168.1.10:8822/
```

## `rcmd script`

```text
rcmd script [FILE] [-c <COMMAND>]... [--keep-going]
```

Runs a script file (`-` reads from stdin), commands given with `-c`, or — without either —
an interactive console. Scripts stop at the first error unless `--keep-going` is given; the
exit code is non-zero if any command failed. See [Scripting](scripting.md).

## `rcmd sites`

Lists the sites saved in the Site Manager with their URLs (without secrets):

```text
$ rcmd sites
Production/web-01                         sftp://deploy@web-01.example.com/var/www/html
Cloud/S3 backups                          s3://…
```

## Environment variables

| Variable | Used by | Meaning |
|---|---|---|
| `RCMD_CONFIG_DIR` | all commands | Configuration directory |
| `RCMD_PASSWORD` | `serve` | Login password for this run |
| `RUST_LOG` | all commands | Log filter, e.g. `info` or `rc_core=debug` |
