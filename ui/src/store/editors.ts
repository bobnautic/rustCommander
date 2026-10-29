import { create } from 'zustand';
import type { FileEntry } from '../api/types';
import { call } from '../api/client';
import { normalizeError } from '../api/errors';
import { base64ToBytes, hexDump } from '../lib/base64';
import { applyEol, detectEol, detectIndent, splitBom, withBom, type Eol, type IndentStyle } from '../lib/editor/detect';
import { isPdf, isPreviewableImage } from '../lib/fileTypes';
import { formatDate } from '../lib/format';
import * as P from '../lib/paths';
import { load, save } from '../lib/storage';
import { useApp } from './app';
import { confirmDialog, openDialog } from './dialogs';
import { refreshWhere } from './panels';
import { toast } from './toasts';
import { tr } from '../i18n';

export const MAX_TEXT = 8 * 1024 * 1024;
const MAX_IMAGE = 25 * 1024 * 1024;

export type EditorKind = 'text' | 'image' | 'pdf' | 'binary';
export type Encoding = 'utf-8' | 'latin1';

export interface EditorTab {
  id: string;
  session: string;
  path: string;
  name: string;
  mode: 'edit' | 'view';
  kind: EditorKind;
  encoding: Encoding;
  /** Line ending written on save (the editor itself always works with '\n'). */
  eol: Eol;
  /** The file mixed CRLF and LF when it was loaded. */
  eolMixed: boolean;
  /** UTF-8 byte order mark at the start of the file. */
  bom: boolean;
  indent: IndentStyle;
  /** Language name chosen by the editor (CodeMirror language-data name), null = plain text. */
  language: string | null;
  /** Size and modification time on the server when last loaded or saved (to notice changes by others). */
  size: number;
  modified?: number | null;
  readOnly: boolean;
  truncated: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;
  dirty: boolean;
  /** Bumped when the content is replaced from outside (load/reload) so the editor remounts. */
  version: number;
  /** Bumped on every save (the "changes" view compares against the saved text). */
  savedVersion: number;
  dataUrl?: string;
  hex?: string;
}

interface EditorStore {
  tabs: EditorTab[];
  active: string | null;
  visible: boolean;
}

export const useEditors = create<EditorStore>(() => ({ tabs: [], active: null, visible: false }));

const contents = new Map<string, string>();
const originals = new Map<string, string>();
/** eol/bom/encoding as last saved; changing them makes the tab dirty too. */
const savedMeta = new Map<string, string>();

const metaOf = (t: Pick<EditorTab, 'eol' | 'bom' | 'encoding'>) => `${t.eol}|${t.bom}|${t.encoding}`;

export function getContent(id: string): string {
  return contents.get(id) ?? '';
}

/** The text as it was loaded or last saved. */
export function getOriginal(id: string): string {
  return originals.get(id) ?? '';
}

export function getTab(id: string): EditorTab | undefined {
  return useEditors.getState().tabs.find((t) => t.id === id);
}

function patchTab(id: string, p: Partial<EditorTab>) {
  useEditors.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...p } : t)) }));
}

function updateDirty(id: string) {
  const tab = getTab(id);
  if (!tab) return;
  const dirty = contents.get(id) !== originals.get(id) || metaOf(tab) !== savedMeta.get(id);
  if (tab.dirty !== dirty) patchTab(id, { dirty });
}

const tabId = (session: string, path: string, mode: string) => `${mode}:${session}:${path}`;

// ---------------------------------------------------------------- recent files

export interface RecentFile {
  /** 'local', a site id or the session URL – stable across reconnects. */
  key: string;
  path: string;
  name: string;
  at: number;
}

function sessionKey(session: string): string {
  if (session === 'local') return 'local';
  const s = useApp.getState().sessions.find((x) => x.id === session);
  return s?.siteId || s?.url || session;
}

export function sessionForKey(key: string): string | null {
  if (key === 'local') return 'local';
  const s = useApp.getState().sessions.find((x) => x.siteId === key || x.url === key || x.id === key);
  return s?.id ?? null;
}

export function recentFiles(): RecentFile[] {
  return load<RecentFile[]>('recentFiles', []);
}

function rememberRecent(session: string, path: string, name: string) {
  const key = sessionKey(session);
  const list = recentFiles().filter((r) => !(r.key === key && r.path === path));
  list.unshift({ key, path, name, at: Date.now() });
  save('recentFiles', list.slice(0, 30));
}

