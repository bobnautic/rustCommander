#!/usr/bin/env node
// Sets the version of every package in the repository: the Cargo workspace (and its
// Cargo.lock entries), the Tauri app and both npm packages (and their lockfiles).
//
//   node scripts/set-version.mjs 0.2.0           # before tagging a release
//   node scripts/set-version.mjs 1.0.0-beta.1    # pre-release
//
// The release workflow runs it with the version from the tag, so the installers always carry
// the tagged version. Line endings are preserved (Windows checkouts use CRLF).
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const version = (process.argv[2] ?? '').replace(/^v/, '');
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
if (!SEMVER.test(version)) {
  console.error(`usage: node scripts/set-version.mjs <major.minor.patch[-pre]>  (got "${process.argv[2] ?? ''}")`);
  process.exit(2);
}

const read = (p) => readFileSync(join(root, p), 'utf8');
function edit(path, replacements) {
  let text = read(path);
  for (const [what, re, count = 1] of replacements) {
    let hits = 0;
    text = text.replace(re, (_, before, after = '') => {
      hits++;
      return before + version + after;
    });
    if (hits !== count) {
      console.error(`${path}: expected ${count} ${what}, found ${hits}`);
      process.exit(1);
    }
  }
  writeFileSync(join(root, path), text);
  console.log(`  ${path}`);
}

// Workspace members that inherit the workspace version (their Cargo.lock entries change too).
const manifest = read('Cargo.toml');
const members = [...manifest.match(/^members\s*=\s*\[([^\]]*)\]/m)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
const inheriting = members
  .map((m) => read(`${m}/Cargo.toml`))
  .filter((t) => /^version\.workspace\s*=\s*true/m.test(t))
  .map((t) => t.match(/^name\s*=\s*"([^"]+)"/m)[1]);
const names = inheriting.map((n) => n.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|');

console.log(`Setting version ${version}:`);
edit('Cargo.toml', [['[workspace.package] version', /(\[workspace\.package\]\r?\n(?:(?!\[)[^\n]*\n)*?version\s*=\s*")[^"]*(")/]]);
edit('Cargo.lock', [
  ['workspace packages', new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "(?:${names})"\\r?\\nversion = ")[^"]*(")`, 'g'), inheriting.length],
]);
// The top-level "version" of a JSON file is the first one indented by two spaces.
const topLevelVersion = /^(\{[\s\S]*?\n {2}"version":\s*")[^"]*(")/;
edit('src-tauri/tauri.conf.json', [['top-level "version"', topLevelVersion]]);
for (const pkg of ['', 'ui/']) {
  edit(`${pkg}package.json`, [['top-level "version"', topLevelVersion]]);
  edit(`${pkg}package-lock.json`, [
    ['top-level "version"', topLevelVersion],
    ['root package "version"', /("packages":\s*\{\s*"":\s*\{\s*"name":\s*"[^"]*",\s*"version":\s*")[^"]*(")/],
  ]);
}
