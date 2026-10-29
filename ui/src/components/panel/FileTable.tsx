import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { create } from 'zustand';
import { ArrowDown, ArrowUp, CornerLeftUp, FolderOpen, Link2, LockKeyhole, RefreshCw, SearchX, ServerCrash, Unplug, Upload } from 'lucide-react';
import type { FileEntry } from '../../api/types';
import { mode } from '../../api/client';
import { useT, type TFn, type TKey } from '../../i18n';
import { CATEGORY_ICON, categoryOf, isDirLike } from '../../lib/fileTypes';
import { formatDate, formatPerms, formatSize } from '../../lib/format';
import * as P from '../../lib/paths';
import { load, save } from '../../lib/storage';
import { setActiveSide, useApp } from '../../store/app';
import {
  allRows, extendRange, goHome, goUp, invertSelection, other, PARENT, patchPanel, refresh, selectAll, selectNone, selectRange,
  setCursor, setSort, toggleSelected, usePanels, type CompareMark, type Side, type SortKey,
} from '../../store/panels';
import * as ops from '../../actions/fileOps';
import { reconnectSession } from '../../actions/sessions';
import { showContextMenu } from '../Menu';
import { buildPanelMenu } from './panelMenu';
import { armPointerDrag, usePanelDrag } from './panelDrag';
import { Button, cx, EmptyState, Spinner } from '../ui';


// ---------------------------------------------------------------- column widths (shared by both panels)

type Col = Exclude<SortKey, 'name'>;
const COLS: Col[] = ['size', 'type', 'modified', 'permissions', 'owner'];
const DEFAULT_WIDTHS: Record<Col, number> = { size: 74, type: 98, modified: 130, permissions: 90, owner: 84 };

export const useColumns = create<{ widths: Record<Col, number> }>(() => ({ widths: { ...DEFAULT_WIDTHS, ...load<Partial<Record<Col, number>>>('columns', {}) } }));

function setColWidth(col: Col, w: number) {
  const widths = { ...useColumns.getState().widths, [col]: Math.max(44, Math.min(400, Math.round(w))) };
  useColumns.setState({ widths });
  save('columns', widths);
}

const coarse = window.matchMedia('(pointer: coarse)');

function useRowHeight(): number {
  const narrow = useApp((s) => s.narrow);
  const [isCoarse, setCoarse] = useState(coarse.matches);
  useEffect(() => {
    const fn = (e: MediaQueryListEvent) => setCoarse(e.matches);
    coarse.addEventListener('change', fn);
    return () => coarse.removeEventListener('change', fn);
  }, []);
  return narrow || isCoarse ? 34 : 22;
}

export function typeLabel(e: FileEntry, t: TFn): string {
  if (e.name === PARENT) return t('ftype.parent');
  const cat = categoryOf(e);
  if (cat === 'dir' || cat === 'linkDir' || cat === 'link') return t(`ftype.${cat}` as TKey);
  const base = t(`ftype.${cat}` as TKey);
  // the extension is visible in the name already; only unknown types get it spelled out
  const ext = cat === 'file' ? P.extname(e.name) : '';
  return ext && ext.length <= 6 ? t('ftype.withExt', { ext: ext.toUpperCase(), type: base }) : base;
}

const CMP_KEYS: Record<CompareMark, TKey> = { only: 'compare.only', newer: 'compare.newer', older: 'compare.older', differs: 'compare.differs' };

// ---------------------------------------------------------------- row

interface RowProps {
  entry: FileEntry;
  top: number;
  cursor: boolean;
  selected: boolean;
  renaming: boolean;
  cmp?: CompareMark;
  dropTarget: boolean;
  dragging: boolean;
  sizeFormat: 'auto' | 'bytes';
  side: Side;
  t: TFn;
}

