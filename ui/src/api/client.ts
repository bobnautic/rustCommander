// Transport layer: one `call()` / `on()` API over three back ends:
//   desktop – Tauri `invoke('rpc')` + the 'rc-event' event
//   web     – POST /api/rpc + WebSocket /api/events (rcmd serve / embedded server)
//   mock    – in-memory fake backend (?mock=1 or VITE_MOCK=1), used for development, tests and demos
import { create } from 'zustand';
import type { RpcEventName, RpcEvents, RpcMethod, RpcParams, RpcResult } from './types';
import { normalizeError, RpcCallError } from './errors';
import type { MockBackend } from './mock';

export type Mode = 'desktop' | 'web' | 'mock';

const query = (() => {
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return new URLSearchParams();
  }
})();

function detectMode(): Mode {
  const m = query.get('mock');
  if (m !== null && m !== '0' && m !== 'false') return 'mock';
  if (import.meta.env.VITE_MOCK === '1' || import.meta.env.VITE_MOCK === 'true') return 'mock';
  if ('__TAURI_INTERNALS__' in window) return 'desktop';
  return 'web';
}

/** Which transport is in use. For feature decisions (desktop vs. browser UI) use `app.info.mode`. */
export const mode: Mode = detectMode();

/** Options for the mock backend, taken from the query string. */
export const mockOptions = {
  /** `?mock=1&mode=web` simulates the browser UI (upload/download, no desktop-only features). */
  webMode: query.get('mode') === 'web',
  /** `?mock=1&locked=1` starts with a locked vault (password "demo"). */
  locked: query.get('locked') === '1',
  /** `?mock=1&login=1` shows the web login screen first (password "demo"). */
  login: query.get('login') === '1',
  /** `?mock=1&fast=1` makes jobs and delays very short (used by tests). */
  fast: query.get('fast') === '1',
};

// ---------------------------------------------------------------- connection state & busy tracking

export type ConnectionState = 'connecting' | 'online' | 'offline';

interface ConnectionStore {
  state: ConnectionState;
  /** Number of RPC calls in flight (excluding chatty ones like terminal input). */
  inflight: number;
}

export const useConnection = create<ConnectionStore>(() => ({ state: mode === 'web' ? 'connecting' : 'online', inflight: 0 }));

const QUIET_METHODS = new Set<string>(['terminal.write', 'terminal.resize', 'fs.diskInfo', 'discovery.peers', 'jobs.list', 'log.recent']);

// ---------------------------------------------------------------- events

type Handler = (payload: unknown) => void;
const handlers = new Map<string, Set<Handler>>();

function dispatch(name: string, payload: unknown) {
  const set = handlers.get(name);
  if (!set) return;
  for (const h of [...set]) {
    try {
      h(payload);
    } catch (e) {
      console.error(`[rc] handler for '${name}' failed`, e);
    }
  }
}

/** Subscribe to a backend event. Returns an unsubscribe function. */
export function on<E extends RpcEventName>(name: E, cb: (payload: RpcEvents[E]) => void): () => void {
  let set = handlers.get(name);
  if (!set) {
    set = new Set();
    handlers.set(name, set);
  }
  const h = cb as Handler;
  set.add(h);
  return () => {
    set!.delete(h);
  };
}

const unauthorizedHandlers = new Set<() => void>();
const reconnectHandlers = new Set<() => void>();

/** Web mode: called when the server answers 401 (session expired / not logged in). */
export function onUnauthorized(cb: () => void): () => void {
  unauthorizedHandlers.add(cb);
  return () => unauthorizedHandlers.delete(cb);
}

/** Web mode: called after the event socket reconnected (state should be re-fetched). */
export function onReconnected(cb: () => void): () => void {
  reconnectHandlers.add(cb);
  return () => reconnectHandlers.delete(cb);
}

function fireUnauthorized() {
  for (const h of [...unauthorizedHandlers]) h();
}

// ---------------------------------------------------------------- transports

interface Transport {
  call(method: string, params: unknown): Promise<unknown>;
}

/** Set when the mock backend is active (used by the web upload/download helpers). */
export let mockBackend: MockBackend | null = null;

