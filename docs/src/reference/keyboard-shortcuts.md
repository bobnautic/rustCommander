# Keyboard shortcuts

Rust Commander offers three keyboard layouts. Choose one under *View* → **Keyboard layout**,
in **Preferences** (Ctrl+,) → *General*, or directly in the shortcut list that **F1** opens.

| Layout | |
|---|---|
| **Norton Commander** (default) | The original layout of the DOS classic: `1Help 2Menu 3View 4Edit 5Copy 6RenMov 7Mkdir 8Delete 9PullDn 10Quit` |
| **Total Commander** | The layout of the Windows classic: F2 rereads the panel, Shift+F6 renames, Ctrl+D is the directory hotlist |
| **Rust Commander** | The layout of earlier versions of Rust Commander: F2 renames, F9 refreshes |

The **function key bar** above the status bar shows what F1–F10 do in the chosen layout.
Hold **Shift**, **Ctrl** or **Alt** and it shows that layer, as in Norton Commander; a click
on a key runs its command. *View* → **Function key bar** (or *Preferences* → *General*)
hides it. It is not shown on phones.

Keys the original programs leave free carry Rust Commander's additional functions (terminal,
synchronization, Remote Explorer …); they are marked with \* in the tables below and in the
app. Functions the originals have but Rust Commander does not (the DOS command line, the
info and quick-view panels, panels on/off, folder tabs) are left unassigned.

On macOS, **Ctrl** is **⌘**, **Shift** is **⇧** and **Alt** is **⌥**. On Windows and
Linux the operating system may keep some keys for itself (Alt+F4 closes the window in many
desktops).

## Norton Commander (default)

