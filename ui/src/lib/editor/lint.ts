// Problems shown in the editor: syntax errors from real parsers (Prettier's for JS/TS/CSS, the
// YAML and TOML libraries, our JSON checker, Lezer grammars for Python, Rust, Go, Java, XML and
// HTML) plus a few checks for every text file (merge conflict markers, mixed indentation,
// invisible characters).
import type { Diagnostic } from '@codemirror/lint';
import { ensureSyntaxTree } from '@codemirror/language';
import type { EditorView } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { tr } from '../../i18n';
import { checkJson, isJsonWithComments, type JsonProblem } from './jsonCheck';

const MAX_LINT = 2 * 1024 * 1024;
const MAX_DIAGNOSTICS = 300;

export interface LintContext {
  language: string | null;
  fileName: string;
  /** The file is indented with tabs (from detection or the user's choice). */
  tabs: boolean;
}

type Severity = Diagnostic['severity'];

function lineStart(text: string, line: number): number {
  let pos = 0;
  for (let l = 1; l < line; l++) {
    const nl = text.indexOf('\n', pos);
    if (nl === -1) return text.length;
    pos = nl + 1;
  }
  return pos;
}

/** Offset of a 1-based line and column. */
function offsetOf(text: string, line: number, column: number): number {
  const start = lineStart(text, line);
  const end = text.indexOf('\n', start);
  return Math.min(start + Math.max(0, column - 1), end === -1 ? text.length : end);
}

function diag(from: number, to: number, severity: Severity, message: string, source: string): Diagnostic {
  return { from, to: Math.max(from, to), severity, message, source };
}

// ---------------------------------------------------------------- generic checks

const INVISIBLE = /[\u200b\u200c\u200d\u2060\u00ad\u2028\u2029]|(?!^)\ufeff/g;

