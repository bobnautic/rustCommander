# Remote Explorer

The Remote Explorer is a sidebar that lets you **look around on any SSH host** without
setting anything up: nothing is installed on the target and no files are copied.

![Remote Explorer](../images/remote-explorer.png)

Open it with **Ctrl+Shift+E**, the tree icon in the toolbar or *View* → **Remote
Explorer**.

## Targets

The explorer lists every SSH target it knows:

- your saved **SFTP and SCP sites**, and
- the hosts in **`~/.ssh/config`** — read directly, without importing them, and including
  `ProxyJump`. Wildcard entries such as `Host *.internal` are skipped.

The input field filters the list. Type an address such as `admin@10.0.0.7:2222` and press
**Enter** to connect to a host that is not listed.

## Browsing

Clicking a target connects via SSH — with the usual host key check and authentication —
and shows the **home folder** and **`/`** as a tree.

- **↑/↓** move, **←/→** collapse and expand.
- Clicking a file shows its **details** (location, type, size, rights, owner, modified)
  and a **preview** of the first 64 KiB.
- Double-click or **F4** opens the file in the [editor](editor.md); saving goes over the
  same SSH connection.

The context menu offers **Go to path…**, **Open in panel** (shows the folder in a file
panel), **Terminal here** and **Copy path**.

The connection also appears as a session tab; disconnect it there or in the explorer.

## Servers without SFTP

Routers and appliances (for example with Dropbear) often have no SFTP subsystem. The
explorer then lists files through the same SSH connection with shell commands (`ls`) and
marks the target with a **Shell** badge.

## In the web mode

When Rust Commander runs as [`rcmd serve`](web-mode.md), the explorer uses the
`~/.ssh/config` and SSH keys of the user that runs `rcmd serve`.
