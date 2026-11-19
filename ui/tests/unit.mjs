#!/usr/bin/env node
// Unit tests for the editor's pure helpers (language/indent/line-ending detection, the JSON
// checker, the XML formatter) and the Prettier/SQL formatting they feed. Loads the TypeScript
// sources through Vite, so no extra test framework is needed:   node tests/unit.mjs
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const vite = await createServer({ root, logLevel: 'error', server: { middlewareMode: true, hmr: false }, appType: 'custom', optimizeDeps: { noDiscovery: true } });
const load = (p) => vite.ssrLoadModule(p);

let failed = 0;
let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✘ ${name}: ${e.message}`);
  }
}
function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what} expected ${b}, got ${a}`);
}

try {
  const detect = await load('/src/lib/editor/detect.ts');
  const json = await load('/src/lib/editor/jsonCheck.ts');
  const xml = await load('/src/lib/editor/xmlFormat.ts');
  const langs = await load('/src/lib/editor/languages.ts');

  await test('line endings, BOM', () => {
    eq(detect.detectEol('a\r\nb\r\nc\n'), { eol: '\r\n', mixed: true });
    eq(detect.detectEol('a\nb\n'), { eol: '\n', mixed: false });
    eq(detect.applyEol('a\nb\n', '\r\n'), 'a\r\nb\r\n');
    eq(detect.splitBom('\ufeffx'), { text: 'x', bom: true });
  });

  await test('indentation', () => {
    const fb = { tabs: false, size: 4 };
    eq(detect.detectIndent('a:\n  b:\n    c: 1\n  d: 2\n', fb), { tabs: false, size: 2 });
    eq(detect.detectIndent('fn x() {\n\tlet a = 1;\n\tif a {\n\t\tb();\n\t}\n}\n', fb), { tabs: true, size: 4 });
    eq(detect.detectIndent('/**\n * doc\n */\nfunction f() {\n    return 1;\n}\n', fb), { tabs: false, size: 4 });
    eq(detect.detectIndent('plain text\n', fb), fb);
  });

  await test('code style for Prettier', () => {
    eq(detect.detectCodeStyle("import x from 'y';\nconst a = 'b';\n"), { singleQuote: true, semi: true });
    eq(detect.detectCodeStyle('const a = "b"\nconst c = "d"\nlet e = 1\nlet f = 2\nlet g = 3\n'), { singleQuote: false, semi: false });
  });

  await test('language from file name and content', () => {
    const name = (f, path = '', content = '') => langs.detectLanguage(f, path || `/x/${f}`, content)?.name ?? null;
    eq(name('main.rs'), 'Rust');
    eq(name('Dockerfile.prod'), 'Dockerfile');
    eq(name('Containerfile'), 'Dockerfile');
    eq(name('.bashrc'), 'Shell');
    eq(name('tsconfig.json'), 'JSON');
    eq(name('app.service'), 'Properties files');
    eq(name('setup.cfg'), 'Properties files');
    eq(name('nginx.conf'), 'Nginx');
    eq(name('default', '/etc/nginx/sites-available/default'), 'Nginx');
    eq(name('site.conf', '/srv/site.conf', 'server {\n  listen 80;\n}\n'), 'Nginx');
    eq(name('Cargo.lock'), 'TOML');
    eq(name('project.csproj'), 'XML');
    eq(name('run', '', '#!/usr/bin/env python3\nprint(1)\n'), 'Python');
    eq(name('hook', '', '#!/bin/bash\necho\n'), 'Shell');
    eq(name('cli', '', '#!/usr/bin/env -S node --no-warnings\n'), 'JavaScript');
    eq(name('data', '', '{"a": [1, 2]}'), 'JSON');
    eq(name('notes', '', '# vim: set ft=yaml :\na: 1\n'), 'YAML');
    eq(name('page', '', '<!DOCTYPE html>\n<html></html>'), 'HTML');
    eq(name('config', '', '[core]\n  editor = vim\n  bare = false\n'), 'Properties files');
    eq(name('README'), null);
  });

  await test('JSON checker: errors with positions', () => {
    const check = (t, o = { comments: false, trailingCommas: false }) => json.checkJson(t, o).map((p) => `${p.code}@${p.from}`);
    eq(check('{"a": 1, "b": [1, 2]}'), []);
    eq(check(''), []);
    eq(check('{"a": 1,}'), ['trailingComma@7']);
    eq(check('{"a": 1,}', { comments: true, trailingCommas: true }), []);
    eq(check('{"a": 1 "b": 2}'), ['expectedComma@8']);
    eq(check('{"a" 1}'), ['expectedColon@5']);
    eq(check('{a: 1}'), ['expectedKey@1']);
    eq(check('[1, 2'), ['unexpectedEnd@5']);
    eq(check('{"a": 01}'), ['badNumber@6']);
    eq(check('{"a": "x\\q"}'), ['badEscape@8']);
    eq(check('{"a": "line\nbreak"}'), ['unterminatedString@6']);
    eq(check('// c\n{}'), ['comment@0']);
    eq(check('// c\n{"x": /* y */ 1}', { comments: true, trailingCommas: false }), []);
    eq(check('{} {}'), ['extraContent@3']);
    eq(check('{"a": tru}'), ['unexpectedChar@6']);
    eq(check('{"a": 1, "b": {"a": 2}, "a": 3}'), ['duplicateKey@24']);
    eq(json.isJsonWithComments('tsconfig.app.json'), true);
    eq(json.isJsonWithComments('package.json'), false);
  });

  await test('JSON key sorting', () => {
    eq(json.sortJsonKeys({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 3 } }), { a: { c: 3, d: [{ y: 2, z: 1 }] }, b: 1 });
  });

  await test('XML formatter', () => {
    const src = '<?xml version="1.0"?>\n<project   sdk="x"><!-- deps --><items><item  id="1">One</item><item id=\'2\'/></items><p xml:space="preserve">  keep  <b>me</b> </p><mixed>text <b>bold</b></mixed><empty>  </empty></project>';
    eq(
      xml.formatXml(src, '  '),
      '<?xml version="1.0"?>\n<project sdk="x">\n  <!-- deps -->\n  <items>\n    <item id="1">One</item>\n    <item id=\'2\'/>\n  </items>\n  <p xml:space="preserve">  keep  <b>me</b> </p>\n  <mixed>text <b>bold</b></mixed>\n  <empty></empty>\n</project>\n',
    );
    eq(xml.formatXml('<a><![CDATA[ x < y ]]></a>'), '<a><![CDATA[ x < y ]]></a>\n');
    eq(xml.formatXml('<!DOCTYPE note [<!ELEMENT note (#PCDATA)>]><note>x</note>'), '<!DOCTYPE note [<!ELEMENT note (#PCDATA)>]>\n<note>x</note>\n');
    for (const [bad, msg] of [['<a><b></a>', 'does not match'], ['<a>', 'not closed'], ['</a>', 'Unexpected closing tag'], ['<a x="1>', 'Unterminated']]) {
      let err = '';
      try {
        xml.formatXml(bad);
      } catch (e) {
        err = e.message;
      }
      if (!err.includes(msg)) throw new Error(`${bad}: expected error containing "${msg}", got "${err}"`);
    }
  });

  await test('Prettier formats with the file style', async () => {
    const { format } = await import('prettier/standalone');
    const plugins = [await import('prettier/plugins/babel'), await import('prettier/plugins/estree')];
    const src = "const a = {b:'c'}\nlet d = 'e'\nlet x = 1\nlet y = 2\nlet z = 3\n";
    const out = await format(src, { parser: 'babel', plugins, ...detect.detectCodeStyle(src) });
    eq(out, "const a = { b: 'c' }\nlet d = 'e'\nlet x = 1\nlet y = 2\nlet z = 3\n");
  });

  await test('paths: backslashes, drive roots', async () => {
    const P = await load('/src/lib/paths.ts');
    eq(P.join('/srv', 'a\\b.txt'), '/srv/a\\b.txt', 'POSIX names keep backslashes');
    eq(P.normalize('C:\\Users\\me'), 'C:/Users/me');
    eq(P.parent('C:/'), '/', 'drive root goes up to the drive list');
    eq(P.parent('C:/Users'), 'C:/');
    eq(P.parent('/'), null);
    eq(P.resolve('C:/Users', '..\\Windows'), 'C:/Windows');
  });

  await test('sizes round across unit boundaries', async () => {
    const f = await load('/src/lib/format.ts');
    f.setFormatLocale('en');
    eq(f.formatBytes(1023), '1023 B');
    eq(f.formatBytes(1536), '1.5 KB');
    eq(f.formatBytes(102349), '100 KB');
    eq(f.formatBytes(1048575), '1.0 MB');
    eq(f.formatBytes(5 * 1024 ** 3), '5.0 GB');
  });

  await test('SQL formatter', async () => {
    const m = await import('sql-formatter');
    const out = m.formatDialect('select a,b from t where x=1', { dialect: m.postgresql, keywordCase: 'preserve', tabWidth: 2 });
    eq(out, 'select\n  a,\n  b\nfrom\n  t\nwhere\n  x = 1');
  });

  await test('translations: same keys, placeholders and plural forms in every language', async () => {
    const { en } = await load('/src/i18n/en.ts');
    const { de } = await load('/src/i18n/de.ts');
    eq(Object.keys(de).sort(), Object.keys(en).sort(), 'keys');
    const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    const bad = [];
    for (const k of Object.keys(en)) {
      if (JSON.stringify(vars(en[k])) !== JSON.stringify(vars(de[k]))) bad.push(`${k}: {${vars(en[k])}} vs {${vars(de[k])}}`);
      if (en[k].includes('|') !== de[k].includes('|')) bad.push(`${k}: plural forms differ`);
      if (!de[k].trim()) bad.push(`${k}: empty`);
    }
    if (bad.length) throw new Error(bad.slice(0, 10).join('; '));
  });

  // ---------------------------------------------------------------- keyboard layouts
  const km = await load('/src/lib/keymaps.ts');
  const key = (k, mods = {}, code) => ({ key: k, code, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

  await test('keyboard layouts: Norton Commander is the default', () => {
    eq(km.DEFAULT_KEYMAP, 'norton');
    eq(km.keymapOf(undefined).id, 'norton');
    eq(km.keymapOf('nonsense').id, 'norton');
    eq(km.keymapOf('total').id, 'total');
  });

  await test('keyboard layouts: every combination is written the way comboOf produces it', () => {
    const bad = [];
    for (const id of km.KEYMAP_IDS) for (const c of Object.keys(km.KEYMAPS[id].bindings)) if (!km.isCanonical(c)) bad.push(`${id}: ${c}`);
    for (const id of km.KEYMAP_IDS) for (const c of km.KEYMAPS[id].extras) if (!(c in km.KEYMAPS[id].bindings)) bad.push(`${id}: extra ${c} not bound`);
    if (bad.length) throw new Error(bad.join(', '));
  });

  await test('keyboard layouts: Norton Commander key bar and Alt/Ctrl layers', () => {
    const b = km.KEYMAPS.norton.bindings;
    eq(km.KEY_BAR_KEYS.map((k) => b[k]), ['help', 'userMenu', 'view', 'edit', 'copy', 'move', 'mkdir', 'delete', 'menu', 'quit']);
    eq(['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7'].map((k) => b['Alt+' + k]), ['driveLeft', 'driveRight', 'viewExternal', 'editExternal', 'pack', 'unpack', 'find']);
    eq(['F3', 'F4', 'F5', 'F6'].map((k) => b['Ctrl+' + k]), ['sortName', 'sortExt', 'sortTime', 'sortSize']);
    eq([b['Shift+F4'], b['Ctrl+O'], b['Ctrl+U'], b['Ctrl+PageUp'], b['Ctrl+\\']], ['newFile', 'toggleTerminal', 'swapPanels', 'parentDir', 'root']);
    eq(km.KEYMAPS.norton.quickSearch, 'alt');
    eq(km.comboFor(km.KEYMAPS.norton, 'find'), 'Alt+F7', 'NC find');
    eq(km.comboFor(km.KEYMAPS.norton, 'rename'), 'Shift+F6', 'NC rename');
  });

  await test('keyboard layouts: Total Commander', () => {
    const b = km.KEYMAPS.total.bindings;
    eq(km.KEY_BAR_KEYS.map((k) => b[k]), ['help', 'refresh', 'view', 'edit', 'copy', 'move', 'mkdir', 'delete', 'menu', 'menu']);
    eq([b['Alt+F4'], b['Alt+F5'], b['Alt+F9'], b['Alt+F7'], b['Alt+ArrowDown']], ['quit', 'pack', 'unpack', 'find', 'dirHistory']);
    eq([b['Shift+F2'], b['Shift+F4'], b['Shift+F6'], b['Shift+Delete']], ['compareDirs', 'newFile', 'rename', 'deletePermanent']);
    eq([b['Ctrl+D'], b['Ctrl+S'], b['Ctrl+U'], b['Ctrl+F'], b['Ctrl+ArrowLeft'], b['Ctrl+Num+'], b['Ctrl+Num-']], ['hotlist', 'quickFilter', 'swapPanels', 'siteManager', 'toLeft', 'selectAll', 'selectNone']);
    eq(km.KEYMAPS.total.quickSearch, 'ctrlAlt');
  });

  await test('keyboard layouts: "Rust Commander" keeps the layout of version 0.1', () => {
    const before = {
      F1: 'help', F2: 'rename', F3: 'view', F4: 'edit', 'Shift+F4': 'newFile', F5: 'copy', 'Shift+F5': 'copyQuick', F6: 'move', 'Shift+F6': 'moveQuick',
      F7: 'mkdir', F8: 'delete', Delete: 'delete', 'Shift+F8': 'deletePermanent', 'Shift+Delete': 'deletePermanent', 'Ctrl+Z': 'undo', 'Alt+Enter': 'properties',
      'Ctrl+R': 'refresh', F9: 'refresh', 'Ctrl+H': 'toggleHidden', 'Ctrl+N': 'siteManager', 'Ctrl+T': 'terminal', 'Ctrl+F': 'find', 'Ctrl+L': 'focusPath',
      'Ctrl+D': 'addBookmark', 'Ctrl+Shift+S': 'sync', 'Ctrl+B': 'sidebar', 'Ctrl+Shift+E': 'explorer', 'Ctrl+J': 'dock', 'Alt+ArrowLeft': 'back',
      'Alt+ArrowRight': 'forward', 'Ctrl+\\': 'root', 'Ctrl+Shift+C': 'copyPath', 'Ctrl+,': 'preferences', 'Ctrl+P': 'openFile', 'Ctrl+K': 'fingerprints', 'Ctrl+U': 'upload',
    };
    const b = km.KEYMAPS.rust.bindings;
    const diff = Object.entries(before).filter(([k, v]) => b[k] !== v).map(([k, v]) => `${k}: ${b[k]} instead of ${v}`);
    if (diff.length) throw new Error(diff.join(', '));
    eq(km.KEYMAPS.rust.quickSearch, null);
  });

  await test('keyboard layouts: help groups keys per command and marks additions', () => {
    const g = Object.fromEntries(km.groupedBindings(km.KEYMAPS.norton).map((x) => [x.cmd, x]));
    eq(g.delete.combos, ['F8', 'Delete']);
    eq(g.delete.extra, false, 'F8 is original');
    eq(g.find.combos, ['Alt+F7', 'Ctrl+F']);
    eq(g.undo.extra, true, 'undo is an addition');
    eq(km.groupedBindings(km.KEYMAPS.rust).some((x) => x.extra), false);
  });

  await test('key events: combination names and quick search', () => {
    eq(km.comboOf(key('s', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+S');
    eq(km.comboOf(key('k', { metaKey: true })), 'Ctrl+K');
    eq(km.comboOf(key('F7', { altKey: true })), 'Alt+F7');
    eq(km.comboOf(key('Del')), 'Delete');
    eq(km.comboOf(key('+', { ctrlKey: true }, 'NumpadAdd')), 'Ctrl+Num+');
    eq(km.comboOf(key('+', { ctrlKey: true }, 'Equal')), 'Ctrl++');
    eq(km.splitCombo('Ctrl++'), { mods: ['Ctrl'], key: '+' });
    eq(km.splitCombo('F5'), { mods: [], key: 'F5' });
    eq(km.isCanonical('Shift+Ctrl+A'), false);
    eq(km.isCanonical('Ctrl+a'), false);
    eq(km.quickSearchChar(key('d', { altKey: true }, 'KeyD'), 'alt'), 'd');
    eq(km.quickSearchChar(key('∂', { altKey: true }, 'KeyD'), 'alt'), 'd', 'macOS Option+D');
    eq(km.quickSearchChar(key('d', { altKey: true, ctrlKey: true }, 'KeyD'), 'alt'), null, 'Ctrl+Alt in NC');
    eq(km.quickSearchChar(key('m', { altKey: true, ctrlKey: true }, 'KeyM'), 'ctrlAlt'), 'm');
    eq(km.quickSearchChar(key('m', { altKey: true }, 'KeyM'), 'ctrlAlt'), null, 'Alt alone in TC');
    eq(km.quickSearchChar(key('m', {}, 'KeyM'), 'alt'), null, 'no modifier');
    eq(km.quickSearchChar(key('ArrowLeft', { altKey: true }, 'ArrowLeft'), 'alt'), null, 'not a letter');
    eq(km.keyBarLayer({ ctrl: false, alt: true, shift: false }), 'Alt+');
    eq(km.keyBarLayer({ ctrl: true, alt: false, shift: true }), 'Ctrl+Shift+');
  });

  // ------------------------------------------------------------ skins
  const color = await load('/src/lib/skins/color.ts');
  const tokens = await load('/src/lib/skins/tokens.ts');
  const engine = await load('/src/lib/skins/engine.ts');
  const { BUILTIN_SKINS } = await load('/src/skins/index.ts');
  const byId = new Map(BUILTIN_SKINS.map((s) => [s.id, s]));
  const lookup = (id) => byId.get(id);

  await test('skins: colors are parsed and normalized', () => {
    eq(color.normalizeColor('#ABC'), '#aabbcc');
    eq(color.normalizeColor('#11223380'), 'rgba(17, 34, 51, 0.502)');
    eq(color.normalizeColor('rgb(1, 2, 3)'), '#010203');
    eq(color.normalizeColor('rgb(1 2 3 / 50%)'), 'rgba(1, 2, 3, 0.5)');
    eq(color.normalizeColor('rgba(255,0,0,.25)'), 'rgba(255, 0, 0, 0.25)');
    eq(color.normalizeColor('hsl(120, 100%, 25%)'), '#008000');
    eq(color.normalizeColor(' white '), '#ffffff');
    eq(color.normalizeColor('transparent'), 'rgba(0, 0, 0, 0)');
    for (const bad of ['red', '#12', 'rgb(1,2)', 'url(x)', 'var(--x)', '#fff;}body{', 'expression(alert(1))']) eq(color.normalizeColor(bad), null, bad);
    eq(Math.round(color.contrast(color.parseColor('#000'), color.parseColor('#fff'))), 21);
    eq(color.toHex6('rgba(10, 20, 30, 0.5)'), '#0a141e');
  });

  await test('skins: validation keeps good values and reports bad ones', () => {
    const v = engine.validateSkin({
      $schema: 'x',
      id: 'ocean',
      name: 'Ocean',
      extends: 'nord',
      style: { radius: 99, density: 'huge', stripes: true, fontUi: 'Inter, sans-serif', fontMono: 'x;}body{color:red' },
      dark: { accent: '#0af', '--bg': '#001020', nope: '#fff', text: 'url(https://evil)', shadow: '0 1px 2px rgba(0,0,0,.3)', 'shadow-lg': 'url(x)' },
      light: 5,
      extra: true,
    });
    eq(v.errors, []);
    eq(v.skin.style, { radius: 16, stripes: true, fontUi: 'Inter, sans-serif' });
    eq(v.skin.dark, { accent: '#00aaff', bg: '#001020', shadow: '0 1px 2px rgba(0,0,0,.3)' });
    eq(v.skin.light, undefined);
    eq(v.warnings.length, 8, v.warnings.join(' | '));
    eq(engine.validateSkin({ id: '../x', name: 'x' }).skin, null);
    eq(engine.validateSkin({ id: 'x' }).errors.length, 1);
    eq(engine.validateSkin([]).skin, null);
  });

  await test('skins: derived tokens follow what a skin sets', () => {
    const def = lookup('default');
    const base = engine.resolveSkin(def, lookup, 'light');
    eq(base.tokens.accent, '#2563d9');
    eq(base.tokens['cursor-fg'], undefined, 'optional tokens stay unset');
    eq(base.vars['--radius'], '6px');
    eq(base.rowHeight, 22);
    const mine = { id: 'mine', name: 'Mine', light: { accent: '#ff0000', green: '#00aa00' } };
    const r = engine.resolveSkin(mine, lookup, 'light');
    eq(r.tokens.accent, '#ff0000');
    if (r.tokens['accent-hover'] === base.tokens['accent-hover']) throw new Error('accent-hover not derived');
    eq(r.tokens['fi-link'], '#ff0000', 'links follow the accent');
    eq(r.tokens.ok, '#00aa00', 'status follows the palette');
    eq(r.tokens['fi-script'], '#00aa00', 'file icons follow the palette');
    eq(r.tokens['term-green'], '#00aa00', 'terminal follows the palette');
    eq(r.tokens.text, base.tokens.text, 'unrelated tokens keep the default');
    eq(r.tokens['fi-dir'], base.tokens['fi-dir']);
    const user = engine.resolveSkin(def, lookup, 'dark', { accent: '#00ff00', density: 'compact', listFontSize: 15, stripes: true, radius: 0 });
    eq(user.tokens.accent, '#00ff00');
    eq(user.tokens['accent-fg'], '#111318', 'readable text on a light accent');
    eq(user.rowHeight, Math.round(15 * 1.5));
    eq(user.classes, ['rc-stripes']);
    eq([user.vars['--radius'], user.vars['--radius-panel']], ['0px', '0px']);
  });

  await test('skins: extends, variants and cycles', () => {
    const child = { id: 'child', name: 'Child', extends: 'retro-blue', style: { stripes: true } };
    eq(engine.variantsOf(child, lookup), ['dark'], 'inherits the variants of its base');
    const r = engine.resolveSkin(child, lookup, 'light');
    eq(r.scheme, 'dark', 'a dark-only skin stays dark');
    eq(r.tokens.surface, '#0000a8');
    eq(r.style.radius, 0);
    eq(r.style.stripes, true);
    const a = { id: 'a', name: 'A', extends: 'b', dark: { accent: '#111111' } };
    const b = { id: 'b', name: 'B', extends: 'a' };
    const cyc = new Map([['a', a], ['b', b], ['default', lookup('default')]]);
    eq(engine.chainOf(a, (id) => cyc.get(id)).map((s) => s.id), ['default', 'b', 'a']);
    eq(engine.resolveSkin(a, (id) => cyc.get(id), 'dark').tokens.accent, '#111111');
    eq(engine.resolveSkin({ id: 'lost', name: 'Lost', extends: 'missing' }, lookup, 'light').tokens.bg, engine.resolveSkin(lookup('default'), lookup, 'light').tokens.bg, 'unknown base');
  });

  await test('skins: built-in skins are valid, complete and readable', () => {
    const ids = BUILTIN_SKINS.map((s) => s.id);
    for (const id of ['default', 'ember', 'graphite', 'retro-blue', 'high-contrast', 'nord', 'solarized', 'catppuccin', 'gruvbox', 'dracula']) if (!ids.includes(id)) throw new Error(`missing ${id}`);
    const def = lookup('default');
    for (const scheme of ['light', 'dark']) {
      const missing = tokens.TOKENS.filter((t) => !t.optional && !(t.name in def[scheme])).map((t) => t.name);
      if (missing.length) throw new Error(`default ${scheme} lacks ${missing.join(', ')}`);
    }
    const low = [];
    for (const skin of BUILTIN_SKINS) {
      for (const scheme of engine.variantsOf(skin, lookup)) {
        const r = engine.resolveSkin(skin, lookup, scheme);
        for (const c of engine.contrastReport(r)) if (!c.ok) low.push(`${skin.id}/${scheme}: ${c.what} ${c.ratio}`);
      }
    }
    if (low.length) throw new Error(low.join('; '));
  });

  await test('skins: base.css matches the default skin, the schema matches the tokens', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(join(root, 'src/styles/base.css'), 'utf8');
    const block = (sel) => Object.fromEntries([...css.slice(css.indexOf(sel + ' {'), css.indexOf('}', css.indexOf(sel + ' {'))).matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
    const def = lookup('default');
    const diff = [];
    for (const [scheme, sel] of [['light', ':root'], ['dark', ":root[data-theme='dark']"]]) {
      for (const [k, v] of Object.entries(block(sel))) {
        if (!tokens.TOKEN_MAP.has(k)) continue;
        if (color.normalizeColor(v) !== null ? color.normalizeColor(v) !== def[scheme][k] : v !== def[scheme][k]) diff.push(`${scheme} ${k}: css ${v} ≠ skin ${def[scheme][k]}`);
      }
    }
    if (diff.length) throw new Error(diff.join('; '));
    const schema = JSON.parse(readFileSync(join(root, 'src/skins/skin.schema.json'), 'utf8'));
    eq(Object.keys(schema.$defs.variant.properties), tokens.TOKENS.map((t) => t.name), 'run: node scripts/skins.mjs schema');
  });

  await test('skins: every token is documented', async () => {
    const { readFileSync } = await import('node:fs');
    const doc = readFileSync(join(root, '..', 'docs', 'src', 'reference', 'skin-tokens.md'), 'utf8');
    const missing = tokens.TOKENS.filter((t) => !doc.includes('`' + t.name + '`')).map((t) => t.name);
    if (missing.length) throw new Error(`not in docs/src/reference/skin-tokens.md: ${missing.join(', ')}`);
  });
} finally {
  await vite.close();
}

console.log(failed ? `\n✘ ${failed} failed, ${passed} passed` : `\n✔ ${passed} unit tests passed`);
process.exit(failed ? 1 : 0);
