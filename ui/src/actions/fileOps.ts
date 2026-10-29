// User-level file commands, shared by the toolbar, menus, context menu and keyboard shortcuts.
import type { CustomCommand, FileEntry, TransferOptions } from '../api/types';
import { call } from '../api/client';
import { normalizeError } from '../api/errors';
import { tr } from '../i18n';
import { formatBytes } from '../lib/format';
import { isArchive, isDirLike, isPdf, isPreviewableImage } from '../lib/fileTypes';
import * as P from '../lib/paths';
import { load, save } from '../lib/storage';
import { isWebUi, reloadBookmarks, sessionById, showDock, useApp } from '../store/app';
import { confirmWithCheckbox, inputDialog, openDialog } from '../store/dialogs';
import { openFile } from '../store/editors';
import {
  enterDir, focusedEntry, getPanel, goUp, navigate, other, PARENT, refresh, selectNone, startRename, stopRename, targets, type Side,
} from '../store/panels';
import { openTerminal } from '../store/terminals';
import { attempt, toast } from '../store/toasts';
import { upsertBg } from '../store/misc';

export const activeSide = (): Side => useApp.getState().activeSide;

const nameError = (v: string): string | null => (P.isValidName(v.trim()) ? null : tr('ops.invalidName'));

function sessionName(id: string) {
  return sessionById(id)?.name ?? id;
}

// ---------------------------------------------------------------- open / view / edit

export function openEntry(side: Side, entry: FileEntry) {
  if (entry.name === PARENT) return void goUp(side);
  if (isDirLike(entry)) return void enterDir(side, entry);
  const action = useApp.getState().settings?.doubleClickAction ?? 'edit';
  const p = getPanel(side);
  if (action === 'transfer') return copyEntries(side, [entry], false);
  if (action === 'open') {
    const info = useApp.getState().info;
    if (info?.mode === 'desktop') {
      if (p.session === 'local' && info.features.openLocal) return void attempt(() => call('app.open', { target: entry.path }));
      if (info.features.externalEdit) return void externalEdit(side, entry);
    }
    return void openFile(p.session, entry, 'view');
  }
  if (isPreviewableImage(entry.name) || isPdf(entry.name)) return void openFile(p.session, entry, 'view');
  void openFile(p.session, entry, 'edit');
}

export function openFocused(side: Side) {
  const e = focusedEntry(side);
  if (e) openEntry(side, e);
}

export function viewFocused(side: Side) {
  const e = focusedEntry(side);
  if (!e || e.name === PARENT) return;
  if (isDirLike(e)) return void enterDir(side, e);
  void openFile(getPanel(side).session, e, 'view');
}

export function editFocused(side: Side) {
  const e = focusedEntry(side);
  if (!e || e.name === PARENT || isDirLike(e)) return;
  void openFile(getPanel(side).session, e, 'edit');
}

export async function externalEdit(side: Side, entry?: FileEntry) {
  const e = entry ?? focusedEntry(side);
  if (!e || isDirLike(e) || e.name === PARENT) return;
  const r = await attempt(() => call('edit.external', { session: getPanel(side).session, path: e.path }));
  if (r) {
    upsertBg('edits', r);
    toast.info(tr('edit.externalStarted', { name: e.name }), tr('edit.externalHint'));
  }
}

export function openWithSystem(side: Side) {
  const e = focusedEntry(side);
  const p = getPanel(side);
  if (!e || p.session !== 'local') return;
  void attempt(() => call('app.open', { target: e.name === PARENT ? p.path : e.path }));
}

// ---------------------------------------------------------------- copy / move

export function copyEntries(side: Side, entries: FileEntry[], move: boolean, opts: { skipDialog?: boolean; dstSide?: Side; dstDir?: string; dstSession?: string } = {}) {
  const items = entries.filter((e) => e.name !== PARENT);
  if (!items.length) return;
  const src = getPanel(side);
  const dst = getPanel(opts.dstSide ?? other(side));
  const dstSession = opts.dstSession ?? dst.session;
  const dstDir = opts.dstDir ?? dst.path;
  if (opts.skipDialog || load('skipCopyDialog', false)) {
    void startTransfer(src.session, items.map((e) => e.path), dstSession, dstDir, { move });
    return;
  }
  openDialog('copy', { srcSession: src.session, entries: items, dstSession, dstDir, move, srcSide: side });
}

export function copySelection(side: Side, move: boolean, skipDialog = false) {
  const t = targets(side);
  if (!t.length) return toast.info(tr('ops.nothingSelected'));
  copyEntries(side, t, move, { skipDialog });
}

export async function startTransfer(srcSession: string, srcPaths: string[], dstSession: string, dstDir: string, options: Partial<TransferOptions>) {
  const job = await attempt(() => call('transfer.start', { srcSession, srcPaths, dstSession, dstDir, options }));
  if (job) {
    for (const side of ['left', 'right'] as Side[]) {
      const p = getPanel(side);
      if (p.session === srcSession && srcPaths.some((x) => P.dirname(x) === p.path)) {
        // clear the selection of the source panel like WinSCP does
        selectNone(side);
      }
    }
  }
  return job;
}

