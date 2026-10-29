#!/usr/bin/env node
// Regenerates the screenshots used by README.md and docs/ from the mock backend (?mock=1).
//
//   node tests/docs-screenshots.mjs            builds if needed, starts `vite preview`, writes docs/src/images/*.png
//   BASE_URL=http://127.0.0.1:5173 node tests/docs-screenshots.mjs     use an already running dev/preview server
//   ONLY=hero,editor node tests/docs-screenshots.mjs                   only some shots
//
// The "Demo mode" label and toasts are hidden so the images show the UI as users see it.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, '..', 'docs', 'src', 'images');
mkdirSync(out, { recursive: true });

const PORT = Number(process.env.PORT ?? 4180);
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
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

const CLEAN_CSS = '.sb-demo { visibility: hidden; } .toasts { display: none !important; }';
const browser = await chromium.launch();
let failed = 0;

/** Opens a fresh page in the given theme with the demo backend loaded. */
async function open({ theme = 'light', width = 1440, height = 860, scale = 1, query = '' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme: theme, locale: 'en-US' });
  await ctx.addInitScript((t) => localStorage.setItem('rc.theme', t), theme);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`  page error: ${e.message}`));
  await page.goto(`${base}/?mock=1&fast=1${query}`);
  await page.addStyleTag({ content: CLEAN_CSS });
  await page.locator('[data-testid="panel-left"]').waitFor();
  const h = {
    page,
    ctx,
    row: (side, name) => page.locator(`[data-testid="table-${side}"] .ft-row[data-name="${name}"]`),
    dialog: (title) => page.locator('.dlg').filter({ has: page.locator('h2', { hasText: title }) }),
    snap: async (name) => {
      await page.mouse.move(0, height - 1);
      await page.waitForTimeout(250);
      await page.screenshot({ path: join(out, name), animations: 'disabled' });
      console.log(`  ✔ ${name}`);
    },
    /** Connects the right panel to the web-01 SFTP site (its local dir opens on the left). */
    connectWeb01: async () => {
      await page.locator('[data-testid="tb-new-session"]').click();
      const sm = h.dialog('Site Manager');
      await sm.locator('[data-testid="site-web-01"]').click();
      await sm.locator('[data-testid="site-login"]').click();
      await h.dialog('Unknown host key').locator('[data-testid="prompt-accept-save"]').click();
      await h.row('right', 'old-landing.html').waitFor();
      await h.row('left', 'index.html').waitFor();
    },
    sidebar: async (view) => {
      await page.locator(`[data-testid="tb-${view}"]`).click();
      await page.locator(`[data-testid="${view}"]`).waitFor();
    },
    terminal: async (commands) => {
      await page.locator('[data-testid="tb-terminal"]').click();
      const term = page.locator('.term-pane:not(.hidden) .xterm');
      await term.waitFor({ timeout: 10000 });
      await page.waitForTimeout(400);
      await term.click();
      for (const c of commands) {
        await page.keyboard.type(c);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(250);
      }
    },
  };
  return h;
}

async function shot(name, fn) {
  if (only && !only.has(name)) return;
  try {
    await fn();
  } catch (e) {
    failed++;
    console.log(`  ✘ ${name}: ${e.message.split('\n')[0]}`);
  }
}