const Row = memo(function Row({ entry: e, top, cursor, selected, renaming, cmp, dropTarget, dragging, sizeFormat, side, t }: RowProps) {
  const parent = e.name === PARENT;
  const cat = parent ? 'dir' : categoryOf(e);
  const Icon = parent ? CornerLeftUp : CATEGORY_ICON[cat];
  const dirLike = parent || isDirLike(e);
  return (
    <div
      className={cx('ft-row', cursor && 'cursor', selected && 'selected', e.hidden && 'is-hidden', cmp && `cmp-${cmp}`, dropTarget && 'drop-target', dragging && 'dragging', dirLike && 'is-dir')}
      style={{ transform: `translateY(${top}px)` }}
      data-name={e.name}
      role="row"
      aria-selected={selected}
      title={cmp ? t(CMP_KEYS[cmp]) : undefined}
    >
      <div className="ft-cell col-name" role="gridcell">
        <span className={cx('fi', `fi-${cat}`)}>
          <Icon size={16} strokeWidth={1.6} />
          {e.kind === 'symlink' && <Link2 size={9} strokeWidth={2.5} className="fi-link-badge" />}
        </span>
        {renaming ? (
          <RenameInput side={side} name={e.name} />
        ) : (
          <span className="ft-name">
            {e.name}
            {e.kind === 'symlink' && e.linkTarget && <span className="ft-link-target"> → {e.linkTarget}</span>}
          </span>
        )}
      </div>
      <div className="ft-cell col-size" role="gridcell">{dirLike ? '' : formatSize(e.size, sizeFormat)}</div>
      <div className="ft-cell col-type" role="gridcell">{parent ? '' : typeLabel(e, t)}</div>
      <div className="ft-cell col-modified" role="gridcell">{parent ? '' : formatDate(e.modified)}</div>
      <div className="ft-cell col-permissions mono" role="gridcell">{parent ? '' : formatPerms(e.permissions, e.kind)}</div>
      <div className="ft-cell col-owner" role="gridcell" title={e.owner ? `${e.owner}${e.group ? ':' + e.group : ''}` : undefined}>
        {parent ? '' : e.owner ?? ''}
      </div>
    </div>
  );
});

function RenameInput({ side, name }: { side: Side; name: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const [stem] = P.splitExt(name);
    el.setSelectionRange(0, stem.length);
  }, [name]);
  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    const v = ref.current?.value ?? name;
    document.querySelector<HTMLElement>(`[data-panel="${side}"] .ft-body`)?.focus();
    if (commit) void ops.commitRename(side, name, v);
    else patchPanel(side, { renaming: null });
  };
  return (
    <input
      ref={ref}
      className="ft-rename"
      defaultValue={name}
      spellCheck={false}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    />
  );
}

// ---------------------------------------------------------------- header