export function setSkipCopyDialog(v: boolean) {
  save('skipCopyDialog', v);
}

// ---------------------------------------------------------------- delete

export async function deleteSelection(side: Side) {
  const items = targets(side);
  if (!items.length) return toast.info(tr('ops.nothingSelected'));
  const p = getPanel(side);
  const settings = useApp.getState().settings;
  if (settings?.confirmDelete !== false) {
    const names = items.slice(0, 6).map((e) => `• ${e.name}${isDirLike(e) ? '/' : ''}`).join('\n') + (items.length > 6 ? `\n… ${tr('ops.andMore', { n: items.length - 6 })}` : '');
    const size = items.filter((e) => !isDirLike(e)).reduce((s, e) => s + e.size, 0);
    const { ok, checked } = await confirmWithCheckbox({
      title: tr('ops.deleteTitle'),
      message: tr('ops.deleteMessage', { n: items.length, session: sessionName(p.session) }),
      detail: names + (size ? `\n\n${tr('ops.filesSize', { size: formatBytes(size) })}` : ''),
      okLabel: tr('common.delete'),
      danger: true,
      checkbox: { label: tr('ops.dontAskAgain'), checked: false },
    });
    if (!ok) return;
    if (checked && settings) {
      const { patchSettings } = await import('../store/app');
      void patchSettings((s) => ({ ...s, confirmDelete: false }));
    }
  }
  const job = await attempt(() => call('fs.delete', { session: p.session, paths: items.map((e) => e.path) }), tr('ops.deleteTitle'));
  if (job) selectNone(side);
}

// ---------------------------------------------------------------- create / rename

export async function makeDir(side: Side) {
  const p = getPanel(side);
  const name = await inputDialog({ title: tr('ops.newFolder'), label: tr('ops.folderName'), value: tr('ops.newFolderDefault'), validate: nameError, okLabel: tr('common.create'), hint: tr('ops.mkdirHint') });
  if (!name) return;
  const parts = name.trim().split('/').filter(Boolean);
  const path = P.join(p.path, ...parts);
  const ok = await attempt(() => call('fs.mkdir', { session: p.session, path, parents: parts.length > 1 }), tr('ops.newFolder'));
  if (ok !== undefined) await navigate(side, p.session, p.path, { history: false, select: parts[0] });
}

export async function newFile(side: Side) {
  const p = getPanel(side);
  const name = await inputDialog({ title: tr('ops.newFile'), label: tr('ops.fileName'), value: 'new-file.txt', selectStem: true, validate: nameError, okLabel: tr('common.create') });
  if (!name) return;
  const path = P.join(p.path, name.trim());
  const ok = await attempt(() => call('fs.createFile', { session: p.session, path }), tr('ops.newFile'));
  if (ok === undefined) return;
  await navigate(side, p.session, p.path, { history: false, select: name.trim() });
  void openFile(p.session, { name: name.trim(), path, size: 0 }, 'edit');
}

export function renameFocused(side: Side) {
  const e = focusedEntry(side);
  if (!e || e.name === PARENT) return;
  startRename(side, e.name);
}

export async function commitRename(side: Side, oldName: string, newName: string): Promise<boolean> {
  const name = newName.trim();
  stopRename(side);
  if (!name || name === oldName) return true;
  if (!P.isValidName(name)) {
    toast.warning(tr('ops.invalidName'));
    return false;
  }
  const p = getPanel(side);
  try {
    await call('fs.rename', { session: p.session, from: P.join(p.path, oldName), to: P.join(p.path, name) });
    await navigate(side, p.session, p.path, { history: false, select: name });
    return true;
  } catch (e) {
    toast.error(e, tr('ops.rename'));
    return false;
  }
}

export async function renameDialog(side: Side) {
  const e = focusedEntry(side);
  if (!e || e.name === PARENT) return;
  const name = await inputDialog({ title: tr('ops.rename'), label: tr('ops.newName'), value: e.name, selectStem: true, validate: nameError, okLabel: tr('ops.rename') });
  if (name) await commitRename(side, e.name, name);
}

export function createSymlink(side: Side) {
  const p = getPanel(side);
  const e = focusedEntry(side);
  openDialog('symlink', { session: p.session, dir: p.path, target: e && e.name !== PARENT ? e.path : undefined });
}

// ---------------------------------------------------------------- properties, checksums, paths

export async function showProperties(side: Side) {
  const p = getPanel(side);
  let items = targets(side);
  if (!items.length) {
    const st = await attempt(() => call('fs.stat', { session: p.session, path: p.path }));
    if (!st) return;
    items = [st];
  }
  openDialog('properties', { session: p.session, entries: items, side });
}

export function showChecksum(side: Side) {
  const e = focusedEntry(side);
  if (!e || e.name === PARENT || isDirLike(e)) return toast.info(tr('ops.checksumFileOnly'));
  openDialog('checksum', { session: getPanel(side).session, entry: e });
}

