import { memo, useEffect, useMemo, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import {
  ChevronDown, ChevronRight, Copy, Eye, FolderInput, FolderTree, Info, Loader2, MoreHorizontal, Pencil, Plug, RefreshCw, Route, Server,
  ShieldCheck, SquareTerminal, Trash2, Unplug, X,
} from 'lucide-react';
import type { FileEntry, SessionSummary } from '../api/types';
import { call } from '../api/client';
import { useT, type TFn } from '../i18n';
import { CATEGORY_ICON, categoryOf, isDirLike } from '../lib/fileTypes';
import { formatBytes, formatDate, formatOctal, formatPerms } from '../lib/format';
import * as P from '../lib/paths';
import { setActiveSide, setLayout, useApp } from '../store/app';
import { inputDialog } from '../store/dialogs';
import {
  addRoot, addressOf, closePreview, connectAddress, connectTarget, dirKey, loadDir, loadPreview, loadTargets, removeAdhoc, rowKey,
  selectEntry, sessionOf, setExplorerFilter, setFocus, showAllOf, toggleDir, toggleTarget, useExplorer,
  type DirNode, type TargetConn, type XTarget,
} from '../store/explorer';
import { navigate, remoteSide } from '../store/panels';
import { openTerminal } from '../store/terminals';
import { closeSession, openSiteManager, showSessionInfo } from '../actions/sessions';
import { copyText } from '../actions/fileOps';
import { showContextMenu, type MenuItem } from './Menu';
import { SessionDot } from './panel/Panel';
import { typeLabel } from './panel/FileTable';
import { SidebarClose, SidebarSwitch } from './SidebarSwitch';
import { Badge, Button, IconButton, Spinner, TextInput, cx } from './ui';

/** Entries rendered per folder before a "show all" row. */
const PAGE = 300;

type Row =
  | { kind: 'section'; key: string; label: string; count: number; raw: boolean }
  | { kind: 'target'; key: string; t: XTarget; session?: SessionSummary; conn?: TargetConn; open: boolean }
  | { kind: 'entry'; key: string; parent: string; depth: number; t: XTarget; session: string; entry: FileEntry; root: string; isRoot: boolean; open: boolean; dir: boolean }
  | { kind: 'info'; key: string; depth: number; text: string; tone: 'muted' | 'err'; busy?: boolean; action?: { label: string; run: () => void } }
  | { kind: 'more'; key: string; parent: string; depth: number; dk: string; n: number };

const focusable = (r: Row) => r.kind === 'target' || r.kind === 'entry' || r.kind === 'more';

function matches(t: XTarget, f: string): boolean {
  if (!f) return true;
  const q = f.toLowerCase();
  return [t.name, t.host, t.username, t.folder, addressOf(t)].some((v) => v.toLowerCase().includes(q));
}

function rootEntry(path: string): FileEntry {
  return { name: path, path, kind: 'dir', size: 0, hidden: false };
}

function FileIcon({ entry }: { entry: FileEntry }) {
  const cat = categoryOf(entry);
  const Icon = CATEGORY_ICON[cat];
  return (
    <span className={cx('fi', `fi-${cat}`)}>
      <Icon size={15} strokeWidth={1.6} />
    </span>
  );
}

interface TreeState {
  conns: Record<string, TargetConn>;
  dirs: Record<string, DirNode>;
  expanded: Record<string, boolean>;
  showAll: Record<string, boolean>;
}

/** The visible tree as a flat list (sections, targets, folders/files, status lines). */
function buildRows(t: TFn, targets: XTarget[], filter: string, st: TreeState, showHidden: boolean): Row[] {
  const rows: Row[] = [];
  const groups: [string, XTarget[]][] = [
    ['explorer.sites', targets.filter((x) => x.source === 'site')],
    ['explorer.sshConfig', targets.filter((x) => x.source === 'sshConfig')],
    ['explorer.adhoc', targets.filter((x) => x.source === 'address')],
  ];
  const pushEntry = (x: XTarget, session: string, entry: FileEntry, depth: number, root: string, parent: string, isRoot: boolean) => {
    const key = rowKey(x.id, root, entry.path);
    const dir = isDirLike(entry);
    const open = dir && !!st.expanded[key];
    rows.push({ kind: 'entry', key, parent, depth, t: x, session, entry, root, isRoot, open, dir });
    if (!open) return;
    const dk = dirKey(session, entry.path);
    const node: DirNode | undefined = st.dirs[dk];
    if (!node || (!node.entries && node.loading)) {
      rows.push({ kind: 'info', key: `${key}\u0000loading`, depth: depth + 1, text: t('explorer.loading'), tone: 'muted', busy: true });
    } else if (node.error) {
      rows.push({ kind: 'info', key: `${key}\u0000error`, depth: depth + 1, text: node.error.message, tone: 'err', action: { label: t('common.retry'), run: () => void loadDir(session, entry.path, true) } });
    } else if (node.entries) {
      const children = showHidden ? node.entries : node.entries.filter((e) => !e.hidden);
      if (!children.length) rows.push({ kind: 'info', key: `${key}\u0000empty`, depth: depth + 1, text: t('explorer.empty'), tone: 'muted' });
      const shown = st.showAll[dk] ? children : children.slice(0, PAGE);
      for (const c of shown) pushEntry(x, session, c, depth + 1, root, key, false);
      if (shown.length < children.length) rows.push({ kind: 'more', key: `${key}\u0000more`, parent: key, depth: depth + 1, dk, n: children.length });
    }
  };
  for (const [label, list] of groups) {
    const visible = list.filter((x) => matches(x, filter));
    if (!visible.length) continue;
    rows.push({ kind: 'section', key: `section:${label}`, label: t(label as Parameters<TFn>[0]), count: visible.length, raw: label === 'explorer.sshConfig' });
    for (const x of visible) {
      const conn = st.conns[x.id];
      const session = sessionOf(x);
      const open = !!st.expanded[x.id];
      rows.push({ kind: 'target', key: x.id, t: x, session, conn, open });
      if (!open) continue;
      if (conn?.connecting) rows.push({ kind: 'info', key: `${x.id}\u0000connecting`, depth: 1, text: t('explorer.connecting'), tone: 'muted', busy: true });
      else if (conn?.error) rows.push({ kind: 'info', key: `${x.id}\u0000error`, depth: 1, text: conn.error.message, tone: 'err', action: { label: t('common.retry'), run: () => void connectTarget(x) } });
      else if (session && conn?.session === session.id) for (const r of conn.roots) pushEntry(x, session.id, rootEntry(r), 1, r, x.id, true);
    }
  }
  return rows;
}

// ---------------------------------------------------------------- actions

function openInPanel(session: string, entry: FileEntry) {
  const side = remoteSide();
  const dir = isDirLike(entry);
  void navigate(side, session, dir ? entry.path : P.dirname(entry.path), dir ? { select: null } : { select: entry.name });
  setActiveSide(side);
  if (useApp.getState().narrow) setLayout({ sidebarOpen: false });
}

function canTerminal(s: SessionSummary | undefined): boolean {
  return !!s?.capabilities.terminal && !!useApp.getState().info?.features.terminal;
}

async function goToPath(x: XTarget, t: TFn) {
  const s = sessionOf(x);
  if (!s) return;
  const v = await inputDialog({ title: t('explorer.goTo'), label: t('explorer.goToLabel', { name: x.name }), value: s.home, okLabel: t('explorer.open') });
  if (v && v.trim()) addRoot(x, P.resolve(s.home, v.trim(), s.home));
}

function targetMenu(x: XTarget, t: TFn): MenuItem[] {
  const s = sessionOf(x);
  return [
    { label: s ? t('explorer.expand') : t('explorer.connect'), icon: Plug, onClick: () => void connectTarget(x) },
    { label: t('explorer.goTo'), icon: Route, disabled: !s, onClick: () => void goToPath(x, t) },
    { label: t('explorer.openInPanel'), icon: FolderInput, disabled: !s, onClick: () => s && openInPanel(s.id, rootEntry(s.initialDir || s.home)) },
    { label: t('explorer.terminal'), icon: SquareTerminal, hidden: !canTerminal(s), onClick: () => s && void openTerminal(s.id, s.home) },
    { label: t('session.info'), icon: Info, disabled: !s, onClick: () => s && showSessionInfo(s.id) },
    { separator: true },
    { label: t('explorer.copyAddress'), icon: Copy, onClick: () => void copyText(addressOf(x)) },
    { label: t('explorer.editSite'), icon: Pencil, hidden: !x.siteId, onClick: () => openSiteManager(x.siteId!) },
    { separator: true },
    { label: t('explorer.disconnect'), icon: Unplug, hidden: !s, danger: true, onClick: () => s && void closeSession(s.id) },
    { label: t('common.remove'), icon: Trash2, hidden: x.source !== 'address' || !!s, onClick: () => removeAdhoc(x.id) },
  ];
}

function entryMenu(r: Extract<Row, { kind: 'entry' }>, t: TFn): MenuItem[] {
  const s = sessionOf(r.t);
  return [
    r.dir
      ? { label: r.open ? t('common.collapse') : t('common.expand'), icon: r.open ? ChevronDown : ChevronRight, onClick: () => toggleDir(r.key, r.session, r.entry.path) }
      : { label: t('explorer.preview'), icon: Eye, onClick: () => preview(r) },
    { label: t('explorer.openInPanel'), icon: FolderInput, onClick: () => openInPanel(r.session, r.entry) },
    { label: t('explorer.terminalHere'), icon: SquareTerminal, hidden: !r.dir || !canTerminal(s), onClick: () => void openTerminal(r.session, r.entry.path) },
    { separator: true },
    { label: t('ops.copyPath'), icon: Copy, onClick: () => void copyText(r.entry.path) },
    { label: t('common.refresh'), icon: RefreshCw, hidden: !r.dir, onClick: () => void loadDir(r.session, r.entry.path, true) },
  ];
}

function select(r: Extract<Row, { kind: 'entry' }>) {
  selectEntry({ key: r.key, target: r.t.id, session: r.session, entry: r.entry });
  if (r.isRoot) {
    // roots are synthetic entries: fetch the real attributes for the details
    void call('fs.stat', { session: r.session, path: r.entry.path }).then(
      (entry) => {
        const cur = useExplorer.getState().selected;
        if (cur?.key === r.key) selectEntry({ ...cur, entry: { ...entry, path: r.entry.path } });
      },
      () => undefined,
    );
  }
}

function preview(r: Extract<Row, { kind: 'entry' }>) {
  select(r);
  void loadPreview(r.session, r.entry.path);
}

function activate(r: Row) {
  if (r.kind === 'target') toggleTarget(r.t);
  else if (r.kind === 'entry') {
    if (r.dir) {
      select(r);
      toggleDir(r.key, r.session, r.entry.path);
    } else preview(r);
  } else if (r.kind === 'more') showAllOf(r.dk);
}

// ---------------------------------------------------------------- rows

const TargetRow = memo(function TargetRow({ r, focused, id }: { r: Extract<Row, { kind: 'target' }>; focused: boolean; id: string }) {
  const t = useT();
  const { t: x, session, conn, open } = r;
  const shell = session?.protocol === 'scp';
  const state = conn?.connecting ? 'busy' : session ? 'on' : conn?.error ? 'err' : 'off';
  const more = useRef<HTMLButtonElement>(null);
  const sub = [addressOf(x), x.jump ? t('explorer.via', { name: x.jump }) : ''].filter(Boolean).join(' · ');
  return (
    <div
      id={id}
      role="treeitem"
      aria-level={1}
      aria-expanded={open}
      aria-selected={focused}
      className={cx('xp-row xp-target', focused && 'focus')}
      data-testid="xp-target"
      data-target={x.id}
      onClick={() => {
        setFocus(r.key);
        toggleTarget(x);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        setFocus(r.key);
        showContextMenu(e.clientX, e.clientY, targetMenu(x, t));
      }}
    >
      <span className="xp-caret">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
      <span className={cx('xp-host', `st-${state}`)}>
        <Server size={15} strokeWidth={1.6} />
        {state === 'busy' ? <Loader2 size={10} className="spin xp-host-busy" /> : <span className="xp-host-dot" />}
      </span>
      <span className="xp-target-text">
        <span className="xp-target-name">
          {x.color && <SessionDot color={x.color} />}
          <span className="xp-ellipsis">{x.name}</span>
          {shell && (
            <Badge tone="warn" title={t('explorer.shellMode')}>
              {t('explorer.shell')}
            </Badge>
          )}
        </span>
        <span className="xp-target-sub xp-ellipsis" title={sub}>
          {sub}
        </span>
      </span>
      <IconButton
        ref={more}
        icon={MoreHorizontal}
        size={14}
        title={t('common.more')}
        className="xp-more"
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          const b = more.current!.getBoundingClientRect();
          showContextMenu(b.left, b.bottom + 2, targetMenu(x, t));
        }}
      />
    </div>
  );
});

