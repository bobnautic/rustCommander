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
} finally {
  await vite.close();
}

console.log(failed ? `\n✘ ${failed} failed, ${passed} passed` : `\n✔ ${passed} unit tests passed`);
process.exit(failed ? 1 : 0);
