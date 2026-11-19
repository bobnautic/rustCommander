// Global keyboard shortcuts (window level), taken from the active keyboard layout (see
// lib/keymaps.ts). Panel navigation keys live in FileTable.
import { isAnyDialogOpen } from '../store/dialogs';
import { usePrompts } from '../store/misc';
import { useEditors } from '../store/editors';
import { useApp } from '../store/app';
import { useContextMenu } from '../components/Menu';
import { comboFor, comboOf, keymapOf, type CommandId, type Keymap } from '../lib/keymaps';
import { isAvailable, runCommand } from './commands';

export { comboOf };

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl';

const KEY_NAMES: [RegExp, string][] = [
  [/ArrowLeft/g, '←'],
  [/ArrowRight/g, '→'],
  [/ArrowUp/g, '↑'],
  [/ArrowDown/g, '↓'],
  [/PageUp/g, 'PgUp'],
  [/PageDown/g, 'PgDn'],
  [/Num([+\-*/])/g, 'Num $1'],
];

/** Display form of a shortcut ('Ctrl+Shift+S' -> '⌘⇧S' on macOS, 'Alt+ArrowDown' -> 'Alt+↓'). */
export function keyLabel(combo: string): string {
  let s = combo;
  for (const [re, name] of KEY_NAMES) s = s.replace(re, name);
  if (!isMac) return s;
  return s.replace(/Ctrl\+/g, '⌘').replace(/Shift\+/g, '⇧').replace(/Alt\+/g, '⌥');
}

/** The keyboard layout chosen in the preferences. */
export function activeKeymap(): Keymap {
  return keymapOf(useApp.getState().settings?.keymap);
}

/** Subscribes a component to the keyboard layout (re-renders when it changes). */
export function useKeymap(): Keymap {
  return keymapOf(useApp((s) => s.settings?.keymap));
}

/** Display form of the key that runs `cmd` in the active layout, if there is one. */
export function shortcutLabel(cmd: CommandId, km: Keymap = activeKeymap()): string | undefined {
  const c = comboFor(km, cmd);
  return c ? keyLabel(c) : undefined;
}

/** Commands that also work while typing in a plain input field outside of dialogs. */
const ALWAYS: ReadonlySet<CommandId> = new Set<CommandId>(['sidebar', 'dock', 'explorer']);

function blocked(target: EventTarget | null, combo: string): boolean {
  if (isAnyDialogOpen() || usePrompts.getState().queue.length > 0) return true;
  if (useEditors.getState().visible) return true;
  if (useContextMenu.getState().menu) return true;
  const el = target as HTMLElement | null;
  if (!el || !el.closest) return false;
  // Keys pressed in the remote explorer tree (Delete, F5, F8, ...) must not act on the
  // active panel; Ctrl/Alt shortcuts (Ctrl+B, ...) keep working there.
  if (el.closest('.xp-tree') && !/^(Ctrl|Alt)\+/.test(combo)) return true;
  return !!el.closest('input, textarea, select, [contenteditable="true"], .xterm, .cm-editor, .menu');
}

export function installShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return;
    const combo = comboOf(e);
    const cmd = activeKeymap().bindings[combo];
    if (!cmd) return;
    const target = e.target as HTMLElement | null;
    if (blocked(target, combo)) {
      const inPlainInput = !!target?.closest?.('input, select') && !isAnyDialogOpen() && !useEditors.getState().visible && !usePrompts.getState().queue.length;
      if (!(ALWAYS.has(cmd) && inPlainInput)) return;
    }
    if (!isAvailable(cmd)) return;
    e.preventDefault();
    e.stopPropagation();
    runCommand(cmd);
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
