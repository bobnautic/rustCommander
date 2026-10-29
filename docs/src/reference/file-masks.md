# File masks

File masks select files for transfers, synchronization, *select by mask* (**+** / **−**)
and the `-filemask=` switch of [scripts](scripting.md).

```text
*.txt; *.log | tmp/; *.bak
```

## Rules

- Patterns are separated by `;` (or `,`).
- Everything after `|` is an **exclusion** list; an exclusion always wins.
- Wildcards: `*` (any characters), `?` (one character), `[abc]` (one of these characters).
- Matching is **case-insensitive**.
- A pattern ending in `/` applies to **folders only**: `node_modules/`.
- A pattern that contains `/` elsewhere is matched against the path **relative to the
  transfer root** (`src/*.rs`); otherwise it is matched against the bare name.
- Name patterns are **alternatives** (any one may match); size and age conditions must
  **all** hold in addition.
- Folders are only filtered by folder patterns (`name/`) and exclusions, so `*.txt` still
  looks into every subfolder.
- An empty mask matches everything.

## Size and age conditions

Operators: `<`, `<=`, `>`, `>=`, `=`.

| Condition | Meaning |
|---|---|
| `>100K` | Larger than 100 KiB (units `K`, `M`, `G`, `T` — powers of 1024; no unit = bytes) |
| `<=1G` | At most 1 GiB |
| `<7D` | Modified within the last 7 days |
| `>2W` | Modified more than 2 weeks ago |
| `>=2024-01-31` | Modified on or after 31 January 2024 (UTC) |

Age units: `S` seconds, `N` minutes, `H` hours, `D` days, `W` weeks, `Y` years.

## Examples

| Mask | Selects |
|---|---|
| `*.jpg; *.png` | JPEG and PNG images |
| `* \| .git/; node_modules/` | Everything except Git metadata and `node_modules` |
| `*.jpg; *.png \| thumbs/; *.tmp` | Images, but not in `thumbs` folders, and no temp files |
| `*.log; >10M` | Log files larger than 10 MiB |
| `<1D` | Everything modified in the last 24 hours |
| `* \| <7D` | Files that were *not* modified in the last week |
| `src/*.rs` | Rust files directly in `src/` |
