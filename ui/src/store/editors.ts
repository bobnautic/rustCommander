import { create } from 'zustand';
import type { FileEntry } from '../api/types';
import { call } from '../api/client';
import { normalizeError } from '../api/errors';
import { base64ToBytes, hexDump } from '../lib/base64';
import { isPdf, isPreviewableImage } from '../lib/fileTypes';
import * as P from '../lib/paths';
import { confirmDialog } from './dialogs';
import { refreshWhere } from './panels';
import { toast } from './toasts';
import { tr } from '../i18n';

export const MAX_TEXT = 8 * 1024 * 1024;
const MAX_IMAGE = 25 * 1024 * 1024;

export type EditorKind = 'text' | 'image' | 'pdf' | 'binary';

export interface EditorTab {
  id: string;
  session: string;
  path: string;
  name: string;
  mode: 'edit' | 'view';
  kind: EditorKind;
  encoding: 'utf-8' | 'latin1';
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

export function getContent(id: string): string {
  return contents.get(id) ?? '';
}

function patchTab(id: string, p: Partial<EditorTab>) {
  useEditors.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...p } : t)) }));
}

const tabId = (session: string, path: string, mode: string) => `${mode}:${session}:${path}`;

export async function openFile(session: string, entry: Pick<FileEntry, 'name' | 'path' | 'size'>, mode: 'edit' | 'view') {
  const id = tabId(session, entry.path, mode);
  const existing = useEditors.getState().tabs.find((t) => t.id === id);
  if (existing) {
    useEditors.setState({ active: id, visible: true });
    return;
  }
  const kind: EditorKind = mode === 'view' && isPreviewableImage(entry.name) ? 'image' : mode === 'view' && isPdf(entry.name) ? 'pdf' : 'text';
  const tab: EditorTab = {
    id, session, path: entry.path, name: entry.name, mode, kind, encoding: 'utf-8', size: entry.size, readOnly: mode === 'view',
    truncated: false, loading: true, saving: false, error: null, dirty: false, version: 0,
  };
  useEditors.setState((s) => ({ tabs: [...s.tabs, tab], active: id, visible: true }));
  await loadTab(id);
}

async function loadTab(id: string) {
  const tab = useEditors.getState().tabs.find((t) => t.id === id);
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
    contents.set(id, r.content);
    originals.set(id, r.content);
    const truncated = r.size > MAX_TEXT;
    patchTab(id, {
      loading: false, encoding: r.encoding, size: r.size, modified: r.modified, truncated,
      readOnly: tab.mode === 'view' || truncated, dirty: false, version: tab.version + 1,
    });
  } catch (e) {
    const err = normalizeError(e);
    patchTab(id, { loading: false, error: err.message });
  }
}

export function setContent(id: string, value: string) {
  contents.set(id, value);
  const dirty = value !== originals.get(id);
  const tab = useEditors.getState().tabs.find((t) => t.id === id);
  if (tab && tab.dirty !== dirty) patchTab(id, { dirty });
}

export async function saveTab(id: string): Promise<boolean> {
  const tab = useEditors.getState().tabs.find((t) => t.id === id);
  if (!tab || tab.readOnly || tab.saving) return false;
  const content = contents.get(id) ?? '';
  patchTab(id, { saving: true });
  try {
    await call('fs.writeText', { session: tab.session, path: tab.path, content, encoding: tab.encoding });
    originals.set(id, content);
    patchTab(id, { saving: false, dirty: false, size: new TextEncoder().encode(content).length, modified: Math.floor(Date.now() / 1000) });
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
  const tab = useEditors.getState().tabs.find((t) => t.id === id);
  if (!tab) return;
  if (tab.dirty && !(await confirmDialog({ title: tr('editor.reload'), message: tr('editor.reloadConfirm', { name: tab.name }), okLabel: tr('editor.discard'), danger: true }))) return;
  await loadTab(id);
}

export async function closeTab(id: string): Promise<boolean> {
  const tab = useEditors.getState().tabs.find((t) => t.id === id);
  if (!tab) return true;
  if (tab.dirty) {
    const ok = await confirmDialog({ title: tr('editor.unsavedTitle'), message: tr('editor.unsavedMessage', { name: tab.name }), okLabel: tr('editor.discard'), danger: true });
    if (!ok) return false;
  }
  contents.delete(id);
  originals.delete(id);
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
