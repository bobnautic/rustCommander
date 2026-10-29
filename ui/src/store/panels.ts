import { create } from 'zustand';
import type { DiskInfo, FileEntry, SessionSummary } from '../api/types';
import { call } from '../api/client';
import { normalizeError, RpcCallError } from '../api/errors';
import * as P from '../lib/paths';
import { load, save } from '../lib/storage';
import { categoryOf, isDirLike } from '../lib/fileTypes';
import { compileMask, matchSelectMask } from '../lib/mask';
import { sessionById, setLayout, useApp, type Side } from './app';
import { toast } from './toasts';
import { tr } from '../i18n';

export type { Side } from './app';
export type SortKey = 'name' | 'size' | 'type' | 'modified' | 'permissions' | 'owner';
export type CompareMark = 'only' | 'newer' | 'older' | 'differs';

export interface Loc {
  session: string;
  path: string;
}

export interface PanelState {
  side: Side;
  session: string;
  path: string;
  entries: FileEntry[];
  loading: boolean;
  error: RpcCallError | null;
  selected: ReadonlySet<string>;
  cursor: string | null;
  anchor: string | null;
  renaming: string | null;
  sortKey: SortKey;
  sortDesc: boolean;
  filter: string;
  back: Loc[];
  fwd: Loc[];
  disk: DiskInfo | null;
  compare: Record<string, CompareMark> | null;
  lastPaths: Record<string, string>;
  seq: number;
  loaded: boolean;
}

interface PanelsStore {
  left: PanelState;
  right: PanelState;
}

interface SavedPanel {
  session: string;
  path: string;
  sortKey: SortKey;
  sortDesc: boolean;
  lastPaths: Record<string, string>;
}

function emptyPanel(side: Side): PanelState {
  return {
    side,
    session: 'local',
    path: '',
    entries: [],
    loading: false,
    error: null,
    selected: new Set(),
    cursor: null,
    anchor: null,
    renaming: null,
    sortKey: 'name',
    sortDesc: false,
    filter: '',
    back: [],
    fwd: [],
    disk: null,
    compare: null,
    lastPaths: {},
    seq: 0,
    loaded: false,
  };
}

export const usePanels = create<PanelsStore>(() => ({ left: emptyPanel('left'), right: emptyPanel('right') }));

export const other = (side: Side): Side => (side === 'left' ? 'right' : 'left');
export const getPanel = (side: Side) => usePanels.getState()[side];

function patch(side: Side, p: Partial<PanelState>) {
  usePanels.setState((s) => ({ [side]: { ...s[side], ...p } }) as Partial<PanelsStore>);
}

export const patchPanel = patch;

function persist() {
  const s = usePanels.getState();
  const pick = (p: PanelState): SavedPanel => ({ session: p.session, path: p.path, sortKey: p.sortKey, sortDesc: p.sortDesc, lastPaths: p.lastPaths });
  save('panels', { left: pick(s.left), right: pick(s.right) });
}

// ---------------------------------------------------------------- view (sorted/filtered rows)

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const PARENT = '..';

function compareEntries(a: FileEntry, b: FileEntry, key: SortKey): number {
  switch (key) {
    case 'size':
      return a.size - b.size || collator.compare(a.name, b.name);
    case 'modified':
      return (a.modified ?? 0) - (b.modified ?? 0) || collator.compare(a.name, b.name);
    case 'type': {
      const ca = categoryOf(a);
      const cb = categoryOf(b);
      const ea = P.extname(a.name);
      const eb = P.extname(b.name);
      return collator.compare(ca, cb) || collator.compare(ea, eb) || collator.compare(a.name, b.name);
    }
    case 'permissions':
      return (a.permissions ?? 0) - (b.permissions ?? 0) || collator.compare(a.name, b.name);
    case 'owner':
      return collator.compare(a.owner ?? '', b.owner ?? '') || collator.compare(a.name, b.name);
    default:
      return collator.compare(a.name, b.name);
  }
}

