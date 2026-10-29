import { create } from 'zustand';
import type { AppInfo, Bookmark, CustomCommand, SessionSummary, Settings, VaultStatus } from '../api/types';
import { call } from '../api/client';
import { applyLanguage } from '../i18n';
import { load, save, saveRaw } from '../lib/storage';
import { toast } from './toasts';

export type DockTab = 'queue' | 'terminal' | 'log' | 'search';
export type Side = 'left' | 'right';

export interface Layout {
  sidebarOpen: boolean;
  sidebarWidth: number;
  dockOpen: boolean;
  dockTab: DockTab;
  dockHeight: number;
  /** Left panel width as a fraction of the panel area. */
  split: number;
  syncBrowse: boolean;
}

interface AppStore extends Layout {
  info: AppInfo | null;
  settings: Settings | null;
  sessions: SessionSummary[];
  vault: VaultStatus | null;
  bookmarks: Bookmark[];
  commands: CustomCommand[];
  activeSide: Side;
  /** Narrow viewport: only one panel is visible. */
  narrow: boolean;
  resolvedTheme: 'light' | 'dark';
}

const defaultLayout: Layout = {
  sidebarOpen: false,
  sidebarWidth: 270,
  dockOpen: false,
  dockTab: 'queue',
  dockHeight: 240,
  split: 0.5,
  syncBrowse: false,
};

const savedLayout = { ...defaultLayout, ...load<Partial<Layout>>('layout', {}) };

const narrowQuery = window.matchMedia('(max-width: 799px)');
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

export const useApp = create<AppStore>(() => ({
  ...savedLayout,
  info: null,
  settings: null,
  sessions: [],
  vault: null,
  bookmarks: [],
  commands: [],
  activeSide: 'left',
  narrow: narrowQuery.matches,
  resolvedTheme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
}));

narrowQuery.addEventListener('change', (e) => useApp.setState({ narrow: e.matches }));

export function setLayout(patch: Partial<Layout>) {
  useApp.setState(patch);
  const s = useApp.getState();
  const layout: Layout = {
    sidebarOpen: s.sidebarOpen,
    sidebarWidth: s.sidebarWidth,
    dockOpen: s.dockOpen,
    dockTab: s.dockTab,
    dockHeight: s.dockHeight,
    split: s.split,
    syncBrowse: s.syncBrowse,
  };
  save('layout', layout);
}

export function showDock(tab: DockTab) {
  setLayout({ dockOpen: true, dockTab: tab });
}

export function toggleDock(tab?: DockTab) {
  const s = useApp.getState();
  if (tab && s.dockOpen && s.dockTab !== tab) setLayout({ dockTab: tab });
  else setLayout({ dockOpen: !s.dockOpen, ...(tab ? { dockTab: tab } : {}) });
}

export function setActiveSide(side: Side) {
  if (useApp.getState().activeSide !== side) useApp.setState({ activeSide: side });
}

// ---------------------------------------------------------------- theme

function applyTheme(theme: Settings['theme']) {
  saveRaw('theme', theme);
  const dark = theme === 'dark' || (theme === 'system' && darkQuery.matches);
  const resolved = dark ? 'dark' : 'light';
  document.documentElement.dataset.theme = resolved;
  if (useApp.getState().resolvedTheme !== resolved) useApp.setState({ resolvedTheme: resolved });
}

darkQuery.addEventListener('change', () => {
  const t = useApp.getState().settings?.theme ?? 'system';
  applyTheme(t);
});

export function applySettings(s: Settings) {
  useApp.setState({ settings: s });
  applyTheme(s.theme);
  applyLanguage(s.language);
}

/** Persists settings on the backend and applies them. */
export async function saveSettings(next: Settings): Promise<Settings | undefined> {
  const prev = useApp.getState().settings;
  applySettings(next); // optimistic
  try {
    const saved = await call('settings.set', { settings: next });
    applySettings(saved);
    return saved;
  } catch (e) {
    if (prev) applySettings(prev);
    toast.error(e);
    return undefined;
  }
}

export async function patchSettings(fn: (s: Settings) => Settings): Promise<void> {
  const cur = useApp.getState().settings;
  if (!cur) return;
  await saveSettings(fn(structuredClone(cur)));
}

export function toggleHidden() {
  void patchSettings((s) => ({ ...s, showHidden: !s.showHidden }));
}

export function setTheme(theme: Settings['theme']) {
  void patchSettings((s) => ({ ...s, theme }));
}

export function cycleTheme() {
  const cur = useApp.getState().settings?.theme ?? 'system';
  setTheme(cur === 'system' ? 'light' : cur === 'light' ? 'dark' : 'system');
}

// ---------------------------------------------------------------- sessions, bookmarks, commands

export function sessionById(id: string): SessionSummary | undefined {
  return useApp.getState().sessions.find((s) => s.id === id);
}

export function upsertSession(s: SessionSummary) {
  useApp.setState((st) => {
    const i = st.sessions.findIndex((x) => x.id === s.id);
    if (i < 0) return { sessions: [...st.sessions, s] };
    const next = [...st.sessions];
    next[i] = s;
    return { sessions: next };
  });
}

export function removeSession(id: string) {
  useApp.setState((st) => ({ sessions: st.sessions.filter((s) => s.id !== id) }));
}

export async function reloadBookmarks() {
  try {
    useApp.setState({ bookmarks: await call('bookmarks.list') });
  } catch {
    /* optional */
  }
}

export async function reloadCommands() {
  try {
    useApp.setState({ commands: await call('commands.list') });
  } catch {
    /* optional */
  }
}

/** True when the UI runs in a browser against `rcmd serve` (or the mock in web mode). */
export function isWebUi(): boolean {
  return useApp.getState().info?.mode === 'web';
}
