import { useRef, useState } from 'react';
import {
  ArrowLeftRight, Bookmark, CircleHelp, Columns2, Copy, Download, Edit3, Eye, EyeOff, FilePlus, FolderInput, FolderPlus, FolderSync,
  GitCompareArrows, Hash, Info, Keyboard, Link2, ListChecks, Lock, LogOut, Menu as MenuIcon, Monitor, Moon, MoveRight, Network,
  PanelBottom, PanelLeft, Pencil, Plus, RefreshCw, Search, Settings, Share2, SquareTerminal, Sun, SunMoon, Trash2, Unplug, Upload,
  Command, Archive, ArrowDownUp, Radar, ClipboardCopy, FolderOpen, Route, Repeat, FolderTree, Fingerprint, GitCompare, FileSearch,
  Undo2,
} from 'lucide-react';
import { call, mode, webLogout } from '../api/client';
import { useT, type TFn } from '../i18n';
import { cycleTheme, saveSettings, setLayout, setTheme, toggleDock, toggleHidden, toggleSidebar, useApp } from '../store/app';
import { openDialog, openSingleton } from '../store/dialogs';
import { getPanel, navigate, other, patchPanel, refresh, selectAll, selectNone, invertSelection, setSort, usePanels, type SortKey } from '../store/panels';
import * as ops from '../actions/fileOps';
import { closeSession, openSiteManager, reconnectSession, showSessionInfo } from '../actions/sessions';
import { keyLabel, shortcutLabel } from '../actions/shortcuts';
import { swapPanels, toggleCompare } from '../actions/commands';
import { KEYMAP_IDS, keymapOf } from '../lib/keymaps';
import { rememberFocus, useOnUiRequest } from '../store/uiRequests';
import { useConnection } from '../api/client';
import { toast } from '../store/toasts';
import { commandsSubmenu } from './panel/panelMenu';
import { MenuList, type MenuItem } from './Menu';
import { cx, IconButton } from './ui';
import { undoLabel, undoLast, useUndo } from '../actions/undo';

function samePath() {
  const side = useApp.getState().activeSide;
  const p = getPanel(side);
  void navigate(other(side), p.session, p.path);
}

