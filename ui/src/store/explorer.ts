// Remote explorer: SSH targets (saved sites + ~/.ssh/config) browsed read-only as a tree.
// Directory listings are cached per session and path; tree rows are keyed per target and root
// so that the same folder can appear below several roots (e.g. '~' and '/').
import { create } from 'zustand';
import type { ExplorerTarget, FileEntry, FilePreview, SessionSummary } from '../api/types';
import { call } from '../api/client';
import { normalizeError, type RpcCallError } from '../api/errors';
import { isDirLike } from '../lib/fileTypes';
import * as P from '../lib/paths';
import { upsertSession, useApp } from './app';

/** A target in the tree; 'address' targets were connected by typing `user@host[:port]`. */
export type XTarget = Omit<ExplorerTarget, 'source'> & { source: ExplorerTarget['source'] | 'address' };

export interface DirNode {
  entries: FileEntry[] | null;
  loading: boolean;
  error: RpcCallError | null;
}

export interface TargetConn {
  session: string | null;
  connecting: boolean;
  error: RpcCallError | null;
  /** Directories shown as roots below the target. */
  roots: string[];
}

export interface Selection {
  /** Tree row the entry was selected in. */
  key: string;
  target: string;
  session: string;
  entry: FileEntry;
}

interface PreviewState {
  session: string;
  path: string;
  loading: boolean;
  data: FilePreview | null;
  error: string | null;
}

interface ExplorerStore {
  targets: ExplorerTarget[];
  adhoc: XTarget[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  filter: string;
  conns: Record<string, TargetConn>;
  /** dirKey(session, path) -> listing. */
  dirs: Record<string, DirNode>;
  /** Target ids and row keys of expanded folders. */
  expanded: Record<string, boolean>;
  /** dirKeys whose long listings are shown completely. */
  showAll: Record<string, boolean>;
  focus: string | null;
  selected: Selection | null;
  preview: PreviewState | null;
}

export const useExplorer = create<ExplorerStore>(() => ({
  targets: [],
  adhoc: [],
  loaded: false,
  loading: false,
  error: null,
  filter: '',
  conns: {},
  dirs: {},
  expanded: {},
  showAll: {},
  focus: null,
  selected: null,
  preview: null,
}));

const set = useExplorer.setState;
const get = useExplorer.getState;

export const dirKey = (session: string, path: string) => `${session}\u0000${path}`;
export const rowKey = (target: string, root: string, path: string) => `${target}\u0000${root}\u0000${path}`;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => Number(isDirLike(b)) - Number(isDirLike(a)) || collator.compare(a.name, b.name));
}

// ---------------------------------------------------------------- targets

export async function loadTargets() {
  set({ loading: true, error: null });
  try {
    set({ targets: await call('explorer.targets'), loaded: true, loading: false });
  } catch (e) {
    set({ loading: false, loaded: true, error: normalizeError(e).message });
  }
}

export function setExplorerFilter(filter: string) {
  set({ filter });
}

function liveSession(id: string | null | undefined): SessionSummary | undefined {
  return id ? useApp.getState().sessions.find((s) => s.id === id) : undefined;
}

/** The open session of a target: the explorer's own connection, or an open session of the same site. */
export function sessionOf(t: XTarget): SessionSummary | undefined {
  const own = liveSession(get().conns[t.id]?.session);
  if (own) return own;
  return t.siteId ? useApp.getState().sessions.find((s) => s.siteId === t.siteId) : undefined;
}

function rootsFor(s: SessionSummary): string[] {
  const roots = [s.initialDir, s.home, '/'].filter((p) => !!p).map((p) => P.normalize(p));
  return [...new Set(roots)];
}

function patchConn(id: string, patch: Partial<TargetConn>) {
  set((s) => {
    const prev: TargetConn = s.conns[id] ?? { session: null, connecting: false, error: null, roots: [] };
    return { conns: { ...s.conns, [id]: { ...prev, ...patch } } };
  });
}