// ---------------------------------------------------------------- open / load

export async function openFile(session: string, entry: Pick<FileEntry, 'name' | 'path' | 'size'>, mode: 'edit' | 'view') {
  const id = tabId(session, entry.path, mode);
  const existing = getTab(id);
  if (existing) {
    useEditors.setState({ active: id, visible: true });
    return;
  }
  const kind: EditorKind = mode === 'view' && isPreviewableImage(entry.name) ? 'image' : mode === 'view' && isPdf(entry.name) ? 'pdf' : 'text';
  const tabSize = useApp.getState().settings?.editor.tabSize ?? 4;
  const tab: EditorTab = {
    id, session, path: entry.path, name: entry.name, mode, kind, encoding: 'utf-8', eol: '\n', eolMixed: false, bom: false,
    indent: { tabs: false, size: tabSize }, language: null, size: entry.size, readOnly: mode === 'view',
    truncated: false, loading: true, saving: false, error: null, dirty: false, version: 0, savedVersion: 0,
  };
  useEditors.setState((s) => ({ tabs: [...s.tabs, tab], active: id, visible: true }));
  if (kind === 'text') rememberRecent(session, entry.path, entry.name);
  await loadTab(id);
}

async function loadTab(id: string) {
  const tab = getTab(id);
  if (!tab) return;
  patchTab(id, { loading: true, error: null });
  try {
    if (tab.kind === 'image' || tab.kind === 'pdf') {
      const r = await call('fs.readBase64', { session: tab.session, path: tab.path, maxBytes: MAX_IMAGE });
      patchTab(id, { loading: false, dataUrl: `data:${r.mime};base64,${r.data}`, size: r.size, truncated: r.size > MAX_IMAGE });
      return;
    }
    const r = await call('fs.readText', { session: tab.session, path: tab.path, maxBytes: MAX_TEXT });
    if (r.binary) {
      let hex = '';
      try {
        const b = await call('fs.readBase64', { session: tab.session, path: tab.path, maxBytes: 4096 });
        hex = hexDump(base64ToBytes(b.data));
      } catch {
        /* hex preview is optional */
      }
      patchTab(id, { loading: false, kind: 'binary', readOnly: true, size: r.size, hex, modified: r.modified });
      return;
    }
    const { text, bom } = splitBom(r.content);
    const { eol, mixed } = detectEol(text);
    // CodeMirror splits lines at \r\n, \r and \n and joins them with \n
    const normalized = text.replace(/\r\n?/g, '\n');
    const tabSize = useApp.getState().settings?.editor.tabSize ?? 4;
    contents.set(id, normalized);
    originals.set(id, normalized);
    savedMeta.set(id, metaOf({ eol, bom, encoding: r.encoding }));
    const truncated = r.size > MAX_TEXT;
    patchTab(id, {
      loading: false, encoding: r.encoding, eol, eolMixed: mixed, bom, indent: detectIndent(normalized, { tabs: false, size: tabSize }),
      size: r.size, modified: r.modified, truncated, readOnly: tab.mode === 'view' || truncated, dirty: false, version: tab.version + 1,
    });
  } catch (e) {
    const err = normalizeError(e);
    patchTab(id, { loading: false, error: err.message });
  }
}

export function setContent(id: string, value: string) {
  contents.set(id, value);
  updateDirty(id);
}

/** Line ending, encoding, byte order mark, indentation or language chosen in the status bar. */
export function setTabOptions(id: string, p: Partial<Pick<EditorTab, 'eol' | 'encoding' | 'bom' | 'indent' | 'language'>>) {
  patchTab(id, p);
  updateDirty(id);
}

// ---------------------------------------------------------------- save

/** Bytes the backend will write for `text` (to compare with the size on the server). */
function encodedText(tab: EditorTab, text: string): string {
  return withBom(applyEol(text, tab.eol), tab.bom && tab.encoding === 'utf-8');
}

type ChangedChoice = 'overwrite' | 'compare' | 'cancel';

function askChangedOnServer(tab: EditorTab, modified?: number | null): Promise<ChangedChoice> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (c: ChangedChoice) => {
      if (!settled) resolve(c);
      settled = true;
    };
    openDialog('confirm', {
      title: tr('editor.changedTitle'),
      message: tr('editor.changedMessage', { name: tab.name }),
      detail: modified ? tr('editor.changedAt', { date: formatDate(modified) }) : undefined,
      okLabel: tr('editor.overwrite'),
      danger: true,
      alt: { label: tr('editor.compare'), onClick: () => done('compare') },
      resolve: (ok) => done(ok ? 'overwrite' : 'cancel'),
    });
  });
}