const EntryRow = memo(function EntryRow({ r, focused, selected, id, home }: { r: Extract<Row, { kind: 'entry' }>; focused: boolean; selected: boolean; id: string; home?: string }) {
  const t = useT();
  const e = r.entry;
  const label = r.isRoot ? (e.path === home ? '~' : e.path) : e.name;
  return (
    <div
      id={id}
      role="treeitem"
      aria-level={r.depth + 1}
      aria-expanded={r.dir ? r.open : undefined}
      aria-selected={selected}
      className={cx('xp-row xp-entry', focused && 'focus', selected && 'sel', e.hidden && 'hidden-file')}
      style={{ paddingLeft: 6 + r.depth * 14 }}
      title={e.path}
      data-testid="xp-entry"
      data-path={e.path}
      onClick={() => {
        setFocus(r.key);
        activate(r);
      }}
      onContextMenu={(ev: MouseEvent) => {
        ev.preventDefault();
        setFocus(r.key);
        select(r);
        showContextMenu(ev.clientX, ev.clientY, entryMenu(r, t));
      }}
    >
      <span
        className="xp-caret"
        onClick={(ev) => {
          if (!r.dir) return;
          ev.stopPropagation();
          setFocus(r.key);
          toggleDir(r.key, r.session, e.path);
        }}
      >
        {r.dir ? r.open ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : null}
      </span>
      <FileIcon entry={e} />
      <span className="xp-name xp-ellipsis">{label}</span>
      {r.isRoot && e.path === home && <span className="xp-dim xp-ellipsis">{home}</span>}
      {!r.dir && <span className="xp-dim xp-size">{formatBytes(e.size)}</span>}
    </div>
  );
});