interface ViewCacheEntry {
  key: string;
  rows: FileEntry[];
}
const viewCache = new WeakMap<FileEntry[], ViewCacheEntry>();

/** Visible entries (without '..'): hidden filtered, quick filter applied, sorted with directories first. */
export function viewRows(p: PanelState, showHidden: boolean): FileEntry[] {
  const key = `${p.sortKey}|${p.sortDesc}|${showHidden}|${p.filter}`;
  const c = viewCache.get(p.entries);
  if (c && c.key === key) return c.rows;
  let rows = p.entries;
  if (!showHidden) rows = rows.filter((e) => !e.hidden);
  if (p.filter) {
    const f = p.filter.trim();
    if (/[*?[]/.test(f)) {
      const m = compileMask(f);
      rows = rows.filter((e) => matchSelectMask(m, e.name, isDirLike(e)));
    } else {
      const fl = f.toLowerCase();
      rows = rows.filter((e) => e.name.toLowerCase().includes(fl));
    }
  }
  const dir = p.sortDesc ? -1 : 1;
  rows = [...rows].sort((a, b) => {
    const da = isDirLike(a) ? 0 : 1;
    const db = isDirLike(b) ? 0 : 1;
    if (da !== db) return da - db;
    // directories keep name order when sorting by size
    if (da === 0 && p.sortKey === 'size') return collator.compare(a.name, b.name);
    return compareEntries(a, b, p.sortKey) * dir;
  });
  viewCache.set(p.entries, { key, rows });
  return rows;
}

export function parentEntry(p: PanelState): FileEntry | null {
  const par = P.parent(p.path);
  if (par === null) return null;
  return { name: PARENT, path: par, kind: 'dir', size: 0, hidden: false };
}

/** Rows including the '..' entry. */
export function allRows(p: PanelState, showHidden: boolean): FileEntry[] {
  const rows = viewRows(p, showHidden);
  const par = parentEntry(p);
  return par ? [par, ...rows] : rows;
}

const showHidden = () => useApp.getState().settings?.showHidden ?? false;

export function currentRows(side: Side): FileEntry[] {
  return allRows(getPanel(side), showHidden());
}

/** Entries an operation applies to: the selection, or the focused entry (never '..'). */
export function targets(side: Side): FileEntry[] {
  const p = getPanel(side);
  const rows = viewRows(p, showHidden());
  if (p.selected.size) return rows.filter((e) => p.selected.has(e.name));
  if (p.cursor && p.cursor !== PARENT) {
    const e = p.entries.find((x) => x.name === p.cursor);
    if (e) return [e];
  }
  return [];
}

export function focusedEntry(side: Side): FileEntry | null {
  const p = getPanel(side);
  if (!p.cursor) return null;
  if (p.cursor === PARENT) return parentEntry(p);
  return p.entries.find((e) => e.name === p.cursor) ?? null;
}

// ---------------------------------------------------------------- loading & navigation

export interface NavOpts {
  select?: string | null;
  history?: boolean;
  /** Called by sync browsing for the other panel – do not propagate again. */
  noSync?: boolean;
}

/** Load `path` of `session` into the panel. Returns true on success. */
export async function navigate(side: Side, session: string, path: string, opts: NavOpts = {}): Promise<boolean> {
  const st = getPanel(side);
  const seq = st.seq + 1;
  patch(side, { seq, loading: true });
  const target = P.normalize(path || '/');
  try {
    const res = await call('fs.list', { session, path: target });
    const cur = getPanel(side);
    if (cur.seq !== seq) return false;
    const newPath = P.normalize(res.path || target);
    const sameDir = cur.session === session && cur.path === newPath;
    let { back, fwd } = cur;
    if (opts.history !== false && !sameDir && cur.loaded) {
      back = [...back, { session: cur.session, path: cur.path }].slice(-60);
      fwd = [];
    }
    const names = new Set(res.entries.map((e) => e.name));
    const selected = sameDir ? new Set([...cur.selected].filter((n) => names.has(n))) : new Set<string>();
    let cursor = opts.select !== undefined ? opts.select : sameDir ? cur.cursor : null;
    if (cursor && cursor !== PARENT && !names.has(cursor)) cursor = null;
    patch(side, {
      session,
      path: newPath,
      entries: res.entries,
      loading: false,
      error: null,
      selected,
      cursor,
      anchor: sameDir ? cur.anchor : null,
      renaming: sameDir ? cur.renaming : null,
      back,
      fwd,
      filter: sameDir ? cur.filter : '',
      compare: sameDir ? cur.compare : null,
      lastPaths: { ...cur.lastPaths, [session]: newPath },
      loaded: true,
      disk: cur.session === session ? cur.disk : null,
    });
    persist();
    void loadDisk(side);
    return true;
  } catch (e) {
    const cur = getPanel(side);
    if (cur.seq !== seq) return false;
    const err = normalizeError(e);
    const sameDir = cur.session === session && cur.path === target;
    let { back, fwd } = cur;
    if (opts.history !== false && !sameDir && cur.loaded) {
      back = [...back, { session: cur.session, path: cur.path }].slice(-60);
      fwd = [];
    }
    patch(side, {
      session,
      path: target,
      entries: [],
      loading: false,
      error: err,
      selected: new Set(),
      cursor: null,
      back,
      fwd,
      compare: null,
      loaded: true,
    });
    persist();
    return false;
  }
}

export function refresh(side: Side) {
  const p = getPanel(side);
  if (!p.path) return Promise.resolve(false);
  return navigate(side, p.session, p.path, { history: false });
}

export function refreshWhere(session: string, path: string) {
  for (const side of ['left', 'right'] as Side[]) {
    const p = getPanel(side);
    if (p.session === session && p.path === P.normalize(path) && !p.loading) void refresh(side);
  }
}

export function refreshSession(session: string) {
  for (const side of ['left', 'right'] as Side[]) if (getPanel(side).session === session) void refresh(side);
}

export async function loadDisk(side: Side) {
  const p = getPanel(side);
  const s = sessionById(p.session);
  if (!s?.capabilities.diskInfo) {
    if (p.disk) patch(side, { disk: null });
    return;
  }
  try {
    const d = await call('fs.diskInfo', { session: p.session, path: p.path });
    const cur = getPanel(side);
    if (cur.session === p.session) patch(side, { disk: d });
  } catch {
    /* not essential */
  }
}

/** Navigate into a child directory (handles synchronized browsing). */
export async function enterDir(side: Side, entry: FileEntry) {
  const p = getPanel(side);
  const ok = await navigate(side, p.session, entry.path || P.join(p.path, entry.name), { select: null });
  if (ok && useApp.getState().syncBrowse) {
    const o = getPanel(other(side));
    const ok2 = await navigate(other(side), o.session, P.join(o.path, entry.name), { noSync: true });
    if (!ok2) {
      setLayout({ syncBrowse: false });
      await navigate(other(side), o.session, o.path, { history: false });
      toast.warning(tr('panel.syncBrowseOff'), tr('panel.syncBrowseMissing', { name: entry.name }));
    }
  }
}

export async function goUp(side: Side) {
  const p = getPanel(side);
  const par = P.parent(p.path);
  if (par === null) return;
  const ok = await navigate(side, p.session, par, { select: P.basename(p.path) });
  if (ok && useApp.getState().syncBrowse) {
    const o = getPanel(other(side));
    const opar = P.parent(o.path);
    if (opar !== null) await navigate(other(side), o.session, opar, { select: P.basename(o.path), noSync: true });
  }
}

export async function goBack(side: Side) {
  const p = getPanel(side);
  const loc = p.back[p.back.length - 1];
  if (!loc) return;
  const back = p.back.slice(0, -1);
  const fwd = [...p.fwd, { session: p.session, path: p.path }];
  patch(side, { back, fwd });
  const ok = await navigate(side, loc.session, loc.path, { history: false, select: undefined });
  if (!ok) patch(side, { back, fwd });
}

export async function goForward(side: Side) {
  const p = getPanel(side);
  const loc = p.fwd[p.fwd.length - 1];
  if (!loc) return;
  const fwd = p.fwd.slice(0, -1);
  const back = [...p.back, { session: p.session, path: p.path }];
  patch(side, { back, fwd });
  await navigate(side, loc.session, loc.path, { history: false });
}

export function goHome(side: Side) {
  const p = getPanel(side);
  const s = sessionById(p.session);
  return navigate(side, p.session, s?.home || '/');
}

export function goRoot(side: Side) {
  const p = getPanel(side);
  const m = /^([A-Za-z]:)/.exec(p.path);
  return navigate(side, p.session, m ? m[1] + '/' : '/');
}

/** Switch the panel to another session, at its last known path or its initial directory. */
export function switchSession(side: Side, sessionId: string) {
  const p = getPanel(side);
  const s = sessionById(sessionId);
  if (!s) return Promise.resolve(false);
  const path = p.lastPaths[sessionId] || s.initialDir || s.home || '/';
  return navigate(side, sessionId, path, { select: null });
}

/** Panel that should show a remote session (used by session tabs / new connections). */
export function remoteSide(): Side {
  const { activeSide } = useApp.getState();
  const s = usePanels.getState();
  if (s[activeSide].session !== 'local') return activeSide;
  if (s[other(activeSide)].session !== 'local') return other(activeSide);
  return 'right';
}

/** Show a freshly opened session: remote in the right panel, the site's local dir in the left. */
export async function showNewSession(s: SessionSummary) {
  const side = remoteSide();
  await navigate(side, s.id, s.initialDir || s.home || '/', { select: null });
  // on phones only one panel is visible: show the new session
  if (useApp.getState().narrow) useApp.setState({ activeSide: side });
  if (s.localDir) {
    const o = other(side);
    await navigate(o, 'local', s.localDir, { select: null });
  }
}

/** Panels showing a closed session fall back to Local. */
export function onSessionClosed(id: string) {
  for (const side of ['left', 'right'] as Side[]) {
    const p = getPanel(side);
    if (p.session === id) {
      const local = sessionById('local');
      void navigate(side, 'local', p.lastPaths.local || local?.home || '/', { history: false });
      const back = p.back.filter((l) => l.session !== id);
      const fwd = p.fwd.filter((l) => l.session !== id);
      patch(side, { back, fwd });
    }
  }
}

export async function initPanels(sessions: SessionSummary[]) {
  const saved = load<{ left?: SavedPanel; right?: SavedPanel } | null>('panels', null);
  const has = (id: string | undefined) => !!id && sessions.some((s) => s.id === id);
  const local = sessions.find((s) => s.id === 'local');
  const remotes = sessions.filter((s) => s.id !== 'local').sort((a, b) => b.connectedAt - a.connectedAt);
  const sides: Side[] = ['left', 'right'];
  await Promise.all(
    sides.map((side) => {
      const sv = saved?.[side];
      let session: string;
      let path: string;
      if (sv && has(sv.session)) {
        session = sv.session;
        path = sv.path;
      } else if (side === 'right' && remotes[0]) {
        session = remotes[0].id;
        path = remotes[0].initialDir;
      } else {
        session = 'local';
        path = sv?.lastPaths?.local || local?.home || '/';
      }
      patch(side, {
        sortKey: sv?.sortKey ?? 'name',
        sortDesc: sv?.sortDesc ?? false,
        lastPaths: Object.fromEntries(Object.entries(sv?.lastPaths ?? {}).filter(([k]) => has(k))),
      });
      return navigate(side, session, path || '/', { history: false, select: null }).then((ok) => {
        if (!ok && session !== 'local') return navigate(side, 'local', local?.home || '/', { history: false });
        if (!ok && path !== (local?.home ?? '/')) return navigate(side, 'local', local?.home || '/', { history: false });
        return ok;
      });
    }),
  );
}

// ---------------------------------------------------------------- selection

export function setCursor(side: Side, name: string | null) {
  patch(side, { cursor: name });
}

export function setSort(side: Side, key: SortKey) {
  const p = getPanel(side);
  patch(side, p.sortKey === key ? { sortDesc: !p.sortDesc } : { sortKey: key, sortDesc: key === 'modified' || key === 'size' });
  persist();
}

export function setFilter(side: Side, filter: string) {
  patch(side, { filter });
}

export function setSelected(side: Side, names: Iterable<string>) {
  const set = new Set(names);
  set.delete(PARENT);
  patch(side, { selected: set });
}

export function toggleSelected(side: Side, name: string) {
  if (name === PARENT) return;
  const p = getPanel(side);
  const set = new Set(p.selected);
  if (set.has(name)) set.delete(name);
  else set.add(name);
  patch(side, { selected: set, anchor: name });
}

export function selectRange(side: Side, from: string | null, to: string, additive: boolean) {
  const p = getPanel(side);
  const rows = allRows(p, showHidden());
  const idx = (n: string | null) => rows.findIndex((r) => r.name === n);
  let a = idx(from);
  const b = idx(to);
  if (a < 0) a = b;
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  const set = additive ? new Set(p.selected) : new Set<string>();
  for (let i = lo; i <= hi; i++) if (rows[i] && rows[i].name !== PARENT) set.add(rows[i].name);
  patch(side, { selected: set, cursor: to });
}

export function selectAll(side: Side) {
  setSelected(side, viewRows(getPanel(side), showHidden()).map((e) => e.name));
}

export function selectNone(side: Side) {
  setSelected(side, []);
}

export function invertSelection(side: Side) {
  const p = getPanel(side);
  setSelected(side, viewRows(p, showHidden()).filter((e) => !p.selected.has(e.name)).map((e) => e.name));
}

export function selectByMask(side: Side, mask: string, select: boolean) {
  const p = getPanel(side);
  const m = compileMask(mask);
  const set = new Set(p.selected);
  let n = 0;
  for (const e of viewRows(p, showHidden())) {
    if (matchSelectMask(m, e.name, isDirLike(e))) {
      n++;
      if (select) set.add(e.name);
      else set.delete(e.name);
    }
  }
  patch(side, { selected: set });
  return n;
}

export function startRename(side: Side, name: string) {
  if (name === PARENT) return;
  patch(side, { renaming: name, cursor: name });
}

export function stopRename(side: Side) {
  patch(side, { renaming: null });
}

// ---------------------------------------------------------------- compare directories

export function compareDirectories(): number {
  const s = usePanels.getState();
  const L = viewRows(s.left, true);
  const R = viewRows(s.right, true);
  const rm = new Map(R.map((e) => [e.name, e]));
  const lm = new Map(L.map((e) => [e.name, e]));
  const markL: Record<string, CompareMark> = {};
  const markR: Record<string, CompareMark> = {};
  const mark = (a: FileEntry, b: FileEntry | undefined, out: Record<string, CompareMark>) => {
    if (!b) {
      out[a.name] = 'only';
      return;
    }
    if (isDirLike(a) || isDirLike(b)) return;
    const dt = (a.modified ?? 0) - (b.modified ?? 0);
    if (dt > 2) out[a.name] = 'newer';
    else if (dt < -2) out[a.name] = 'older';
    else if (a.size !== b.size) out[a.name] = 'differs';
  };
  for (const e of L) mark(e, rm.get(e.name), markL);
  for (const e of R) mark(e, lm.get(e.name), markR);
  const sel = (m: Record<string, CompareMark>) => Object.entries(m).filter(([, v]) => v === 'only' || v === 'newer' || v === 'differs').map(([k]) => k);
  patch('left', { compare: markL, selected: new Set(sel(markL)) });
  patch('right', { compare: markR, selected: new Set(sel(markR)) });
  return Object.keys(markL).length + Object.keys(markR).length;
}

export function clearCompare() {
  patch('left', { compare: null });
  patch('right', { compare: null });
}