function attach(t: XTarget, s: SessionSummary) {
  const roots = get().conns[t.id]?.session === s.id ? get().conns[t.id].roots : rootsFor(s);
  patchConn(t.id, { session: s.id, connecting: false, error: null, roots: roots.length ? roots : rootsFor(s) });
  const first = get().conns[t.id].roots[0] ?? '/';
  set((st) => ({ expanded: { ...st.expanded, [t.id]: true, [rowKey(t.id, first, first)]: true } }));
  void loadDir(s.id, first);
}

export async function connectTarget(t: XTarget): Promise<SessionSummary | null> {
  const existing = sessionOf(t);
  if (existing) {
    attach(t, existing);
    return existing;
  }
  if (get().conns[t.id]?.connecting) return null;
  patchConn(t.id, { connecting: true, error: null });
  set((st) => ({ expanded: { ...st.expanded, [t.id]: true } }));
  try {
    // address targets keep the typed form: it may be a URL
    const s = await call('explorer.connect', t.source === 'address' ? { address: t.name } : { target: t.id });
    upsertSession(s);
    attach(t, s);
    return s;
  } catch (e) {
    const err = normalizeError(e);
    patchConn(t.id, { connecting: false, error: err.code === 'cancelled' ? null : err });
    if (err.code === 'cancelled') set((st) => ({ expanded: { ...st.expanded, [t.id]: false } }));
    return null;
  }
}

/** `user@host:port` as typed into ssh. */
export function addressOf(t: Pick<ExplorerTarget, 'username' | 'host' | 'port'>): string {
  const host = t.host.includes(':') ? `[${t.host}]` : t.host;
  return `${t.username ? t.username + '@' : ''}${host}${t.port && t.port !== 22 ? ':' + t.port : ''}`;
}