| Key | Action |
|---|---|
| F1 | Keyboard shortcuts (help) |
| F2 | User menu: your [custom commands](../guide/file-operations.md#custom-commands) |
| F3 | View |
| F4 | Edit |
| F5 | Copy |
| F6 | Move (RenMov) |
| F7 | New folder |
| F8 / Delete\* | Delete (local files: to the trash) |
| F9 | Open the menu bar (PullDn) |
| F10 | Quit (desktop app) |
| Shift+F4 | New file |
| Shift+F6 | Rename in place |
| Shift+F8 / Shift+Delete\* | Delete permanently |
| Alt+F1 / Alt+F2 | Choose the location (drive, session) of the left / right panel |
| Alt+F3 | View with the external application |
| Alt+F4 | Edit with the external application (desktop app) |
| Alt+F5 | Pack: create an archive |
| Alt+F6 | Unpack: extract the archive here |
| Alt+F7 | Find files |
| Ctrl+F3 / F4 / F5 / F6 | Sort by name / type / date / size (again: reverse) |
| Ctrl+O | Show or hide the terminal (the "user screen") |
| Ctrl+U | Swap panels |
| Ctrl+R | Reread the panel |
| Ctrl+\\ | Root folder |
| Ctrl+PgUp / Ctrl+PgDn | Parent folder / open the folder under the cursor |
| Alt+letter | Quick search: jump to the next file starting with the typed letters |

Additions (\*): Alt+Enter properties, Alt+← / Alt+→ back / forward, Ctrl+N new session,
Ctrl+F find files, Ctrl+D bookmark this folder, Ctrl+Z undo, Ctrl+H hidden files, Ctrl+T
terminal, Ctrl+L edit the path, Ctrl+Shift+S synchronize, Ctrl+B sidebar, Ctrl+Shift+E
Remote Explorer, Ctrl+J dock, Ctrl+Shift+C copy path, Ctrl+, preferences, Ctrl+P open file,
Ctrl+K compare fingerprints.

## Total Commander

| Key | Action |
|---|---|
| F1 | Keyboard shortcuts (help) |
| F2 / Ctrl+R | Reread the panel |
| F3 | View |
| F4 | Edit |
| F5 | Copy |
| F6 | Move |
| F7 | New folder |
| F8 / Delete | Delete (local files: to the trash) |
| Shift+F8 / Shift+Delete | Delete permanently |
| F9 / F10 | Open the menu bar |
| Alt+F4 | Quit (desktop app) |
| Shift+F2 | Compare directories |
| Shift+F4 | New file |
| Shift+F6 | Rename in place |
| Alt+F1 / Alt+F2 | Choose the location (drive, session) of the left / right panel |
| Alt+F3 | View with the external application |
| Alt+F5 | Pack: create an archive |
| Alt+F9 / Alt+F6 | Unpack: extract the archive here |
| Alt+F7 | Find files |
| Alt+Enter | Properties |
| Alt+← / Alt+→ | Back / forward |
| Alt+↓ | Folder history |
| Ctrl+F3 / F4 / F5 / F6 | Sort by name / type / date / size (again: reverse) |
| Ctrl+Num + / Ctrl+Num − | Select all / select none |
| Ctrl+PgUp / Ctrl+PgDn | Parent folder / open the folder under the cursor |
| Ctrl+\\ | Root folder |
| Ctrl+← / Ctrl+→ | Show the folder under the cursor in the left / right panel |
| Ctrl+D | Directory hotlist (bookmarks) |
| Ctrl+F / Ctrl+N | Connect (Site Manager) |
| Ctrl+Shift+F | Disconnect the session of the active panel |
| Ctrl+S | Quick filter |
| Ctrl+U | Swap panels |
| Ctrl+Alt+letter | Quick search |

Additions (\*): Ctrl+Z undo, Ctrl+H hidden files, Ctrl+T terminal, Ctrl+L edit the path,
Ctrl+Shift+S synchronize, Ctrl+B sidebar, Ctrl+Shift+E Remote Explorer, Ctrl+J dock,
Ctrl+Shift+C copy path, Ctrl+, preferences, Ctrl+P open file, Ctrl+K compare fingerprints.

## Rust Commander

| Key | Action |
|---|---|
| Enter | Open |
| F2 | Rename |
| F3 | View |
| F4 | Edit |
| Shift+F4 | New file |
| F5 | Copy |
| Shift+F5 | Copy without dialog |
| F6 | Move |
| Shift+F6 | Move without dialog |
| F7 | New folder |
| F8 / Delete | Delete (local files: to the trash) |
| Shift+F8 / Shift+Delete | Delete permanently |
| Ctrl+Z | Undo the last rename or move |
| Alt+Enter | Properties |
| Ctrl+Shift+C | Copy path |
| Ctrl+K | Compare fingerprints with the other panel |
| Ctrl+P | Open file… |
| Ctrl+U | Upload from this computer (web mode) |
| Alt+← / Alt+→ | Back / forward |
| Ctrl+\\ | Root folder |
| Ctrl+PgUp / Ctrl+PgDn | Parent folder / open the folder under the cursor |
| Ctrl+L | Edit the path |
| Ctrl+R / F9 | Refresh |
| Ctrl+N | New session (Site Manager) |
| Ctrl+T | Open terminal |
| Ctrl+F | Find files |
| Ctrl+D | Add bookmark |
| Ctrl+Shift+S | Synchronize |
| Ctrl+B | Toggle the sidebar |
| Ctrl+Shift+E | Remote Explorer |
| Ctrl+J | Toggle the dock (queue, terminal, log, search results) |
| Ctrl+H | Show hidden files |
| Ctrl+, | Preferences |
| F1 | Keyboard shortcuts |

## File panels (all layouts)

| Key | Action |
|---|---|
| Tab | Switch panel |
| Enter | Open |
| Backspace | Parent folder |
| Insert | Toggle selection and move down |
| Space | Toggle selection |
| Ctrl+A | Select all |
| Ctrl+Shift+A | Select none |
| + / − | Select / unselect by mask |
| * | Invert selection |
| A–Z | Jump to a file (type-ahead) |
| Shift+F10, Menu key | Context menu |
| Esc | Clear the selection, cancel a drag |

## Editor

| Key | Action |
|---|---|
| Ctrl+S | Save |
| Shift+Alt+F | Format document |
| Ctrl+G | Go to line |
| Ctrl+/ | Toggle comment |
| Ctrl+Shift+M | Problems |
| F8 | Next problem |
| Ctrl+= / Ctrl+- | Larger / smaller text |
| Esc | Back to the file panels |

## Remote Explorer

| Key | Action |
|---|---|
| ↑ / ↓ | Move |
| ← / → | Collapse / expand |
| Enter (in the filter field) | Connect to the typed `user@host[:port]` |
| F4 / double-click | Open the file in the editor |
