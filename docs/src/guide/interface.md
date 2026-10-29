# The interface

![Main window](../images/hero-light.png)

| Area | Purpose |
|---|---|
| **Menu bar and toolbar** | All commands, grouped into *Session*, *Files*, *Commands*, *View*, *Tools* and *Help*. The toolbar holds the most frequent ones. |
| **Session tabs** | One tab per open connection. Drag files onto a tab to copy them into that session. |
| **Sidebar** (Ctrl+B) | Switches between **Nearby** (instances on your network) and the **Remote Explorer** (Ctrl+Shift+E). |
| **Two file panels** | Each panel shows any session — local, SFTP, S3, another Rust Commander … — so you can copy between any two of them. |
| **Dock** (Ctrl+J) | **Queue**, **Terminal**, **Log** and **Search results**. |
| **Status bar** | Mode (desktop or web), running jobs, errors, open editor files and the active session. |

## Panels

Each panel has a session selector, back/forward/up/root/home buttons, refresh, bookmarks and
a quick filter. The path bar shows breadcrumbs; **Ctrl+L** turns it into an input field.

- Columns: name, size, type, modified, rights and owner (rights and owner where the
  protocol has them). Click a header to sort.
- **Ctrl+H** shows hidden files.
- **Synchronized browsing** (*Commands* menu) mirrors folder changes in the other panel.
- *View* → **Swap panels**, **Same folder in the other panel** and **Equal panel widths**.
- The footer shows the number of files and folders, the selection size and free disk space
  where the protocol reports it.

### Selecting files

| Key | Action |
|---|---|
| Insert | Toggle selection and move to the next file |
| Space | Toggle selection |
| Ctrl+A / Ctrl+Shift+A | Select all / none |
| + / − | Select / unselect by [mask](../reference/file-masks.md) |
| * | Invert selection |
| A–Z | Type-ahead: jump to the first matching name |
| Enter / Backspace | Open / go to the parent folder |

### Drag and drop

Drag files from one panel to the other to copy them (hold **Shift** to move), onto a folder
row to copy into that folder, or onto a session tab. **Esc** cancels a drag. In the desktop
app you can also drop files from your operating system's file manager.

## Bookmarks

**Ctrl+D** bookmarks the current folder. Bookmarks can apply to the local file system, to a
single site or to every session (for example `/var/log/nginx`).

## Themes and languages

The theme follows your system by default; *View* → **Theme** or the toolbar button
switches between system, light and dark. The interface is available in English and German
(*View* → **Language** or **Preferences**, Ctrl+,).

On narrow screens — for example the [web mode](web-mode.md) on a phone — the layout shows
one panel at a time with a switcher.

## Log

The **Log** tab in the dock records connections, transfers and errors. When an error
occurs, the status bar shows a counter; click it to jump to the log.
