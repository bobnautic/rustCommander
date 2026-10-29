import { create } from 'zustand';
import type { Peer, SessionSummary, SiteConfig } from '../api/types';
import { call, mode } from '../api/client';
import { tr } from '../i18n';
import { sessionById, upsertSession, useApp } from '../store/app';
import { confirmDialog, openDialog, openSingleton } from '../store/dialogs';
import { isFinished, useJobs } from '../store/jobs';
import { showNewSession } from '../store/panels';
import { toast } from '../store/toasts';

interface ConnectingStore {
  /** Labels of connections in progress. */
  items: { id: number; label: string }[];
}

export const useConnecting = create<ConnectingStore>(() => ({ items: [] }));
let connSeq = 1;

export function openSiteManager(siteId?: string) {
  openSingleton('siteManager', { siteId });
}

/** Opens a session and shows it in a panel. Returns the session or null (errors are toasted). */
export async function connect(params: { siteId?: string; site?: SiteConfig; url?: string; password?: string | null }, label: string): Promise<SessionSummary | null> {
  const id = connSeq++;
  useConnecting.setState((s) => ({ items: [...s.items, { id, label }] }));
  try {
    const s = await call('session.open', params);
    upsertSession(s);
    await showNewSession(s);
    toast.success(tr('session.connected', { name: s.name }));
    return s;
  } catch (e) {
    toast.error(e, tr('session.connectFailed', { name: label }));
    return null;
  } finally {
    useConnecting.setState((s) => ({ items: s.items.filter((x) => x.id !== id) }));
  }
}

export async function closeSession(id: string) {
  if (id === 'local') return;
  const busy = Object.values(useJobs.getState().jobs).filter((j) => !isFinished(j.state) && (j.srcSession === id || j.dstSession === id));
  if (busy.length) {
    const ok = await confirmDialog({
      title: tr('session.close'),
      message: tr('session.closeBusy', { n: busy.length, name: sessionById(id)?.name ?? id }),
      okLabel: tr('session.close'),
      danger: true,
    });
    if (!ok) return;
  }
  try {
    await call('session.close', { id });
  } catch (e) {
    toast.error(e);
  }
}

export async function reconnectSession(id: string) {
  try {
    const s = await call('session.reconnect', { id });
    upsertSession(s);
    toast.success(tr('session.reconnected', { name: s.name }));
    const { refreshSession } = await import('../store/panels');
    refreshSession(id);
  } catch (e) {
    toast.error(e, tr('session.reconnect'));
  }
}

export function showSessionInfo(id: string) {
  openDialog('sessionInfo', { sessionId: id });
}

// ---------------------------------------------------------------- nearby peers

export async function peerSite(peer: Peer, password: string | null): Promise<SiteConfig> {
  const t = await call('sites.template', { protocol: 'rcmd' });
  const web = peer.web;
  return {
    ...t,
    id: '',
    name: peer.name,
    folder: tr('nearby.siteFolder'),
    protocol: 'rcmd',
    host: peer.addresses[0] ?? peer.hostname,
    port: web?.port ?? 8822,
    username: '',
    password,
    notes: `${peer.hostname} · ${peer.os} · Rust Commander ${peer.version}`,
    rcmd: { tls: web?.tls ?? false, fingerprint: web?.fingerprint ?? null },
  };
}

export async function connectPeer(peer: Peer, password: string) {
  try {
    const site = await peerSite(peer, password || null);
    return await connect({ site }, peer.name);
  } catch (e) {
    toast.error(e);
    return null;
  }
}

export async function savePeerAsSite(peer: Peer) {
  try {
    const site = await peerSite(peer, null);
    const saved = await call('sites.save', { site });
    toast.success(tr('nearby.savedAsSite', { name: saved.name }), undefined, { action: { label: tr('sites.open'), run: () => openSiteManager(saved.id) } });
  } catch (e) {
    toast.error(e);
  }
}

export async function openPeerWebUi(peer: Peer) {
  const url = peer.web?.url;
  if (!url) return;
  if (useApp.getState().info?.mode === 'desktop' && mode !== 'mock') {
    try {
      await call('app.open', { target: url });
    } catch (e) {
      toast.error(e);
    }
  } else window.open(url, '_blank', 'noopener');
}

export function askConnectPeer(peer: Peer) {
  openDialog('connectPeer', { peer });
}
