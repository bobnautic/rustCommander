// "Format document": Prettier for web languages, sql-formatter for SQL, our own XML printer,
// and formatters installed on the host (rustfmt, gofmt, ruff, shfmt, ...) for everything else.
// Every formatter is loaded on first use.
import type { Plugin } from 'prettier';
import type { FormatterInfo } from '../../api/types';
import { call } from '../../api/client';
import { detectCodeStyle } from './detect';

export interface FormatOptions {
  fileName: string;
  language: string;
  tabSize: number;
  useTabs: boolean;
  printWidth: number;
}

export interface Formatter {
  /** Shown in the UI, e.g. "Prettier" or "rustfmt". */
  label: string;
  format(text: string, o: FormatOptions): Promise<string>;
}

type PluginName = 'babel' | 'estree' | 'postcss' | 'html' | 'markdown' | 'yaml';

const pluginLoaders: Record<PluginName, () => Promise<unknown>> = {
  babel: () => import('prettier/plugins/babel'),
  estree: () => import('prettier/plugins/estree'),
  postcss: () => import('prettier/plugins/postcss'),
  html: () => import('prettier/plugins/html'),
  markdown: () => import('prettier/plugins/markdown'),
  yaml: () => import('prettier/plugins/yaml'),
};

const JS: PluginName[] = ['babel', 'estree'];
const WEB: PluginName[] = ['html', 'postcss', 'babel', 'estree'];

/** Language name -> Prettier parser and the plugins it needs. */
const PRETTIER: Record<string, { parser: string; plugins: PluginName[] }> = {
  JavaScript: { parser: 'babel', plugins: JS },
  JSX: { parser: 'babel', plugins: JS },
  TypeScript: { parser: 'babel-ts', plugins: JS },
  TSX: { parser: 'babel-ts', plugins: JS },
  JSON: { parser: 'json', plugins: JS },
  'JSON-LD': { parser: 'json', plugins: JS },
  CSS: { parser: 'css', plugins: ['postcss'] },
  SCSS: { parser: 'scss', plugins: ['postcss'] },
  LESS: { parser: 'less', plugins: ['postcss'] },
  HTML: { parser: 'html', plugins: WEB },
  Vue: { parser: 'vue', plugins: WEB },
  Markdown: { parser: 'markdown', plugins: ['markdown', 'yaml'] },
  YAML: { parser: 'yaml', plugins: ['yaml'] },
};

function prettierParser(language: string, fileName: string): string | null {
  const p = PRETTIER[language]?.parser;
  if (p !== 'json') return p ?? null;
  // npm and composer write these with JSON.stringify; keep their layout
  if (/^(package|package-lock|composer)\.json$/i.test(fileName)) return 'json-stringify';
  if (/\.json5$/i.test(fileName)) return 'json5';
  if (/\.jsonc$/i.test(fileName)) return 'jsonc';
  return 'json';
}

const prettier: Formatter = {
  label: 'Prettier',
  async format(text, o) {
    const parser = prettierParser(o.language, o.fileName)!;
    const code = ['babel', 'babel-ts', 'css', 'scss', 'less', 'vue'].includes(parser);
    const [{ format }, ...plugins] = await Promise.all([import('prettier/standalone'), ...PRETTIER[o.language].plugins.map((p) => pluginLoaders[p]())]);
    return format(text, {
      parser,
      plugins: plugins as Plugin[],
      filepath: o.fileName,
      tabWidth: o.tabSize,
      useTabs: o.useTabs,
      printWidth: o.printWidth,
      endOfLine: 'lf',
      ...(code ? detectCodeStyle(text) : {}),
    });
  },
};

const SQL_DIALECTS: Record<string, string> = {
  SQL: 'sql',
  PostgreSQL: 'postgresql',
  MySQL: 'mysql',
  'MariaDB SQL': 'mariadb',
  SQLite: 'sqlite',
  'MS SQL': 'transactsql',
  PLSQL: 'plsql',
};

const sqlFormatter: Formatter = {
  label: 'sql-formatter',
  async format(text, o) {
    const m = await import('sql-formatter');
    const dialects = { sql: m.sql, postgresql: m.postgresql, mysql: m.mysql, mariadb: m.mariadb, sqlite: m.sqlite, transactsql: m.transactsql, plsql: m.plsql };
    const dialect = dialects[SQL_DIALECTS[o.language] as keyof typeof dialects] ?? m.sql;
    const out = m.formatDialect(text, { dialect, tabWidth: o.tabSize, useTabs: o.useTabs, keywordCase: 'preserve', expressionWidth: Math.max(20, Math.min(o.printWidth, 120)) });
    return out.endsWith('\n') ? out : out + '\n';
  },
};

const xmlFormatter: Formatter = {
  label: 'XML',
  async format(text, o) {
    const { formatXml } = await import('./xmlFormat');
    return formatXml(text, o.useTabs ? '\t' : ' '.repeat(o.tabSize));
  },
};

function external(info: FormatterInfo): Formatter {
  return {
    label: info.id,
    async format(text, o) {
      const r = await call('edit.format', { language: o.language, fileName: o.fileName, content: text, tabSize: o.tabSize, useTabs: o.useTabs });
      return r.content;
    },
  };
}

/** The formatter for a language: built-in ones first, then one installed on the host. */
export function formatterFor(language: string | null, fileName: string, installed: FormatterInfo[]): Formatter | null {
  if (!language) return null;
  if (PRETTIER[language] && prettierParser(language, fileName)) return prettier;
  if (SQL_DIALECTS[language]) return sqlFormatter;
  if (language === 'XML') return xmlFormatter;
  const ext = installed.find((f) => f.languages.includes(language));
  return ext ? external(ext) : null;
}

let installedCache: Promise<FormatterInfo[]> | null = null;

/** Formatters found on the machine that runs Rust Commander (asked once per app start). */
export function installedFormatters(): Promise<FormatterInfo[]> {
  installedCache ??= call('edit.formatters').catch(() => {
    installedCache = null;
    return [];
  });
  return installedCache;
}