// ---------------------------------------------------------------- details

function Details({ sessions }: { sessions: SessionSummary[] }) {
  const t = useT();
  const sel = useExplorer((s) => s.selected);
  const pv = useExplorer((s) => s.preview);
  if (!sel) return null;
  const e = sel.entry;
  const s = sessions.find((x) => x.id === sel.session);
  const dir = isDirLike(e);
  const showPreview = pv && pv.session === sel.session && pv.path === e.path;
  const items: [string, ReactNode][] = [
    [t('props.location'), <span className="mono-soft xp-copy" title={t('common.clickToCopy')} onClick={() => void copyText(e.path)} data-testid="xp-path">{e.path}</span>],
    [t('col.type'), typeLabel(e, t)],
  ];
  if (!dir) items.push([t('col.size'), `${formatBytes(e.size)}${e.size >= 1024 ? ` (${e.size.toLocaleString()} B)` : ''}`]);
  if (e.permissions !== undefined && e.permissions !== null) items.push([t('col.rights'), <span className="mono-soft">{formatPerms(e.permissions, e.kind)} ({formatOctal(e.permissions)})</span>]);
  if (e.owner || e.group) items.push([t('col.owner'), `${e.owner ?? '?'} : ${e.group ?? '?'}`]);
  if (e.modified) items.push([t('col.modified'), formatDate(e.modified)]);
  if (e.linkTarget) items.push([t('props.linkTarget'), <span className="mono-soft">{e.linkTarget}</span>]);
  return (
    <div className="xp-details" data-testid="xp-details">
      <div className="xp-details-head">
        <FileIcon entry={e} />
        <strong className="xp-ellipsis" title={e.name}>{e.name}</strong>
        <div className="flex1" />
        <IconButton icon={X} size={14} title={t('common.close')} onClick={() => selectEntry(null)} />
      </div>
      <dl className="xp-props">
        {items.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="xp-actions">
        {!dir && (
          <Button size="sm" icon={Eye} onClick={() => void loadPreview(sel.session, e.path, true)} data-testid="xp-preview-btn">
            {t('explorer.preview')}
          </Button>
        )}
        <Button size="sm" icon={FolderInput} onClick={() => openInPanel(sel.session, e)}>
          {t('explorer.openInPanel')}
        </Button>
        {dir && canTerminal(s) && <IconButton icon={SquareTerminal} size={14} title={t('explorer.terminalHere')} onClick={() => void openTerminal(sel.session, e.path)} />}
      </div>
      {showPreview && (
        <div className="xp-preview-box" data-testid="xp-preview">
          <div className="xp-preview-head">
            <Eye size={12} />
            <span className="flex1">
              {pv.data?.truncated ? t('explorer.previewTruncated', { total: formatBytes(pv.data.size) }) : t('explorer.preview')}
            </span>
            <IconButton icon={X} size={12} title={t('common.close')} onClick={() => closePreview()} />
          </div>
          {pv.loading ? (
            <div className="xp-preview-note">
              <Spinner size={13} /> {t('explorer.loading')}
            </div>
          ) : pv.error ? (
            <div className="xp-preview-note err">{pv.error}</div>
          ) : pv.data?.binary ? (
            <div className="xp-preview-note">{t('explorer.previewBinary')}</div>
          ) : pv.data && !pv.data.content ? (
            <div className="xp-preview-note">{t('explorer.previewEmpty')}</div>
          ) : (
            <pre className="xp-preview">{pv.data?.content}</pre>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- view

export function RemoteExplorer() {
  const t = useT();
  const savedTargets = useExplorer((s) => s.targets);
  const adhoc = useExplorer((s) => s.adhoc);
  const rawFilter = useExplorer((s) => s.filter);
  const conns = useExplorer((s) => s.conns);
  const dirs = useExplorer((s) => s.dirs);
  const expanded = useExplorer((s) => s.expanded);
  const showAll = useExplorer((s) => s.showAll);
  const focus = useExplorer((s) => s.focus);
  const selected = useExplorer((s) => s.selected?.key ?? null);
  const loaded = useExplorer((s) => s.loaded);
  const loading = useExplorer((s) => s.loading);
  const error = useExplorer((s) => s.error);
  const sessions = useApp((s) => s.sessions);
  const showHidden = useApp((s) => s.settings?.showHidden ?? false);
  const treeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadTargets();
  }, []);

  const filter = rawFilter.trim();
  const targets = useMemo(() => [...savedTargets, ...adhoc], [savedTargets, adhoc]);
  // sessionOf() reads the open sessions: rebuild when they change
  const rows = useMemo(
    () => buildRows(t, targets, filter, { conns, dirs, expanded, showAll }, showHidden),
    [t, targets, filter, conns, dirs, expanded, showAll, showHidden, sessions], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const nav = useMemo(() => rows.filter(focusable), [rows]);
  const ids = useMemo(() => new Map(rows.map((r, i) => [r.key, `xp-row-${i}`])), [rows]);
  const matching = targets.filter((x) => matches(x, filter));

  useEffect(() => {
    const id = focus ? ids.get(focus) : undefined;
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'nearest' });
  }, [focus, ids]);

  const move = (key: string | undefined) => {
    if (key) setFocus(key);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = nav.findIndex((r) => r.key === focus);
    const cur = i >= 0 ? nav[i] : undefined;
    switch (e.key) {
      case 'ArrowDown':
        move(nav[Math.min(nav.length - 1, i + 1)]?.key);
        break;
      case 'ArrowUp':
        move(nav[Math.max(0, i - 1)]?.key);
        break;
      case 'Home':
        move(nav[0]?.key);
        break;
      case 'End':
        move(nav[nav.length - 1]?.key);
        break;
      case 'ArrowRight':
        if (!cur) break;
        if ((cur.kind === 'target' || (cur.kind === 'entry' && cur.dir)) && !cur.open) activate(cur);
        else move(nav[i + 1]?.key);
        break;
      case 'ArrowLeft':
        if (!cur) break;
        if (cur.kind === 'target' && cur.open) toggleTarget(cur.t);
        else if (cur.kind === 'entry' && cur.dir && cur.open) toggleDir(cur.key, cur.session, cur.entry.path);
        else if (cur.kind === 'entry' || cur.kind === 'more') move(cur.parent);
        break;
      case 'Enter':
        if (cur) activate(cur);
        break;
      case ' ':
        if (cur?.kind === 'entry') select(cur);
        else if (cur) activate(cur);
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (matching.length === 1) {
        setFocus(matching[0].id);
        void connectTarget(matching[0]);
      } else if (matching.length === 0 && filter) void connectAddress(filter);
      else if (matching.length) {
        setFocus(matching[0].id);
        treeRef.current?.focus();
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (!focus && nav[0]) setFocus(nav[0].key);
      treeRef.current?.focus();
    } else if (e.key === 'Escape' && rawFilter) {
      e.preventDefault();
      setExplorerFilter('');
    }
  };

  const homeOf = (session: string) => sessions.find((s) => s.id === session)?.home;

  return (
    <div className="sidebar-view" data-testid="explorer">
      <div className="sidebar-head">
        <SidebarSwitch />
        <div className="flex1" />
        <IconButton icon={RefreshCw} size={14} title={t('explorer.reload')} className={loading ? 'spinning' : undefined} onClick={() => void loadTargets()} />
        <SidebarClose />
      </div>
      <div className="sidebar-status">
        <span title={t('explorer.readOnlyHint')}>
          <ShieldCheck size={12} className="ok" /> {t('explorer.readOnly')}
        </span>
      </div>
      <div className="xp-search">
        <TextInput
          value={rawFilter}
          onChange={(e) => setExplorerFilter(e.target.value)}
          onKeyDown={onSearchKey}
          placeholder={t('explorer.searchPlaceholder')}
          aria-label={t('explorer.searchPlaceholder')}
          spellCheck={false}
          autoCapitalize="off"
          data-testid="xp-search"
        />
      </div>
      <div className="sidebar-body xp-body">
        {filter && matching.length === 0 && (
          <button type="button" className="xp-connect-to" onClick={() => void connectAddress(filter)} data-testid="xp-connect-address">
            <Plug size={14} />
            <span className="xp-ellipsis">{t('explorer.connectTo', { address: filter })}</span>
            <kbd className="kbd">↵</kbd>
          </button>
        )}
        {!loaded ? (
          <div className="sidebar-empty">
            <Spinner />
          </div>
        ) : error ? (
          <div className="sidebar-empty">
            <p className="err">{error}</p>
            <Button size="sm" icon={RefreshCw} onClick={() => void loadTargets()}>
              {t('common.retry')}
            </Button>
          </div>
        ) : targets.length === 0 && !filter ? (
          <div className="sidebar-empty">
            <FolderTree size={26} strokeWidth={1.3} />
            <p>{t('explorer.none')}</p>
            <Button size="sm" icon={Server} onClick={() => openSiteManager()}>
              {t('session.newSession')}
            </Button>
          </div>
        ) : (
          <div
            ref={treeRef}
            className="xp-tree"
            role="tree"
            aria-label={t('explorer.title')}
            tabIndex={0}
            aria-activedescendant={focus ? ids.get(focus) : undefined}
            onKeyDown={onKey}
            onFocus={() => !focus && nav[0] && setFocus(nav[0].key)}
            data-testid="xp-tree"
          >
            {rows.map((r) => {
              const id = ids.get(r.key)!;
              switch (r.kind) {
                case 'section':
                  return (
                    <div key={r.key} className={cx('sidebar-section xp-section', r.raw && 'raw')} role="presentation">
                      {r.label} <span className="xp-count">{r.count}</span>
                    </div>
                  );
                case 'target':
                  return <TargetRow key={r.key} r={r} focused={focus === r.key} id={id} />;
                case 'entry':
                  return <EntryRow key={r.key} r={r} focused={focus === r.key} selected={selected === r.key} id={id} home={homeOf(r.session)} />;
                case 'more':
                  return (
                    <div
                      key={r.key}
                      id={id}
                      role="treeitem"
                      aria-level={r.depth + 1}
                      className={cx('xp-row xp-info xp-more-row', focus === r.key && 'focus')}
                      style={{ paddingLeft: 26 + r.depth * 14 }}
                      onClick={() => showAllOf(r.dk)}
                    >
                      {t('explorer.showAll', { n: r.n })}
                    </div>
                  );
                case 'info':
                  return (
                    <div key={r.key} className={cx('xp-row xp-info', r.tone === 'err' && 'err')} style={{ paddingLeft: 26 + r.depth * 14 }} role="none">
                      {r.busy && <Spinner size={12} />}
                      <span className="xp-info-text">{r.text}</span>
                      {r.action && (
                        <button type="button" className="link-btn" onClick={r.action.run}>
                          {r.action.label}
                        </button>
                      )}
                    </div>
                  );
              }
            })}
            {filter && matching.length === 0 && targets.length > 0 && <div className="sidebar-empty small">{t('explorer.noMatch', { filter })}</div>}
          </div>
        )}
      </div>
      <Details sessions={sessions} />
    </div>
  );
}
