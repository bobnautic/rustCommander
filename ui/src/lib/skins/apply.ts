// Puts a resolved skin on the page: CSS custom properties on <html>, the color scheme, the
// classes for optional looks, and a copy in localStorage that public/theme-init.js applies
// before the bundle has loaded (no flash of the default colors).
import type { ITheme } from '@xterm/xterm';
import { save } from '../storage';
import type { Resolved, TokenValues } from './engine';

export const LOOK_CACHE_KEY = 'look';
const ROOT_CLASSES = ['rc-stripes'];

/** Custom properties currently set on <html> (theme-init.js may have set some already). */
let applied = new Set<string>(Array.from(document.documentElement.style).filter((p) => p.startsWith('--')));

export function applyToDocument(r: Resolved) {
  const el = document.documentElement;
  for (const k of applied) if (!(k in r.vars)) el.style.removeProperty(k);
  for (const [k, v] of Object.entries(r.vars)) el.style.setProperty(k, v);
  applied = new Set(Object.keys(r.vars));
  el.dataset.theme = r.scheme;
  el.dataset.skin = r.id;
  for (const c of ROOT_CLASSES) el.classList.toggle(c, r.classes.includes(c));
  const chrome = r.tokens['menubar-bg'] ?? r.tokens.chrome;
  if (chrome) document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', chrome));
}

interface CachedLook {
  scheme: 'light' | 'dark';
  vars: Record<string, string>;
  classes: string[];
}

/** What theme-init.js applies on the next start, for a light and a dark system setting. */
export function cacheLook(light: Resolved, dark: Resolved) {
  const pick = (r: Resolved): CachedLook => ({ scheme: r.scheme, vars: r.vars, classes: r.classes });
  save(LOOK_CACHE_KEY, { light: pick(light), dark: pick(dark) });
}

/** xterm.js colors from the terminal tokens. */
export function terminalTheme(t: TokenValues): ITheme {
  return {
    background: t['term-bg'],
    foreground: t['term-fg'],
    cursor: t['term-cursor'],
    cursorAccent: t['term-bg'],
    selectionBackground: t['term-selection'],
    black: t['term-black'],
    red: t['term-red'],
    green: t['term-green'],
    yellow: t['term-yellow'],
    blue: t['term-blue'],
    magenta: t['term-magenta'],
    cyan: t['term-cyan'],
    white: t['term-white'],
    brightBlack: t['term-bright-black'],
    brightRed: t['term-bright-red'],
    brightGreen: t['term-bright-green'],
    brightYellow: t['term-bright-yellow'],
    brightBlue: t['term-bright-blue'],
    brightMagenta: t['term-bright-magenta'],
    brightCyan: t['term-bright-cyan'],
    brightWhite: t['term-bright-white'],
  };
}
