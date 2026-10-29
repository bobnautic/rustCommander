import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, ServerCrash } from 'lucide-react';
import { call, fetchWebInfo, mockOptions, mode, onUnauthorized, startEvents, stopEvents, type WebInfo } from './api/client';
import { normalizeError } from './api/errors';
import { onOsDragDrop } from './api/desktop';
import type { FileEntry } from './api/types';
import { useT } from './i18n';
import * as P from './lib/paths';
import { setActiveSide, setLayout, useApp } from './store/app';
import { openDialog } from './store/dialogs';
import { hasDirtyTabs } from './store/editors';
import { isFinished, useJobs } from './store/jobs';
import { getPanel, usePanels, type Side } from './store/panels';
import { loadState, subscribeEvents } from './actions/boot';
import { installShortcuts } from './actions/shortcuts';
import { MenuBar } from './components/MenuBar';
import { SessionTabs } from './components/SessionTabs';
import { Panel, SessionDot } from './components/panel/Panel';
import { Splitter } from './components/Splitter';
import { Dock } from './components/dock/Dock';
import { NearbySidebar } from './components/NearbySidebar';
import { StatusBar } from './components/StatusBar';
import { DialogHost } from './components/DialogHost';
import { PromptHost } from './components/PromptHost';
import { ConflictHost } from './components/ConflictHost';
import { ContextMenuHost } from './components/Menu';
import { Toasts } from './components/Toasts';
import { EditorHost } from './components/editor/EditorHost';
import { DragGhost } from './components/panel/DragGhost';
import { LoginScreen } from './components/LoginScreen';
import { Button, Spinner, cx } from './components/ui';

type Phase = 'boot' | 'login' | 'ready' | 'error';

function PanelSwitcher() {
  const t = useT();
  const active = useApp((s) => s.activeSide);
  const sessions = useApp((s) => s.sessions);
  const left = usePanels((s) => s.left);
  const right = usePanels((s) => s.right);
  const item = (side: Side, p: typeof left) => {
    const s = sessions.find((x) => x.id === p.session);
    return (
      <button type="button" className={cx('ps-item', active === side && 'on')} onClick={() => setActiveSide(side)} data-testid={`switch-${side}`}>
        <SessionDot color={s?.color} />
        <span className="ps-name">{s?.id === 'local' ? t('session.local') : s?.name}</span>
        <span className="ps-path">{P.basename(p.path) || p.path}</span>
      </button>
    );
  };
  return (
    <div className="panel-switcher" role="tablist">
      {item('left', left)}
      {item('right', right)}
    </div>
  );
}

function useOsDrop() {
  const [target, setTarget] = useState<Side | null>(null);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let alive = true;
    void onOsDragDrop(async (e) => {
      const el = e.type === 'leave' ? null : document.elementFromPoint(e.x, e.y);
      const panelEl = el?.closest<HTMLElement>('[data-panel]');
      const side = (panelEl?.dataset.panel as Side | undefined) ?? null;
      if (e.type !== 'drop') {
        setTarget(e.type === 'over' ? side : null);
        return;
      }
      setTarget(null);
      if (!side || !e.paths.length) return;
      const p = getPanel(side);
      const rowName = el?.closest<HTMLElement>('.ft-row')?.dataset.name;
      const row = rowName ? p.entries.find((x) => x.name === rowName) : undefined;
      const dstDir = row && (row.kind === 'dir' || row.targetKind === 'dir') ? row.path : p.path;
      const entries: FileEntry[] = await Promise.all(
        e.paths.map((path) => call('fs.stat', { session: 'local', path }).catch(() => ({ name: P.basename(path), path, kind: 'file' as const, size: 0, hidden: false }))),
      );
      setActiveSide(side);
      openDialog('copy', { srcSession: 'local', entries, dstSession: p.session, dstDir, move: false });
    }).then((u) => {
      if (alive) unlisten = u;
      else u();
    });
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);
  return target;
}

