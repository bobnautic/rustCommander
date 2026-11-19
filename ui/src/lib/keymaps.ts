// Keyboard layouts ("keymaps"): which key combination runs which command.
//
// Pure data and helpers, without DOM or store access, so they can be unit-tested. The
// commands themselves live in actions/commands.ts, the window-level handler in
// actions/shortcuts.ts. Keys that only make sense inside a file panel (arrows, Insert,
// Space, Tab, + - *, type-ahead) are handled by the panel itself and are the same in all
// layouts – except the modifier of the quick search, see `Keymap.quickSearch`.

export type KeymapId = 'norton' | 'total' | 'rust';

export const KEYMAP_IDS: readonly KeymapId[] = ['norton', 'total', 'rust'];
export const DEFAULT_KEYMAP: KeymapId = 'norton';

export type CommandId =
  | 'help'
  | 'userMenu'
  | 'view'
  | 'viewExternal'
  | 'edit'
  | 'editExternal'
  | 'newFile'
  | 'copy'
  | 'copyQuick'
  | 'move'
  | 'moveQuick'
  | 'rename'
  | 'mkdir'
  | 'delete'
  | 'deletePermanent'
  | 'menu'
  | 'quit'
  | 'refresh'
  | 'toggleHidden'
  | 'siteManager'
  | 'disconnect'
  | 'terminal'
  | 'toggleTerminal'
  | 'find'
  | 'focusPath'
  | 'addBookmark'
  | 'hotlist'
  | 'sync'
  | 'sidebar'
  | 'explorer'
  | 'dock'
  | 'back'
  | 'forward'
  | 'root'
  | 'parentDir'
  | 'openDir'
  | 'dirHistory'
  | 'copyPath'
  | 'preferences'
  | 'openFile'
  | 'fingerprints'
  | 'upload'
  | 'properties'
  | 'undo'
  | 'sortName'
  | 'sortExt'
  | 'sortTime'
  | 'sortSize'
  | 'swapPanels'
  | 'toLeft'
  | 'toRight'
  | 'compareDirs'
  | 'selectAll'
  | 'selectNone'
  | 'pack'
  | 'unpack'
  | 'driveLeft'
  | 'driveRight'
  | 'quickFilter';

export interface Keymap {
  id: KeymapId;
  /** Product name; not translated. */
  name: string;
  /**
   * Modifier of the quick search in the file panels: letters typed while holding it jump to
   * the first matching file. Letters typed without a modifier always do the same.
   */
  quickSearch: 'alt' | 'ctrlAlt' | null;
  /**
   * Key combination → command, in the order the help lists them. Several combinations may
   * run the same command; the first one is shown in menus. Combinations are written as
   * `comboOf` produces them: modifiers in the order Ctrl, Alt, Shift, then the key.
   */
  bindings: Readonly<Record<string, CommandId>>;
  /**
   * Bindings that are Rust Commander additions (functions the original program does not
   * have, on keys it leaves free). The help marks them.
   */
  extras: readonly string[];
}

/** Rust Commander additions shared by the classic layouts: keys the originals leave free. */
const EXTRAS_COMMON: Record<string, CommandId> = {
  'Ctrl+Z': 'undo',
  'Ctrl+H': 'toggleHidden',
  'Ctrl+T': 'terminal',
  'Ctrl+L': 'focusPath',
  'Ctrl+Shift+S': 'sync',
  'Ctrl+B': 'sidebar',
  'Ctrl+Shift+E': 'explorer',
  'Ctrl+J': 'dock',
  'Ctrl+Shift+C': 'copyPath',
  'Ctrl+,': 'preferences',
  'Ctrl+P': 'openFile',
  'Ctrl+K': 'fingerprints',
};

/**
 * Norton Commander (DOS) – the original key bar
 * `1Help 2Menu 3View 4Edit 5Copy 6RenMov 7Mkdir 8Delete 9PullDn 10Quit`, the Alt layer
 * `1Left 2Right 3View.. 4Edit.. 5Pack 6UnPack 7Find` and the Ctrl keys for sorting, the
 * user screen and swapping the panels. Quick search: Alt+letters.
 */
const NORTON_OWN: Record<string, CommandId> = {
  F1: 'help',
  F2: 'userMenu',
  F3: 'view',
  F4: 'edit',
  F5: 'copy',
  F6: 'move',
  F7: 'mkdir',
  F8: 'delete',
  F9: 'menu',
  F10: 'quit',
  'Shift+F4': 'newFile',
  'Shift+F6': 'rename',
  'Shift+F8': 'deletePermanent',
  'Alt+F1': 'driveLeft',
  'Alt+F2': 'driveRight',
  'Alt+F3': 'viewExternal',
  'Alt+F4': 'editExternal',
  'Alt+F5': 'pack',
  'Alt+F6': 'unpack',
  'Alt+F7': 'find',
  'Ctrl+F3': 'sortName',
  'Ctrl+F4': 'sortExt',
  'Ctrl+F5': 'sortTime',
  'Ctrl+F6': 'sortSize',
  'Ctrl+O': 'toggleTerminal',
  'Ctrl+U': 'swapPanels',
  'Ctrl+R': 'refresh',
  'Ctrl+\\': 'root',
  'Ctrl+PageUp': 'parentDir',
  'Ctrl+PageDown': 'openDir',
};

