#!/usr/bin/env node
// End-to-end smoke test against the mock backend (?mock=1).
//
//   node tests/smoke.mjs                 builds if needed, starts `vite preview`, runs the checks
//   BASE_URL=http://127.0.0.1:5173 node tests/smoke.mjs     use an already running dev/preview server
//   HEADED=1 node tests/smoke.mjs        watch it run
//
// Screenshots are written to tests/screenshots/.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const shots = join(root, 'tests', 'screenshots');
mkdirSync(shots, { recursive: true });

const PORT = Number(process.env.PORT ?? 4179);
let base = process.env.BASE_URL;
let server = null;

async function waitForHttp(url, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server at ${url} did not start`);
}

if (!base) {
  if (!existsSync(join(root, 'dist', 'index.html'))) {
    console.log('• building (dist/ missing)…');
    const b = spawnSync('npx', ['vite', 'build'], { cwd: root, stdio: 'inherit' });
    if (b.status !== 0) process.exit(b.status ?? 1);
  }
  server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
  base = `http://127.0.0.1:${PORT}`;
  await waitForHttp(base + '/');
}
base = base.replace(/\/$/, '');

const results = [];
let failed = 0;
async function step(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`  ✔ ${name} (${Date.now() - t0} ms)`);
    console.log(results[results.length - 1]);
  } catch (e) {
    failed++;
    results.push(`  ✘ ${name}: ${e.message.split('\n')[0]}`);
    console.log(results[results.length - 1]);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const browser = await chromium.launch({ headless: !process.env.HEADED });
const pageErrors = [];
function watch(page, label) {
  page.on('pageerror', (e) => pageErrors.push(`${label}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(`${label} console: ${m.text()}`);
  });
}

const ctx = await browser.newContext({ viewport: { width: 1366, height: 820 }, colorScheme: 'light', locale: 'en-US' });
const page = await ctx.newPage();
watch(page, 'desktop');
const row = (side, name) => page.locator(`[data-testid="table-${side}"] .ft-row[data-name="${name}"]`);
const dialog = (title) => page.locator('.dlg').filter({ has: page.locator('h2', { hasText: title }) });
const snap = (p, name) => p.screenshot({ path: join(shots, name), animations: 'disabled' });

try {
  await step('app loads with two panels', async () => {
    await page.goto(`${base}/?mock=1&fast=1`);
    await page.locator('[data-testid="panel-left"]').waitFor();
    await page.locator('[data-testid="panel-right"]').waitFor();
    await row('left', 'Documents').waitFor();
    await row('right', 'Documents').waitFor();
    assert((await page.locator('[data-testid="panel-left"] .ft-row').count()) > 5, 'left panel has too few rows');
  });

  await step('navigate into a directory', async () => {
    await row('left', 'projects').dblclick();
    await row('left', 'website').waitFor();
    await row('left', 'website').dblclick();
    await row('left', 'index.html').waitFor();
    const crumbs = await page.locator('[data-panel="left"] .pathbar').innerText();
    assert(crumbs.includes('website'), `path bar shows "${crumbs}"`);
  });

  await step('select files, F5 → copy dialog → job completes', async () => {
    await row('left', 'index.html').click();
    await row('left', 'about.html').click({ modifiers: ['Control'] });
    await row('left', 'contact.html').click({ modifiers: ['Control'] });
    const selected = await page.locator('[data-testid="table-left"] .ft-row.selected').count();
    assert(selected === 3, `expected 3 selected rows, got ${selected}`);
    await page.keyboard.press('F5');
    const dlg = dialog('Copy');
    await dlg.waitFor();
    assert((await dlg.innerText()).includes('3 items'), 'copy dialog does not mention 3 items');
    await dlg.locator('.collapsible-head').click();
    await dlg.locator('.topts').waitFor();
    await snap(page, 'copy-dialog.png');
    await dlg.locator('button[type=submit]').click();
    await dlg.waitFor({ state: 'detached' });
    const job = page.locator('[data-testid="job"]').first();
    await job.waitFor();
    await page.locator('[data-testid="job"][data-state="completed"]').first().waitFor({ timeout: 15000 });
    await row('right', 'index.html').waitFor({ timeout: 5000 });
  });

  await step('site manager opens; connecting shows the host-key prompt', async () => {
    await page.locator('[data-testid="tb-new-session"]').click();
    const sm = dialog('Site Manager');
    await sm.waitFor();
    await sm.locator('[data-testid="site-web-01"]').click();
    await sm.locator('#site-host').waitFor();
    assert((await sm.locator('#site-host').inputValue()) === 'web-01.example.com', 'site form not filled');
    await snap(page, 'site-manager.png');
    await sm.locator('[data-testid="site-login"]').click();
    const prompt = dialog('Unknown host key');
    await prompt.waitFor();
    assert((await prompt.innerText()).includes('SHA256:'), 'fingerprint missing in host key prompt');
    await snap(page, 'host-key-prompt.png');
    await prompt.locator('[data-testid="prompt-accept-save"]').click();
    await page.locator('[data-testid="session-tab"]', { hasText: 'web-01' }).waitFor();
    await row('right', 'old-landing.html').waitFor();
    await row('left', 'index.html').waitFor();
  });

  await step('main window (light) screenshot', async () => {
    await row('right', 'index.html').click();
    await page.waitForTimeout(300);
    await snap(page, 'main-light.png');
  });

  await step('synchronize: compare shows a checklist', async () => {
    await page.locator('[data-testid="tb-sync"]').click();
    const sd = dialog('Synchronize');
    await sd.waitFor();
    await sd.locator('button[type=submit]').click();
    const cl = dialog('Synchronization checklist');
    await cl.waitFor({ timeout: 10000 });
    const rows = await cl.locator('[data-testid="sync-row"]').count();
    assert(rows >= 3, `expected sync actions, got ${rows}`);
    await snap(page, 'sync-checklist.png');
    await page.keyboard.press('Escape');
    await cl.waitFor({ state: 'detached' });
  });

  await step('copy onto an existing file shows the conflict dialog', async () => {
    await row('left', 'index.html').click();
    await page.keyboard.press('F5');
    const dlg = dialog('Copy');
    await dlg.waitFor();
    await dlg.locator('button[type=submit]').click();
    const conflict = dialog('File already exists');
    await conflict.waitFor({ timeout: 10000 });
    assert((await conflict.innerText()).includes('index.html'), 'conflict dialog does not name the file');
    await snap(page, 'conflict.png');
    await conflict.locator('[data-testid="conflict-overwrite"]').click();
    await conflict.waitFor({ state: 'detached' });
    await page.locator('[data-testid="job"][data-state="completed"]', { hasText: 'index.html' }).first().waitFor({ timeout: 10000 });
  });

  await step('properties dialog (Alt+Enter)', async () => {
    await row('right', 'index.html').click();
    await page.keyboard.press('Alt+Enter');
    const props = dialog('Properties');
    await props.waitFor();
    await props.locator('.perm-grid').waitFor();
    const octal = await props.locator('.input-octal').inputValue();
    assert(octal === '644', `expected octal 644, got ${octal}`);
    await snap(page, 'properties.png');
    await page.keyboard.press('Escape');
    await props.waitFor({ state: 'detached' });
  });

  await step('Nearby sidebar lists peers', async () => {
    await page.locator('[data-testid="tb-nearby"]').click();
    await page.locator('[data-testid="nearby"]').waitFor();
    await page.locator('[data-testid="self-peer"]').waitFor();
    const peers = await page.locator('[data-testid="peer"]').count();
    assert(peers >= 3, `expected ≥3 peers, got ${peers}`);
    await snap(page, 'nearby.png');
  });

  await step('remote explorer: ~/.ssh/config host, tree, preview, shell fallback', async () => {
    await page.locator('[data-testid="sidebar-tab-explorer"]').click();
    const xp = page.locator('[data-testid="explorer"]');
    await xp.waitFor();
    const target = (id) => xp.locator(`[data-testid="xp-target"][data-target="${id}"]`);
    await target('ssh:build-box').waitFor();
    assert(await target('site:site-web01').count(), 'saved SFTP site missing');
    assert(!(await xp.locator('[data-testid="xp-target"]', { hasText: 'internal' }).count()), 'wildcard host listed');
    await target('ssh:build-box').click();
    const prompt = dialog('Unknown host key');
    await prompt.waitFor();
    await prompt.locator('[data-testid="prompt-accept-once"]').click();
    const entry = (path) => xp.locator(`[data-testid="xp-entry"][data-path="${path}"]`);
    await entry('/home/ci/app').click();
    await entry('/home/ci/app/docker-compose.yml').click();
    await xp.locator('[data-testid="xp-preview"] pre', { hasText: 'services:' }).waitFor();
    assert((await xp.locator('[data-testid="xp-path"]').innerText()) === '/home/ci/app/docker-compose.yml', 'details show the wrong path');
    await page.locator('[data-testid="session-tab"]', { hasText: 'build-box' }).waitFor();
    // keyboard: Left collapses the focused folder's parent chain, Up/Down move
    await xp.locator('[data-testid="xp-tree"]').focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await entry('/home/ci/app/docker-compose.yml').waitFor({ state: 'detached' });
    await snap(page, 'remote-explorer.png');
    // a server without SFTP is listed through shell commands
    await target('ssh:router').click();
    await prompt.waitFor();
    await prompt.locator('[data-testid="prompt-accept-once"]').click();
    await target('ssh:router').locator('.badge', { hasText: 'Shell' }).waitFor();
    await entry('/home/root/deploy.log').waitFor();
    // Ctrl+Shift+E toggles the explorer; the Nearby button switches back
    await page.keyboard.press('Control+Shift+E');
    await xp.waitFor({ state: 'detached' });
    await page.keyboard.press('Control+Shift+E');
    await xp.waitFor();
    await page.locator('[data-testid="tb-nearby"]').click();
    await page.locator('[data-testid="nearby"]').waitFor();
  });

  await step('terminal opens and echoes', async () => {
    await page.locator('[data-testid="tb-terminal"]').click();
    const term = page.locator('.term-pane:not(.hidden) .xterm');
    await term.waitFor({ timeout: 10000 });
    await page.waitForTimeout(300);
    await term.click();
    await page.keyboard.type('echo hello-rcmd');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => {
      const el = document.querySelector('.term-pane:not(.hidden) .xterm-rows');
      return !!el && (el.textContent ?? '').split('hello-rcmd').length >= 3;
    }, null, { timeout: 5000 });
    await snap(page, 'terminal.png');
  });

  await step('editor opens a file and saves', async () => {
    await row('left', 'README.md').click();
    await page.locator('[data-testid="table-left"]').focus();
    await page.keyboard.press('F4');
    const ed = page.locator('[data-testid="editor"]');
    await ed.waitFor();
    const content = ed.locator('.cm-content');
    await content.waitFor();
    await content.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('\nEdited by the smoke test.');
    await ed.locator('.dirty-dot').first().waitFor();
    await snap(page, 'editor.png');
    await page.keyboard.press('Control+s');
    await page.locator('.toast', { hasText: 'Saved README.md' }).waitFor();
    await ed.locator('.editor-tab .dirty-dot').waitFor({ state: 'detached' });
    await page.keyboard.press('Escape');
    await ed.waitFor({ state: 'detached' });
  });

  await step('dark theme', async () => {
    const theme = () => page.evaluate(() => document.documentElement.dataset.theme);
    for (let i = 0; i < 3 && (await theme()) !== 'dark'; i++) await page.locator('[data-testid="tb-theme"]').click();
    assert((await theme()) === 'dark', 'theme did not switch to dark');
    await page.locator('[data-testid="nearby"]').waitFor();
    await page.waitForTimeout(250);
    await snap(page, 'main-dark.png');
  });

  await step('German language', async () => {
    await page.keyboard.press('Control+,');
    const prefs = dialog('Preferences');
    await prefs.waitFor();
    await prefs.locator('[data-testid="prefs-language"]').selectOption('de');
    await prefs.locator('button[type=submit]').click();
    await page.locator('[data-testid="menu-session"]', { hasText: 'Sitzung' }).waitFor();
    assert((await page.locator('[data-testid="menu-files"]').innerText()) === 'Dateien', 'menu not translated');
    await snap(page, 'german-dark.png');
  });
} finally {
  await ctx.close();
}

// ---------------------------------------------------------------- keyboard-driven file operations
{
  const kctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en-US' });
  const kp = await kctx.newPage();
  watch(kp, 'keyboard');
  const krow = (name) => kp.locator(`[data-testid="table-left"] .ft-row[data-name="${name}"]`);
  const kdialog = (title) => kp.locator('.dlg').filter({ has: kp.locator('h2', { hasText: title }) });
  const cursor = () => kp.locator('[data-testid="table-left"] .ft-row.cursor').getAttribute('data-name');
  const until = async (fn, msg, ms = 4000) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
      last = await fn();
      if (last === true) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`${msg} (got ${last})`);
  };
  const selectedCount = () => kp.locator('[data-testid="table-left"] .ft-row.selected').count();

  await step('keyboard: arrows, type-ahead, Enter, Backspace, Insert, Tab', async () => {
    await kp.goto(`${base}/?mock=1&fast=1`);
    await krow('Documents').waitFor();
    await kp.locator('[data-testid="table-left"]').focus();
    await kp.keyboard.press('Home');
    await kp.keyboard.press('ArrowDown');
    await kp.keyboard.type('mu');
    await until(async () => (await cursor()) === 'Music' || cursor(), 'type-ahead');
    await kp.keyboard.press('Enter');
    await krow('01 - Intro.mp3').waitFor();
    await kp.keyboard.press('Backspace');
    await krow('Music').waitFor();
    await until(async () => (await cursor()) === 'Music' || cursor(), 'cursor returns to the left folder');
    await kp.keyboard.press('Insert');
    await kp.keyboard.press('Insert');
    await until(async () => (await selectedCount()) === 2 || selectedCount(), 'Insert marks two rows');
    await kp.keyboard.press('Escape');
    await until(async () => (await selectedCount()) === 0 || selectedCount(), 'Escape clears the selection');
    await kp.keyboard.press('Tab');
    assert((await kp.locator('.panel.active').getAttribute('data-panel')) === 'right', 'Tab did not switch panels');
    await kp.keyboard.press('Tab');
  });

  await step('F7 new folder, F2 inline rename, F8 delete', async () => {
    await kp.keyboard.press('F7');
    await kdialog('New folder').waitFor();
    await kp.keyboard.type('smoke-dir');
    await kp.keyboard.press('Enter');
    await krow('smoke-dir').waitFor();
    await until(async () => (await cursor()) === 'smoke-dir' || cursor(), 'new folder focused');
    await kp.keyboard.press('F2');
    await kp.locator('.ft-rename').waitFor();
    await kp.keyboard.press('Control+a');
    await kp.keyboard.type('smoke-renamed');
    await kp.keyboard.press('Enter');
    await krow('smoke-renamed').waitFor();
    await kp.locator('[data-testid="table-left"]').focus();
    await kp.keyboard.press('F8');
    await kdialog('Delete').waitFor();
    await kp.keyboard.press('Enter');
    await krow('smoke-renamed').waitFor({ state: 'detached', timeout: 5000 });
  });

  await step('select by mask (+) and quick filter', async () => {
    await kp.locator('[data-testid="table-left"]').focus();
    await kp.keyboard.press('+');
    await kdialog('Select by mask').waitFor();
    await kp.keyboard.press('Control+a');
    await kp.keyboard.type('*.txt');
    await kp.keyboard.press('Enter');
    await until(async () => (await selectedCount()) === 1 || selectedCount(), 'mask selects notes.txt');
    await kp.keyboard.press('Escape');
    await kp.locator('[data-panel="left"] .panel-head button[title="Quick filter"]').click();
    await kp.keyboard.type('doc');
    await until(async () => (await kp.locator('[data-testid="table-left"] .ft-row').count()) === 2 || 'rows', 'filter shows Documents only');
    await kp.keyboard.press('Escape');
  });

  // panel-to-panel drags use pointer events (HTML5 DnD is unavailable in WebView2 with dragDropEnabled)
  async function pointerDrag(from, to, { shift = false, cancel = false } = {}) {
    const a = await from.boundingBox();
    const b = await to.boundingBox();
    await kp.mouse.move(a.x + 30, a.y + a.height / 2);
    await kp.mouse.down();
    await kp.mouse.move(a.x + 50, a.y + a.height / 2 + 8, { steps: 3 });
    await kp.mouse.move(b.x + Math.min(b.width / 2, 120), b.y + Math.min(b.height / 2, 60), { steps: 8 });
    await kp.locator('[data-testid="drag-ghost"]').waitFor();
    if (shift) await kp.keyboard.down('Shift');
    if (cancel) await kp.keyboard.press('Escape');
    await kp.mouse.up();
    if (shift) await kp.keyboard.up('Shift');
    await kp.locator('[data-testid="drag-ghost"]').waitFor({ state: 'detached' });
  }

  await step('pointer drag & drop: copy, Shift = move, onto a folder, Esc cancels', async () => {
    await krow('notes.txt').click();
    await krow('backup-2026-10-01.tar.gz').click({ modifiers: ['Control'] });
    await pointerDrag(krow('notes.txt'), kp.locator('[data-testid="table-right"]'));
    let dlg = kdialog('Copy');
    await dlg.waitFor({ timeout: 4000 });
    assert((await dlg.innerText()).includes('2 items'), 'drag did not carry both selected files');
    await kp.keyboard.press('Escape');
    await dlg.waitFor({ state: 'detached' });
    await pointerDrag(krow('notes.txt'), kp.locator('[data-testid="table-right"]'), { shift: true });
    dlg = kdialog('Move');
    await dlg.waitFor({ timeout: 4000 });
    await kp.keyboard.press('Escape');
    await pointerDrag(krow('notes.txt'), kp.locator('[data-testid="table-right"] .ft-row[data-name="Documents"]'));
    dlg = kdialog('Copy');
    await dlg.waitFor({ timeout: 4000 });
    const target = await dlg.locator('[data-testid="copy-target"]').inputValue();
    assert(target === '/home/demo/Documents', `drop onto a folder targets "${target}"`);
    await kp.keyboard.press('Escape');
    await pointerDrag(krow('notes.txt'), kp.locator('[data-testid="table-right"]'), { cancel: true });
    await kp.waitForTimeout(300);
    assert((await kp.locator('.dlg').count()) === 0, 'Esc did not cancel the drag');
  });

  await step('password prompt for a site without a saved password', async () => {
    await kp.keyboard.press('Control+n');
    await kdialog('Site Manager').waitFor();
    await kp.locator('[data-testid="site-staging"]').dblclick();
    await kdialog('Unknown host key').waitFor();
    await kp.locator('[data-testid="prompt-accept-once"]').click();
    await kdialog('Password').waitFor();
    await kp.locator('[data-testid="prompt-input"]').fill('secret');
    await kp.keyboard.press('Enter');
    await kp.locator('[data-testid="session-tab"]', { hasText: 'staging' }).waitFor();
  });

  await step('pointer drag onto a session tab targets that session', async () => {
    await krow('notes.txt').waitFor();
    await pointerDrag(krow('notes.txt'), kp.locator('[data-testid="session-tab"]', { hasText: 'staging' }));
    const dlg = kdialog('Copy');
    await dlg.waitFor({ timeout: 4000 });
    const target = await dlg.locator('[data-testid="copy-target"]').inputValue();
    assert(target === '/var/www/html', `tab drop targets "${target}"`);
    assert((await dlg.innerText()).includes('staging'), 'copy dialog does not show the staging session');
    await kp.keyboard.press('Escape');
  });
  await kctx.close();
}

{
  // Editor and pre-copy checks on a fresh page, so earlier steps cannot influence them.
  const ectx = await browser.newContext({ viewport: { width: 1366, height: 820 }, colorScheme: 'light', locale: 'en-US' });
  const ep = await ectx.newPage();
  watch(ep, 'editor');
  const erow = (side, name) => ep.locator(`[data-testid="table-${side}"] .ft-row[data-name="${name}"]`);
  const edlg = (title) => ep.locator('.dlg').filter({ has: ep.locator('h2', { hasText: title }) });
  const activeCm = '[data-testid="editor"] .cm-wrap:not(.cm-hidden) .cm-content';
  const settled = () =>
    ep.waitForFunction(() => {
      const rows = document.querySelectorAll('[data-testid="fp-row"]');
      return rows.length > 0 && !document.querySelector('[data-testid="fp-row"][data-status="hashing"], [data-testid="fp-row"][data-status="pending"]');
    }, null, { timeout: 15000 });

  await step('editor: problems, formatting, status bar, open file (Ctrl+P)', async () => {
    await ep.goto(`${base}/?mock=1&fast=1`);
    await erow('left', 'Desktop').dblclick();
    await erow('left', 'servers.json').click();
    await ep.keyboard.press('F4');
    await ep.locator(activeCm).waitFor();
    const problems = ep.locator('[data-testid="editor-problems"]');
    // duplicate key (warning) and trailing comma (error)
    await ep.waitForFunction(() => /1\s*1/.test(document.querySelector('[data-testid="editor-problems"]')?.textContent ?? ''), null, { timeout: 5000 });
    await problems.click();
    const panel = await ep.locator('.cm-panel-lint').innerText();
    assert(panel.includes('Duplicate key “web”') && panel.includes('Trailing comma'), `lint panel: ${panel}`);
    const status = await ep.locator('[data-testid="editor-status"]').innerText();
    assert(/JSON/.test(status) && /Spaces: 2/.test(status) && /LF/.test(status), `status bar: ${status}`);
    await snap(ep, 'editor-problems.png');
    await ep.keyboard.press('Escape');
    // Prettier keeps the file's quote style
    await ep.keyboard.press('Control+p');
    const of = edlg('Open file');
    await of.waitFor();
    await ep.locator('[data-testid="open-file-path"]').fill('/home/demo/projects/website/js/app');
    await of.locator('.of-item', { hasText: 'app.js' }).waitFor();
    await ep.keyboard.press('Enter');
    await of.waitFor({ state: 'detached' });
    await ep.locator('.editor-tab.on', { hasText: 'app.js' }).waitFor();
    await ep.locator('[data-testid="editor-language"]', { hasText: 'JavaScript' }).waitFor();
    await ep.locator(activeCm).click();
    await ep.keyboard.press('Control+End');
    await ep.keyboard.type("\nconst  extra={a:'b'}");
    await ep.keyboard.press('Shift+Alt+F');
    await ep.locator('.toast', { hasText: 'Formatted with Prettier' }).waitFor();
    const text = await ep.locator(activeCm).innerText();
    assert(text.includes("const extra = { a: 'b' };"), `formatted text: ${text.slice(-120)}`);
    await ep.locator('[data-testid="editor-changes"]').click();
    await ep.locator('[data-testid="editor"] .cm-changedLine').first().waitFor();
    await snap(ep, 'editor-changes.png');
    // language picker
    await ep.locator('[data-testid="editor-language"]').click();
    await ep.locator('[data-testid="lang-picker"] input').fill('typescr');
    await ep.keyboard.press('Enter');
    await ep.locator('[data-testid="editor-language"]', { hasText: 'TypeScript' }).waitFor();
  });

  await step('fingerprints: compare source and target, diff, copy only changed', async () => {
    await ep.keyboard.press('Escape');
    await ep.locator('[data-testid="editor"]').waitFor({ state: 'detached' });
    await ep.locator('[data-testid="tb-new-session"]').click();
    await edlg('Site Manager').locator('[data-testid="site-web-01"]').click();
    await edlg('Site Manager').locator('[data-testid="site-login"]').click();
    await edlg('Unknown host key').locator('[data-testid="prompt-accept-save"]').click();
    await erow('right', 'about.html').waitFor();
    // the site's local directory opens in the left panel
    await erow('left', 'index.html').waitFor();
    await erow('left', 'index.html').click();
    await ep.keyboard.press('Control+a');
    await ep.keyboard.press('Control+k');
    const fp = edlg('Fingerprints');
    await fp.waitFor();
    await settled();
    const states = await fp.locator('[data-testid="fp-row"]').evaluateAll((els) => Object.fromEntries(els.map((e) => [e.children[1].textContent, e.dataset.status])));
    assert(states['js/app.js'] === 'identical' && states['css/style.css'] === 'different' && states['index.html'] === 'sizeDiffers' && states['contact.html'] === 'new', JSON.stringify(states));
    await snap(ep, 'fingerprints.png');
    await fp.locator('[data-testid="fp-row"][data-status="different"] [data-testid="fp-diff"]').click();
    const diff = ep.locator('.diff-dialog');
    await diff.locator('[data-testid="diff-view"] .cm-editor').first().waitFor();
    assert((await diff.locator('.dlg-head').innerText()).includes('1 change'), 'diff header');
    await snap(ep, 'diff.png');
    await diff.locator('.dlg-foot-buttons button').click();
    await fp.locator('[data-testid="fp-copy-changed"]').click();
    await fp.waitFor({ state: 'detached' });
    await ep.locator('[data-testid="job"][data-state="completed"]').first().waitFor({ timeout: 15000 });
    await ep.keyboard.press('Control+k');
    await fp.waitFor();
    await settled();
    await fp.locator('[data-testid="fp-summary"]', { hasText: 'All files are identical' }).waitFor();
    await fp.locator('.dlg-close').click();
  });

  await step('copy dialog and overwrite question compare fingerprints', async () => {
    await erow('left', 'about.html').click();
    await ep.keyboard.press('F5');
    const cd = edlg('Copy');
    await cd.waitFor();
    await cd.locator('[data-testid="copy-fingerprints"]').click();
    const fp = edlg('Fingerprints');
    await fp.waitFor();
    await settled();
    assert((await fp.locator('[data-testid="fp-copy-changed"]').innerText()).includes('Nothing to copy'), 'nothing to copy expected');
    await fp.locator('.dlg-close').click();
    await cd.locator('button[type=submit]').click();
    const cf = ep.locator('.conflict-dialog');
    await cf.waitFor();
    await cf.locator('[data-testid="conflict-fp-run"]').click();
    await cf.locator('[data-testid="conflict-fp"]', { hasText: 'Both files have the same content' }).waitFor();
    await cf.locator('[data-testid="conflict-skip"]').click();
    await cf.waitFor({ state: 'detached' });
  });
  await ectx.close();
}

{
  const vctx = await browser.newContext({ viewport: { width: 1200, height: 760 }, locale: 'en-US' });
  const vp = await vctx.newPage();
  watch(vp, 'vault');
  await step('locked vault is unlocked on startup; browser upload (web mode)', async () => {
    await vp.goto(`${base}/?mock=1&fast=1&locked=1&mode=web`);
    const vault = vp.locator('.dlg').filter({ has: vp.locator('h2', { hasText: 'Unlock the credential vault' }) });
    await vault.waitFor();
    await vp.locator('[data-testid="vault-password"]').fill('demo');
    await vp.keyboard.press('Enter');
    await vault.waitFor({ state: 'detached' });
    const [chooser] = await Promise.all([vp.waitForEvent('filechooser'), vp.locator('[data-testid="tb-upload"]').click()]);
    await chooser.setFiles([{ name: 'smoke-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('uploaded by the smoke test\n') }]);
    await vp.locator('[data-testid="table-left"] .ft-row[data-name="smoke-upload.txt"]').waitFor({ timeout: 5000 });
    await vp.locator('[data-testid="job"][data-state="completed"]').first().waitFor();
  });
  await vctx.close();
}

const lctx = await browser.newContext({ viewport: { width: 1100, height: 720 }, colorScheme: 'dark', locale: 'en-US' });
const lpage = await lctx.newPage();
watch(lpage, 'login');
await step('web mode login screen', async () => {
  await lpage.goto(`${base}/?mock=1&fast=1&mode=web&login=1`);
  await lpage.locator('[data-testid="login-password"]').waitFor();
  await snap(lpage, 'login.png');
  await lpage.locator('[data-testid="login-password"]').fill('wrong');
  await lpage.keyboard.press('Enter');
  await lpage.locator('.login-card .err').waitFor();
  await lpage.locator('[data-testid="login-password"]').fill('demo');
  await lpage.keyboard.press('Enter');
  await lpage.locator('[data-testid="panel-left"]').waitFor();
  await lpage.locator('[data-testid="tb-upload"]').waitFor();
});
await lctx.close();

const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light', locale: 'en-US' });
const mpage = await mobile.newPage();
watch(mpage, 'mobile');
await step('mobile viewport: one panel with switcher', async () => {
  await mpage.goto(`${base}/?mock=1&fast=1&mode=web`);
  await mpage.locator('.panel-switcher').waitFor();
  const visible = await mpage.locator('[data-testid^="panel-"]:visible').count();
  assert(visible === 1, `expected one visible panel, got ${visible}`);
  await mpage.locator('[data-testid="table-left"] .ft-row[data-name="Documents"]').waitFor();
  await snap(mpage, 'mobile.png');
  await mpage.locator('[data-testid="switch-right"]').click();
  await mpage.locator('[data-testid="panel-right"]').waitFor({ state: 'visible' });
  assert(await mpage.locator('[data-testid="panel-left"]').isHidden(), 'left panel should be hidden');
});
await mobile.close();

await browser.close();
if (server) server.kill();

if (pageErrors.length) {
  failed++;
  console.log('\nPage errors:\n  ' + pageErrors.join('\n  '));
}
console.log(`\n${failed ? `✘ ${failed} problem(s)` : '✔ all smoke checks passed'} — screenshots in ${shots}`);
process.exit(failed ? 1 : 0);