export async function copyText(text: string, what?: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(tr('ops.copiedToClipboard'), what ?? (text.length > 120 ? text.slice(0, 117) + '…' : text));
  } catch {
    // fallback for insecure contexts
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      toast.success(tr('ops.copiedToClipboard'));
    } catch {
      toast.warning(tr('ops.clipboardFailed'));
    }
    ta.remove();
  }
}

export function copyPaths(side: Side) {
  const items = targets(side);
  const p = getPanel(side);
  const text = items.length ? items.map((e) => e.path).join('\n') : p.path;
  void copyText(text);
}

export async function copyUrl(side: Side) {
  const p = getPanel(side);
  const s = sessionById(p.session);
  if (!s) return;
  const e = focusedEntry(side);
  const path = e && e.name !== PARENT ? e.path : p.path;
  if (s.id === 'local') return void copyText(`file://${path.startsWith('/') ? '' : '/'}${path}`);
  const base = s.url.replace(/^([a-z0-9+.-]+:\/\/[^/]*).*$/i, '$1');
  void copyText(base + (path.startsWith('/') ? '' : '/') + path.split('/').map(encodeURIComponent).join('/'));
}

// ---------------------------------------------------------------- terminal, find, sync, bookmarks

export function openTerminalHere(side: Side) {
  const p = getPanel(side);
  const s = sessionById(p.session);
  if (s?.capabilities.terminal) return void openTerminal(p.session, p.path);
  const local = getPanel(other(side));
  void openTerminal('local', local.session === 'local' ? local.path : null);
}

export function newTerminal() {
  openTerminalHere(activeSide());
}

export function findFiles(side: Side) {
  const p = getPanel(side);
  openDialog('find', { session: p.session, root: p.path });
}

export function synchronize() {
  openDialog('sync', {});
}

export async function addBookmark(side: Side) {
  const p = getPanel(side);
  const s = sessionById(p.session);
  const name = await inputDialog({ title: tr('bookmarks.add'), label: tr('bookmarks.name'), value: P.basename(p.path) || p.path, okLabel: tr('common.add'), hint: `${s?.name ?? p.session}: ${p.path}` });
  if (!name) return;
  const scope = p.session === 'local' ? 'local' : s?.siteId || '*';
  const ok = await attempt(() => call('bookmarks.save', { bookmark: { id: '', name: name.trim(), scope, path: p.path } }));
  if (ok) {
    toast.success(tr('bookmarks.added'), name);
    void reloadBookmarks();
  }
}

export function selectMask(side: Side, select: boolean) {
  openDialog('selectMask', { side, select });
}

// ---------------------------------------------------------------- archives (local)

export async function extractArchive(side: Side) {
  const e = focusedEntry(side);
  const p = getPanel(side);
  if (!e || !isArchive(e.name)) return;
  const job = await attempt(() => call('archive.extract', { session: p.session, path: e.path, dstDir: p.path }));
  if (job) showDock('queue');
}

export function createArchive(side: Side) {
  const items = targets(side);
  if (!items.length) return toast.info(tr('ops.nothingSelected'));
  const p = getPanel(side);
  openDialog('createArchive', { session: p.session, paths: items.map((e) => e.path), dir: p.path });
}

// ---------------------------------------------------------------- custom commands

export async function runCustomCommand(side: Side, cmd: CustomCommand) {
  const p = getPanel(side);
  const items = targets(side);
  const session = cmd.target === 'local' ? 'local' : p.session;
  const cwd = cmd.target === 'local' && p.session !== 'local' ? getPanel(other(side)).path : p.path;
  try {
    const outputs = await call('commands.run', { id: cmd.id, session, cwd, names: items.map((e) => e.name) });
    if (cmd.showOutput) openDialog('commandOutput', { title: cmd.name, outputs });
    else {
      const failed = outputs.filter((o) => o.exitCode && o.exitCode !== 0);
      if (failed.length) openDialog('commandOutput', { title: cmd.name, outputs });
      else toast.success(tr('commands.done', { name: cmd.name }));
    }
    if (cmd.refresh) void refresh(side);
  } catch (e) {
    toast.error(e, cmd.name);
  }
}

// ---------------------------------------------------------------- web: upload/download

export async function uploadFromComputer(side: Side, directory = false) {
  const { pickBrowserFiles, collectFileList, uploadToSession } = await import('../api/web');
  const files = await pickBrowserFiles({ directory, multiple: true });
  if (!files) return;
  const p = getPanel(side);
  await uploadToSession(p.session, p.path, collectFileList(files));
}

export async function downloadToComputer(side: Side) {
  const items = targets(side);
  if (!items.length) return toast.info(tr('ops.nothingSelected'));
  const { downloadToComputer: dl } = await import('../api/web');
  await dl(getPanel(side).session, items);
}

export function canDownloadToComputer(): boolean {
  return isWebUi();
}

/** Opens a file in a new browser tab via /api/download?inline=1 (web mode). */
export async function openInBrowser(side: Side) {
  const e = focusedEntry(side);
  if (!e || isDirLike(e)) return;
  const { downloadUrl } = await import('../api/web');
  window.open(downloadUrl(getPanel(side).session, [e.path], true), '_blank', 'noopener');
}

export function describeError(e: unknown): string {
  return normalizeError(e).message;
}
