// What kind of text a file holds: line endings, indentation, byte order mark and – when the
// file name says nothing – the language, guessed from the content (shebang, modelines, markers).

export type Eol = '\n' | '\r\n';

export interface IndentStyle {
  tabs: boolean;
  /** Width of one indentation level (spaces) or of a tab. */
  size: number;
}

const BOM = '\ufeff';

export function splitBom(text: string): { text: string; bom: boolean } {
  return text.startsWith(BOM) ? { text: text.slice(1), bom: true } : { text, bom: false };
}

export function withBom(text: string, bom: boolean): string {
  return bom ? BOM + text : text;
}

/** The line ending most lines use; `mixed` when both occur. */
export function detectEol(text: string): { eol: Eol; mixed: boolean } {
  let crlf = 0;
  let lf = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++;
    else lf++;
  }
  return { eol: crlf > lf ? '\r\n' : '\n', mixed: crlf > 0 && lf > 0 };
}

/** Convert the editor's '\n' text to the file's line ending. */
export function applyEol(text: string, eol: Eol): string {
  return eol === '\n' ? text : text.replace(/\r?\n/g, eol);
}

/**
 * Indentation of the file: tabs or spaces, and the step between indentation levels
 * (the most common increase from one indented line to the next).
 */
export function detectIndent(text: string, fallback: IndentStyle): IndentStyle {
  let tabLines = 0;
  let spaceLines = 0;
  const steps = new Map<number, number>();
  let prev = 0;
  let seen = 0;
  for (const line of text.split('\n', 20000)) {
    if (!line.trim()) continue;
    const m = /^[ \t]*/.exec(line)![0];
    if (m.startsWith('\t')) {
      tabLines++;
      prev = 0;
      continue;
    }
    const width = m.length;
    // ' * ' continuation lines of block comments are not indentation
    if (width > 0 && /^\s*\*/.test(line) && width % 2 === 1) continue;
    if (width > 0) spaceLines++;
    const d = width - prev;
    if (d >= 2 && d <= 8) steps.set(d, (steps.get(d) ?? 0) + 1);
    prev = width;
    if (++seen > 5000) break;
  }
  if (tabLines === 0 && spaceLines === 0) return fallback;
  if (tabLines > spaceLines) return { tabs: true, size: fallback.size };
  let best = 0;
  let bestN = 0;
  for (const [step, n] of steps) {
    if (n > bestN || (n === bestN && step < best)) {
      best = step;
      bestN = n;
    }
  }
  return { tabs: false, size: best || fallback.size };
}

/**
 * Keep the file's own conventions where Prettier has an option for them: quote style and
 * semicolons. Strings inside comments are counted too; that is close enough.
 */
export function detectCodeStyle(text: string): { singleQuote: boolean; semi: boolean } {
  const sample = text.length > 200_000 ? text.slice(0, 200_000) : text;
  const single = sample.match(/'(?:[^'\\\n]|\\.)*'/g)?.length ?? 0;
  const double = sample.match(/"(?:[^"\\\n]|\\.)*"/g)?.length ?? 0;
  const lines = sample.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//') && !l.startsWith('*') && !l.startsWith('/*'));
  const withSemi = lines.filter((l) => l.endsWith(';')).length;
  return { singleQuote: single > double, semi: withSemi > 0 || lines.length < 5 };
}

// ---------------------------------------------------------------- language guessing

/** File names whose extension says nothing (or the wrong thing). Values are language names. */
const BY_NAME: [RegExp, string][] = [
  [/^(Containerfile|Dockerfile(\..+)?|.+\.dockerfile)$/i, 'Dockerfile'],
  [/^(\.(bash|zsh|ksh)(rc|_profile|_login|_logout|env)|\.profile|\.zprofile|\.zlogin|\.xprofile|\.xinitrc|\.envrc|.+\.(zsh|command|bats))$/, 'Shell'],
  [/^(Vagrantfile|Podfile|Brewfile|Guardfile|Fastfile|Capfile|.+\.(gemspec|rake|ru))$/, 'Ruby'],
  [/^(Pipfile|Cargo\.lock|poetry\.lock|uv\.lock|pdm\.lock)$/, 'TOML'],
  [/^(\.(babelrc|eslintrc|prettierrc|swcrc|jshintrc|stylelintrc)|.+\.(jsonc|json5|webmanifest|ipynb|geojson|har|code-workspace))$/i, 'JSON'],
  [/^.+\.(xaml|csproj|vbproj|fsproj|vcxproj|props|targets|plist|xlf|xliff|resx|nuspec|kml|gpx|rss|atom|xsl|xslt|wsdl|config|manifest|storyboard|xib|ui|glade|qrc|svgz)$/i, 'XML'],
  [/^.+\.(svelte|astro|xhtml|shtml)$/i, 'HTML'],
  [/^.+\.(mdx|markdown|mdown|rmd)$/i, 'Markdown'],
  [/^.+\.(cfg|conf|cnf|service|socket|timer|mount|automount|path|target|slice|network|netdev|link|desktop|editorconfig|gitconfig|gitmodules|npmrc|yarnrc|pypirc|env|env\..+)$/i, 'Properties files'],
  [/^(\.(editorconfig|gitconfig|gitmodules|npmrc|yarnrc|pypirc|pylintrc|flake8|coveragerc|env)|\.env\..+|.+\.env|my\.cnf|php\.ini|tox\.ini|setup\.cfg)$/i, 'Properties files'],
  [/^(\.gitlab-ci\.yml|\.clang-format|\.clang-tidy|\.yamllint|.+\.(sls|yaml\.j2|yml\.j2|kubeconfig))$/i, 'YAML'],
  [/^(nginx\.conf|.+\.nginx|.+\.nginxconf)$/i, 'Nginx'],
  [/^(Jenkinsfile|.+\.jenkinsfile)$/i, 'Groovy'],
  [/^(CMakeLists\.txt|.+\.cmake)$/i, 'CMake'],
  [/^(go\.mod|go\.sum|go\.work)$/i, 'Go'],
];

