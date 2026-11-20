# Changelog

All notable changes to Rust Commander are listed here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

The release workflow puts the section of the released version into the release notes on
GitHub (see [Releasing](docs/src/development/releasing.md)), so add an entry here before
cutting a release.

## [0.0.2] - 2026-11-20

### Added

- **Keyboard layouts.** The original Norton Commander layout is the new default: F1 Help,
  F2 Menu, F3 View, F4 Edit, F5 Copy, F6 Rename/Move, F7 Mkdir, F8 Delete, F9 Pull-down
  menu, F10 Quit, Alt+F1/F2 drive, Ctrl+F3–F6 sorting, Ctrl+O, Ctrl+U and Alt+letter quick
  search. The Total Commander layout (F2 reread, Shift+F6 rename, Ctrl+D hotlist, Ctrl+S
  filter, Alt+Down history, …) and the previous Rust Commander layout can be chosen in the
  View menu, in Preferences or in the F1 dialog (setting `keymap`). A function key bar above
  the status bar shows the Shift/Ctrl/Alt layers (setting `showKeyBar`), and menus, toolbar,
  context menu and the F1 list follow the active layout. F10 / Alt+F4 quit the desktop app
  after a confirmation.
  ([#39](https://github.com/bobnautic/rustCommander/pull/39))
- **Skins.** A skin sets the whole look — colors, file icons, terminal and syntax colors,
  shadows, fonts, corner radii, row height, striped rows — in a light and/or dark variant.
  Ten skins are built in: Rust Commander (default, unchanged look), Ember, Graphite,
  Retro Blue, High Contrast, Nord, Solarized, Catppuccin, Gruvbox and Dracula.
  ([#42](https://github.com/bobnautic/rustCommander/pull/42))
  - Preferences → Appearance: skin gallery with live previews, adjustments on top of any
    skin (accent, row height, list font size, corner radius, striped rows, fonts),
    import/export and a link to the skins folder; View → Skin menu.
  - Skin editor with grouped tokens, color pickers, a live preview of panels, editor,
    terminal and controls, contrast warnings and a JSON view.
  - User skins are JSON files in `<config dir>/skins/` and reload when the window gets the
    focus again, so they can be written in any editor. A JSON schema and a token reference
    are part of the docs.
- **Jobs and sessions survive a restart.** Unfinished jobs come back on the next start:
  finished files are skipped and a half-written file is continued. Open connections are
  reconnected and the panels return to them. Settings `resumeJobs` and `restoreSessions`.
  ([#9](https://github.com/bobnautic/rustCommander/pull/9))
- **Queue controls:** pause, resume or cancel all jobs, change the speed limit of a running
  job and retry only what failed. Paused jobs no longer take a slot.
  ([#9](https://github.com/bobnautic/rustCommander/pull/9))
- **Trash and undo:** in the desktop app, deleting local files moves them to the system trash
  and Shift+Delete deletes for good (setting `useTrash`). Ctrl+Z undoes the last rename or
  move within a session. ([#9](https://github.com/bobnautic/rustCommander/pull/9))
- **Sync conflicts** can be resolved in the checklist (left wins, right wins, keep both,
  skip, resolve all, with a diff button) and in scripts
  (`synchronize -conflict=skip|local|remote|both|fail`).
  ([#9](https://github.com/bobnautic/rustCommander/pull/9))
- **Downloads:** every release now has an `.rpm` (pre-releases too), a `SHA256SUMS.txt` and a
  download table with first-start notes for macOS and Windows.
  ([#7](https://github.com/bobnautic/rustCommander/pull/7),
  [#26](https://github.com/bobnautic/rustCommander/pull/26))

### Changed

- **Faster on SSH hosts:** deleting folders, recursive chmod/chown, folder sizes and search
  run as commands on the SFTP/SCP server (guarded, with a fallback to the generic way).
  ([#9](https://github.com/bobnautic/rustCommander/pull/9))
- **Faster on object stores:** S3, Azure and GCS answer MD5 checksums from the object
  metadata, transfers and syncs compare with the strongest algorithm both sides compute
  themselves, and uploads keep the source modification time. Checksum comparisons during a
  sync run in parallel. ([#9](https://github.com/bobnautic/rustCommander/pull/9))
- **Releases** are created as a draft with all files, every uploaded file is checked against
  the built one (size and SHA-256), and only then the release is published. A release
  created by hand on GitHub shows a note with a link to the running build.
  ([#7](https://github.com/bobnautic/rustCommander/pull/7),
  [#26](https://github.com/bobnautic/rustCommander/pull/26))

### Fixed

- Pausing or resuming a job right after it was queued, before it had started, was lost.
  ([#9](https://github.com/bobnautic/rustCommander/pull/9))
- A conflict between a file and a folder in a sync also listed the folder's content as
  actions. ([#9](https://github.com/bobnautic/rustCommander/pull/9))

### Security

- `zip` 2.6 → 9.5 (RUSTSEC-2026-0367, RUSTSEC-2026-0368, RUSTSEC-2026-0369,
  RUSTSEC-2026-0429); extracting an archive no longer sets setuid/setgid bits.
  ([#9](https://github.com/bobnautic/rustCommander/pull/9))
- CI audits the dependencies (`cargo audit`, `npm audit`) and runs the Playwright smoke test;
  Dependabot keeps Cargo, npm and GitHub Actions dependencies up to date.
  ([#9](https://github.com/bobnautic/rustCommander/pull/9))

### Dependencies

- UI: React 19, Vite 8, TypeScript 7, `@vitejs/plugin-react` 6 and minor updates
  (lucide-react, zustand, prettier, CodeMirror lint).
  ([#25](https://github.com/bobnautic/rustCommander/pull/25),
  [#27](https://github.com/bobnautic/rustCommander/pull/27),
  [#33](https://github.com/bobnautic/rustCommander/pull/33))
- RustCrypto: `digest` 0.11 stack (`sha1` 0.11, `sha2`, `md-5`, `hmac` 0.13) and `argon2` 0.6;
  existing password hashes keep working.
  ([#25](https://github.com/bobnautic/rustCommander/pull/25))
- `x509-cert` 0.3, `async_zip` 0.0.19, `axum-server` 0.9, `parking_lot` 0.13,
  `tokio-tungstenite` 0.30, `base64` 0.23, `roxmltree` 0.21 and minor updates (`russh`,
  `notify`, `trash`, `uuid`, `flate2`, `rust-embed`, `webpki-roots`, `rpassword`).
  ([#25](https://github.com/bobnautic/rustCommander/pull/25),
  [#28](https://github.com/bobnautic/rustCommander/pull/28),
  [#31](https://github.com/bobnautic/rustCommander/pull/31),
  [#32](https://github.com/bobnautic/rustCommander/pull/32),
  [#34](https://github.com/bobnautic/rustCommander/pull/34),
  [#35](https://github.com/bobnautic/rustCommander/pull/35),
  [#36](https://github.com/bobnautic/rustCommander/pull/36))
- GitHub Actions: `actions/checkout` 7, `actions/setup-node` 7, `actions/upload-artifact` 7,
  `actions/download-artifact` 8. ([#25](https://github.com/bobnautic/rustCommander/pull/25))

### Documentation

- New guides: *Skins and appearance*, *Creating skins* (tutorial, recipes, tools) and the
  skin token reference; the keyboard shortcut reference covers all three layouts.
- Transfers, file operations and synchronization describe resuming, trash/undo and
  conflict resolution; *Releasing* describes the new release process.
- Feature analysis and implementation plan (`docs/feature-analyse.md`,
  `docs/implementierungsplan.md`).
  ([#8](https://github.com/bobnautic/rustCommander/pull/8),
  [#9](https://github.com/bobnautic/rustCommander/pull/9))

## [0.0.1-alpha] - 2026-10-30

First version: a two-panel file manager in Rust and Tauri with a web mode, LAN discovery,
a read-only remote explorer for SSH hosts, an editor with linting and formatting, and
release builds for macOS, Windows and Linux plus the `rcmd` CLI.

[0.0.2]: https://github.com/bobnautic/rustCommander/compare/v0.0.1-alpha...v0.0.2
[0.0.1-alpha]: https://github.com/bobnautic/rustCommander/releases/tag/v0.0.1-alpha