const NORTON_EXTRAS: Record<string, CommandId> = {
  Delete: 'delete',
  'Shift+Delete': 'deletePermanent',
  'Alt+Enter': 'properties',
  'Alt+ArrowLeft': 'back',
  'Alt+ArrowRight': 'forward',
  'Ctrl+N': 'siteManager',
  'Ctrl+F': 'find',
  'Ctrl+D': 'addBookmark',
  ...EXTRAS_COMMON,
};

/**
 * Total Commander – F2 rereads the panel, F9/F10 open the menu, Alt+F4 quits, Shift+F6
 * renames in place, Ctrl+D is the directory hotlist, Ctrl+F/Ctrl+N connect, Ctrl+S is the
 * quick filter. Quick search: Ctrl+Alt+letters.
 */
const TOTAL_OWN: Record<string, CommandId> = {
  F1: 'help',
  F2: 'refresh',
  F3: 'view',
  F4: 'edit',
  F5: 'copy',
  F6: 'move',
  F7: 'mkdir',
  F8: 'delete',
  Delete: 'delete',
  F9: 'menu',
  F10: 'menu',
  'Shift+F2': 'compareDirs',
  'Shift+F4': 'newFile',
  'Shift+F6': 'rename',
  'Shift+F8': 'deletePermanent',
  'Shift+Delete': 'deletePermanent',
  'Alt+F1': 'driveLeft',
  'Alt+F2': 'driveRight',
  'Alt+F3': 'viewExternal',
  'Alt+F4': 'quit',
  'Alt+F5': 'pack',
  'Alt+F7': 'find',
  'Alt+F9': 'unpack',
  'Alt+F6': 'unpack',
  'Alt+Enter': 'properties',
  'Alt+ArrowLeft': 'back',
  'Alt+ArrowRight': 'forward',
  'Alt+ArrowDown': 'dirHistory',
  'Ctrl+F3': 'sortName',
  'Ctrl+F4': 'sortExt',
  'Ctrl+F5': 'sortTime',
  'Ctrl+F6': 'sortSize',
  'Ctrl+Num+': 'selectAll',
  'Ctrl+Num-': 'selectNone',
  'Ctrl+PageUp': 'parentDir',
  'Ctrl+PageDown': 'openDir',
  'Ctrl+\\': 'root',
  'Ctrl+ArrowLeft': 'toLeft',
  'Ctrl+ArrowRight': 'toRight',
  'Ctrl+D': 'hotlist',
  'Ctrl+F': 'siteManager',
  'Ctrl+Shift+F': 'disconnect',
  'Ctrl+N': 'siteManager',
  'Ctrl+R': 'refresh',
  'Ctrl+S': 'quickFilter',
  'Ctrl+U': 'swapPanels',
};

const TOTAL_EXTRAS: Record<string, CommandId> = { ...EXTRAS_COMMON };

/** The layout of Rust Commander up to version 0.1: F2 renames, F9 refreshes. */
const RUST_BINDINGS: Record<string, CommandId> = {
  F1: 'help',
  F2: 'rename',
  F3: 'view',
  F4: 'edit',
  'Shift+F4': 'newFile',
  F5: 'copy',
  'Shift+F5': 'copyQuick',
  F6: 'move',
  'Shift+F6': 'moveQuick',
  F7: 'mkdir',
  F8: 'delete',
  Delete: 'delete',
  'Shift+F8': 'deletePermanent',
  'Shift+Delete': 'deletePermanent',
  'Ctrl+Z': 'undo',
  'Alt+Enter': 'properties',
  'Ctrl+R': 'refresh',
  F9: 'refresh',
  'Ctrl+H': 'toggleHidden',
  'Ctrl+N': 'siteManager',
  'Ctrl+T': 'terminal',
  'Ctrl+F': 'find',
  'Ctrl+L': 'focusPath',
  'Ctrl+D': 'addBookmark',
  'Ctrl+Shift+S': 'sync',
  'Ctrl+B': 'sidebar',
  'Ctrl+Shift+E': 'explorer',
  'Ctrl+J': 'dock',
  'Alt+ArrowLeft': 'back',
  'Alt+ArrowRight': 'forward',
  'Ctrl+\\': 'root',
  'Ctrl+PageUp': 'parentDir',
  'Ctrl+PageDown': 'openDir',
  'Ctrl+Shift+C': 'copyPath',
  'Ctrl+,': 'preferences',
  'Ctrl+P': 'openFile',
  'Ctrl+K': 'fingerprints',
  'Ctrl+U': 'upload',
};

