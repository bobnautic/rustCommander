import { useMemo } from 'react';
import { ArrowLeftRight, CircleAlert, FileText, Globe, Loader2, Lock, Monitor, PlugZap, TriangleAlert, Wifi, WifiOff } from 'lucide-react';
import { mode, useConnection } from '../api/client';
import { useT } from '../i18n';
import { formatBytes, formatSpeed, percent } from '../lib/format';
import { setLayout, showDock, useApp } from '../store/app';
import { useEditors, setEditorVisible } from '../store/editors';
import { summarize, useJobs } from '../store/jobs';
import { useLog } from '../store/misc';
import { usePanels } from '../store/panels';
import { useConnecting } from '../actions/sessions';
import { ProgressBar, cx } from './ui';

export function StatusBar() {
  const t = useT();
  const info = useApp((s) => s.info);
  const conn = useConnection((s) => s.state);
  const busy = useConnection((s) => s.inflight > 0);
  const jobs = useJobs((s) => s.jobs);
  const client = useJobs((s) => s.client);
  const dockOpen = useApp((s) => s.dockOpen);
  const dockTab = useApp((s) => s.dockTab);
  const syncBrowse = useApp((s) => s.syncBrowse);
  const activeSide = useApp((s) => s.activeSide);
  const sessions = useApp((s) => s.sessions);
  const vault = useApp((s) => s.vault);
  const panelSession = usePanels((s) => s[activeSide].session);
  const editorTabs = useEditors((s) => s.tabs.length);
  const editorVisible = useEditors((s) => s.visible);
  const errors = useLog((s) => s.unseenErrors);
  const connecting = useConnecting((s) => s.items.length);
  const sum = useMemo(() => summarize(jobs, client), [jobs, client]);
  const session = sessions.find((s) => s.id === panelSession);

  const modeLabel = mode === 'mock' ? t('status.demo') : info?.mode === 'web' ? t('status.web') : t('status.desktop');
  const ModeIcon = info?.mode === 'web' ? Globe : Monitor;
  const showQueueSummary = sum.active > 0 && !(dockOpen && dockTab === 'queue');

  return (
    <footer className="statusbar">
      <span className={cx('sb-item', mode === 'mock' && 'sb-demo')} title={info ? `Rust Commander ${info.version} · ${info.hostname} (${info.os}/${info.arch})` : undefined}>
        <ModeIcon size={13} />
        {modeLabel}
      </span>
      {mode === 'web' && (
        <span className={cx('sb-item', conn !== 'online' && 'sb-warn')} title={t(`conn.${conn}`)}>
          {conn === 'online' ? <Wifi size={13} /> : <WifiOff size={13} />}
          {conn !== 'online' && t(`conn.${conn}`)}
        </span>
      )}
      {(busy || connecting > 0) && (
        <span className="sb-item muted" title={t('status.busy')}>
          <Loader2 size={13} className="spin" />
          {connecting > 0 && t('status.connecting')}
        </span>
      )}
      {showQueueSummary && (
        <button type="button" className={cx('sb-item sb-btn sb-queue', sum.waiting > 0 && 'sb-attention')} onClick={() => showDock('queue')} title={t('queue.title')}>
          {sum.waiting > 0 ? <TriangleAlert size={13} /> : <Loader2 size={13} className="spin" />}
          <span>{t('status.jobs', { n: sum.active })}</span>
          <span className="sb-progress">
            <ProgressBar value={percent(sum.bytesDone, sum.bytesTotal)} thin />
          </span>
          <span className="muted">
            {Math.round(percent(sum.bytesDone, sum.bytesTotal))}%{sum.speed > 0 ? ` · ${formatSpeed(sum.speed)}` : ''}
            {sum.bytesTotal > 0 ? ` · ${formatBytes(sum.bytesTotal - sum.bytesDone)} ${t('status.left')}` : ''}
          </span>
        </button>
      )}
      <span className="sb-spacer" />
      {errors > 0 && (
        <button type="button" className="sb-item sb-btn sb-err" onClick={() => { useLog.setState({ unseenErrors: 0 }); showDock('log'); }} title={t('log.title')}>
          <CircleAlert size={13} />
          {t('status.errors', { n: errors })}
        </button>
      )}
      {editorTabs > 0 && !editorVisible && (
        <button type="button" className="sb-item sb-btn" onClick={() => setEditorVisible(true)}>
          <FileText size={13} />
          {t('status.editors', { n: editorTabs })}
        </button>
      )}
      {syncBrowse && (
        <button type="button" className="sb-item sb-btn accent" onClick={() => setLayout({ syncBrowse: false })} title={t('panel.syncBrowse')}>
          <ArrowLeftRight size={13} />
          {t('status.syncBrowse')}
        </button>
      )}
      {vault?.hasMasterPassword && (
        <span className="sb-item muted" title={vault.locked ? t('vault.locked') : t('vault.unlocked')}>
          <Lock size={12} />
        </span>
      )}
      {session && (
        <span className="sb-item sb-session" title={session.url}>
          <PlugZap size={13} />
          {session.id === 'local' ? `${t('session.local')} · ${info?.user ?? ''}@${info?.hostname ?? ''}` : `${session.protocol.toUpperCase()} · ${session.username ? session.username + '@' : ''}${session.host}`}
        </span>
      )}
    </footer>
  );
}
