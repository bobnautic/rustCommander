import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ArrowLeft, ArrowRight, ArrowUp, Bookmark, BookmarkPlus, ChevronDown, Cloud, Filter, Globe, HardDrive, Home, Plus, Radar, RefreshCw,
  Server, Slash, Trash2, X, type LucideIcon,
} from 'lucide-react';
import type { Protocol } from '../../api/types';
import { call } from '../../api/client';
import { useT } from '../../i18n';
import { formatBytes, formatNumber } from '../../lib/format';
import { isDirLike } from '../../lib/fileTypes';
import { reloadBookmarks, setActiveSide, useApp } from '../../store/app';
import { goBack, goForward, goHome, goRoot, goUp, navigate, refresh, setFilter, switchSession, usePanels, viewRows, type Side } from '../../store/panels';
import * as ops from '../../actions/fileOps';
import { openSiteManager } from '../../actions/sessions';
import { attempt } from '../../store/toasts';
import { MenuList, type MenuItem } from '../Menu';
import { cx, IconButton } from '../ui';
import { FileTable } from './FileTable';
import { PathBar } from './PathBar';

export const PROTOCOL_ICON: Record<Protocol, LucideIcon> = {
  local: HardDrive,
  sftp: Server,
  scp: Server,
  ftp: Server,
  webdav: Globe,
  s3: Cloud,
  azure: Cloud,
  gcs: Cloud,
  rcmd: Radar,
};

export function SessionDot({ color }: { color?: string | null }) {
  return <span className="session-dot" style={{ background: color || 'transparent', borderColor: color || undefined }} />;
}

function Dropdown({ button, items, className, title, testId }: { button: ReactNode; items: () => MenuItem[]; className?: string; title?: string; testId?: string }) {
  const [open, setOpen] = useState<DOMRect | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={cx('dropdown-btn', className, open && 'open')}
        title={title}
        data-testid={testId}
        onClick={() => setOpen(open ? null : ref.current!.getBoundingClientRect())}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(ref.current!.getBoundingClientRect());
          }
        }}
      >
        {button}
      </button>
      {open && (
        <>
          <div className="menu-catcher" onMouseDown={() => setOpen(null)} />
          <MenuList items={items()} x={open.left} y={open.bottom} anchor={open} onClose={() => setOpen(null)} />
        </>
      )}
    </>
  );
}

function SessionPicker({ side }: { side: Side }) {
  const t = useT();
  const sessions = useApp((s) => s.sessions);
  const sessionId = usePanels((s) => s[side].session);
  const cur = sessions.find((s) => s.id === sessionId);
  const Icon = PROTOCOL_ICON[cur?.protocol ?? 'local'];
  const items = (): MenuItem[] => [
    ...sessions.map((s) => ({
      label: s.id === 'local' ? t('session.local') : s.name,
      icon: PROTOCOL_ICON[s.protocol],
      checked: s.id === sessionId,
      onClick: () => void switchSession(side, s.id),
    })),
    { separator: true },
    { label: t('session.newSession'), icon: Plus, shortcut: 'Ctrl+N', onClick: () => openSiteManager() },
  ];
  return (
    <Dropdown
      className="session-picker"
      title={t('panel.sessionPicker')}
      testId={`session-picker-${side}`}
      items={items}
      button={
        <>
          <SessionDot color={cur?.color} />
          <Icon size={14} />
          <span className="session-picker-name">{cur ? (cur.id === 'local' ? t('session.local') : cur.name) : '…'}</span>
          <ChevronDown size={13} className="muted" />
        </>
      }
    />
  );
}

function BookmarksMenu({ side }: { side: Side }) {
  const t = useT();
  const bookmarks = useApp((s) => s.bookmarks);
  const sessions = useApp((s) => s.sessions);
  const p = usePanels((s) => s[side]);
  const items = (): MenuItem[] => {
    const s = sessions.find((x) => x.id === p.session);
    const scope = (b: { scope: string }) => b.scope === '*' || (p.session === 'local' ? b.scope === 'local' : b.scope === s?.siteId);
    const list = bookmarks.filter(scope).sort((a, b) => a.name.localeCompare(b.name));
    return [
      { label: t('bookmarks.add'), icon: BookmarkPlus, shortcut: 'Ctrl+D', onClick: () => void ops.addBookmark(side) },
      { separator: true },
      ...(list.length ? list.map((b) => ({ label: `${b.name}`, icon: Bookmark, shortcut: b.path.length > 28 ? '…' + b.path.slice(-26) : b.path, onClick: () => void navigate(side, p.session, b.path) })) : [{ label: t('bookmarks.none'), disabled: true }]),
      { separator: true },
      {
        label: t('bookmarks.remove'),
        icon: Trash2,
        disabled: !bookmarks.length,
        submenu: bookmarks.map((b) => ({ label: `${b.name} (${b.path})`, onClick: () => void attempt(() => call('bookmarks.delete', { id: b.id })).then(() => reloadBookmarks()) })),
      },
    ];
  };
  return <Dropdown className="icon-dropdown" title={t('bookmarks.title')} items={items} button={<Bookmark size={15} strokeWidth={1.75} />} />;
}

