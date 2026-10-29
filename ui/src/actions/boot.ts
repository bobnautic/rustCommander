// Initial state loading and backend event wiring.
import { call, on, onReconnected } from '../api/client';
import type { Job } from '../api/types';
import * as P from '../lib/paths';
import { tr } from '../i18n';
import { applySettings, removeSession, showDock, upsertSession, useApp, reloadBookmarks, reloadCommands } from '../store/app';
import { isFinished, removeJob, setJobs, upsertJob, useJobs } from '../store/jobs';
import { addPrompt, appendLog, removePrompt, setBg, setLog, upsertBg, useNearby, usePrompts, useSearch } from '../store/misc';
import { initPanels, onSessionClosed, refreshWhere, usePanels } from '../store/panels';
import { adoptTerminals, onTerminalData, onTerminalExit } from '../store/terminals';
import { toast } from '../store/toasts';
import { openDialog } from '../store/dialogs';

let subscribed = false;

function onJobUpdated(j: Job) {
  const prev = useJobs.getState().jobs[j.id];
  upsertJob(j);
  if (prev && !isFinished(prev.state) && isFinished(j.state)) {
    if (j.state === 'completed') {
      toast.success(tr('queue.jobDone'), j.title);
    } else if (j.state === 'failed') {
      toast.warning(tr('queue.jobFailed'), j.errors[0] ? `${j.title}\n${j.errors[0].message}` : j.title, {
        action: { label: tr('queue.show'), run: () => showDock('queue') },
      });
    }
    if (j.dstSession && j.dstDir) refreshWhere(j.dstSession, j.dstDir);
    if (j.srcSession) for (const d of new Set(j.srcPaths.map((p) => P.dirname(p)))) refreshWhere(j.srcSession, d);
  }
}

const pendingRefresh = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleRefresh(session: string, path: string) {
  const key = `${session}\u0000${P.normalize(path)}`;
  if (pendingRefresh.has(key)) return;
  pendingRefresh.set(
    key,
    setTimeout(() => {
      pendingRefresh.delete(key);
      refreshWhere(session, path);
    }, 150),
  );
}

export function subscribeEvents() {
  if (subscribed) return;
  subscribed = true;
  on('session.opened', (s) => upsertSession(s));
  on('session.closed', ({ id, reason }) => {
    const s = useApp.getState().sessions.find((x) => x.id === id);
    removeSession(id);
    onSessionClosed(id);
    if (reason) toast.warning(tr('session.closedTitle', { name: s?.name ?? id }), reason);
  });
  on('job.updated', onJobUpdated);
  on('job.removed', ({ id }) => removeJob(id));
  on('prompt.request', (p) => addPrompt(p));
  on('prompt.closed', ({ id }) => removePrompt(id));
  on('terminal.data', ({ id, data }) => onTerminalData(id, data));
  on('terminal.exit', ({ id, code }) => onTerminalExit(id, code));
  on('search.result', ({ id, entries }) => {
    useSearch.setState((s) => (s.run && s.run.id === id ? { run: { ...s.run, results: [...s.run.results, ...entries] } } : s));
  });
  on('search.done', ({ id, scanned, cancelled, error }) => {
    useSearch.setState((s) => (s.run && s.run.id === id ? { run: { ...s.run, running: false, scanned, cancelled, error } } : s));
  });
  on('watch.updated', (w) => upsertBg('watches', w));
  on('edit.updated', (e) => upsertBg('edits', e));
  on('tunnel.updated', (t) => upsertBg('tunnels', t));
  on('discovery.peers', (peers) => useNearby.setState({ peers, refreshing: false }));
  on('server.status', (server) => useNearby.setState({ server }));
  on('fs.changed', ({ session, path }) => scheduleRefresh(session, path));
  on('log', (e) => appendLog(e));
  onReconnected(() => {
    void loadState(false);
    toast.info(tr('conn.reconnected'));
  });
}

/** Loads everything the UI needs. On reconnect (`initial=false`) panels are only refreshed. */
export async function loadState(initial: boolean) {
  const [info, settings, sessions, vault, jobs, prompts, peers, disc, server, log, terms, watches, edits, tunnels] = await Promise.allSettled([
    call('app.info'),
    call('settings.get'),
    call('session.list'),
    call('vault.status'),
    call('jobs.list'),
    call('prompt.pending'),
    call('discovery.peers'),
    call('discovery.status'),
    call('server.status'),
    call('log.recent'),
    call('terminal.list'),
    call('watch.list'),
    call('edit.list'),
    call('tunnel.list'),
  ]);
  if (info.status === 'rejected') throw info.reason;
  useApp.setState({ info: info.value });
  if (settings.status === 'fulfilled') applySettings(settings.value);
  if (vault.status === 'fulfilled') useApp.setState({ vault: vault.value });
  if (jobs.status === 'fulfilled') setJobs(jobs.value);
  if (prompts.status === 'fulfilled') {
    const ids = new Set(prompts.value.map((p) => p.id));
    usePrompts.setState((s) => ({ queue: [...s.queue.filter((p) => ids.has(p.id)), ...prompts.value.filter((p) => !s.queue.some((q) => q.id === p.id))] }));
  }
  if (peers.status === 'fulfilled') useNearby.setState({ peers: peers.value });
  if (disc.status === 'fulfilled') useNearby.setState({ discovery: disc.value });
  if (server.status === 'fulfilled') useNearby.setState({ server: server.value });
  if (log.status === 'fulfilled') setLog(log.value);
  if (terms.status === 'fulfilled') adoptTerminals(terms.value);
  if (watches.status === 'fulfilled') setBg('watches', watches.value);
  if (edits.status === 'fulfilled') setBg('edits', edits.value);
  if (tunnels.status === 'fulfilled') setBg('tunnels', tunnels.value);
  void reloadBookmarks();
  void reloadCommands();

  if (sessions.status === 'fulfilled') {
    const list = sessions.value;
    const known = new Set(list.map((s) => s.id));
    const prev = useApp.getState().sessions;
    useApp.setState({ sessions: list });
    if (initial) await initPanels(list);
    else {
      for (const s of prev) if (!known.has(s.id)) onSessionClosed(s.id);
      const st = usePanels.getState();
      for (const side of ['left', 'right'] as const) if (known.has(st[side].session)) refreshWhere(st[side].session, st[side].path);
    }
  }
  if (initial && vault.status === 'fulfilled' && vault.value.locked) openDialog('vault', {});
}