export const KEYMAPS: Readonly<Record<KeymapId, Keymap>> = {
  norton: {
    id: 'norton',
    name: 'Norton Commander',
    quickSearch: 'alt',
    bindings: { ...NORTON_OWN, ...NORTON_EXTRAS },
    extras: Object.keys(NORTON_EXTRAS),
  },
  total: {
    id: 'total',
    name: 'Total Commander',
    quickSearch: 'ctrlAlt',
    bindings: { ...TOTAL_OWN, ...TOTAL_EXTRAS },
    extras: Object.keys(TOTAL_EXTRAS),
  },
  rust: {
    id: 'rust',
    name: 'Rust Commander',
    quickSearch: null,
    bindings: RUST_BINDINGS,
    extras: [],
  },
};

/** The layout for a setting value; unknown values fall back to the default. */
export function keymapOf(id: string | null | undefined): Keymap {
  return (id && (KEYMAPS as Record<string, Keymap>)[id]) || KEYMAPS[DEFAULT_KEYMAP];
}

/** All combinations bound to `cmd`, in the layout's order. */
export function combosFor(km: Keymap, cmd: CommandId): string[] {
  return Object.entries(km.bindings)
    .filter(([, c]) => c === cmd)
    .map(([k]) => k);
}

/** The combination shown for `cmd` in menus and tooltips (the first one), if any. */
export function comboFor(km: Keymap, cmd: CommandId): string | undefined {
  for (const [k, c] of Object.entries(km.bindings)) if (c === cmd) return k;
  return undefined;
}

/** Commands of a layout with all their combinations, in the order of the first binding. */
export function groupedBindings(km: Keymap): { cmd: CommandId; combos: string[]; extra: boolean }[] {
  const out = new Map<CommandId, { cmd: CommandId; combos: string[]; extra: boolean }>();
  for (const [k, cmd] of Object.entries(km.bindings)) {
    const g = out.get(cmd);
    if (g) g.combos.push(k);
    else out.set(cmd, { cmd, combos: [k], extra: km.extras.includes(k) });
  }
  // a command counts as an addition only when every key that runs it is one
  for (const g of out.values()) g.extra = g.combos.every((k) => km.extras.includes(k));
  return [...out.values()];
}

// ---------------------------------------------------------------- key events

/** The subset of a KeyboardEvent the helpers below read (handy for tests). */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const NUMPAD_OPS = new Set(['+', '-', '*', '/']);

/**
 * Canonical name of a key press: `Ctrl+Alt+Shift+Key` (⌘ counts as Ctrl). Letters are upper
 * case, the operators of the numeric keypad are `Num+`, `Num-`, `Num*`, `Num/`.
 */
export function comboOf(e: KeyLike): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (k.length === 1) k = k.toUpperCase();
  if (k === 'Del') k = 'Delete';
  if (e.code?.startsWith('Numpad') && NUMPAD_OPS.has(k)) k = 'Num' + k;
  parts.push(k);
  return parts.join('+');
}

/** Splits a combination into its modifiers and the key (`Ctrl++` → [['Ctrl'], '+']). */
export function splitCombo(combo: string): { mods: string[]; key: string } {
  const m = /^((?:(?:Ctrl|Alt|Shift)\+)*)(.+)$/.exec(combo);
  const mods = m && m[1] ? m[1].slice(0, -1).split('+') : [];
  return { mods, key: m ? m[2] : combo };
}

/** True when `combo` is written the way `comboOf` produces it. */
export function isCanonical(combo: string): boolean {
  const { mods, key } = splitCombo(combo);
  const order = ['Ctrl', 'Alt', 'Shift'];
  const sorted = [...mods].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const unique = new Set(mods).size === mods.length;
  return unique && sorted.join() === mods.join() && key.length > 0 && (key.length > 1 || key === key.toUpperCase());
}

/**
 * The character a quick-search key press adds, or null when the modifiers do not match the
 * layout's quick search. Uses the physical key when the modifier produces another
 * character (Option+letter on macOS, AltGr on Windows).
 */
export function quickSearchChar(e: KeyLike, mode: Keymap['quickSearch']): string | null {
  const ctrl = e.ctrlKey || e.metaKey;
  const ok = mode === 'alt' ? e.altKey && !ctrl : mode === 'ctrlAlt' ? e.altKey && ctrl : false;
  if (!ok) return null;
  if (e.key.length === 1 && /^[\p{L}\p{N}]$/u.test(e.key)) return e.key.toLowerCase();
  const m = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(e.code ?? '');
  if (m) return (m[1] ?? m[2]).toLowerCase();
  return null;
}

/** The function keys shown in the key bar. */
export const KEY_BAR_KEYS = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10'] as const;

/** Modifier prefix of the key bar layer for the held modifiers ('' when none). */
export function keyBarLayer(mods: { ctrl: boolean; alt: boolean; shift: boolean }): string {
  return `${mods.ctrl ? 'Ctrl+' : ''}${mods.alt ? 'Alt+' : ''}${mods.shift ? 'Shift+' : ''}`;
}