function QuickFilter({ side }: { side: Side }) {
  const t = useT();
  const filter = usePanels((s) => s[side].filter);
  const [open, setOpen] = useState(false);
  const show = open || !!filter;
  if (!show) return <IconButton icon={Filter} title={t('panel.filter')} onClick={() => setOpen(true)} />;
  return (
    <div className="quick-filter">
      <Filter size={13} className="muted" />
      <input
        autoFocus={open && !filter}
        value={filter}
        placeholder={t('panel.filterPlaceholder')}
        aria-label={t('panel.filter')}
        spellCheck={false}
        onChange={(e) => setFilter(side, e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') {
            setFilter(side, '');
            setOpen(false);
            document.querySelector<HTMLElement>(`[data-panel="${side}"] .ft-body`)?.focus();
          } else if (e.key === 'Enter' || e.key === 'ArrowDown') {
            e.preventDefault();
            document.querySelector<HTMLElement>(`[data-panel="${side}"] .ft-body`)?.focus();
          }
        }}
        onBlur={() => !filter && setOpen(false)}
      />
      {filter && (
        <button type="button" className="qf-clear" onClick={() => setFilter(side, '')} aria-label={t('common.clear')}>
          <X size={12} />
        </button>
      )}
    </div>
  );
}

function PanelStatus({ side }: { side: Side }) {
  const t = useT();
  const p = usePanels((s) => s[side]);
  const showHidden = useApp((s) => s.settings?.showHidden ?? false);
  const stats = useMemo(() => {
    const rows = viewRows(p, showHidden);
    let files = 0;
    let dirs = 0;
    let bytes = 0;
    let selFiles = 0;
    let selBytes = 0;
    for (const e of rows) {
      const d = isDirLike(e);
      if (d) dirs++;
      else {
        files++;
        bytes += e.size;
      }
      if (p.selected.has(e.name)) {
        selFiles++;
        if (!d) selBytes += e.size;
      }
    }
    const hidden = p.entries.length - (showHidden ? p.entries.length : p.entries.filter((e) => !e.hidden).length);
    return { files, dirs, bytes, selFiles, selBytes, total: rows.length, hidden };
  }, [p, showHidden]);
  return (
    <div className="panel-status">
      <span className="panel-status-main">
        {stats.selFiles > 0
          ? t('panel.selectedOf', { sel: formatNumber(stats.selFiles), total: formatNumber(stats.total), size: formatBytes(stats.selBytes) })
          : t('panel.summary', { dirs: formatNumber(stats.dirs), files: formatNumber(stats.files), size: formatBytes(stats.bytes) })}
        {stats.hidden > 0 && <span className="muted"> · {t('panel.hiddenCount', { n: stats.hidden })}</span>}
        {p.filter && <span className="accent"> · {t('panel.filtered')}</span>}
      </span>
      {p.disk && (
        <span className="panel-status-disk" title={t('panel.diskTitle', { free: formatBytes(p.disk.available), total: formatBytes(p.disk.total) })}>
          <span className="disk-meter">
            <span style={{ width: `${Math.min(100, ((p.disk.total - p.disk.free) / Math.max(1, p.disk.total)) * 100)}%` }} />
          </span>
          {t('panel.free', { size: formatBytes(p.disk.available) })}
        </span>
      )}
    </div>
  );
}

export function Panel({ side, hidden }: { side: Side; hidden?: boolean }) {
  const t = useT();
  const active = useApp((s) => s.activeSide === side);
  const p = usePanels((s) => s[side]);
  return (
    <section
      className={cx('panel', active && 'active', hidden && 'panel-hidden')}
      data-panel={side}
      data-testid={`panel-${side}`}
      onMouseDown={() => setActiveSide(side)}
      onFocus={() => setActiveSide(side)}
      aria-label={side === 'left' ? t('panel.left') : t('panel.right')}
    >
      <div className="panel-head">
        <SessionPicker side={side} />
        <div className="panel-nav">
          <IconButton icon={ArrowLeft} title={t('nav.back')} shortcut="Alt+←" disabled={!p.back.length} onClick={() => void goBack(side)} />
          <IconButton icon={ArrowRight} title={t('nav.forward')} shortcut="Alt+→" disabled={!p.fwd.length} onClick={() => void goForward(side)} />
          <IconButton icon={ArrowUp} title={t('nav.up')} shortcut="Backspace" onClick={() => void goUp(side)} />
          <IconButton icon={Slash} title={t('nav.root')} shortcut="Ctrl+\\" onClick={() => void goRoot(side)} />
          <IconButton icon={Home} title={t('nav.home')} shortcut="Ctrl+Home" onClick={() => void goHome(side)} />
          <IconButton icon={RefreshCw} title={t('common.refresh')} shortcut="Ctrl+R" className={p.loading ? 'spinning' : undefined} onClick={() => void refresh(side)} />
          <BookmarksMenu side={side} />
        </div>
        <div className="panel-head-spacer" />
        <QuickFilter side={side} />
      </div>
      <PathBar side={side} path={p.path} session={p.session} />
      <FileTable side={side} active={active} />
      <PanelStatus side={side} />
    </section>
  );
}

export { Dropdown };