export function buildMenus(t: TFn): { id: string; label: string; items: () => MenuItem[] }[] {
  const k = keyLabel;
  const sc = (id: Parameters<typeof shortcutLabel>[0]) => shortcutLabel(id);
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
          { label: t('session.newSession'), icon: Plus, shortcut: sc('siteManager'), onClick: () => openSiteManager(), testId: 'menu-new-session' },
          { label: t('sites.manager'), icon: Network, onClick: () => openSiteManager() },
          { separator: true },
          { label: t('session.info'), icon: Info, disabled: !remote, onClick: () => showSessionInfo(sid) },
          { label: t('session.reconnect'), icon: Repeat, disabled: !remote, onClick: () => void reconnectSession(sid) },
          { label: t('session.close'), icon: Unplug, disabled: !remote, shortcut: sc('disconnect'), onClick: () => void closeSession(sid) },
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
          { label: t('ops.edit'), icon: Edit3, shortcut: sc('edit'), onClick: () => ops.editFocused(side) },
          { label: t('ops.view'), icon: Eye, shortcut: sc('view'), onClick: () => ops.viewFocused(side) },
          { label: t('openFile.menu'), icon: FileSearch, shortcut: sc('openFile'), onClick: () => ops.openFileDialog(), testId: 'menu-open-file' },
          { separator: true },
          { label: t('ops.copy'), icon: Copy, shortcut: sc('copy'), onClick: () => ops.copySelection(side, false) },
          { label: t('ops.move'), icon: MoveRight, shortcut: sc('move'), onClick: () => ops.copySelection(side, true) },
          { label: t('ops.rename'), icon: Pencil, shortcut: sc('rename'), onClick: () => ops.renameFocused(side) },
          { label: undoLabel() ?? t('undo.menu'), icon: Undo2, shortcut: sc('undo'), disabled: !useUndo.getState().last, onClick: () => void undoLast(), testId: 'menu-undo' },
          { label: ops.usesTrash(getPanel(side).session) ? t('ops.trashTitle') : t('common.delete'), icon: Trash2, shortcut: sc('delete'), danger: true, onClick: () => void ops.deleteSelection(side) },
          { label: t('ops.deletePermanently'), icon: Trash2, shortcut: sc('deletePermanent'), danger: true, hidden: !ops.usesTrash(getPanel(side).session), onClick: () => void ops.deleteSelection(side, true) },
          { separator: true },
          { label: t('ops.newFolder'), icon: FolderPlus, shortcut: sc('mkdir'), onClick: () => void ops.makeDir(side) },
          { label: t('ops.newFile'), icon: FilePlus, shortcut: sc('newFile'), onClick: () => void ops.newFile(side) },
          { label: t('ops.createLink'), icon: Link2, onClick: () => ops.createSymlink(side) },
          { separator: true },
          { label: t('web.upload'), icon: Upload, shortcut: sc('upload'), hidden: !webUi, onClick: () => void ops.uploadFromComputer(side) },
          { label: t('web.uploadFolder'), icon: FolderInput, hidden: !webUi, onClick: () => void ops.uploadFromComputer(side, true) },
          { label: t('web.download'), icon: Download, hidden: !webUi, onClick: () => void ops.downloadToComputer(side) },
          { separator: true },
          { label: t('ops.copyPath'), icon: ClipboardCopy, shortcut: sc('copyPath'), onClick: () => ops.copyPaths(side) },
          { label: t('ops.checksum'), icon: Hash, onClick: () => ops.showChecksum(side) },
          { label: t('ops.properties'), icon: Info, shortcut: sc('properties'), onClick: () => void ops.showProperties(side) },
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
          { label: t('find.title'), icon: Search, shortcut: sc('find'), onClick: () => ops.findFiles(side) },
          { label: t('sync.title'), icon: FolderSync, shortcut: sc('sync'), onClick: () => ops.synchronize(), testId: 'menu-sync' },
          { label: t('watch.title'), icon: Radar, onClick: () => openDialog('keepUpToDate', {}) },
          { label: comparing ? t('compare.clear') : t('compare.title'), icon: GitCompareArrows, shortcut: sc('compareDirs'), onClick: () => toggleCompare() },
          { label: t('fp.menu'), icon: Fingerprint, shortcut: sc('fingerprints'), onClick: () => ops.compareFingerprints(side), testId: 'menu-fingerprints' },
          { label: t('diff.menu'), icon: GitCompare, onClick: () => ops.diffWithOtherPanel(side) },
          { label: t('panel.syncBrowse'), icon: ArrowLeftRight, checked: st.syncBrowse, onClick: () => setLayout({ syncBrowse: !st.syncBrowse }) },
          { separator: true },
          { label: t('terminal.open'), icon: SquareTerminal, shortcut: sc('terminal'), hidden: !st.info?.features.terminal, onClick: () => ops.openTerminalHere(side) },
          { label: t('commands.title'), icon: Command, shortcut: sc('userMenu'), submenu: commandsSubmenu(side) },
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
              { label: t('archive.extractHere'), shortcut: sc('unpack'), onClick: () => void ops.extractArchive(side) },
              { label: t('archive.create'), shortcut: sc('pack'), onClick: () => ops.createArchive(side) },
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
        const sortShortcut: Partial<Record<SortKey, string | undefined>> = { name: sc('sortName'), type: sc('sortExt'), modified: sc('sortTime'), size: sc('sortSize') };
        const sortItem = (key: SortKey, label: string): MenuItem => ({ label, checked: p.sortKey === key, shortcut: sortShortcut[key], onClick: () => setSort(side, key) });
        const keymap = keymapOf(st.settings?.keymap).id;
        return [
          { label: t('view.showHidden'), icon: st.settings?.showHidden ? Eye : EyeOff, checked: st.settings?.showHidden, shortcut: sc('toggleHidden'), onClick: () => toggleHidden() },
          { label: t('sidebar.toggle'), icon: PanelLeft, checked: st.sidebarOpen, shortcut: sc('sidebar'), onClick: () => setLayout({ sidebarOpen: !st.sidebarOpen }) },
          { label: t('nearby.title'), icon: Radar, checked: st.sidebarOpen && st.sidebarView === 'nearby', onClick: () => toggleSidebar('nearby') },
          { label: t('explorer.title'), icon: FolderTree, checked: st.sidebarOpen && st.sidebarView === 'explorer', shortcut: sc('explorer'), onClick: () => toggleSidebar('explorer'), testId: 'menu-explorer' },
          { label: t('dock.title'), icon: PanelBottom, checked: st.dockOpen, shortcut: sc('dock'), onClick: () => toggleDock() },
          { label: t('keybar.show'), icon: Keyboard, checked: st.settings?.showKeyBar ?? true, onClick: () => st.settings && void saveSettings({ ...st.settings, showKeyBar: !(st.settings.showKeyBar ?? true) }), testId: 'menu-keybar' },
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
            label: t('keymap.title'),
            icon: Keyboard,
            testId: 'menu-keymap',
            submenu: KEYMAP_IDS.map((id) => ({
              label: t(`keymap.${id}`),
              checked: keymap === id,
              testId: `menu-keymap-${id}`,
              onClick: () => st.settings && void saveSettings({ ...st.settings, keymap: id }),
            })),
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
          { label: t('view.swapPanels'), icon: ArrowLeftRight, shortcut: sc('swapPanels'), onClick: swapPanels },
          { label: t('view.samePath'), icon: Columns2, onClick: samePath },
          { label: t('view.equalPanels'), icon: Columns2, onClick: () => setLayout({ split: 0.5 }) },
          { label: t('common.refresh'), icon: RefreshCw, shortcut: sc('refresh'), onClick: () => void refresh(side) },
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
          { label: t('prefs.title'), icon: Settings, shortcut: sc('preferences'), onClick: () => openSingleton('preferences', {}), testId: 'menu-preferences' },
          { label: t('commands.manage'), icon: Command, onClick: () => openDialog('commands', { side: st.activeSide }) },
          { label: t('bookmarks.add'), icon: Bookmark, shortcut: sc('addBookmark'), onClick: () => void ops.addBookmark(st.activeSide) },
          { label: t('tunnels.title'), icon: Route, onClick: () => openSingleton('tunnels', {}) },
          { label: t('prefs.knownHosts'), icon: Lock, onClick: () => openSingleton('preferences', { tab: 'security' }) },
          { separator: true },
          { label: t('share.title'), icon: Share2, hidden: webUi, onClick: () => openSingleton('share', {}) },
          { label: t('nearby.title'), icon: Radar, onClick: () => setLayout({ sidebarOpen: true, sidebarView: 'nearby' }) },
          { label: t('explorer.title'), icon: FolderTree, shortcut: sc('explorer'), onClick: () => setLayout({ sidebarOpen: true, sidebarView: 'explorer' }) },
        ];
      },
    },
    {
      id: 'help',
      label: t('menu.help'),
      items: () => [
        { label: t('help.shortcuts'), icon: Keyboard, shortcut: sc('help'), onClick: () => openSingleton('shortcuts', {}) },
        { label: t('help.about'), icon: CircleHelp, onClick: () => openSingleton('about', {}) },
      ],
    },
  ];
}