/** Connect to a typed `user@host[:port]` (or URL) and show it as its own target. */
export async function connectAddress(address: string): Promise<boolean> {
  const a = address.trim();
  if (!a) return false;
  const m = /^(?:([^@\s]+)@)?(\[[^\]]+\]|[^:/\s]+)(?::(\d+))?/.exec(a.replace(/^(sftp|ssh|scp):\/\//, ''));
  const t: XTarget = {
    id: `addr:${a}`,
    source: 'address',
    name: a,
    folder: '',
    protocol: a.startsWith('scp://') ? 'scp' : 'sftp',
    host: m ? m[2].replace(/^\[|\]$/g, '') : a,
    port: m?.[3] ? parseInt(m[3], 10) : 22,
    username: m?.[1] ?? '',
    siteId: null,
    jump: null,
    color: null,
  };
  if (!get().adhoc.some((x) => x.id === t.id)) set((s) => ({ adhoc: [...s.adhoc, t] }));
  set({ filter: '', focus: t.id });
  return !!(await connectTarget(t));
}

export function removeAdhoc(id: string) {
  set((s) => ({ adhoc: s.adhoc.filter((t) => t.id !== id) }));
}

export function toggleTarget(t: XTarget) {
  if (get().expanded[t.id]) {
    set((st) => ({ expanded: { ...st.expanded, [t.id]: false } }));
    return;
  }
  const s = sessionOf(t);
  const conn = get().conns[t.id];
  if (s && conn?.session === s.id && conn.roots.length) set((st) => ({ expanded: { ...st.expanded, [t.id]: true } }));
  else void connectTarget(t);
}

/** Add another root directory below a connected target and expand it. */
export function addRoot(t: XTarget, path: string) {
  const s = sessionOf(t);
  if (!s) return;
  const root = P.normalize(path);
  const conn = get().conns[t.id];
  const roots = conn?.session === s.id ? conn.roots : rootsFor(s);
  patchConn(t.id, { session: s.id, roots: roots.includes(root) ? roots : [...roots, root] });
  const key = rowKey(t.id, root, root);
  set((st) => ({ expanded: { ...st.expanded, [t.id]: true, [key]: true }, focus: key }));
  void loadDir(s.id, root, true);
}

// ---------------------------------------------------------------- directories

/** Latest request per folder: an older, slower answer must not overwrite a newer one. */
const loadSeq = new Map<string, number>();

export async function loadDir(session: string, path: string, force = false) {
  const key = dirKey(session, path);
  const cur = get().dirs[key];
  if (cur && !force && (cur.entries || cur.loading)) return;
  set((s) => ({ dirs: { ...s.dirs, [key]: { entries: cur?.entries ?? null, loading: true, error: null } } }));
  const seq = (loadSeq.get(key) ?? 0) + 1;
  loadSeq.set(key, seq);
  try {
    const res = await call('fs.list', { session, path });
    if (loadSeq.get(key) === seq) set((s) => ({ dirs: { ...s.dirs, [key]: { entries: sortEntries(res.entries), loading: false, error: null } } }));
  } catch (e) {
    if (loadSeq.get(key) === seq) set((s) => ({ dirs: { ...s.dirs, [key]: { entries: null, loading: false, error: normalizeError(e) } } }));
  }
}

export function toggleDir(key: string, session: string, path: string) {
  const open = !get().expanded[key];
  set((s) => ({ expanded: { ...s.expanded, [key]: open } }));
  if (open) void loadDir(session, path);
}

export function showAllOf(key: string) {
  set((s) => ({ showAll: { ...s.showAll, [key]: true } }));
}

// ---------------------------------------------------------------- selection & preview

export function setFocus(key: string | null) {
  if (get().focus !== key) set({ focus: key });
}

export function selectEntry(sel: Selection | null) {
  const prev = get().preview;
  const keep = prev && sel && prev.session === sel.session && prev.path === sel.entry.path;
  set({ selected: sel, preview: keep ? prev : null });
}

export async function loadPreview(session: string, path: string, force = false) {
  const prev = get().preview;
  if (!force && prev?.session === session && prev.path === path && (prev.loading || prev.data)) return;
  set({ preview: { session, path, loading: true, data: null, error: null } });
  try {
    const data = await call('explorer.preview', { session, path });
    const cur = get().preview;
    if (cur?.session === session && cur.path === path) set({ preview: { session, path, loading: false, data, error: null } });
  } catch (e) {
    const cur = get().preview;
    if (cur?.session === session && cur.path === path) set({ preview: { session, path, loading: false, data: null, error: normalizeError(e).message } });
  }
}

export function closePreview() {
  set({ preview: null });
}

// ---------------------------------------------------------------- backend events

export function explorerSessionClosed(id: string) {
  // answers still in flight for this session are dropped
  for (const k of [...loadSeq.keys()]) if (k.startsWith(id + '\u0000')) loadSeq.delete(k);
  set((s) => {
    const conns = { ...s.conns };
    const expanded = { ...s.expanded };
    for (const [t, c] of Object.entries(conns)) {
      if (c.session !== id) continue;
      conns[t] = { ...c, session: null, roots: [] };
      expanded[t] = false;
    }
    const dirs = Object.fromEntries(Object.entries(s.dirs).filter(([k]) => !k.startsWith(id + '\u0000')));
    return {
      conns,
      expanded,
      dirs,
      selected: s.selected?.session === id ? null : s.selected,
      preview: s.preview?.session === id ? null : s.preview,
    };
  });
}

const changeTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Reloads a shown folder after an operation changed it (events come in bursts during jobs). */
export function explorerFsChanged(session: string, path: string) {
  const dir = P.normalize(path);
  const key = dirKey(session, dir);
  if (!get().dirs[key]) return;
  clearTimeout(changeTimers.get(key));
  changeTimers.set(
    key,
    setTimeout(() => {
      changeTimers.delete(key);
      if (get().dirs[key]) void loadDir(session, dir, true);
    }, 150),
  );
}
