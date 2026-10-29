// Smaller stores: log, LAN discovery, prompts, search, watches/edits/tunnels.
import { create } from 'zustand';
import type {
  DiscoveryStatus, ExternalEdit, FileEntry, LogEntry, PendingPrompt, Peer, SearchParams, ServerStatus, Tunnel, Watch,
} from '../api/types';

// ---------------------------------------------------------------- log

const MAX_LOG = 5000;

interface LogStore {
  entries: LogEntry[];
  unseenErrors: number;
}

export const useLog = create<LogStore>(() => ({ entries: [], unseenErrors: 0 }));

export function setLog(entries: LogEntry[]) {
  useLog.setState({ entries: entries.slice(-MAX_LOG) });
}

export function appendLog(e: LogEntry) {
  useLog.setState((s) => {
    const entries = s.entries.length >= MAX_LOG ? [...s.entries.slice(-MAX_LOG + 1), e] : [...s.entries, e];
    return { entries, unseenErrors: e.level === 'error' ? s.unseenErrors + 1 : s.unseenErrors };
  });
}

export function clearLog() {
  useLog.setState({ entries: [], unseenErrors: 0 });
}

// ---------------------------------------------------------------- nearby

interface NearbyStore {
  peers: Peer[];
  discovery: DiscoveryStatus | null;
  server: ServerStatus | null;
  refreshing: boolean;
}

export const useNearby = create<NearbyStore>(() => ({ peers: [], discovery: null, server: null, refreshing: false }));

// ---------------------------------------------------------------- prompts

interface PromptStore {
  queue: PendingPrompt[];
}

export const usePrompts = create<PromptStore>(() => ({ queue: [] }));

export function addPrompt(p: PendingPrompt) {
  usePrompts.setState((s) => (s.queue.some((x) => x.id === p.id) ? s : { queue: [...s.queue, p] }));
}

export function removePrompt(id: string) {
  usePrompts.setState((s) => ({ queue: s.queue.filter((x) => x.id !== id) }));
}

// ---------------------------------------------------------------- search

export interface SearchRun {
  id: string;
  params: SearchParams;
  results: FileEntry[];
  running: boolean;
  scanned?: number;
  cancelled?: boolean;
  error?: string | null;
  startedAt: number;
}

interface SearchStore {
  run: SearchRun | null;
}

export const useSearch = create<SearchStore>(() => ({ run: null }));

// ---------------------------------------------------------------- background helpers (watches, external edits, tunnels)

interface BgStore {
  watches: Record<string, Watch>;
  edits: Record<string, ExternalEdit>;
  tunnels: Record<string, Tunnel>;
}

export const useBg = create<BgStore>(() => ({ watches: {}, edits: {}, tunnels: {} }));

export function upsertBg<K extends keyof BgStore>(kind: K, item: BgStore[K][string]) {
  useBg.setState((s) => ({ [kind]: { ...s[kind], [item.id]: item } }) as Partial<BgStore>);
}

export function removeBg(kind: keyof BgStore, id: string) {
  useBg.setState((s) => {
    const next = { ...s[kind] };
    delete next[id];
    return { [kind]: next } as Partial<BgStore>;
  });
}

export function setBg<K extends keyof BgStore>(kind: K, items: BgStore[K][string][]) {
  useBg.setState({ [kind]: Object.fromEntries(items.map((x) => [x.id, x])) } as Partial<BgStore>);
}
