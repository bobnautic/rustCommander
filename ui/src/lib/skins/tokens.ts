// The design tokens a skin can set. Every token is a CSS custom property (`--name`) that
// the stylesheets, the editor and the terminal read.
//
// Tokens a skin leaves out come from the "default" skin, unless they can be derived from
// tokens the skin did set: a skin that only sets `accent` also gets matching hover,
// selection and cursor colors; a skin that sets the palette hues gets matching file icon,
// terminal and syntax colors. `docs/src/reference/skin-tokens.md` lists them all.
import { BLACK, WHITE, mix, readableOn, withAlpha, type RGBA } from './color';

export type Scheme = 'light' | 'dark';
export type TokenKind = 'color' | 'shadow';
export type TokenGroup = 'palette' | 'base' | 'text' | 'accent' | 'selection' | 'status' | 'chrome' | 'files' | 'terminal' | 'syntax' | 'editor';

export interface DeriveCtx {
  /** Resolved value of another token. */
  c(name: string): RGBA;
  dark: boolean;
}

export interface TokenDef {
  name: string;
  group: TokenGroup;
  kind: TokenKind;
  /** English description (skin editor, documentation). */
  doc: string;
  /** Only emitted when a skin sets it; the stylesheets fall back to another token. */
  optional?: boolean;
  /** Tokens `derive` reads. */
  from?: string[];
  derive?: (x: DeriveCtx) => RGBA;
}

export const GROUPS: TokenGroup[] = ['base', 'text', 'accent', 'selection', 'status', 'palette', 'files', 'chrome', 'terminal', 'syntax', 'editor'];

type Derive = (x: DeriveCtx) => RGBA;
const def =
  (group: TokenGroup) =>
  (name: string, doc: string, from?: string[], derive?: Derive, extra: Partial<TokenDef> = {}): TokenDef => ({ name, group, kind: 'color', doc, from, derive, ...extra });

/** Copy of another token. */
const same = (src: string): [string[], Derive] => [[src], (x) => x.c(src)];
/** Lighter in dark skins, darker in light skins (terminal "bright" colors). */
const bright = (src: string): [string[], Derive] => [[src], (x) => (x.dark ? mix(x.c(src), WHITE, 0.25) : mix(x.c(src), BLACK, 0.2))];
/** Tinted background for a status color: translucent in dark skins, solid in light ones. */
const weak = (src: string, light: number, dark: number): [string[], Derive] => [[src, 'surface'], (x) => (x.dark ? withAlpha(x.c(src), dark) : mix(x.c('surface'), x.c(src), light))];

const palette = def('palette');
const base = def('base');
const text = def('text');
const accent = def('accent');
const sel = def('selection');
const status = def('status');
const chrome = def('chrome');
const files = def('files');
const term = def('terminal');
const syn = def('syntax');
const editor = def('editor');

const hue = (name: string) => palette(name, `Palette hue "${name}". File icons, status, terminal and syntax colors are derived from the palette.`);

