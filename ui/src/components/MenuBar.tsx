import { useRef, useState } from 'react';
import {
  ArrowLeftRight, Bookmark, CircleHelp, Columns2, Copy, Download, Edit3, Eye, EyeOff, FilePlus, FolderInput, FolderPlus, FolderSync,
  GitCompareArrows, Hash, Info, Keyboard, Link2, ListChecks, Lock, LogOut, Menu as MenuIcon, Monitor, Moon, MoveRight, Network,
  PanelBottom, PanelLeft, Pencil, Plus, RefreshCw, Search, Settings, Share2, SquareTerminal, Sun, SunMoon, Trash2, Unplug, Upload,
  Command, Archive, ArrowDownUp, Radar, ClipboardCopy, FolderOpen, Route, Repeat,
} from 'lucide-react';
import { call, mode, webLogout } from '../api/client';
import { tr, useT, type TFn } from '../i18n';
import { cycleTheme, saveSettings, setLayout, setTheme, toggleDock, toggleHidden, useApp } from '../store/app';
import { openDialog, openSingleton } from '../store/dialogs';
import { clearCompare, compareDirectories, getPanel, navigate, other, patchPanel, refresh, selectAll, selectNone, invertSelection, setSort, usePanels, type SortKey } from '../store/panels';
import * as ops from '../actions/fileOps';
import { closeSession, openSiteManager, reconnectSession, showSessionInfo } from '../actions/sessions';
import { keyLabel } from '../actions/shortcuts';
import { useConnection } from '../api/client';
import { toast } from '../store/toasts';
import { commandsSubmenu } from './panel/panelMenu';
import { MenuList, type MenuItem } from './Menu';
import { cx, IconButton } from './ui';

function swapPanels() {
  const { left, right } = usePanels.getState();
  void navigate('left', right.session, right.path, { select: right.cursor });
  void navigate('right', left.session, left.path, { select: left.cursor });
}

function samePath() {
  const side = useApp.getState().activeSide;
  const p = getPanel(side);
  void navigate(other(side), p.session, p.path);
}

