// The commands keyboard layouts bind to keys (see lib/keymaps.ts): what each one does, its
// name in menus and the help, its short label in the function key bar, and when it is
// available at all.
import type { TKey } from '../i18n';
import { tr } from '../i18n';
import { mode } from '../api/client';
import type { CommandId } from '../lib/keymaps';
import { isDirLike } from '../lib/fileTypes';
import * as P from '../lib/paths';
import { setLayout, showDock, toggleDock, toggleHidden, toggleSidebar, useApp, type Side } from '../store/app';
import { confirmDialog, openSingleton } from '../store/dialogs';
import { hasDirtyTabs } from '../store/editors';
import {
  clearCompare, compareDirectories, focusedEntry, getPanel, goBack, goForward, goRoot, goUp, navigate, PARENT, refresh, selectAll,
  selectNone, setSort, type SortKey,
} from '../store/panels';
import { useTerms } from '../store/terminals';
import { toast } from '../store/toasts';
import { requestUi } from '../store/uiRequests';
import { showContextMenu, type MenuItem } from '../components/Menu';
import { commandsSubmenu } from '../components/panel/panelMenu';
import { focusPathBar } from '../components/panel/PathBar';
import * as ops from './fileOps';
import { closeSession, openSiteManager } from './sessions';
import { undoLast } from './undo';

export interface Command {
  run: (side: Side) => void;
  /** Name in menus and the help. */
  label: TKey;
  /** Short label in the function key bar. */
  short: TKey;
  /** False hides the command in the key bar and lets its keys through. */
  available?: () => boolean;
}

const info = () => useApp.getState().info;
const desktop = () => info()?.mode === 'desktop';
const web = () => info()?.mode === 'web';
const hasTerminal = () => !!info()?.features.terminal;

// ---------------------------------------------------------------- helpers for single commands

/** Point below the cursor row of a panel (or its top left corner), for popup menus. */
function anchorPoint(side: Side): { x: number; y: number } {
  const body = document.querySelector<HTMLElement>(`[data-panel="${side}"] .ft-body`);
  const row = body?.querySelector<HTMLElement>('.ft-row.cursor');
  const r = row?.getBoundingClientRect() ?? body?.getBoundingClientRect();
  if (!r) return { x: 40, y: 80 };
  return row ? { x: r.left + 40, y: r.bottom } : { x: r.left + 40, y: r.top + 8 };
}

function popup(side: Side, items: MenuItem[]) {
  const { x, y } = anchorPoint(side);
  showContextMenu(x, y, items);
}

export function swapPanels() {
  const left = getPanel('left');
  const right = getPanel('right');
  void navigate('left', right.session, right.path, { select: right.cursor });
  void navigate('right', left.session, left.path, { select: left.cursor });
}

export function toggleCompare() {
  if (getPanel('left').compare) return clearCompare();
  const n = compareDirectories();
  toast.info(n ? tr('compare.found', { n }) : tr('compare.identical'));
}

function sortBy(side: Side, key: SortKey) {
  setSort(side, key);
}

/** Total Commander's Ctrl+←/→: shows the folder under the cursor (or the current one) in a panel. */
function showDirIn(side: Side, to: Side) {
  const p = getPanel(side);
  const e = focusedEntry(side);
  let path = p.path;
  if (e?.name === PARENT) path = P.parent(p.path) ?? p.path;
  else if (e && isDirLike(e)) path = e.path || P.join(p.path, e.name);
  void navigate(to, p.session, path);
}

function openDirUnderCursor(side: Side) {
  const e = focusedEntry(side);
  if (e && (e.name === PARENT || isDirLike(e))) ops.openEntry(side, e);
}

function userMenu(side: Side) {
  popup(side, [{ label: tr('cmd.userMenu'), header: true }, ...commandsSubmenu(side)]);
}

