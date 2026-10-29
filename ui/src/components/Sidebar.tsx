import { useRef } from 'react';
import { useT } from '../i18n';
import { setLayout, useApp } from '../store/app';
import { NearbyView } from './NearbySidebar';
import { RemoteExplorer } from './RemoteExplorer';
import { Splitter } from './Splitter';

/** Left sidebar: LAN discovery ("Nearby") or the remote explorer. */
export function Sidebar() {
  const t = useT();
  const view = useApp((s) => s.sidebarView);
  const width = useApp((s) => s.sidebarWidth);
  const narrow = useApp((s) => s.narrow);
  const startW = useRef(width);
  return (
    <aside className="sidebar" style={narrow ? undefined : { width }} data-testid="sidebar">
      {view === 'explorer' ? <RemoteExplorer /> : <NearbyView />}
      {!narrow && (
        <Splitter
          axis="x"
          className="sidebar-splitter"
          label={t('nearby.resize')}
          onStart={() => (startW.current = useApp.getState().sidebarWidth)}
          onDrag={(d) => setLayout({ sidebarWidth: Math.max(220, Math.min(560, startW.current + d)) })}
        />
      )}
    </aside>
  );
}
