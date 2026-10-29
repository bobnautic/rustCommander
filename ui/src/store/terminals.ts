import { create } from 'zustand';
import { call } from '../api/client';
import { base64ToBytes } from '../lib/base64';
import { showDock } from './app';
import { toast } from './toasts';

export interface TermTab {
  id: string;
  session: string;
  title: string;
  exited: boolean;
  code?: number | null;
}

interface TermStore {
  tabs: TermTab[];
  active: string | null;
}

export const useTerms = create<TermStore>(() => ({ tabs: [], active: null }));

type Writer = (data: Uint8Array) => void;
const writers = new Map<string, Writer>();
const buffers = new Map<string, Uint8Array[]>();
const disposers = new Map<string, () => void>();

/** Called by the xterm view once a terminal instance exists. */
export function registerTerminal(id: string, write: Writer, dispose: () => void) {
  writers.set(id, write);
  disposers.set(id, dispose);
  const buf = buffers.get(id);
  if (buf) {
    buffers.delete(id);
    for (const b of buf) write(b);
  }
}

export function onTerminalData(id: string, b64: string) {
  const bytes = base64ToBytes(b64);
  const w = writers.get(id);
  if (w) w(bytes);
  else {
    const buf = buffers.get(id) ?? [];
    buf.push(bytes);
    buffers.set(id, buf);
  }
}

export function onTerminalExit(id: string, code?: number | null) {
  useTerms.setState((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, exited: true, code } : t)) }));
  const w = writers.get(id);
  const msg = `\r\n\x1b[2m[process exited${code !== null && code !== undefined ? ` with code ${code}` : ''}]\x1b[0m\r\n`;
  if (w) w(new TextEncoder().encode(msg));
}

export async function openTerminal(session: string, cwd?: string | null): Promise<string | null> {
  try {
    const info = await call('terminal.open', { session, cols: 100, rows: 24, cwd: cwd ?? null });
    useTerms.setState((s) => ({ tabs: [...s.tabs.filter((t) => t.id !== info.id), { ...info, exited: false }], active: info.id }));
    showDock('terminal');
    return info.id;
  } catch (e) {
    toast.error(e);
    return null;
  }
}

export function adoptTerminals(list: { id: string; session: string; title: string }[]) {
  useTerms.setState((s) => {
    const known = new Set(s.tabs.map((t) => t.id));
    const added = list.filter((t) => !known.has(t.id)).map((t) => ({ ...t, exited: false }));
    const alive = new Set(list.map((t) => t.id));
    const tabs = [...s.tabs.map((t) => (alive.has(t.id) || t.exited ? t : { ...t, exited: true })), ...added];
    return { tabs, active: s.active ?? tabs[0]?.id ?? null };
  });
}

export async function closeTerminal(id: string) {
  const tab = useTerms.getState().tabs.find((t) => t.id === id);
  if (tab && !tab.exited) {
    try {
      await call('terminal.close', { id });
    } catch {
      /* already gone */
    }
  }
  disposers.get(id)?.();
  disposers.delete(id);
  writers.delete(id);
  buffers.delete(id);
  useTerms.setState((s) => {
    const tabs = s.tabs.filter((t) => t.id !== id);
    const idx = s.tabs.findIndex((t) => t.id === id);
    const active = s.active === id ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : s.active;
    return { tabs, active };
  });
}

export function setActiveTerminal(id: string) {
  useTerms.setState({ active: id });
}
