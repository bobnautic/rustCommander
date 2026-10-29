# Transfers

## Copy and move

Select files and press **F5** to copy or **F6** to move them to the folder of the other
panel. You can also drag them (hold **Shift** to move) onto the other panel, a folder or a
session tab. **Shift+F5** / **Shift+F6** skip the dialog.

![Copy dialog](../images/copy-dialog.png)

The dialog shows the target folder (editable) and, under **Transfer settings**, the
options for this transfer:

| Option | Meaning |
|---|---|
| **If the file exists** | What to do with existing files (see below) |
| **Transfer mode** | *Automatic*, *Binary* or *Text* (line endings are converted for files matching the **text file masks**) |
| **File mask** | Which files to include and exclude, e.g. `*.jpg; *.png \| thumbs/; *.tmp` — see [File masks](../reference/file-masks.md) |
| **Exclude hidden files** | Skip dot files |
| **Follow symbolic links** | Copy the link target instead of the link |
| **Preserve timestamps** | Keep the modification time |
| **Permissions** | *Keep*, *Server default* or *Set to* a mode such as `644` |
| **Speed limit** | KB/s, 0 = unlimited |
| **Parallel files** | How many files of one job are transferred at the same time |
| **Upload via temporary file** | Upload as `.filepart` and rename when complete, so nobody sees half-written files |
| **Verify the checksum after the transfer** | Compare source and target checksums after each file |

**Compare fingerprints** in the copy dialog checks what the copy would hit before it starts —
see [Fingerprints before copying](fingerprints.md).

Copies work between **any two sessions**: SFTP → S3, FTP → SFTP, local → another
Rust Commander instance. Data is streamed between the two sessions, not stored on your
local disk first.

## When the file already exists

| Mode | Behavior |
|---|---|
| Ask | Show a dialog for each conflict |
| Overwrite | Always overwrite |
| Skip | Keep the existing file |
| Overwrite if newer | Only if the source is newer |
| Overwrite if the size differs | Only if the sizes differ |
| Overwrite if the content differs (checksum) | Compares checksums and only overwrites files whose content differs |
| Resume | Continue an interrupted transfer |
| Keep both (rename new file) | Store the new file under a different name |

With **Ask**, the conflict dialog shows source and target side by side. It can compare
both fingerprints right there and show a diff of text files. **Apply to all** uses the
answer for the remaining files of the job.

![File already exists](../images/conflict.png)

## The queue

Every copy, move, delete and synchronization runs as a **job** in the background. The
**Queue** tab in the dock shows progress, speed, remaining time and errors per job.

- **Pause**, **Resume**, **Cancel** and **Retry** per job; **Clear finished** tidies up.
- While the queue is hidden, the status bar shows the overall progress.
- Interrupted transfers can be resumed where the protocol allows it (all except uploads to
  object storage).
- Dropped connections are re-established automatically and the operation is retried.

## Web mode: browser uploads and downloads

In the [web mode](web-mode.md) there are extra commands for the computer running the
browser: **Upload from this computer…** (Ctrl+U), **Upload folder…** and **Download to
this computer**.
Folders are downloaded as a ZIP stream.
