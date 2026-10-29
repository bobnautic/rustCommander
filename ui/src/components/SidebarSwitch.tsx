// Header pieces shared by the sidebar views.
import { ChevronsLeft, FolderTree, Radar } from 'lucide-react';
import { useT } from '../i18n';
import { setLayout, useApp, type SidebarView } from '../store/app';
import { IconButton, cx } from './ui';

/** View tabs for the sidebar header: the active view shows its label, the other one only its icon. */
export function SidebarSwitch() {
  const t = useT();
  const view = useApp((s) => s.sidebarView);
  const tabs: { id: SidebarView; icon: typeof Radar; label: string }[] = [
    { id: 'nearby', icon: Radar, label: t('nearby.title') },
    { id: 'explorer', icon: FolderTree, label: t('explorer.title') },
  ];
  return (
    <div className="sidebar-switch" role="tablist" aria-label={t('sidebar.views')}>
      {tabs.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={view === id}
          className={cx('sidebar-tab', view === id && 'on')}
          title={label}
          onClick={() => setLayout({ sidebarView: id })}
          data-testid={`sidebar-tab-${id}`}
        >
          <Icon size={15} className={view === id ? 'accent' : undefined} />
          {view === id && <h3>{label}</h3>}
        </button>
      ))}
    </div>
  );
}

export function SidebarClose() {
  const t = useT();
  return <IconButton icon={ChevronsLeft} size={15} title={t('common.close')} onClick={() => setLayout({ sidebarOpen: false })} />;
}