export const TOKENS: TokenDef[] = [
  // ------------------------------------------------------------ palette
  hue('red'),
  hue('orange'),
  hue('yellow'),
  hue('green'),
  hue('teal'),
  hue('cyan'),
  hue('blue'),
  hue('purple'),
  hue('pink'),

  // ------------------------------------------------------------ base
  base('bg', 'Window background: around the panels and behind the active session tab.'),
  base('chrome', 'Menu bar, session tabs, sidebar, status bar and function key bar.'),
  base('surface', 'Panels, dialogs, menus and cards.'),
  base('surface-2', 'Panel headers, column headers and panel status lines.', ['surface', 'bg', 'text'], (x) => (x.dark ? mix(x.c('surface'), x.c('text'), 0.035) : mix(x.c('surface'), x.c('bg'), 0.5))),
  base('surface-3', 'Hover and pressed backgrounds, segmented controls, progress tracks.', ['surface', 'bg', 'text'], (x) => (x.dark ? mix(x.c('surface'), x.c('text'), 0.08) : mix(x.c('bg'), x.c('text'), 0.02))),
  base('input-bg', 'Text fields and drop-down lists.', ['surface', 'bg'], (x) => (x.dark ? mix(x.c('surface'), x.c('bg'), 0.5) : x.c('surface'))),
  base('hover', 'Row under the mouse pointer.', ['surface-2', 'accent'], (x) => mix(x.c('surface-2'), x.c('accent'), 0.05)),
  base('border', 'Borders of panels, dialogs and tables.', ['surface', 'text'], (x) => mix(x.c('surface'), x.c('text'), 0.13)),
  base('border-soft', 'Subtle separators.', ['border', 'surface'], (x) => mix(x.c('border'), x.c('surface'), 0.5)),
  base('border-strong', 'Borders of buttons and inputs.', ['border', 'text'], (x) => mix(x.c('border'), x.c('text'), 0.12)),
  base('scroll', 'Scrollbar thumbs.', ...same('border-strong')),
  base('backdrop', 'Shade behind modal dialogs (use a translucent color).'),
  base('shadow', 'Shadow of panels and cards: a CSS box-shadow, or "none" for a flat look.', undefined, undefined, { kind: 'shadow' }),
  base('shadow-lg', 'Shadow of menus, dialogs and notifications: a CSS box-shadow or "none".', undefined, undefined, { kind: 'shadow' }),

  // ------------------------------------------------------------ text
  text('text', 'Main text color.'),
  text('text-2', 'Secondary text: other columns, labels, inactive tabs.', ['text', 'surface'], (x) => mix(x.c('text'), x.c('surface'), 0.22)),
  text('muted', 'Hints, placeholders, status texts.', ['text', 'surface'], (x) => mix(x.c('text'), x.c('surface'), 0.45)),
  text('faint', 'Very low-emphasis text and decorations (separators, line numbers).', ['text', 'surface'], (x) => mix(x.c('text'), x.c('surface'), 0.62)),

  // ------------------------------------------------------------ accent
  accent('accent', 'Buttons, links, focus rings, the active panel, highlighted menu items, progress bars.'),
  accent('accent-hover', 'Primary buttons under the mouse pointer.', ['accent'], (x) => (x.dark ? mix(x.c('accent'), WHITE, 0.15) : mix(x.c('accent'), BLACK, 0.1))),
  accent('accent-fg', 'Text on accent-colored backgrounds.', ['accent'], (x) => readableOn(x.c('accent'))),
  accent('accent-weak', 'Light accent tint (active rows, drop zones).', ...weak('accent', 0.1, 0.13)),
  accent('accent-weak-2', 'Stronger accent tint (focus glow, active toggle buttons).', ...weak('accent', 0.2, 0.24)),
  accent('accent-border', 'Border of the active panel.', ['accent'], (x) => withAlpha(x.c('accent'), x.dark ? 0.55 : 0.45)),
  accent('brand', 'The Rust Commander logo color.'),

  // ------------------------------------------------------------ selection
  sel('sel-bg', 'Background of marked (selected) files.', ...weak('accent', 0.13, 0.17)),
  sel('sel-fg', 'Text of marked files.', ['accent', 'text'], (x) => (x.dark ? mix(x.c('accent'), WHITE, 0.35) : mix(x.c('accent'), x.c('text'), 0.3))),
  sel('cursor-bg', 'The file cursor in the active panel.', ...weak('accent', 0.22, 0.32)),
  sel('cursor-fg', 'Text on the file cursor. Optional: without it the text keeps its color.', undefined, undefined, { optional: true }),
  sel('row-alt', 'Every other row of the file lists when striped rows are on.', ['surface', 'text'], (x) => mix(x.c('surface'), x.c('text'), x.dark ? 0.03 : 0.025)),
  sel('dir-fg', 'Names of folders in the file lists. Optional: without it folders look like files.', undefined, undefined, { optional: true }),

  // ------------------------------------------------------------ status
  status('ok', 'Success: finished jobs, identical files, connected.', ...same('green')),
  status('ok-weak', 'Background of success messages.', ...weak('ok', 0.1, 0.12)),
  status('ok-border', 'Border of success messages.', ...weak('ok', 0.4, 0.4)),
  status('warn', 'Warnings: different files, attention.', ['yellow'], (x) => (x.dark ? x.c('yellow') : mix(x.c('yellow'), BLACK, 0.12))),
  status('warn-weak', 'Background of warnings.', ...weak('warn', 0.1, 0.13)),
  status('err', 'Errors and destructive actions.', ...same('red')),
  status('err-weak', 'Background of error messages.', ...weak('err', 0.08, 0.13)),
  status('err-border', 'Border of error messages.', ...weak('err', 0.35, 0.45)),

  // ------------------------------------------------------------ chrome (all optional)
  chrome('menubar-bg', 'Background of the menu bar. Optional: default is "chrome".', undefined, undefined, { optional: true }),
  chrome('menubar-fg', 'Menu titles and toolbar icons. Optional.', undefined, undefined, { optional: true }),
  chrome('key-bg', 'Background of the function key labels (F1–F10). Optional: default is "surface-3".', undefined, undefined, { optional: true }),
  chrome('key-fg', 'Text of the function key labels. Optional: default is "text-2".', undefined, undefined, { optional: true }),
  chrome('key-num', 'Numbers of the function keys. Optional: default is "muted".', undefined, undefined, { optional: true }),

  // ------------------------------------------------------------ file icons
  files('fi-file', 'Files without a known type.', ...same('muted')),
  files('fi-dir', 'Folder icons (outline).', ...same('yellow')),
  files('fi-dir-fill', 'Folder icons (fill).', ['fi-dir', 'surface'], (x) => (x.dark ? withAlpha(x.c('fi-dir'), 0.32) : mix(x.c('surface'), x.c('fi-dir'), 0.5))),
  files('fi-image', 'Images.', ...same('purple')),
  files('fi-video', 'Videos.', ...same('pink')),
  files('fi-audio', 'Audio files.', ...same('teal')),
  files('fi-archive', 'Archives (zip, tar, …).', ...same('orange')),
  files('fi-code', 'Source code.', ...same('blue')),
  files('fi-script', 'Scripts (sh, py, …).', ...same('green')),
  files('fi-config', 'Configuration files (json, yaml, toml, …).', ...same('cyan')),
  files('fi-text', 'Text files.', ...same('muted')),
  files('fi-document', 'Documents (pdf, doc, …).', ...same('red')),
  files('fi-spreadsheet', 'Spreadsheets.', ...same('green')),
  files('fi-presentation', 'Presentations.', ...same('orange')),
  files('fi-key', 'Keys and certificates.', ...same('yellow')),
  files('fi-executable', 'Programs.', ['blue', 'purple'], (x) => mix(x.c('blue'), x.c('purple'), 0.5)),
  files('fi-font', 'Fonts.', ...same('purple')),
  files('fi-database', 'Databases.', ['blue', 'cyan'], (x) => mix(x.c('blue'), x.c('cyan'), 0.5)),
  files('fi-disk', 'Disk images.', ...same('muted')),
  files('fi-link', 'Symbolic links.', ...same('accent')),

  // ------------------------------------------------------------ terminal
  term('term-bg', 'Terminal background.', ['bg', 'surface'], (x) => (x.dark ? mix(x.c('bg'), x.c('surface'), 0.1) : mix(x.c('surface'), x.c('bg'), 0.25))),
  term('term-fg', 'Terminal text.', ...same('text')),
  term('term-cursor', 'Terminal cursor.', ...same('term-fg')),
  term('term-selection', 'Selected text in the terminal.', ['accent'], (x) => withAlpha(x.c('accent'), x.dark ? 0.35 : 0.3)),
  term('term-black', 'ANSI black.', ['text', 'faint', 'bg'], (x) => (x.dark ? mix(x.c('faint'), x.c('bg'), 0.2) : x.c('text'))),
  term('term-red', 'ANSI red.', ...same('red')),
  term('term-green', 'ANSI green.', ...same('green')),
  term('term-yellow', 'ANSI yellow.', ...same('yellow')),
  term('term-blue', 'ANSI blue.', ...same('blue')),
  term('term-magenta', 'ANSI magenta.', ...same('purple')),
  term('term-cyan', 'ANSI cyan.', ...same('cyan')),
  term('term-white', 'ANSI white.', ['muted', 'text-2'], (x) => (x.dark ? x.c('text-2') : x.c('muted'))),
  term('term-bright-black', 'ANSI bright black (often used for gray text).', ['text', 'surface', 'muted'], (x) => (x.dark ? x.c('muted') : mix(x.c('text'), x.c('surface'), 0.35))),
  term('term-bright-red', 'ANSI bright red.', ...bright('red')),
  term('term-bright-green', 'ANSI bright green.', ...bright('green')),
  term('term-bright-yellow', 'ANSI bright yellow.', ...bright('yellow')),
  term('term-bright-blue', 'ANSI bright blue.', ...bright('blue')),
  term('term-bright-magenta', 'ANSI bright magenta.', ...bright('purple')),
  term('term-bright-cyan', 'ANSI bright cyan.', ...bright('cyan')),
  term('term-bright-white', 'ANSI bright white.', ['text', 'faint'], (x) => (x.dark ? mix(x.c('text'), WHITE, 0.6) : x.c('faint'))),

  // ------------------------------------------------------------ syntax highlighting
  syn('syn-keyword', 'Keywords (if, fn, return).', ...same('purple')),
  syn('syn-string', 'Strings.', ...same('green')),
  syn('syn-number', 'Numbers.', ...same('orange')),
  syn('syn-constant', 'Constants, booleans, null.', ...same('orange')),
  syn('syn-comment', 'Comments.', ...same('muted')),
  syn('syn-function', 'Function and method names.', ...same('blue')),
  syn('syn-type', 'Types, classes, namespaces.', ...same('yellow')),
  syn('syn-property', 'Properties and keys.', ...same('red')),
  syn('syn-variable', 'Variables.', ...same('text')),
  syn('syn-operator', 'Operators.', ...same('cyan')),
  syn('syn-tag', 'HTML/XML tags.', ...same('red')),
  syn('syn-attribute', 'HTML/XML attributes.', ...same('orange')),
  syn('syn-heading', 'Markdown headings.', ...same('accent')),
  syn('syn-link', 'Links and URLs.', ...same('accent')),
  syn('syn-invalid', 'Invalid code.', ...same('err')),
  syn('syn-meta', 'Annotations, preprocessor, front matter.', ...same('muted')),
  syn('syn-regexp', 'Regular expressions and escapes.', ...same('teal')),

  // ------------------------------------------------------------ editor
  editor('editor-bg', 'Editor background.', ...same('surface')),
  editor('editor-fg', 'Editor text.', ...same('text')),
  editor('editor-gutter-bg', 'Line number gutter background.', ['surface', 'surface-2'], (x) => (x.dark ? x.c('surface') : x.c('surface-2'))),
  editor('editor-gutter-fg', 'Line numbers.', ...same('faint')),
  editor('editor-active-line', 'Line with the cursor.', ['accent'], (x) => withAlpha(x.c('accent'), x.dark ? 0.06 : 0.05)),
  editor('editor-selection', 'Selected text.', ...weak('accent', 0.22, 0.3)),
  editor('editor-cursor', 'Text cursor.', ...same('accent')),
];

export const TOKEN_MAP: ReadonlyMap<string, TokenDef> = new Map(TOKENS.map((t) => [t.name, t]));

/** Tokens in an order where every token comes after the tokens it is derived from. */
export const EVAL_ORDER: TokenDef[] = (() => {
  const out: TokenDef[] = [];
  const state = new Map<string, 'busy' | 'done'>();
  const visit = (t: TokenDef) => {
    const s = state.get(t.name);
    if (s === 'done') return;
    if (s === 'busy') throw new Error(`token cycle at ${t.name}`);
    state.set(t.name, 'busy');
    for (const f of t.from ?? []) {
      const dep = TOKEN_MAP.get(f);
      if (!dep) throw new Error(`${t.name} derives from unknown token ${f}`);
      visit(dep);
    }
    state.set(t.name, 'done');
    out.push(t);
  };
  TOKENS.forEach(visit);
  return out;
})();