/** Resolves an API path relative to the page, so a reverse proxy sub-path keeps working. */
export function apiUrl(path: string): string {
  return new URL(path.replace(/^\//, ''), document.baseURI).toString();
}

async function createDesktopTransport(): Promise<Transport> {
  const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
  await listen<{ name: string; payload: unknown }>('rc-event', (e) => {
    const p = e.payload;
    if (p && typeof p.name === 'string') dispatch(p.name, p.payload);
  });
  return {
    async call(method, params) {
      try {
        return await invoke('rpc', { method, params });
      } catch (e) {
        throw normalizeError(e, method);
      }
    },
  };
}

function createWebTransport(): Transport {
  return {
    async call(method, params) {
      let res: Response;
      try {
        res = await fetch(apiUrl('api/rpc'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-RC-Request': '1' },
          credentials: 'same-origin',
          body: JSON.stringify({ method, params }),
        });
      } catch (e) {
        throw new RpcCallError('connection_lost', `Network error: ${e instanceof Error ? e.message : String(e)}`, method);
      }
      if (res.status === 401) {
        fireUnauthorized();
        let msg = 'Not logged in';
        try {
          const b = await res.json();
          if (b?.error?.message) msg = b.error.message;
        } catch {
          /* ignore */
        }
        throw new RpcCallError('unauthorized', msg, method);
      }
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      const b = body as { result?: unknown; error?: unknown } | null;
      if (!res.ok || (b && b.error !== undefined && b.error !== null)) {
        throw normalizeError(b?.error ?? `HTTP ${res.status} ${res.statusText}`, method);
      }
      return b?.result ?? null;
    },
  };
}

async function createMockTransport(): Promise<Transport> {
  const m = await import('./mock');
  mockBackend = m.createMockBackend(dispatch, mockOptions);
  return {
    async call(method, params) {
      try {
        return await mockBackend!.call(method, params);
      } catch (e) {
        throw normalizeError(e, method);
      }
    },
  };
}

let transportPromise: Promise<Transport> | null = null;

function getTransport(): Promise<Transport> {
  if (!transportPromise) {
    transportPromise =
      mode === 'desktop' ? createDesktopTransport() : mode === 'mock' ? createMockTransport() : Promise.resolve(createWebTransport());
  }
  return transportPromise;
}

type ParamArgs<M extends RpcMethod> = undefined extends RpcParams<M> ? [params?: RpcParams<M>] : [params: RpcParams<M>];

/** Call a backend method. Rejects with an `RpcCallError`. */
export async function call<M extends RpcMethod>(method: M, ...args: ParamArgs<M>): Promise<RpcResult<M>> {
  const params = args[0] ?? {};
  const quiet = QUIET_METHODS.has(method);
  if (!quiet) useConnection.setState((s) => ({ inflight: s.inflight + 1 }));
  try {
    const t = await getTransport();
    return (await t.call(method, params)) as RpcResult<M>;
  } catch (e) {
    throw normalizeError(e, method);
  } finally {
    if (!quiet) useConnection.setState((s) => ({ inflight: Math.max(0, s.inflight - 1) }));
  }
}

// ---------------------------------------------------------------- web: auth + event socket

export interface WebInfo {
  name: string;
  version: string;
  authRequired: boolean;
  authenticated: boolean;
}

export async function fetchWebInfo(): Promise<WebInfo> {
  if (mode === 'mock') {
    await getTransport();
    return mockBackend!.webInfo();
  }
  const res = await fetch(apiUrl('api/info'), { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new RpcCallError('connection_lost', `HTTP ${res.status}`);
  return (await res.json()) as WebInfo;
}

/** Returns true on success, false on a wrong password. Throws on network problems. */
export async function webLogin(password: string): Promise<boolean> {
  if (mode === 'mock') {
    await getTransport();
    return mockBackend!.webLogin(password);
  }
  const res = await fetch(apiUrl('api/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-RC-Request': '1' },
    credentials: 'same-origin',
    body: JSON.stringify({ password }),
  });
  if (res.status === 401 || res.status === 403) return false;
  if (!res.ok) throw new RpcCallError('other', `HTTP ${res.status} ${res.statusText}`);
  return true;
}

export async function webLogout(): Promise<void> {
  if (mode !== 'web') return;
  stopEvents();
  try {
    await fetch(apiUrl('api/logout'), { method: 'POST', headers: { 'X-RC-Request': '1' }, credentials: 'same-origin' });
  } catch {
    /* ignore */
  }
}

let ws: WebSocket | null = null;
let wsAttempt = 0;
let wsEverOpened = false;
let wsStopped = false;
let wsTimer: ReturnType<typeof setTimeout> | null = null;

function wsUrl(): string {
  const u = new URL(apiUrl('api/events'));
  u.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return u.toString();
}

function connectSocket() {
  if (wsTimer) {
    clearTimeout(wsTimer);
    wsTimer = null;
  }
  if (ws || wsStopped) return;
  useConnection.setState({ state: wsEverOpened ? 'offline' : 'connecting' });
  let sock: WebSocket;
  try {
    sock = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  ws = sock;
  sock.onopen = () => {
    wsAttempt = 0;
    const reconnect = wsEverOpened;
    wsEverOpened = true;
    useConnection.setState({ state: 'online' });
    if (reconnect) for (const h of [...reconnectHandlers]) h();
  };
  sock.onmessage = (m) => {
    try {
      const msg = JSON.parse(typeof m.data === 'string' ? m.data : '') as { name?: string; payload?: unknown };
      if (msg && typeof msg.name === 'string') dispatch(msg.name, msg.payload);
    } catch {
      /* ignore malformed */
    }
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    if (wsStopped) return;
    useConnection.setState({ state: 'offline' });
    scheduleReconnect();
  };
  sock.onerror = () => {
    /* onclose follows */
  };
}

function scheduleReconnect() {
  if (wsStopped || wsTimer) return;
  const delay = Math.min(15000, 500 * 2 ** wsAttempt) + Math.random() * 400;
  wsAttempt = Math.min(wsAttempt + 1, 6);
  wsTimer = setTimeout(async () => {
    wsTimer = null;
    try {
      const info = await fetchWebInfo();
      if (info.authRequired && !info.authenticated) {
        fireUnauthorized();
        return;
      }
    } catch {
      scheduleReconnect();
      return;
    }
    connectSocket();
  }, delay);
}

/** Starts event delivery. Desktop and mock deliver events as soon as the transport exists. */
export async function startEvents(): Promise<void> {
  if (mode !== 'web') {
    await getTransport();
    return;
  }
  wsStopped = false;
  connectSocket();
}

export function stopEvents() {
  wsStopped = true;
  if (wsTimer) clearTimeout(wsTimer);
  wsTimer = null;
  if (ws) {
    const s = ws;
    ws = null;
    s.close();
  }
}

if (mode === 'web') {
  window.addEventListener('online', () => {
    if (!ws && !wsStopped) {
      wsAttempt = 0;
      connectSocket();
    }
  });
}