export function buildMenus(t: TFn): { id: string; label: string; items: () => MenuItem[] }[] {
  const k = keyLabel;
  return [
    {
      id: 'session',
      label: t('menu.session'),
      items: () => {
        const st = useApp.getState();
        const side = st.activeSide;
        const sid = getPanel(side).session;
        const remote = sid !== 'local';
        const webUi = st.info?.mode === 'web';
        return [
          { label: t('session.newSession'), icon: Plus, shortcut: k('Ctrl+N'), onClick: () => openSiteManager(), testId: 'menu-new-session' },
          { label: t('sites.manager'), icon: Network, onClick: () => openSiteManager() },
          { separator: true },
          { label: t('session.info'), icon: Info, disabled: !remote, onClick: () => showSessionInfo(sid) },
          { label: t('session.reconnect'), icon: Repeat, disabled: !remote, onClick: () => void reconnectSession(sid) },
          { label: t('session.close'), icon: Unplug, disabled: !remote, onClick: () => void closeSession(sid) },
          { separator: true },
          { label: t('tunnels.title'), icon: Route, onClick: () => openSingleton('tunnels', { session: remote ? sid : undefined }) },
          { label: t('share.title'), icon: Share2, hidden: webUi, onClick: () => openSingleton('share', {}) },
          { separator: true },
          { label: t('vault.lockNow'), icon: Lock, hidden: !st.vault?.hasMasterPassword, onClick: () => void call('vault.lock').then((v) => { useApp.setState({ vault: v }); openDialog('vault', {}); }).catch((e) => toast.error(e)) },
          { label: t('login.logout'), icon: LogOut, hidden: !(webUi && mode === 'web'), onClick: () => void webLogout().then(() => window.location.reload()) },
        ];
      },
    },
    {
      id: 'files',
      label: t('menu.files'),
      items: () => {
        const side = useApp.getState().activeSide;
        const webUi = useApp.getState().info?.mode === 'web';
        return [
          { label: t('ops.open'), icon: FolderOpen, shortcut: 'Enter', onClick: () => ops.openFocused(side) },
          { label: t('ops.edit'), icon: Edit3, shortcut: 'F4', onClick: () => ops.editFocused(side) },
          { label: t('ops.view'), icon: Eye, shortcut: 'F3', onClick: () => ops.viewFocused(side) },
          { separator: true },
          { label: t('ops.copy'), icon: Copy, shortcut: 'F5', onClick: () => ops.copySelection(side, false) },
          { label: t('ops.move'), icon: MoveRight, shortcut: 'F6', onClick: () => ops.copySelection(side, true) },
          { label: t('ops.rename'), icon: Pencil, shortcut: 'F2', onClick: () => ops.renameFocused(side) },
          { label: t('common.delete'), icon: Trash2, shortcut: 'F8', danger: true, onClick: () => void ops.deleteSelection(side) },
          { separator: true },
          { label: t('ops.newFolder'), icon: FolderPlus, shortcut: 'F7', onClick: () => void ops.makeDir(side) },
          { label: t('ops.newFile'), icon: FilePlus, shortcut: k('Shift+F4'), onClick: () => void ops.newFile(side) },
          { label: t('ops.createLink'), icon: Link2, onClick: () => ops.createSymlink(side) },
          { separator: true },
          { label: t('web.upload'), icon: Upload, shortcut: k('Ctrl+U'), hidden: !webUi, onClick: () => void ops.uploadFromComputer(side) },
          { label: t('web.uploadFolder'), icon: FolderInput, hidden: !webUi, onClick: () => void ops.uploadFromComputer(side, true) },
          { label: t('web.download'), icon: Download, hidden: !webUi, onClick: () => void ops.downloadToComputer(side) },
          { separator: true },
          { label: t('ops.copyPath'), icon: ClipboardCopy, shortcut: k('Ctrl+Shift+C'), onClick: () => ops.copyPaths(side) },
          { label: t('ops.checksum'), icon: Hash, onClick: () => ops.showChecksum(side) },
          { label: t('ops.properties'), icon: Info, shortcut: k('Alt+Enter'), onClick: () => void ops.showProperties(side) },
        ];
      },
    },
    {
      id: 'commands',
      label: t('menu.commands'),
      items: () => {
        const st = useApp.getState();
        const side = st.activeSide;
        const comparing = !!getPanel('left').compare;
        return [
          { label: t('find.title'), icon: Search, shortcut: k('Ctrl+F'), onClick: () => ops.findFiles(side) },
          { label: t('sync.title'), icon: FolderSync, shortcut: k('Ctrl+Shift+S'), onClick: () => ops.synchronize(), testId: 'menu-sync' },
          { label: t('watch.title'), icon: Radar, onClick: () => openDialog('keepUpToDate', {}) },
          { label: comparing ? t('compare.clear') : t('compare.title'), icon: GitCompareArrows, onClick: () => (comparing ? clearCompare() : runCompare()) },
          { label: t('panel.syncBrowse'), icon: ArrowLeftRight, checked: st.syncBrowse, onClick: () => setLayout({ syncBrowse: !st.syncBrowse }) },
          { separator: true },
          { label: t('terminal.open'), icon: SquareTerminal, shortcut: k('Ctrl+T'), hidden: !st.info?.features.terminal, onClick: () => ops.openTerminalHere(side) },
          { label: t('commands.title'), icon: Command, submenu: commandsSubmenu(side) },
          { separator: true },
          {
            label: t('select.title'),
            icon: ListChecks,
            submenu: [
              { label: t('panel.selectAll'), shortcut: k('Ctrl+A'), onClick: () => selectAll(side) },
              { label: t('select.none'), shortcut: k('Ctrl+Shift+A'), onClick: () => selectNone(side) },
              { label: t('select.invert'), shortcut: '*', onClick: () => invertSelection(side) },
              { separator: true },
              { label: t('select.byMask'), shortcut: '+', onClick: () => ops.selectMask(side, true) },
              { label: t('select.unselectByMask'), shortcut: '-', onClick: () => ops.selectMask(side, false) },
            ],
          },
          {
            label: t('archive.title'),
            icon: Archive,
            hidden: getPanel(side).session !== 'local',
            submenu: [
              { label: t('archive.extractHere'), onClick: () => void ops.extractArchive(side) },
              { label: t('archive.create'), onClick: () => ops.createArchive(side) },
            ],
          },
        ];
      },
    },
    {
      id: 'view',
      label: t('menu.view'),
      items: () => {
        const st = useApp.getState();
        const side = st.activeSide;
        const p = getPanel(side);
        const theme = st.settings?.theme ?? 'system';
        const sortItem = (key: SortKey, label: string): MenuItem => ({ label, checked: p.sortKey === key, onClick: () => setSort(side, key) });
        return [
          { label: t('view.showHidden'), icon: st.settings?.showHidden ? Eye : EyeOff, checked: st.settings?.showHidden, shortcut: k('Ctrl+H'), onClick: () => toggleHidden() },
          { label: t('nearby.title'), icon: PanelLeft, checked: st.sidebarOpen, shortcut: k('Ctrl+B'), onClick: () => setLayout({ sidebarOpen: !st.sidebarOpen }) },
          { label: t('dock.title'), icon: PanelBottom, checked: st.dockOpen, shortcut: k('Ctrl+J'), onClick: () => toggleDock() },
          { separator: true },
          {
            label: t('view.sortBy'),
            icon: ArrowDownUp,
            submenu: [
              sortItem('name', t('col.name')), sortItem('size', t('col.size')), sortItem('type', t('col.type')), sortItem('modified', t('col.modified')),
              sortItem('permissions', t('col.rights')), sortItem('owner', t('col.owner')),
              { separator: true },
              { label: t('view.descending'), checked: p.sortDesc, onClick: () => { patchPanel(side, { sortDesc: !p.sortDesc }); } },
            ],
          },
          {
            label: t('view.theme'),
            icon: SunMoon,
            submenu: [
              { label: t('theme.system'), icon: Monitor, checked: theme === 'system', onClick: () => setTheme('system') },
              { label: t('theme.light'), icon: Sun, checked: theme === 'light', onClick: () => setTheme('light') },
              { label: t('theme.dark'), icon: Moon, checked: theme === 'dark', onClick: () => setTheme('dark') },
            ],
          },
          {
            label: t('view.language'),
            submenu: (['auto', 'en', 'de'] as const).map((l) => ({
              label: t(`lang.${l}`),
              checked: (st.settings?.language ?? 'auto') === l,
              onClick: () => st.settings && void saveSettings({ ...st.settings, language: l }),
            })),
          },
          { separator: true },
          { label: t('view.swapPanels'), icon: ArrowLeftRight, onClick: swapPanels },
          { label: t('view.samePath'), icon: Columns2, onClick: samePath },
          { label: t('view.equalPanels'), icon: Columns2, onClick: () => setLayout({ split: 0.5 }) },
          { label: t('common.refresh'), icon: RefreshCw, shortcut: k('Ctrl+R'), onClick: () => void refresh(side) },
        ];
      },
    },
    {
      id: 'tools',
      label: t('menu.tools'),
      items: () => {
        const st = useApp.getState();
        const webUi = st.info?.mode === 'web';
        return [
          { label: t('prefs.title'), icon: Settings, shortcut: k('Ctrl+,'), onClick: () => openSingleton('preferences', {}), testId: 'menu-preferences' },
          { label: t('commands.manage'), icon: Command, onClick: () => openDialog('commands', { side: st.activeSide }) },
          { label: t('bookmarks.add'), icon: Bookmark, shortcut: k('Ctrl+D'), onClick: () => void ops.addBookmark(st.activeSide) },
          { label: t('tunnels.title'), icon: Route, onClick: () => openSingleton('tunnels', {}) },
          { label: t('prefs.knownHosts'), icon: Lock, onClick: () => openSingleton('preferences', { tab: 'security' }) },
          { separator: true },
          { label: t('share.title'), icon: Share2, hidden: webUi, onClick: () => openSingleton('share', {}) },
          { label: t('nearby.title'), icon: Radar, onClick: () => setLayout({ sidebarOpen: true }) },
        ];
      },
    },
    {
      id: 'help',
      label: t('menu.help'),
      items: () => [
        { label: t('help.shortcuts'), icon: Keyboard, shortcut: 'F1', onClick: () => openSingleton('shortcuts', {}) },
        { label: t('help.about'), icon: CircleHelp, onClick: () => openSingleton('about', {}) },
      ],
    },
  ];
}