function dirHistory(side: Side) {
  const p = getPanel(side);
  const sessions = useApp.getState().sessions;
  const seen = new Set<string>([`${p.session}\n${p.path}`]);
  const items: MenuItem[] = [];
  for (const loc of [...p.back].reverse()) {
    const key = `${loc.session}\n${loc.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const s = loc.session === p.session ? null : sessions.find((x) => x.id === loc.session);
    if (loc.session !== p.session && !s) continue; // session closed meanwhile
    items.push({ label: s ? `${s.name}: ${loc.path}` : loc.path, onClick: () => void navigate(side, loc.session, loc.path) });
    if (items.length >= 20) break;
  }
  popup(side, [{ label: tr('cmd.dirHistory'), header: true }, ...(items.length ? items : [{ label: tr('history.empty'), disabled: true }])]);
}

function toggleTerminal(side: Side) {
  const st = useApp.getState();
  if (st.dockOpen && st.dockTab === 'terminal') return setLayout({ dockOpen: false });
  if (!useTerms.getState().tabs.some((t) => !t.exited)) return ops.openTerminalHere(side);
  showDock('terminal');
}

/** The external application: the system default locally, the watched external editor remotely. */
function openExternal(side: Side, fallback: 'view' | 'edit') {
  const e = focusedEntry(side);
  const p = getPanel(side);
  const i = info();
  if (!e || e.name === PARENT) return;
  if (i?.mode === 'desktop') {
    if (p.session === 'local' && i.features.openLocal) return ops.openWithSystem(side);
    if (p.session !== 'local' && i.features.externalEdit && !isDirLike(e)) return void ops.externalEdit(side, e);
  }
  if (i?.mode === 'web' && fallback === 'view' && !isDirLike(e)) return void ops.openInBrowser(side);
  if (fallback === 'view') ops.viewFocused(side);
  else ops.editFocused(side);
}

function localOnly(side: Side, fn: (side: Side) => unknown) {
  if (getPanel(side).session !== 'local') return toast.info(tr('archive.localOnly'));
  void fn(side);
}

async function quit() {
  if (mode !== 'desktop') return;
  const dirty = hasDirtyTabs();
  const ok = await confirmDialog({
    title: tr('quit.title'),
    message: dirty ? tr('quit.unsaved') : tr('quit.message'),
    okLabel: tr('quit.ok'),
    danger: dirty,
  });
  if (!ok) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().close();
}

function disconnect(side: Side) {
  const s = getPanel(side).session;
  if (s !== 'local') void closeSession(s);
}

// ---------------------------------------------------------------- the registry

export const COMMANDS: Record<CommandId, Command> = {
  help: { run: () => openSingleton('shortcuts', {}), label: 'help.shortcuts', short: 'key.help' },
  userMenu: { run: userMenu, label: 'cmd.userMenu', short: 'key.userMenu' },
  view: { run: (s) => ops.viewFocused(s), label: 'ops.view', short: 'key.view' },
  viewExternal: { run: (s) => openExternal(s, 'view'), label: 'cmd.viewExternal', short: 'key.viewExternal' },
  edit: { run: (s) => ops.editFocused(s), label: 'ops.edit', short: 'key.edit' },
  editExternal: { run: (s) => openExternal(s, 'edit'), label: 'ops.editExternal', short: 'key.editExternal', available: desktop },
  newFile: { run: (s) => void ops.newFile(s), label: 'ops.newFile', short: 'key.newFile' },
  copy: { run: (s) => ops.copySelection(s, false), label: 'ops.copy', short: 'key.copy' },
  copyQuick: { run: (s) => ops.copySelection(s, false, true), label: 'help.copyNoDialog', short: 'key.copyQuick' },
  move: { run: (s) => ops.copySelection(s, true), label: 'ops.move', short: 'key.move' },
  moveQuick: { run: (s) => ops.copySelection(s, true, true), label: 'help.moveNoDialog', short: 'key.moveQuick' },
  rename: { run: (s) => ops.renameFocused(s), label: 'ops.rename', short: 'key.rename' },
  mkdir: { run: (s) => void ops.makeDir(s), label: 'ops.newFolder', short: 'key.mkdir' },
  delete: { run: (s) => void ops.deleteSelection(s), label: 'common.delete', short: 'key.delete' },
  deletePermanent: { run: (s) => void ops.deleteSelection(s, true), label: 'ops.deletePermanently', short: 'key.deletePermanent' },
  menu: { run: () => requestUi('menubar'), label: 'cmd.menu', short: 'key.menu' },
  quit: { run: () => void quit(), label: 'cmd.quit', short: 'key.quit', available: () => mode === 'desktop' },
  refresh: { run: (s) => void refresh(s), label: 'common.refresh', short: 'key.refresh' },
  toggleHidden: { run: () => toggleHidden(), label: 'view.showHidden', short: 'key.hidden' },
  siteManager: { run: () => openSiteManager(), label: 'session.newSession', short: 'key.connect' },
  disconnect: { run: disconnect, label: 'session.close', short: 'key.disconnect' },
  terminal: { run: (s) => ops.openTerminalHere(s), label: 'terminal.open', short: 'key.terminal', available: hasTerminal },
  toggleTerminal: { run: toggleTerminal, label: 'cmd.toggleTerminal', short: 'key.terminal', available: hasTerminal },
  find: { run: (s) => ops.findFiles(s), label: 'find.title', short: 'key.find' },
  focusPath: { run: (s) => focusPathBar(s), label: 'help.focusPath', short: 'key.path' },
  addBookmark: { run: (s) => void ops.addBookmark(s), label: 'bookmarks.add', short: 'key.bookmark' },
  hotlist: { run: (s) => requestUi(`dropdown:bookmarks-${s}`), label: 'cmd.hotlist', short: 'key.hotlist' },
  sync: { run: () => ops.synchronize(), label: 'sync.title', short: 'key.sync' },
  sidebar: { run: () => setLayout({ sidebarOpen: !useApp.getState().sidebarOpen }), label: 'sidebar.toggle', short: 'key.sidebar' },
  explorer: { run: () => toggleSidebar('explorer'), label: 'explorer.title', short: 'key.explorer' },
  dock: { run: () => toggleDock(), label: 'dock.title', short: 'key.dock' },
  back: { run: (s) => void goBack(s), label: 'nav.back', short: 'key.back' },
  forward: { run: (s) => void goForward(s), label: 'nav.forward', short: 'key.forward' },
  root: { run: (s) => void goRoot(s), label: 'nav.root', short: 'key.root' },
  parentDir: { run: (s) => void goUp(s), label: 'nav.up', short: 'key.up' },
  openDir: { run: openDirUnderCursor, label: 'cmd.openDir', short: 'key.open' },
  dirHistory: { run: dirHistory, label: 'cmd.dirHistory', short: 'key.history' },
  copyPath: { run: (s) => ops.copyPaths(s), label: 'ops.copyPath', short: 'key.copyPath' },
  preferences: { run: () => openSingleton('preferences', {}), label: 'prefs.title', short: 'key.config' },
  openFile: { run: () => ops.openFileDialog(), label: 'openFile.title', short: 'key.openFile' },
  fingerprints: { run: (s) => ops.compareFingerprints(s), label: 'fp.menu', short: 'key.fingerprints' },
  upload: { run: (s) => void ops.uploadFromComputer(s), label: 'web.upload', short: 'key.upload', available: web },
  properties: { run: (s) => void ops.showProperties(s), label: 'ops.properties', short: 'key.properties' },
  undo: { run: () => void undoLast(), label: 'undo.menu', short: 'key.undo' },
  sortName: { run: (s) => sortBy(s, 'name'), label: 'cmd.sortName', short: 'key.sortName' },
  sortExt: { run: (s) => sortBy(s, 'type'), label: 'cmd.sortExt', short: 'key.sortExt' },
  sortTime: { run: (s) => sortBy(s, 'modified'), label: 'cmd.sortTime', short: 'key.sortTime' },
  sortSize: { run: (s) => sortBy(s, 'size'), label: 'cmd.sortSize', short: 'key.sortSize' },
  swapPanels: { run: () => swapPanels(), label: 'view.swapPanels', short: 'key.swap' },
  toLeft: { run: (s) => showDirIn(s, 'left'), label: 'cmd.toLeft', short: 'key.toLeft' },
  toRight: { run: (s) => showDirIn(s, 'right'), label: 'cmd.toRight', short: 'key.toRight' },
  compareDirs: { run: () => toggleCompare(), label: 'compare.title', short: 'key.compare' },
  selectAll: { run: (s) => selectAll(s), label: 'panel.selectAll', short: 'key.selectAll' },
  selectNone: { run: (s) => selectNone(s), label: 'select.none', short: 'key.selectNone' },
  pack: { run: (s) => localOnly(s, ops.createArchive), label: 'archive.create', short: 'key.pack' },
  unpack: { run: (s) => localOnly(s, ops.extractArchive), label: 'archive.extractHere', short: 'key.unpack' },
  driveLeft: { run: () => requestUi('dropdown:session-left'), label: 'cmd.driveLeft', short: 'key.left' },
  driveRight: { run: () => requestUi('dropdown:session-right'), label: 'cmd.driveRight', short: 'key.right' },
  quickFilter: { run: (s) => requestUi(`filter:${s}`), label: 'panel.filter', short: 'key.filter' },
};

export function isAvailable(id: CommandId): boolean {
  const c = COMMANDS[id];
  return !c.available || c.available();
}

/** Runs a command for the active panel (or `side`). Returns false when it is not available. */
export function runCommand(id: CommandId, side: Side = useApp.getState().activeSide): boolean {
  if (!isAvailable(id)) return false;
  COMMANDS[id].run(side);
  return true;
}

/** Puts the keyboard focus back on the file list of the active panel. */
export function focusActivePanel() {
  const side = useApp.getState().activeSide;
  document.querySelector<HTMLElement>(`[data-panel="${side}"] .ft-body`)?.focus();
}