export function MenuBar() {
  const t = useT();
  const [open, setOpen] = useState<{ id: string; rect: DOMRect } | null>(null);
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});
  const narrow = useApp((s) => s.narrow);
  const settings = useApp((s) => s.settings);
  const sidebarOpen = useApp((s) => s.sidebarOpen);
  const sidebarView = useApp((s) => s.sidebarView);
  const dockOpen = useApp((s) => s.dockOpen);
  const syncBrowse = useApp((s) => s.syncBrowse);
  const webUi = useApp((s) => s.info?.mode === 'web');
  const terminal = useApp((s) => s.info?.features.terminal ?? false);
  const comparing = usePanels((s) => !!s.left.compare);
  const offline = useConnection((s) => s.state === 'offline');
  const menus = buildMenus(t);
  const side = () => useApp.getState().activeSide;
  const sc = (id: Parameters<typeof shortcutLabel>[0]) => shortcutLabel(id, keymapOf(settings?.keymap));

  const openMenu = (id: string) => {
    const el = refs.current[id];
    if (el) setOpen({ id, rect: el.getBoundingClientRect() });
  };
  const navigateMenu = (dir: -1 | 1) => {
    if (!open) return;
    const i = menus.findIndex((m) => m.id === open.id);
    openMenu(menus[(i + dir + menus.length) % menus.length].id);
  };

  // F9 (PullDn) in the classic layouts: open the first menu, keyboard-navigable; closing it
  // gives the focus back to the file list
  const restoreFocus = useRef<(() => void) | null>(null);
  const close = () => {
    setOpen(null);
    restoreFocus.current?.();
    restoreFocus.current = null;
  };
  useOnUiRequest('menubar', () => {
    if (!open) restoreFocus.current = rememberFocus();
    if (narrow) {
      const el = refs.current.all;
      if (el) setOpen({ id: 'all', rect: el.getBoundingClientRect() });
    } else openMenu(menus[0].id);
  });

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
        <IconButton icon={Plus} title={t('session.newSession')} shortcut={sc('siteManager')} onClick={() => openSiteManager()} data-testid="tb-new-session" />
        <span className="tb-sep" />
        <IconButton icon={Copy} title={t('ops.copy')} shortcut={sc('copy')} onClick={() => ops.copySelection(side(), false)} data-testid="tb-copy" />
        <IconButton icon={MoveRight} title={t('ops.move')} shortcut={sc('move')} onClick={() => ops.copySelection(side(), true)} className="hide-narrow" />
        <IconButton icon={FolderPlus} title={t('ops.newFolder')} shortcut={sc('mkdir')} onClick={() => void ops.makeDir(side())} className="hide-narrow" />
        <IconButton icon={Trash2} title={t('common.delete')} shortcut={sc('delete')} onClick={() => void ops.deleteSelection(side())} className="hide-narrow" />
        <IconButton icon={Edit3} title={t('ops.edit')} shortcut={sc('edit')} onClick={() => ops.editFocused(side())} className="hide-narrow" />
        <IconButton icon={Info} title={t('ops.properties')} shortcut={sc('properties')} onClick={() => void ops.showProperties(side())} className="hide-narrow" />
        {webUi && (
          <>
            <span className="tb-sep" />
            <IconButton icon={Upload} title={t('web.upload')} shortcut={sc('upload')} onClick={() => void ops.uploadFromComputer(side())} data-testid="tb-upload" />
            <IconButton icon={Download} title={t('web.download')} onClick={() => void ops.downloadToComputer(side())} />
          </>
        )}
        <span className="tb-sep" />
        <IconButton icon={Search} title={t('find.title')} shortcut={sc('find')} onClick={() => ops.findFiles(side())} className="hide-narrow" />
        <IconButton icon={FolderSync} title={t('sync.title')} shortcut={sc('sync')} onClick={() => ops.synchronize()} data-testid="tb-sync" className="hide-narrow" />
        <IconButton icon={GitCompareArrows} title={comparing ? t('compare.clear') : t('compare.title')} shortcut={sc('compareDirs')} active={comparing} onClick={() => toggleCompare()} className="hide-narrow" />
        <IconButton icon={ArrowLeftRight} title={t('panel.syncBrowse')} active={syncBrowse} onClick={() => setLayout({ syncBrowse: !syncBrowse })} className="hide-narrow" />
        {terminal && <IconButton icon={SquareTerminal} title={t('terminal.open')} shortcut={sc('terminal')} onClick={() => ops.openTerminalHere(side())} data-testid="tb-terminal" />}
        <div className="toolbar-spacer" />
        {narrow ? (
          // one button on phones: the sidebar's own tabs switch the view
          <IconButton icon={sidebarView === 'explorer' ? FolderTree : Radar} title={t('sidebar.toggle')} active={sidebarOpen} onClick={() => setLayout({ sidebarOpen: !sidebarOpen })} data-testid="tb-sidebar" />
        ) : (
          <>
            <IconButton icon={FolderTree} title={t('explorer.title')} shortcut={sc('explorer')} active={sidebarOpen && sidebarView === 'explorer'} onClick={() => toggleSidebar('explorer')} data-testid="tb-explorer" />
            <IconButton icon={Radar} title={t('nearby.title')} active={sidebarOpen && sidebarView === 'nearby'} onClick={() => toggleSidebar('nearby')} data-testid="tb-nearby" />
          </>
        )}
        <IconButton icon={PanelBottom} title={t('dock.title')} shortcut={sc('dock')} active={dockOpen} onClick={() => toggleDock()} className="hide-narrow" />
        <IconButton icon={ThemeIcon} title={`${t('view.theme')}: ${t(`theme.${settings?.theme ?? 'system'}`)}`} onClick={() => cycleTheme()} data-testid="tb-theme" />
        <IconButton icon={Settings} title={t('prefs.title')} shortcut={sc('preferences')} onClick={() => openSingleton('preferences', {})} />
      </div>
      {open && (
        <>
          <div className="menu-catcher" onMouseDown={close} />
          {open.id === 'all' ? (
            <MenuList items={menus.map((m) => ({ label: m.label, submenu: m.items() }))} x={open.rect.left} y={open.rect.bottom} anchor={open.rect} onClose={close} />
          ) : (
            current && <MenuList key={current.id} items={current.items()} x={open.rect.left} y={open.rect.bottom} anchor={open.rect} onClose={close} onNavigate={navigateMenu} />
          )}
        </>
      )}
    </header>
  );
}