function Workbench() {
  const t = useT();
  const narrow = useApp((s) => s.narrow);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const active = useApp((s) => s.activeSide);
  const split = useApp((s) => s.split);
  const panelsRef = useRef<HTMLDivElement>(null);
  const startSplit = useRef(split);
  const osDrop = useOsDrop();

  useEffect(() => installShortcuts(), []);

  // keep the browser from navigating to files dropped outside of a panel
  useEffect(() => {
    const prevent = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files') && !(e.target as HTMLElement)?.closest?.('.ft-body')) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
      }
    };
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      const uploads = Object.values(useJobs.getState().client).some((j) => !isFinished(j.state));
      if (hasDirtyTabs() || uploads) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  return (
    <div className={cx('app', narrow && 'narrow')}>
      <MenuBar />
      <SessionTabs />
      <div className="main">
        {sidebarOpen && (
          <>
            {narrow && <div className="sidebar-backdrop" onClick={() => setLayout({ sidebarOpen: false })} />}
            <NearbySidebar />
          </>
        )}
        <div className="workspace">
          {narrow && <PanelSwitcher />}
          <div className="panels" ref={panelsRef}>
            <div className={cx('panel-slot', osDrop === 'left' && 'os-drop')} style={narrow ? undefined : { flexBasis: `${split * 100}%` }} hidden={narrow && active !== 'left'}>
              <Panel side="left" />
            </div>
            {!narrow && (
              <Splitter
                axis="x"
                label={t('panel.resize')}
                onStart={() => (startSplit.current = useApp.getState().split)}
                onDrag={(d) => {
                  const w = panelsRef.current?.clientWidth ?? 1000;
                  setLayout({ split: Math.max(0.2, Math.min(0.8, startSplit.current + d / w)) });
                }}
                onDoubleClick={() => setLayout({ split: 0.5 })}
              />
            )}
            <div className={cx('panel-slot', osDrop === 'right' && 'os-drop')} style={narrow ? undefined : { flexBasis: `${(1 - split) * 100}%` }} hidden={narrow && active !== 'right'}>
              <Panel side="right" />
            </div>
          </div>
          <Dock />
        </div>
      </div>
      <StatusBar />
      <EditorHost />
      <DialogHost />
      <ConflictHost />
      <PromptHost />
      <ContextMenuHost />
      <DragGhost />
    </div>
  );
}

export function App() {
  const t = useT();
  const [phase, setPhase] = useState<Phase>('boot');
  const [error, setError] = useState<string | null>(null);
  const [webInfo, setWebInfo] = useState<WebInfo | null>(null);
  const starting = useRef(false);

  const start = useCallback(async () => {
    if (starting.current) return;
    starting.current = true;
    setPhase('boot');
    setError(null);
    try {
      if (mode === 'web' || (mode === 'mock' && mockOptions.login)) {
        const wi = await fetchWebInfo();
        setWebInfo(wi);
        document.title = `${wi.name} – Rust Commander`;
        if (wi.authRequired && !wi.authenticated) {
          setPhase('login');
          return;
        }
      }
      subscribeEvents();
      await startEvents();
      await loadState(true);
      const info = useApp.getState().info;
      if (info && mode !== 'mock') document.title = info.mode === 'web' ? `${info.instanceName} – Rust Commander` : 'Rust Commander';
      if (mode === 'mock') document.title = 'Rust Commander (demo)';
      setPhase('ready');
    } catch (e) {
      const err = normalizeError(e);
      if (err.code === 'unauthorized') setPhase('login');
      else {
        setError(err.message);
        setPhase('error');
      }
    } finally {
      starting.current = false;
    }
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  useEffect(
    () =>
      onUnauthorized(() => {
        if (mode !== 'web') return;
        stopEvents();
        setPhase('login');
      }),
    [],
  );

  if (phase === 'login') return <LoginScreen info={webInfo} onLoggedIn={() => void start()} />;
  if (phase === 'error') {
    return (
      <div className="boot-screen">
        <ServerCrash size={36} strokeWidth={1.4} />
        <h2>{t('boot.failed')}</h2>
        <p className="muted">{error}</p>
        <p className="muted small">{t('boot.hint')}</p>
        <Button variant="primary" icon={RefreshCw} onClick={() => void start()}>
          {t('common.retry')}
        </Button>
        <Toasts />
      </div>
    );
  }
  if (phase === 'boot') {
    return (
      <div className="boot-screen">
        <Spinner size={22} />
        <Toasts />
      </div>
    );
  }
  return (
    <>
      <Workbench />
      <Toasts />
    </>
  );
}