try {
  // Hero: both panels, a connected SFTP session, the Nearby sidebar and a terminal.
  for (const theme of ['light', 'dark']) {
    await shot('hero', async () => {
      const h = await open({ theme, scale: 2 });
      await h.connectWeb01();
      await h.sidebar('nearby');
      await h.row('right', 'index.html').click();
      await h.terminal(['uptime']);
      await h.row('right', 'index.html').click();
      await h.snap(`hero-${theme}.png`);
      await h.ctx.close();
    });
  }

  await shot('site-manager', async () => {
    const h = await open();
    await h.page.locator('[data-testid="tb-new-session"]').click();
    const sm = h.dialog('Site Manager');
    await sm.locator('[data-testid="site-web-01"]').click();
    await sm.locator('#site-host').waitFor();
    await h.snap('site-manager.png');
    await h.ctx.close();
  });

  await shot('host-key', async () => {
    const h = await open();
    await h.page.locator('[data-testid="tb-new-session"]').click();
    const sm = h.dialog('Site Manager');
    await sm.locator('[data-testid="site-web-01"]').click();
    await sm.locator('[data-testid="site-login"]').click();
    await h.dialog('Unknown host key').waitFor();
    await h.snap('host-key-prompt.png');
    await h.ctx.close();
  });

  await shot('transfers', async () => {
    const h = await open();
    await h.connectWeb01();
    await h.row('left', 'index.html').click();
    await h.row('left', 'about.html').click({ modifiers: ['Control'] });
    await h.row('left', 'contact.html').click({ modifiers: ['Control'] });
    await h.page.keyboard.press('F5');
    const dlg = h.dialog('Copy');
    await dlg.waitFor();
    await dlg.locator('.collapsible-head').click();
    await dlg.locator('.topts').waitFor();
    await h.snap('copy-dialog.png');
    await dlg.locator('button[type=submit]').click();
    const conflict = h.dialog('File already exists');
    await conflict.waitFor({ timeout: 10000 });
    await h.snap('conflict.png');
    await h.ctx.close();
  });

  await shot('fingerprints', async () => {
    const h = await open();
    await h.connectWeb01();
    await h.row('left', 'index.html').click();
    await h.page.keyboard.press('Control+a');
    await h.page.keyboard.press('Control+k');
    const fp = h.dialog('Fingerprints');
    await fp.waitFor();
    await h.page.waitForFunction(() => {
      const rows = document.querySelectorAll('[data-testid="fp-row"]');
      return rows.length > 0 && !document.querySelector('[data-testid="fp-row"][data-status="hashing"], [data-testid="fp-row"][data-status="pending"]');
    }, null, { timeout: 15000 });
    await h.snap('fingerprints.png');
    await fp.locator('[data-testid="fp-row"][data-status="different"] [data-testid="fp-diff"]').click();
    await h.page.locator('.diff-dialog [data-testid="diff-view"] .cm-editor').first().waitFor();
    await h.snap('diff.png');
    await h.ctx.close();
  });

  await shot('sync', async () => {
    const h = await open();
    await h.connectWeb01();
    await h.page.locator('[data-testid="tb-sync"]').click();
    const sd = h.dialog('Synchronize');
    await sd.waitFor();
    await h.snap('sync-dialog.png');
    await sd.locator('button[type=submit]').click();
    await h.dialog('Synchronization checklist').waitFor({ timeout: 10000 });
    await h.snap('sync-checklist.png');
    await h.ctx.close();
  });

  await shot('properties', async () => {
    const h = await open();
    await h.connectWeb01();
    await h.row('right', 'index.html').click();
    await h.page.keyboard.press('Alt+Enter');
    await h.dialog('Properties').locator('.perm-grid').waitFor();
    await h.snap('properties.png');
    await h.ctx.close();
  });

  await shot('editor', async () => {
    const h = await open({ theme: 'dark', width: 1100, height: 400 });
    await h.row('left', 'Desktop').dblclick();
    await h.row('left', 'servers.json').click();
    await h.page.keyboard.press('F4');
    await h.page.locator('[data-testid="editor"] .cm-content').waitFor();
    await h.page.waitForFunction(() => /1\s*1/.test(document.querySelector('[data-testid="editor-problems"]')?.textContent ?? ''), null, { timeout: 5000 });
    await h.page.locator('[data-testid="editor-problems"]').click();
    await h.page.locator('.cm-panel-lint').waitFor();
    await h.snap('editor.png');
    await h.ctx.close();
  });

  // Full-window editor for the README gallery: several tabs and a CSS syntax error.
  await shot('editor-full', async () => {
    const h = await open({ theme: 'dark' });
    for (const file of ['index.html', 'js/app.js', 'css/style.css']) {
      await h.page.keyboard.press('Control+p');
      const of = h.dialog('Open file');
      await of.waitFor();
      await h.page.locator('[data-testid="open-file-path"]').fill(`/home/demo/projects/website/${file}`);
      await h.page.keyboard.press('Enter');
      await of.waitFor({ state: 'detached' });
      await h.page.locator('.editor-tab.on', { hasText: file.split('/').pop() }).waitFor();
    }
    const cm = h.page.locator('[data-testid="editor"] .cm-wrap:not(.cm-hidden) .cm-content');
    await cm.click();
    await h.page.keyboard.press('Control+End');
    // The editor auto-indents and closes the brace; the missing colon is the error.
    await h.page.keyboard.type('\n.card {\npadding: 1rem;\nborder-radius 8px;');
    await h.page.waitForFunction(() => /[1-9]/.test(document.querySelector('[data-testid="editor-problems"]')?.textContent ?? ''), null, { timeout: 5000 });
    await h.page.locator('[data-testid="editor-problems"]').click();
    await h.page.locator('.cm-panel-lint').waitFor();
    await h.snap('editor-full.png');
    await h.ctx.close();
  });

  await shot('editor-changes', async () => {
    const h = await open({ width: 1100, height: 440 });
    await h.page.keyboard.press('Control+p');
    const of = h.dialog('Open file');
    await of.waitFor();
    await h.page.locator('[data-testid="open-file-path"]').fill('/home/demo/projects/website/js/app');
    await of.locator('.of-item', { hasText: 'app.js' }).waitFor();
    await h.page.keyboard.press('Enter');
    await h.page.locator('.editor-tab.on', { hasText: 'app.js' }).waitFor();
    const cm = h.page.locator('[data-testid="editor"] .cm-wrap:not(.cm-hidden) .cm-content');
    await cm.click();
    await h.page.keyboard.press('Control+End');
    await h.page.keyboard.type("\nconst  extra={a:'b'}");
    await h.page.keyboard.press('Shift+Alt+F');
    await h.page.waitForTimeout(500);
    await h.page.locator('[data-testid="editor-changes"]').click();
    await h.page.locator('[data-testid="editor"] .cm-changedLine').first().waitFor();
    await h.snap('editor-changes.png');
    await h.ctx.close();
  });

  await shot('explorer', async () => {
    const h = await open();
    await h.sidebar('explorer');
    const xp = h.page.locator('[data-testid="explorer"]');
    const target = (id) => xp.locator(`[data-testid="xp-target"][data-target="${id}"]`);
    await target('ssh:build-box').click();
    await h.dialog('Unknown host key').locator('[data-testid="prompt-accept-once"]').click();
    const entry = (path) => xp.locator(`[data-testid="xp-entry"][data-path="${path}"]`);
    await entry('/home/ci/app').click();
    await entry('/home/ci/app/docker-compose.yml').click();
    await xp.locator('[data-testid="xp-preview"] pre', { hasText: 'services:' }).waitFor();
    await h.snap('remote-explorer.png');
    await h.ctx.close();
  });

  await shot('nearby', async () => {
    const h = await open({ theme: 'dark' });
    await h.sidebar('nearby');
    await h.page.locator('[data-testid="peer"]').first().waitFor();
    await h.snap('nearby.png');
    await h.ctx.close();
  });

  await shot('share', async () => {
    const h = await open();
    await h.sidebar('nearby');
    await h.page.locator('[data-testid="share-open"]').click();
    const dlg = h.dialog('Share this instance');
    await dlg.locator('[data-testid="share-toggle"]').click();
    await dlg.getByText('The web UI is running').waitFor();
    await h.snap('share.png');
    await h.ctx.close();
  });

  await shot('terminal', async () => {
    const h = await open({ theme: 'dark' });
    await h.connectWeb01();
    await h.row('right', 'index.html').click();
    await h.terminal(['uname -a', 'df -h', 'ls']);
    await h.snap('terminal.png');
    await h.ctx.close();
  });

  await shot('login', async () => {
    const h0 = await browser.newContext({ viewport: { width: 1100, height: 720 }, colorScheme: 'dark', locale: 'en-US' });
    const p = await h0.newPage();
    await p.goto(`${base}/?mock=1&fast=1&mode=web&login=1`);
    await p.locator('[data-testid="login-password"]').waitFor();
    await p.waitForTimeout(250);
    await p.screenshot({ path: join(out, 'web-login.png'), animations: 'disabled' });
    console.log('  ✔ web-login.png');
    await h0.close();
  });

  await shot('web', async () => {
    const h = await open({ query: '&mode=web' });
    await h.connectWeb01();
    await h.snap('web-mode.png');
    await h.ctx.close();
  });

  await shot('mobile', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light', locale: 'en-US' });
    const p = await ctx.newPage();
    await p.goto(`${base}/?mock=1&fast=1&mode=web`);
    await p.addStyleTag({ content: CLEAN_CSS });
    await p.locator('[data-testid="table-left"] .ft-row[data-name="Documents"]').waitFor();
    await p.waitForTimeout(250);
    await p.screenshot({ path: join(out, 'web-mobile.png'), animations: 'disabled' });
    console.log('  ✔ web-mobile.png');
    await ctx.close();
  });
} finally {
  await browser.close();
  if (server) server.kill();
}
process.exit(failed ? 1 : 0);