function HeaderCell({ col, label, side, sortKey, sortDesc }: { col: SortKey; label: string; side: Side; sortKey: SortKey; sortDesc: boolean }) {
  const onResize = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (col === 'name') return;
    const startX = e.clientX;
    const startW = useColumns.getState().widths[col];
    const move = (ev: globalThis.MouseEvent) => setColWidth(col, startW - (ev.clientX - startX));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing-col');
    };
    document.body.classList.add('resizing-col');
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  return (
    <div className={cx('ft-hcell', `col-${col}`, sortKey === col && 'sorted')} role="columnheader" aria-sort={sortKey === col ? (sortDesc ? 'descending' : 'ascending') : 'none'} onClick={() => setSort(side, col)}>
      {col !== 'name' && <span className="col-resize" onMouseDown={onResize} onClick={(e) => e.stopPropagation()} onDoubleClick={() => setColWidth(col as Col, DEFAULT_WIDTHS[col as Col])} />}
      <span className="ft-hlabel">{label}</span>
      {sortKey === col && (sortDesc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
    </div>
  );
}

// ---------------------------------------------------------------- table

export function FileTable({ side, active }: { side: Side; active: boolean }) {
  const t = useT();
  const p = usePanels((s) => s[side]);
  const showHidden = useApp((s) => s.settings?.showHidden ?? false);
  const sizeFormat = useApp((s) => s.settings?.sizeFormat ?? 'auto');
  const webUi = useApp((s) => s.info?.mode === 'web');
  const widths = useColumns((s) => s.widths);
  const rowH = useRowHeight();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(400);
  // browser file drops (web mode) use HTML5 DnD; panel-to-panel drags use pointer events (panelDrag.ts)
  const [fileDropDir, setFileDropDir] = useState<string | null>(null);
  const [filesOver, setFilesOver] = useState(false);
  const drag = usePanelDrag((s) => s.drag);
  const dragTarget = drag?.target?.kind === 'panel' && drag.target.side === side ? drag.target : null;
  const draggedHere = drag && drag.side === side ? drag.names : null;
  const [typeahead, setTypeahead] = useState('');
  const typeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showSpinner, setShowSpinner] = useState(false);

  const rows = useMemo(() => allRows(p, showHidden), [p.entries, p.path, p.filter, p.sortKey, p.sortDesc, showHidden]);
  const indexOf = useCallback((name: string | null) => (name === null ? -1 : rows.findIndex((r) => r.name === name)), [rows]);
  const cursorIdx = indexOf(p.cursor);

  // delayed loading spinner (avoid flicker for fast listings)
  useEffect(() => {
    if (!p.loading) {
      setShowSpinner(false);
      return;
    }
    const tm = setTimeout(() => setShowSpinner(true), 250);
    return () => clearTimeout(tm);
  }, [p.loading]);

  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    setViewH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // reset scroll on directory change
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el) {
      el.scrollTop = 0;
      setScrollTop(0);
    }
  }, [p.path, p.session]);

  // keep the cursor visible
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || cursorIdx < 0) return;
    const top = cursorIdx * rowH;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + rowH - el.clientHeight;
  }, [cursorIdx, rowH, p.path]);

  // focus the table when the panel becomes active
  useEffect(() => {
    if (!active) return;
    const ae = document.activeElement;
    if (!ae || ae === document.body || (ae instanceof HTMLElement && ae.classList.contains('ft-body'))) bodyRef.current?.focus({ preventScroll: true });
  }, [active]);

  // default cursor: first row (also when the cursor's entry is hidden or filtered out —
  // file operations must never act on an entry that is not shown)
  useEffect(() => {
    if (!p.loading && (p.cursor === null || cursorIdx < 0) && rows.length) setCursor(side, rows[0].name === PARENT && rows.length > 1 ? rows[1].name : rows[0].name);
  }, [p.loading, p.cursor, cursorIdx, rows, side]);

  const first = Math.max(0, Math.floor(scrollTop / rowH) - 6);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewH) / rowH) + 6);

  const moveCursor = (idx: number, extend: boolean) => {
    if (!rows.length) return;
    const i = Math.max(0, Math.min(rows.length - 1, idx));
    const name = rows[i].name;
    if (extend) extendRange(side, name);
    else patchPanel(side, { cursor: name, anchor: name });
  };

  const rowFromEvent = (e: { target: EventTarget }): FileEntry | null => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.ft-row');
    if (!el) return null;
    const name = el.dataset.name ?? null;
    return rows.find((r) => r.name === name) ?? null;
  };

  // ------------------------------------------------ mouse

  const onClick = (e: MouseEvent) => {
    const entry = rowFromEvent(e);
    if (!entry) {
      // click on empty space clears the selection (keeps the cursor)
      if (p.selected.size && (e.target as HTMLElement).closest('.ft-body')) selectNone(side);
      return;
    }
    const name = entry.name;
    // touch screens have no Ctrl key: tapping the icon toggles the selection
    if (rowH > 30 && name !== PARENT && (e.target as HTMLElement).closest('.fi')) {
      toggleSelected(side, name);
      patchPanel(side, { cursor: name });
      return;
    }
    if (e.shiftKey) {
      selectRange(side, p.anchor ?? p.cursor, name, e.ctrlKey || e.metaKey);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      if (!p.selected.size && p.cursor && p.cursor !== PARENT && p.cursor !== name) toggleSelected(side, p.cursor);
      toggleSelected(side, name);
      patchPanel(side, { cursor: name });
      return;
    }
    patchPanel(side, { cursor: name, anchor: name, selected: new Set() });
    if (rowH > 30 && (name === PARENT || isDirLike(entry))) ops.openEntry(side, entry);
  };

  const onDoubleClick = (e: MouseEvent) => {
    const entry = rowFromEvent(e);
    if (!entry || e.shiftKey || e.ctrlKey || e.metaKey) return;
    if (rowH > 30 && (entry.name === PARENT || isDirLike(entry))) return;
    ops.openEntry(side, entry);
  };

  const onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    setActiveSide(side);
    const entry = rowFromEvent(e);
    if (entry && entry.name !== PARENT) {
      if (!p.selected.has(entry.name)) patchPanel(side, { cursor: entry.name, anchor: entry.name, selected: new Set() });
      else patchPanel(side, { cursor: entry.name });
    }
    showContextMenu(e.clientX, e.clientY, buildPanelMenu(side, entry));
  };

  // ------------------------------------------------ keyboard

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // rename input etc.
    const page = Math.max(1, Math.floor(viewH / rowH) - 1);
    const ctrl = e.ctrlKey || e.metaKey;
    const cur = cursorIdx < 0 ? 0 : cursorIdx;
    let handled = true;
    // any navigation / command key ends a type-ahead search
    if (typeahead && e.key.length > 1 && e.key !== 'Backspace' && e.key !== 'Shift') {
      if (typeTimer.current) clearTimeout(typeTimer.current);
      setTypeahead('');
    }
    switch (e.key) {
      case 'ArrowDown':
        moveCursor(cursorIdx < 0 ? 0 : cur + 1, e.shiftKey);
        break;
      case 'ArrowUp':
        moveCursor(cur - 1, e.shiftKey);
        break;
      case 'PageDown':
        moveCursor(cur + page, e.shiftKey);
        break;
      case 'PageUp':
        moveCursor(cur - page, e.shiftKey);
        break;
      case 'Home':
        if (e.ctrlKey || e.metaKey) void goHome(side);
        else moveCursor(0, e.shiftKey);
        break;
      case 'End':
        moveCursor(rows.length - 1, e.shiftKey);
        break;
      case 'Enter':
        if (e.altKey) {
          void ops.showProperties(side);
          break;
        }
        if (rows[cur]) ops.openEntry(side, rows[cur]);
        break;
      case 'Backspace':
        if (typeahead) {
          setTypeahead((s) => s.slice(0, -1));
          break;
        }
        void goUp(side);
        break;
      case 'Insert':
        if (rows[cur]) {
          toggleSelected(side, rows[cur].name);
          moveCursor(cur + 1, false);
        }
        break;
      case ' ':
        if (typeahead) {
          handled = false;
          break;
        }
        if (rows[cur]) toggleSelected(side, rows[cur].name);
        break;
      case 'Tab': {
        const o = other(side);
        setActiveSide(o);
        document.querySelector<HTMLElement>(`[data-panel="${o}"] .ft-body`)?.focus();
        break;
      }
      case 'Escape':
        if (typeahead) setTypeahead('');
        else if (p.filter) patchPanel(side, { filter: '' });
        else if (p.selected.size) selectNone(side);
        else handled = false;
        break;
      case 'ContextMenu': {
        const row = bodyRef.current?.querySelector<HTMLElement>('.ft-row.cursor');
        const r = row?.getBoundingClientRect() ?? bodyRef.current!.getBoundingClientRect();
        showContextMenu(r.left + 40, r.top + r.height, buildPanelMenu(side, rows[cur] ?? null));
        break;
      }
      case 'F10':
        if (e.shiftKey) {
          const row = bodyRef.current?.querySelector<HTMLElement>('.ft-row.cursor');
          const r = row?.getBoundingClientRect() ?? bodyRef.current!.getBoundingClientRect();
          showContextMenu(r.left + 40, r.top + r.height, buildPanelMenu(side, rows[cur] ?? null));
        } else handled = false;
        break;
      default:
        handled = false;
    }
    if (!handled && ctrl && !e.altKey && e.key.toLowerCase() === 'a') {
      if (e.shiftKey) selectNone(side);
      else selectAll(side);
      handled = true;
    }
    if (!handled && !ctrl && !e.altKey && (e.key === '+' || e.key === '-' || e.key === '*') && !typeahead) {
      if (e.key === '*') invertSelection(side);
      else ops.selectMask(side, e.key === '+');
      handled = true;
    }
    const typed = !ctrl && !e.altKey && e.key.length === 1 && (e.key !== ' ' || !!typeahead);
    if (!handled && typed) {
      const buf = (typeahead + e.key).toLowerCase();
      const start = typeahead ? cur : cur + 1;
      let found = -1;
      for (let n = 0; n < rows.length; n++) {
        const i = (start + n) % rows.length;
        if (rows[i].name !== PARENT && rows[i].name.toLowerCase().startsWith(buf)) {
          found = i;
          break;
        }
      }
      if (found >= 0) moveCursor(found, false);
      setTypeahead(found >= 0 || !typeahead ? buf : typeahead);
      if (typeTimer.current) clearTimeout(typeTimer.current);
      typeTimer.current = setTimeout(() => setTypeahead(''), 1100);
      handled = true;
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // ------------------------------------------------ drag & drop

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('.ft-rename')) return;
    const entry = rowFromEvent(e);
    if (!entry || entry.name === PARENT || p.renaming) return;
    armPointerDrag(e.nativeEvent, e.currentTarget, side, entry.name);
  };

  const fileDropDirFor = (e: DragEvent): FileEntry | null => {
    const entry = rowFromEvent(e);
    if (!entry || entry.name === PARENT || !isDirLike(entry)) return null;
    return entry;
  };

  const acceptsFiles = (e: DragEvent) => mode !== 'desktop' && Array.from(e.dataTransfer.types).includes('Files');

  const onDragOver = (e: DragEvent) => {
    if (!acceptsFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setFileDropDir(fileDropDirFor(e)?.name ?? null);
    setFilesOver(true);
  };

  const onDragLeave = (e: DragEvent) => {
    if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) {
      setFileDropDir(null);
      setFilesOver(false);
    }
  };

  const onDrop = (e: DragEvent) => {
    setFileDropDir(null);
    setFilesOver(false);
    if (!acceptsFiles(e)) return;
    e.preventDefault();
    const target = fileDropDirFor(e);
    const dstDir = target ? target.path || P.join(p.path, target.name) : p.path;
    // the entries must be grabbed synchronously inside the event handler
    const dt = e.dataTransfer;
    void (async () => {
      const web = await import('../../api/web');
      const entries = web.entriesFromDataTransfer(dt);
      const files = entries ? null : Array.from(dt.files);
      const set = entries ? await web.collectEntries(entries) : web.collectFileList(files ?? []);
      await web.uploadToSession(p.session, dstDir, set);
    })();
  };

  // ------------------------------------------------ render

  const colVars = Object.fromEntries(COLS.map((c) => [`--w-${c}`, `${widths[c]}px`]));
  const headers: [SortKey, TKey][] = [
    ['name', 'col.name'],
    ['size', 'col.size'],
    ['type', 'col.type'],
    ['modified', 'col.modified'],
    ['permissions', 'col.rights'],
    ['owner', 'col.owner'],
  ];

  const err = p.error;
  const errIcon = err?.code === 'permission_denied' ? LockKeyhole : err?.code === 'connection_lost' || err?.code === 'timeout' ? Unplug : err?.code === 'not_found' ? SearchX : ServerCrash;
  const emptyMsg = p.filter ? t('panel.noMatch') : t('panel.empty');

  return (
    <div className="ft" role="grid" aria-label={t('panel.files')} style={{ ...colVars, ['--row-h' as string]: `${rowH}px` }}>
      <div className="ft-head" role="row">
        {headers.map(([k, label]) => (
          <HeaderCell key={k} col={k} label={t(label)} side={side} sortKey={p.sortKey} sortDesc={p.sortDesc} />
        ))}
      </div>
      <div
        ref={bodyRef}
        className={cx('ft-body', (filesOver || dragTarget) && 'drag-over', filesOver && 'drag-files')}
        tabIndex={0}
        onScroll={(e) => setScrollTop((e.target as HTMLElement).scrollTop)}
        onKeyDown={onKeyDown}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onPointerDown={onPointerDown}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        data-testid={`table-${side}`}
      >
        {!err && (
          <div className="ft-canvas" style={{ height: rows.length * rowH }}>
            {rows.slice(first, last).map((r, i) => (
              <Row
                key={r.name}
                entry={r}
                top={(first + i) * rowH}
                cursor={r.name === p.cursor}
                selected={p.selected.has(r.name)}
                renaming={p.renaming === r.name}
                cmp={p.compare?.[r.name]}
                dropTarget={dragTarget?.dir === r.name || fileDropDir === r.name}
                dragging={!!draggedHere && draggedHere.includes(r.name)}
                sizeFormat={sizeFormat}
                side={side}
                t={t}
              />
            ))}
          </div>
        )}
        {!err && !p.loading && p.loaded && rows.filter((r) => r.name !== PARENT).length === 0 && (
          <div className="ft-empty">
            <EmptyState icon={FolderOpen} title={emptyMsg}>
              {webUi && !p.filter ? t('web.dropHint') : null}
            </EmptyState>
          </div>
        )}
        {err && (
          <div className="ft-empty">
            <EmptyState
              icon={errIcon}
              title={t(`err.${err.code}` as TKey)}
              action={
                <div className="btn-row">
                  <Button size="sm" icon={RefreshCw} onClick={() => void refresh(side)}>
                    {t('common.retry')}
                  </Button>
                  {(err.code === 'connection_lost' || err.code === 'timeout') && p.session !== 'local' && (
                    <Button size="sm" icon={Unplug} onClick={() => void reconnectSession(p.session).then(() => refresh(side))}>
                      {t('session.reconnect')}
                    </Button>
                  )}
                  {P.parent(p.path) !== null && (
                    <Button size="sm" icon={CornerLeftUp} onClick={() => void goUp(side)}>
                      {t('nav.up')}
                    </Button>
                  )}
                  <Button size="sm" onClick={() => void goHome(side)}>
                    {t('nav.home')}
                  </Button>
                </div>
              }
            >
              <span className="mono-soft">{p.path}</span>
              <br />
              {err.message}
            </EmptyState>
          </div>
        )}
        {showSpinner && (
          <div className="ft-loading">
            <Spinner size={18} />
          </div>
        )}
        {filesOver && (
          <div className="ft-dropzone">
            <Upload size={22} />
            <span>{t('web.dropToUpload', { path: fileDropDir ? P.join(p.path, fileDropDir) : p.path })}</span>
          </div>
        )}
        {typeahead && (
          <div className="ft-typeahead">{typeahead}</div>
        )}
      </div>
    </div>
  );
}