const SHEBANG: [RegExp, string][] = [
  [/\b(ba|z|k|da|a|fi)?sh\b/, 'Shell'],
  [/\bpython[\d.]*\b|\bpypy\d?\b/, 'Python'],
  [/\b(node|nodejs|deno|bun|zx)\b/, 'JavaScript'],
  [/\b(ts-node|tsx)\b/, 'TypeScript'],
  [/\bruby\b/, 'Ruby'],
  [/\bperl\d?\b/, 'Perl'],
  [/\bphp\b/, 'PHP'],
  [/\blua(jit)?\b/, 'Lua'],
  [/\bRscript\b/, 'R'],
  [/\bpwsh\b|\bpowershell\b/i, 'PowerShell'],
  [/\b(tclsh|wish|expect)\b/, 'Tcl'],
  [/\bgroovy\b/, 'Groovy'],
  [/\bjulia\b/, 'Julia'],
  [/\b(rust-script|cargo)\b/, 'Rust'],
];

/** Language names that differ from CodeMirror's names in modelines (`vim: ft=sh`). */
const ALIASES: Record<string, string> = {
  sh: 'Shell', bash: 'Shell', zsh: 'Shell', py: 'Python', js: 'JavaScript', ts: 'TypeScript', yml: 'YAML', rs: 'Rust',
  dosini: 'Properties files', ini: 'Properties files', conf: 'Properties files', cfg: 'Properties files', make: '', text: '', md: 'Markdown',
  dockerfile: 'Dockerfile', xml: 'XML', html: 'HTML', json: 'JSON', toml: 'TOML', sql: 'SQL', nginx: 'Nginx', perl: 'Perl', ruby: 'Ruby',
};

function firstLines(text: string, n: number): string[] {
  const out: string[] = [];
  let pos = 0;
  while (out.length < n && pos < text.length && pos < 64 * 1024) {
    let end = text.indexOf('\n', pos);
    if (end === -1) end = text.length;
    out.push(text.slice(pos, end).replace(/\r$/, ''));
    pos = end + 1;
  }
  return out;
}

/** A language from the file name alone, for names CodeMirror does not know. */
export function languageFromName(fileName: string): string | null {
  for (const [re, lang] of BY_NAME) if (re.test(fileName)) return lang;
  return null;
}

/**
 * A language guessed from the content. Returns a language name or an alias (to be looked
 * up with `LanguageDescription.matchLanguageName`), or null for plain text.
 */
export function languageFromContent(text: string): string | null {
  const lines = firstLines(text, 40);
  const head = lines.join('\n');
  const first = lines[0] ?? '';
  if (first.startsWith('#!')) {
    const sb = first.replace(/^#!\s*(\S*\/)?(env\s+(-S\s+)?)?/, '');
    for (const [re, lang] of SHEBANG) if (re.test(sb)) return lang;
  }
  // vim / emacs modelines in the first or last lines
  const tail = text.length > 4000 ? text.slice(-2000) : '';
  const ml =
    /(?:vim?|ex):.*?\b(?:ft|filetype|syntax)=([\w+-]+)/.exec(head + '\n' + tail) ?? /-\*-.*?\bmode:\s*([\w+-]+).*?-\*-/.exec(head) ?? /-\*-\s*([\w+-]+)\s*-\*-/.exec(first);
  if (ml) {
    const name = ml[1].toLowerCase();
    if (name in ALIASES) return ALIASES[name] || null;
    return name;
  }
  const trimmed = head.trimStart();
  if (/^<\?xml\b/.test(trimmed) || /^<svg\b/i.test(trimmed)) return 'XML';
  if (/^<!doctype\s+html|^<html[\s>]/i.test(trimmed)) return 'HTML';
  if (/^<\?php\b/.test(trimmed)) return 'PHP';
  if (/^(diff --git |--- \S.*\n\+\+\+ \S|Index: \S.*\n={10})/m.test(head)) return 'diff';
  if (/^(%YAML|---\s*$)/.test(trimmed)) return 'YAML';
  if (/^[{[]/.test(trimmed) && text.length < 4 * 1024 * 1024) {
    try {
      JSON.parse(text);
      return 'JSON';
    } catch {
      /* not JSON */
    }
  }
  const code = lines.filter((l) => l.trim() && !/^\s*#/.test(l));
  if (code.length && /^FROM\s+\S+/i.test(code[0]) && code.some((l) => /^(RUN|COPY|CMD|ENTRYPOINT|WORKDIR|ENV|ARG)\s/i.test(l))) return 'Dockerfile';
  if (/^\s*(server|http|events|upstream|location)\s*[^{;]*\{/m.test(head) && /;\s*$/m.test(head)) return 'Nginx';
  const meaningful = lines.filter((l) => l.trim() && !/^\s*[#;]/.test(l));
  if (meaningful.length >= 2 && /^\s*\[[^\]]+\]\s*$/.test(meaningful[0]) && meaningful.slice(1, 6).every((l) => /^\s*(\[[^\]]+\]|[\w.\-/ ]+\s*[=:])/.test(l))) {
    return 'Properties files';
  }
  return null;
}