function hygiene(text: string, ctx: LintContext): Diagnostic[] {
  const out: Diagnostic[] = [];
  const conflicts = /^<{7}( |$)/m.test(text) && /^>{7}( |$)/m.test(text);
  const checkIndent = ctx.language !== 'YAML' && ctx.language !== 'Go' && !/^(GNU)?makefile$|\.mk$/i.test(ctx.fileName);
  const prose = ctx.language === null || ctx.language === 'Markdown' || ctx.language === 'HTML';
  let pos = 0;
  let indentHits = 0;
  for (const line of text.split('\n')) {
    const end = pos + line.length;
    if (conflicts && /^(<{7}|={7}|>{7}|\|{7})( |$)/.test(line)) {
      out.push(diag(pos, end, 'error', tr('lint.conflictMarker'), 'rc'));
    }
    if (checkIndent && indentHits < 50) {
      const ws = /^[ \t]*/.exec(line)![0];
      if (ws.includes(' \t')) {
        out.push(diag(pos, pos + ws.length, 'warning', tr('lint.mixedIndent'), 'rc'));
        indentHits++;
      } else if (!ctx.tabs && ws.startsWith('\t') && line.trim()) {
        out.push(diag(pos, pos + ws.length, 'info', tr('lint.tabInSpaces'), 'rc'));
        indentHits++;
      }
    }
    pos = end + 1;
  }
  if (ctx.language !== null) {
    for (const m of text.matchAll(INVISIBLE)) {
      out.push(diag(m.index!, m.index! + 1, 'warning', tr('lint.invisible', { code: `U+${m[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}` }), 'rc'));
      if (out.length > MAX_DIAGNOSTICS) break;
    }
    if (!prose) {
      for (const m of text.matchAll(/\u00a0/g)) {
        out.push(diag(m.index!, m.index! + 1, 'info', tr('lint.nbsp'), 'rc'));
        if (out.length > MAX_DIAGNOSTICS) break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- per language

function jsonMessage(p: JsonProblem): string {
  switch (p.code) {
    case 'unexpectedChar':
      return tr('lint.json.unexpectedChar', { char: p.detail });
    case 'expectedComma':
      return tr('lint.json.expectedComma', { close: p.detail });
    case 'duplicateKey':
      return tr('lint.json.duplicateKey', { key: p.detail });
    default:
      return tr(`lint.json.${p.code}`);
  }
}

function lintJson(text: string, ctx: LintContext): Diagnostic[] {
  if (/\.json5$/i.test(ctx.fileName)) return [];
  const lenient = isJsonWithComments(ctx.fileName);
  return checkJson(text, { comments: lenient, trailingCommas: lenient }).map((p) => diag(p.from, p.to, p.severity, jsonMessage(p), 'json'));
}

async function lintYaml(text: string): Promise<Diagnostic[]> {
  const { parseAllDocuments } = await import('yaml');
  const docs = parseAllDocuments(text, { prettyErrors: false, uniqueKeys: true });
  const out: Diagnostic[] = [];
  for (const d of docs) {
    for (const e of d.errors) out.push(diag(e.pos[0], e.pos[1], 'error', e.message, 'yaml'));
    // custom tags (!Ref, !vault, ...) are fine for the tools that read these files
    for (const w of d.warnings) if (w.code !== 'TAG_RESOLVE_FAILED') out.push(diag(w.pos[0], w.pos[1], 'warning', w.message, 'yaml'));
  }
  return out;
}

async function lintToml(text: string): Promise<Diagnostic[]> {
  const { parse, TomlError } = await import('smol-toml');
  try {
    parse(text);
    return [];
  } catch (e) {
    if (!(e instanceof TomlError)) return [];
    const at = offsetOf(text, e.line, e.column);
    const message = e.message.split('\n')[0].replace(/^Invalid TOML document:\s*/, '');
    return [diag(at, Math.min(at + 1, text.length), 'error', message.charAt(0).toUpperCase() + message.slice(1), 'toml')];
  }
}

const PRETTIER_PARSERS: Record<string, [string, 'babel' | 'postcss']> = {
  JavaScript: ['babel', 'babel'],
  JSX: ['babel', 'babel'],
  TypeScript: ['babel-ts', 'babel'],
  TSX: ['babel-ts', 'babel'],
  CSS: ['css', 'postcss'],
  SCSS: ['scss', 'postcss'],
  LESS: ['less', 'postcss'],
};

interface ParserError {
  message?: string;
  loc?: { start?: { line: number; column: number } };
}

async function lintWithPrettierParser(text: string, ctx: LintContext): Promise<Diagnostic[]> {
  const [parser, plugin] = PRETTIER_PARSERS[ctx.language!];
  const mod = plugin === 'babel' ? await import('prettier/plugins/babel') : await import('prettier/plugins/postcss');
  const parsers = mod.parsers as Record<string, { parse: (text: string, options: object) => unknown }>;
  try {
    await parsers[parser].parse(text, { filepath: ctx.fileName });
    return [];
  } catch (e) {
    const err = e as ParserError;
    const start = err.loc?.start;
    if (!start) return [];
    const at = offsetOf(text, start.line, start.column);
    const message = (err.message ?? '').split('\n')[0].replace(/^CssSyntaxError:\s*/, '').replace(/\s*\(\d+:\d+\)\s*$/, '');
    return [diag(at, Math.min(at + 1, text.length), 'error', message || tr('lint.syntax'), 'syntax')];
  }
}

const TREE_LANGUAGES = new Set(['Python', 'Rust', 'Go', 'Java', 'XML', 'HTML']);

function tagName(el: SyntaxNode | null, view: EditorView): string {
  const open = el?.getChild('OpenTag');
  const name = open?.getChild('TagName');
  return name ? view.state.sliceDoc(name.from, name.to) : '';
}

/** Error nodes of the Lezer parse tree (error recovery inserts them where the grammar fails). */
function lintTree(view: EditorView, ctx: LintContext): Diagnostic[] {
  const tree = ensureSyntaxTree(view.state, view.state.doc.length, 400);
  if (!tree) return [];
  const severity: Severity = ctx.language === 'HTML' ? 'warning' : 'error';
  const out: Diagnostic[] = [];
  const lines = new Set<number>();
  tree.iterate({
    enter: (n) => {
      if (out.length >= MAX_DIAGNOSTICS) return false;
      let message: string | null = null;
      if (n.type.isError) {
        const text = view.state.sliceDoc(n.from, Math.min(n.to, n.from + 40)).split('\n')[0].trim();
        message = text ? tr('lint.unexpected', { text }) : tr('lint.syntax');
      } else if (n.name === 'MismatchedCloseTag') {
        message = tr('lint.mismatchedTag', { name: tagName(n.node.parent, view) || '?' });
      } else if (n.name === 'MissingCloseTag') {
        message = tr('lint.unclosedTag', { name: tagName(n.node.parent, view) || '?' });
      }
      if (!message) return undefined;
      const line = view.state.doc.lineAt(n.from).number;
      if (lines.has(line)) return false;
      lines.add(line);
      const to = n.to > n.from ? n.to : Math.min(n.from + 1, view.state.doc.lineAt(n.from).to);
      out.push(diag(n.from, Math.max(to, n.from), severity, message, 'syntax'));
      return false;
    },
  });
  return out;
}

/** The lint source for a file; runs whenever the text settles after an edit. */
export function lintSource(ctx: LintContext) {
  return async (view: EditorView): Promise<Diagnostic[]> => {
    const text = view.state.doc.toString();
    if (text.length > MAX_LINT) return [];
    const out = hygiene(text, ctx);
    const lang = ctx.language;
    try {
      if (lang === 'JSON' || lang === 'JSON-LD') out.push(...lintJson(text, ctx));
      else if (lang === 'YAML') out.push(...(await lintYaml(text)));
      else if (lang === 'TOML') out.push(...(await lintToml(text)));
      else if (lang && PRETTIER_PARSERS[lang]) out.push(...(await lintWithPrettierParser(text, ctx)));
      else if (lang && TREE_LANGUAGES.has(lang)) out.push(...lintTree(view, ctx));
    } catch (e) {
      console.warn('lint failed', e);
    }
    // the document may have changed while an async parser ran
    const len = view.state.doc.length;
    return out.filter((d) => d.to <= len).slice(0, MAX_DIAGNOSTICS);
  };
}
