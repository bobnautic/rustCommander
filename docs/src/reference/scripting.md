# Scripting

`rcmd script` automates transfers with simple, line-based scripts — for deployments,
backups or cron jobs.

```bash
rcmd script deploy.txt                     # run a file
rcmd script - < deploy.txt                 # read from stdin
rcmd script -c "open sftp://user@example.com -hostkey=*" -c "lcd /backup" \
            -c "get /var/log/*.log" -c "exit"
rcmd script                                # interactive console
```

A script keeps one **local** working folder and at most one **remote** session.

## Syntax

- One command per line; empty lines and lines starting with `#` are ignored.
- Arguments are separated by spaces. Use double quotes for names with spaces
  (`put "my file.txt"`); `""` inside quotes is a literal quote.
- Switches start with `-` and may take a value: `-delete`, `-criteria=checksum`.
- Wildcards (`*`, `?`, `[abc]`) work in file arguments.
- The script stops at the first error unless `rcmd script --keep-going` is used.

## Example

```text
# deploy.txt
open "Production/web-01"             # a saved site (folder/name)
synchronize remote ./dist /var/www/html -delete -criteria=checksum
call systemctl reload nginx
exit
```

## Commands

### Sessions

| Command | Description |
|---|---|
| `open <url\|site>` | Connect to a URL (`sftp://`, `scp://`, `ftp://`, `ftpes://`, `ftps://`, `dav://`, `davs://`, `s3://`, `rcmd://`, `rcmds://`) or a saved site (`name` or `folder/name`) |
| `close` | Close the remote session |
| `exit`, `quit`, `bye` | Close the session and end the script |

Switches for `open`:

| Switch | Meaning |
|---|---|
| `-hostkey=<fingerprint>` | Accept this SSH host key or TLS certificate fingerprint; `-hostkey=*` accepts any (use with care) |
| `-password=<pw>` | Password |
| `-privatekey=<path>` | Private key file |
| `-timeout=<seconds>` | Connection timeout |
| `-scp` | Use SCP instead of SFTP |

Host keys that are already trusted (saved in the app or `rcmd`) are accepted. In
non-interactive runs, a key that is not trusted yet is rejected unless `-hostkey` matches
it — the error message prints the fingerprint to use. Interactive runs ask instead.

### Navigation

| Command | Description |
|---|---|
| `pwd`, `cd [dir]`, `ls [path\|mask]` | Remote working folder and listing (`dir` = `ls`) |
| `lpwd`, `lcd <dir>`, `lls [path\|mask]` | Local working folder and listing (`ldir` = `lls`) |

### Transfers

| Command | Description |
|---|---|
| `get <remote…> [local]` | Download (`recv`, `mget`) |
| `put <local…> [remote]` | Upload (`send`, `mput`) |

Switches for `get` and `put`:

| Switch | Meaning |
|---|---|
| `-delete` | Delete the source after a successful transfer (move) |
| `-resume` | Resume interrupted transfers |
| `-neweronly` | Only transfer files that are newer than the target |
| `-nopreservetime` | Don't keep modification times |
| `-nopermissions` | Don't keep permissions |
| `-permissions=644` | Set permissions on uploaded files |
| `-filemask=<mask>` | Include/exclude files — see [File masks](file-masks.md) |
| `-speed=<KB/s>` | Speed limit |
| `-transfer=ascii` | Text mode (convert line endings) |
| `-verify` | Verify checksums after the transfer |
| `-parallel=<n>` | Files transferred in parallel (default 2) |

Without `-resume` or `-neweronly`, existing files are overwritten.

### File management

| Command | Description |
|---|---|
| `rm <path…>`, `rmdir <dir>` | Delete files / folders |
| `mkdir <dir>` | Create a folder (including parents) |
| `mv <from> <to>` | Rename or move (`rename`) |
| `cp <from> <dir>` | Copy on the server |
| `chmod <mode> <path…>` | Change permissions |
| `ln <target> <link>` | Create a symbolic link (`symlink`) |
| `stat <path>` | Show file details |
| `checksum <md5\|sha1\|sha256> <path>` | Print a checksum |
| `call <command>` | Run a command on the server (`exec`, `!`); fails if the exit code is not 0 |
| `echo <text>` | Print text |
| `help` | List all commands |

### Synchronization

```text
synchronize <remote|local|both> [local] [remote] [switches]
```

| Direction | Meaning |
|---|---|
| `remote` | Local → remote (update the server) |
| `local` | Remote → local (update the local folder) |
| `both` | Both directions |

| Switch | Meaning |
|---|---|
| `-delete` | Delete files that don't exist on the source side |
| `-mirror` | Mirror mode: also replace newer files on the target |
| `-criteria=time\|size\|either\|checksum` | How files are compared (default `time`) |
| `-filemask=<mask>` | Include/exclude files |
| `-preview` | Only print the planned actions |

The transfer switches above (`-speed`, `-verify`, `-parallel` …) apply as well. Without
folder arguments, the current local and remote folders are used.

### Keep up to date

```text
keepuptodate [local] [remote] [-delete] [-filemask=<mask>]
```

Watches the local folder and uploads every change to the remote folder until **Ctrl+C**.
`-delete` also deletes remote files when they are deleted locally.