/** Compare the editor's text with the file as it is on the server now. */
export function compareWithServer(id: string) {
  const tab = getTab(id);
  if (!tab) return;
  openDialog('diff', {
    left: { label: tr('diff.onServer'), session: tab.session, path: tab.path, fileName: tab.name },
    right: { label: tr('diff.inEditor'), text: getContent(id), fileName: tab.name },
  });
}

export async function saveTab(id: string, opts: { force?: boolean } = {}): Promise<boolean> {
  const tab = getTab(id);
  if (!tab || tab.readOnly || tab.saving) return false;
  const content = contents.get(id) ?? '';
  patchTab(id, { saving: true });
  try {
    if (!opts.force && tab.modified) {
      // somebody else may have changed the file since we loaded it
      const now = await call('fs.stat', { session: tab.session, path: tab.path }).catch(() => null);
      if (now && (now.modified !== tab.modified || now.size !== tab.size)) {
        patchTab(id, { saving: false });
        const choice = await askChangedOnServer(tab, now.modified);
        if (choice === 'compare') compareWithServer(id);
        if (choice !== 'overwrite') return false;
        return saveTab(id, { force: true });
      }
    }
    await call('fs.writeText', { session: tab.session, path: tab.path, content: encodedText(tab, content), encoding: tab.encoding });
    originals.set(id, content);
    savedMeta.set(id, metaOf(tab));
    const st = await call('fs.stat', { session: tab.session, path: tab.path }).catch(() => null);
    patchTab(id, {
      saving: false, dirty: contents.get(id) !== content, eolMixed: false, savedVersion: tab.savedVersion + 1,
      size: st?.size ?? new TextEncoder().encode(encodedText(tab, content)).length, modified: st?.modified ?? Math.floor(Date.now() / 1000),
    });
    toast.success(tr('editor.saved', { name: tab.name }));
    refreshWhere(tab.session, P.dirname(tab.path));
    return true;
  } catch (e) {
    patchTab(id, { saving: false });
    toast.error(e, tr('editor.saveFailed'));
    return false;
  }
}

export async function reloadTab(id: string) {
  const tab = getTab(id);
  if (!tab) return;
  if (tab.dirty && !(await confirmDialog({ title: tr('editor.reload'), message: tr('editor.reloadConfirm', { name: tab.name }), okLabel: tr('editor.discard'), danger: true }))) return;
  await loadTab(id);
}

export async function closeTab(id: string): Promise<boolean> {
  const tab = getTab(id);
  if (!tab) return true;
  if (tab.dirty) {
    const ok = await confirmDialog({ title: tr('editor.unsavedTitle'), message: tr('editor.unsavedMessage', { name: tab.name }), okLabel: tr('editor.discard'), danger: true });
    if (!ok) return false;
  }
  contents.delete(id);
  originals.delete(id);
  savedMeta.delete(id);
  useEditors.setState((s) => {
    const idx = s.tabs.findIndex((t) => t.id === id);
    const tabs = s.tabs.filter((t) => t.id !== id);
    const active = s.active === id ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : s.active;
    return { tabs, active, visible: tabs.length > 0 && s.visible };
  });
  return true;
}

export async function closeAllTabs(): Promise<boolean> {
  for (const t of [...useEditors.getState().tabs]) {
    if (!(await closeTab(t.id))) return false;
  }
  return true;
}

export function setEditorVisible(visible: boolean) {
  useEditors.setState({ visible: visible && useEditors.getState().tabs.length > 0 });
}

export function setActiveTab(id: string) {
  useEditors.setState({ active: id });
}

export function hasDirtyTabs(): boolean {
  return useEditors.getState().tabs.some((t) => t.dirty);
}

// ---------------------------------------------------------------- cursor / problems (status bar)

export interface EditorStatus {
  line: number;
  col: number;
  /** Selected characters (all selections). */
  selected: number;
  selections: number;
  errors: number;
  warnings: number;
  infos: number;
}

export const useEditorStatus = create<EditorStatus>(() => ({ line: 1, col: 1, selected: 0, selections: 1, errors: 0, warnings: 0, infos: 0 }));
