# Rust Commander documentation

This folder holds the user and developer documentation of Rust Commander as plain Markdown.
It is laid out as an [mdBook](https://rust-lang.github.io/mdBook/) project, but the pages
are ordinary CommonMark with GitHub tables, so any other static site generator
(MkDocs, Docusaurus, …) can consume them as well.

```
docs/
  book.toml          mdBook configuration
  src/
    SUMMARY.md       table of contents (page order and navigation)
    introduction.md
    getting-started/ installation, building, quick tour
    guide/           one page per feature area
    reference/       shortcuts, CLI, scripting, file masks, configuration files
    deployment/      headless server, security
    development/     architecture, testing
    images/          screenshots and the logo
```

## Building the site

```bash
cargo install mdbook        # once
mdbook serve docs --open    # live preview on http://localhost:3000
mdbook build docs           # static site in docs/book/
```

`docs/book/` is build output and is ignored by Git.

## Writing pages

- Add new pages to `src/SUMMARY.md`, otherwise they are not part of the book.
- Link to other pages with relative `.md` paths (`../guide/editor.md#formatting`);
  generators turn them into HTML links.
- Images live in `src/images/` and are referenced relatively (`../images/editor.png`).
- Use the UI's English labels in **bold** and keyboard shortcuts as written in the app
  (`Ctrl+Shift+E`; on macOS the app shows ⌘ instead of Ctrl).

## Screenshots

All screenshots are taken from the built-in demo backend, so they can be regenerated at
any time and always match the current UI:

```bash
npm --prefix ui ci
npm --prefix ui run build
npm --prefix ui run screenshots:docs                     # all images
ONLY=hero,editor npm --prefix ui run screenshots:docs    # selected shots
```

The script lives in `ui/tests/docs-screenshots.mjs` and writes to `docs/src/images/`.
It uses the Playwright/Chromium installation that the UI smoke test uses.
