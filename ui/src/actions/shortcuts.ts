// Global keyboard shortcuts (window level). Panel navigation keys live in FileTable.
import { isAnyDialogOpen, openSingleton } from '../store/dialogs';
import { usePrompts } from '../store/misc';
import { useEditors } from '../store/editors';
import { setLayout, toggleDock, toggleHidden, useApp } from '../store/app';
import { goBack, goForward, goRoot, refresh, type Side } from '../store/panels';
import { useContextMenu } from '../components/Menu';
import { focusPathBar } from '../components/panel/PathBar';
import * as ops from './fileOps';
import { openSiteManager } from './sessions';

type Action = (side: Side, e: KeyboardEvent) => void;

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl';

/** Display form of a shortcut ('Ctrl+Shift+S' -> '⌘⇧S' on macOS). */
export function keyLabel(combo: string): string {
  if (!isMac) return combo;
  return combo.replace(/Ctrl\+/g, '⌘').replace(/Shift\+/g, '⇧').replace(/Alt\+/g, '⌥');
}

const web = () => useApp.getState().info?.mode === 'web';

export const BINDINGS: Record<string, Action> = {
  F2: (s) => ops.renameFocused(s),
  F3: (s) => ops.viewFocused(s),
  F4: (s) => ops.editFocused(s),
  'Shift+F4': (s) => void ops.newFile(s),
  F5: (s) => ops.copySelection(s, false),
  'Shift+F5': (s) => ops.copySelection(s, false, true),
  F6: (s) => ops.copySelection(s, true),
  'Shift+F6': (s) => ops.copySelection(s, true, true),
  F7: (s) => void ops.makeDir(s),
  F8: (s) => void ops.deleteSelection(s),
  Delete: (s) => void ops.deleteSelection(s),
  'Shift+Delete': (s) => void ops.deleteSelection(s),
  'Alt+Enter': (s) => void ops.showProperties(s),
  'Ctrl+R': (s) => void refresh(s),
  F9: (s) => void refresh(s),
  'Ctrl+H': () => toggleHidden(),
  'Ctrl+N': () => openSiteManager(),
  'Ctrl+T': (s) => ops.openTerminalHere(s),
  'Ctrl+F': (s) => ops.findFiles(s),
  'Ctrl+L': (s) => focusPathBar(s),
  'Ctrl+D': (s) => void ops.addBookmark(s),
  'Ctrl+Shift+S': () => ops.synchronize(),
  'Ctrl+B': () => setLayout({ sidebarOpen: !useApp.getState().sidebarOpen }),
  'Ctrl+J': () => toggleDock(),
  'Alt+ArrowLeft': (s) => void goBack(s),
  'Alt+ArrowRight': (s) => void goForward(s),
  'Ctrl+\\': (s) => void goRoot(s),
  'Ctrl+Shift+C': (s) => ops.copyPaths(s),
  'Ctrl+,': () => openSingleton('preferences', {}),
  'Ctrl+U': (s) => {
    if (web()) void ops.uploadFromComputer(s);
  },
  F1: () => openSingleton('shortcuts', {}),
};

export function comboOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (k.length === 1) k = k.toUpperCase();
  if (k === 'Del') k = 'Delete';
  parts.push(k);
  return parts.join('+');
}

function blocked(target: EventTarget | null): boolean {
  if (isAnyDialogOpen() || usePrompts.getState().queue.length > 0) return true;
  if (useEditors.getState().visible) return true;
  if (useContextMenu.getState().menu) return true;
  const el = target as HTMLElement | null;
  if (!el || !el.closest) return false;
  return !!el.closest('input, textarea, select, [contenteditable="true"], .xterm, .cm-editor, .menu');
}

export function installShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented || e.isComposing) return;
    const combo = comboOf(e);
    // a few shortcuts also work while typing in inputs outside of dialogs
    const always = combo === 'Ctrl+B' || combo === 'Ctrl+J';
    const target = e.target as HTMLElement | null;
    if (blocked(target)) {
      const inPlainInput = !!target?.closest?.('input, select') && !isAnyDialogOpen() && !useEditors.getState().visible && !usePrompts.getState().queue.length;
      if (!(always && inPlainInput)) return;
    }
    const action = BINDINGS[combo];
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    action(useApp.getState().activeSide, e);
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}

