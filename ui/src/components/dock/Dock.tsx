import { lazy, Suspense, useMemo, useRef } from 'react';
import { ChevronDown, ListTodo, ScrollText, Search, SquareTerminal } from 'lucide-react';
import { useT } from '../../i18n';
import { setLayout, useApp, type DockTab } from '../../store/app';
import { isFinished, useJobs } from '../../store/jobs';
import { useLog, useSearch } from '../../store/misc';
import { useTerms } from '../../store/terminals';
import { Splitter } from '../Splitter';
import { IconButton, Spinner, Tabs, type TabDef } from '../ui';
import { QueueView } from './QueueView';
import { LogView } from './LogView';
import { SearchView } from './SearchView';

const TerminalView = lazy(() => import('./TerminalView'));

function Count({ n, tone }: { n: number; tone?: 'err' | 'warn' }) {
  if (!n) return null;
  return <span className={`tab-count ${tone ?? ''}`}>{n}</span>;
}

export function Dock() {
  const t = useT();
  const open = useApp((s) => s.dockOpen);
  const tab = useApp((s) => s.dockTab);
  const height = useApp((s) => s.dockHeight);
  const jobs = useJobs((s) => s.jobs);
  const client = useJobs((s) => s.client);
  const terms = useTerms((s) => s.tabs.length);
  const errors = useLog((s) => s.unseenErrors);
  const results = useSearch((s) => s.run?.results.length ?? 0);
  const startH = useRef(height);
  const active = useMemo(() => [...Object.values(jobs), ...Object.values(client)].filter((j) => !isFinished(j.state)).length, [jobs, client]);
  const waiting = useMemo(() => Object.values(jobs).filter((j) => j.state === 'waiting').length, [jobs]);
  const everTerminal = useRef(false);
  if (open && tab === 'terminal') everTerminal.current = true;

  const tabs: TabDef<DockTab>[] = [
    { id: 'queue', label: t('queue.title'), icon: ListTodo, badge: <Count n={active} tone={waiting ? 'warn' : undefined} /> },
    { id: 'terminal', label: t('terminal.title'), icon: SquareTerminal, badge: <Count n={terms} /> },
    { id: 'log', label: t('log.title'), icon: ScrollText, badge: <Count n={errors} tone="err" /> },
    { id: 'search', label: t('find.results'), icon: Search, badge: <Count n={results} /> },
  ];

  return (
    <div className={`dock ${open ? 'open' : 'closed'}`} style={open ? { height } : undefined} data-testid="dock">
      {open && (
        <Splitter
          axis="y"
          label={t('dock.resize')}
          onStart={() => (startH.current = useApp.getState().dockHeight)}
          onDrag={(d) => setLayout({ dockHeight: Math.max(120, Math.min(window.innerHeight - 220, startH.current - d)) })}
          onDoubleClick={() => setLayout({ dockHeight: 240 })}
        />
      )}
      <div className="dock-head">
        <Tabs tabs={tabs} value={tab} onChange={(v) => setLayout({ dockTab: v, dockOpen: true })} className="dock-tabs" />
        <div className="flex1" />
        <IconButton icon={ChevronDown} title={open ? t('dock.collapse') : t('dock.expand')} className={open ? '' : 'rot180'} onClick={() => setLayout({ dockOpen: !open })} />
      </div>
      {open && (
        <div className="dock-body">
          {tab === 'queue' && <QueueView />}
          {tab === 'log' && <LogView />}
          {tab === 'search' && <SearchView />}
          {everTerminal.current && (
            <div className="dock-terminal" style={{ display: tab === 'terminal' ? undefined : 'none' }}>
              <Suspense fallback={<div className="center-fill"><Spinner /></div>}>
                <TerminalView />
              </Suspense>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