function runCompare() {
  const n = compareDirectories();
  toast.info(n ? tr('compare.found', { n }) : tr('compare.identical'));
}

export function MenuBar() {
  const t = useT();
  const [open, setOpen] = useState<{ id: string; rect: DOMRect } | null>(null);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const narrow = useApp((s) => s.narrow);
  const settings = useApp((s) => s.settings);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const dockOpen = useApp((s) => s.dockOpen);
  const syncBrowse = useApp((s) => s.syncBrowse);
  const webUi = useApp((s) => s.info?.mode === 'web');
  const terminal = useApp((s) => s.info?.features.terminal ?? false);
  const comparing = usePanels((s) => !!s.left.compare);
  const offline = useConnection((s) => s.state === 'offline');
  const menus = buildMenus(t);
  const side = () => useApp.getState().activeSide;

  const openMenu = (id: string) => {
    const el = refs.current[id];
    if (el) setOpen({ id, rect: el.getBoundingClientRect() });
  };
  const navigateMenu = (dir: -1 | 1) => {
    if (!open) return;
    const i = menus.findIndex((m) => m.id === open.id);
    openMenu(menus[(i + dir + menus.length) % menus.length].id);
  };

  const ThemeIcon = settings?.theme === 'dark' ? Moon : settings?.theme === 'light' ? Sun : SunMoon;
  const current = open && (open.id === 'all' ? null : menus.find((m) => m.id === open.id));

  return (
    <header className={cx('menubar', offline && 'offline')}>
      <div className="brand" title="Rust Commander">
        <svg viewBox="0 0 64 64" width="20" height="20" aria-hidden>
          <rect x="4" y="4" width="56" height="56" rx="13" fill="var(--brand)" />
          <rect x="13" y="16" width="17" height="32" rx="3" fill="#fff" opacity=".95" />
          <rect x="34" y="16" width="17" height="32" rx="3" fill="#fff" opacity=".7" />
        </svg>
      </div>
      {narrow ? (
        <button type="button" ref={(el) => { refs.current.all = el; }} className={cx('menubar-item', open?.id === 'all' && 'open')} onClick={() => (open ? setOpen(null) : setOpen({ id: 'all', rect: refs.current.all!.getBoundingClientRect() }))} aria-label={t('menu.menu')}>
          <MenuIcon size={16} />
        </button>
      ) : (
        <nav className="menubar-menus" role="menubar">
          {menus.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitem"
              ref={(el) => { refs.current[m.id] = el; }}
              className={cx('menubar-item', open?.id === m.id && 'open')}
              data-testid={`menu-${m.id}`}
              onMouseDown={(e) => {
                e.preventDefault();
                if (open?.id === m.id) setOpen(null);
                else openMenu(m.id);
              }}
              onMouseEnter={() => open && open.id !== m.id && openMenu(m.id)}
            >
              {m.label}
            </button>
          ))}
        </nav>
      )}
      <div className="toolbar" role="toolbar" aria-label={t('menu.toolbar')}>
        <span className="tb-sep" />
        <IconButton icon={Plus} title={t('session.newSession')} shortcut={keyLabel('Ctrl+N')} onClick={() => openSiteManager()} data-testid="tb-new-session" />
        <span className="tb-sep" />
        <IconButton icon={Copy} title={t('ops.copy')} shortcut="F5" onClick={() => ops.copySelection(side(), false)} data-testid="tb-copy" />
        <IconButton icon={MoveRight} title={t('ops.move')} shortcut="F6" onClick={() => ops.copySelection(side(), true)} className="hide-narrow" />
        <IconButton icon={FolderPlus} title={t('ops.newFolder')} shortcut="F7" onClick={() => void ops.makeDir(side())} className="hide-narrow" />
        <IconButton icon={Trash2} title={t('common.delete')} shortcut="F8" onClick={() => void ops.deleteSelection(side())} className="hide-narrow" />
        <IconButton icon={Edit3} title={t('ops.edit')} shortcut="F4" onClick={() => ops.editFocused(side())} className="hide-narrow" />
        <IconButton icon={Info} title={t('ops.properties')} shortcut={keyLabel('Alt+Enter')} onClick={() => void ops.showProperties(side())} className="hide-narrow" />
        {webUi && (
          <>
            <span className="tb-sep" />
            <IconButton icon={Upload} title={t('web.upload')} shortcut={keyLabel('Ctrl+U')} onClick={() => void ops.uploadFromComputer(side())} data-testid="tb-upload" />
            <IconButton icon={Download} title={t('web.download')} onClick={() => void ops.downloadToComputer(side())} />
          </>
        )}
        <span className="tb-sep" />
        <IconButton icon={Search} title={t('find.title')} shortcut={keyLabel('Ctrl+F')} onClick={() => ops.findFiles(side())} className="hide-narrow" />
        <IconButton icon={FolderSync} title={t('sync.title')} shortcut={keyLabel('Ctrl+Shift+S')} onClick={() => ops.synchronize()} data-testid="tb-sync" className="hide-narrow" />
        <IconButton icon={GitCompareArrows} title={comparing ? t('compare.clear') : t('compare.title')} active={comparing} onClick={() => (comparing ? clearCompare() : runCompare())} className="hide-narrow" />
        <IconButton icon={ArrowLeftRight} title={t('panel.syncBrowse')} active={syncBrowse} onClick={() => setLayout({ syncBrowse: !syncBrowse })} className="hide-narrow" />
        {terminal && <IconButton icon={SquareTerminal} title={t('terminal.open')} shortcut={keyLabel('Ctrl+T')} onClick={() => ops.openTerminalHere(side())} data-testid="tb-terminal" />}
        <div className="toolbar-spacer" />
        <IconButton icon={Radar} title={t('nearby.title')} shortcut={keyLabel('Ctrl+B')} active={sidebarOpen} onClick={() => setLayout({ sidebarOpen: !sidebarOpen })} data-testid="tb-nearby" />
        <IconButton icon={PanelBottom} title={t('dock.title')} shortcut={keyLabel('Ctrl+J')} active={dockOpen} onClick={() => toggleDock()} className="hide-narrow" />
        <IconButton icon={ThemeIcon} title={`${t('view.theme')}: ${t(`theme.${settings?.theme ?? 'system'}`)}`} onClick={() => cycleTheme()} data-testid="tb-theme" />
        <IconButton icon={Settings} title={t('prefs.title')} shortcut={keyLabel('Ctrl+,')} onClick={() => openSingleton('preferences', {})} />
      </div>
      {open && (
        <>
          <div className="menu-catcher" onMouseDown={() => setOpen(null)} />
          {open.id === 'all' ? (
            <MenuList items={menus.map((m) => ({ label: m.label, submenu: m.items() }))} x={open.rect.left} y={open.rect.bottom} anchor={open.rect} onClose={() => setOpen(null)} />
          ) : (
            current && <MenuList key={current.id} items={current.items()} x={open.rect.left} y={open.rect.bottom} anchor={open.rect} onClose={() => setOpen(null)} onNavigate={navigateMenu} />
          )}
        </>
      )}
    </header>
  );
}
