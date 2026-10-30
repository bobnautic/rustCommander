# Releasing

Releases are built by the **Release** workflow (`.github/workflows/release.yml`) and
published on the [Releases page](https://github.com/bobnautic/rustcommander/releases). Each
release is a version tag `v<major>.<minor>.<patch>` (optionally with a pre-release suffix such
as `-beta.1`).

## Cutting a release

1. Optional, but keeps `main` in step with the releases: set the version in the repository
   and merge it.

   ```bash
   node scripts/set-version.mjs 0.2.0     # Cargo workspace + Cargo.lock, tauri.conf.json, package.json files
   git commit -am "Release 0.2.0"
   ```

2. Start the release, either by pushing a tag:

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

   or on GitHub under **Actions → Release → Run workflow**: pick the branch, enter the
   version (`0.2.0`) and run it. The tag `v0.2.0` is then created on that branch's latest
   commit when the release is published.

   A release created by hand works as well: **Releases → Draft a new release**, choose a
   *new* tag `v0.2.0`, write the notes and **Publish release**. Publishing creates the tag,
   which starts the workflow. Until the files are built (about 25 minutes) the release shows
   a note with a link to the build; then the files and the download table are added above
   the notes written there. The tag must not exist before, otherwise no build starts. This
   way needs the repository setting *immutable releases* to be off, because the files are
   added after publishing.

The workflow always builds with the version from the tag (it runs `set-version.mjs` itself),
so the installers, the app and `rcmd --version` carry that version even if step 1 was
skipped.

## What the workflow does

| Job | Runs on | Produces |
|---|---|---|
| Checks | Linux, Windows, macOS | the [CI](testing.md#continuous-integration) checks: UI build and tests, `cargo fmt`, `clippy`, `cargo test` |
| Desktop (macOS) | `macos-latest` | `rustCommander-<version>-macos-universal.dmg` (Apple silicon and Intel) |
| Desktop (Windows) | `windows-latest` | `rustCommander-<version>-windows-x64-setup.exe` (NSIS installer, English/German) and `rustCommander-<version>-windows-x64-portable.exe` |
| Desktop (Linux) | `ubuntu-22.04` | `.AppImage`, `.deb` and `.rpm` (RPM versions cannot contain `-`, so pre-releases have no `.rpm`) |
| rcmd | Linux x86_64/aarch64, macOS arm64/x86_64, Windows x64 | `rcmd-<version>-<platform>.tar.gz` / `.zip` |
| Publish release | | the GitHub release with all files, `SHA256SUMS.txt`, download table and generated release notes |

The release is only created when **every** job succeeded, so a release never has missing
downloads. A version with a suffix (`1.0.0-rc.1`) becomes a pre-release; the newest regular
release is marked *latest*, so
`https://github.com/bobnautic/rustcommander/releases/latest` always points to it.

**Run workflow** has two more options:

- **draft** — create the release as a draft and publish it by hand after a look at it.
- **dry-run** — only build; the files can be downloaded from the workflow run's
  *Artifacts* section and no tag or release is created. Useful to test packaging changes.

Pull requests that change the release workflow, `scripts/set-version.mjs` or
`src-tauri/tauri.conf.json` run the build jobs too (with the version in the repository,
as workflow artifacts only), so packaging changes are tested before they reach a release.

If a run failed for a transient reason, **Re-run failed jobs** on the run continues it. When
the release already exists, the publish job replaces its files and its download table and
keeps the rest of the notes. A release created by hand says so in its notes when the build
failed.

## Code signing

Without further setup the macOS app is ad-hoc signed (`bundle.macOS.signingIdentity: "-"`
in `tauri.conf.json`) and the Windows installer is unsigned. Users see a one-time warning:
on macOS they confirm under **System Settings → Privacy & Security → Open Anyway**, on Windows
SmartScreen asks them to click **More info → Run anyway**. The release notes explain this.

To sign and notarize the macOS app, add these repository secrets
(**Settings → Secrets and variables → Actions**); the workflow uses them automatically:

| Secret | Content |
|---|---|
| `APPLE_CERTIFICATE` | the *Developer ID Application* certificate as base64-encoded `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the password of the `.p12` file |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Jane Doe (TEAMID)` |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Apple ID, app-specific password and team ID for notarization |

See [Tauri's macOS signing guide](https://v2.tauri.app/distribute/sign/macos/) for how to
create the certificate.
