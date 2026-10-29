// Internal drag & drop between panels (and onto session tabs) with pointer events.
//
// HTML5 drag & drop is deliberately not used here: the Tauri window runs with dragDropEnabled=true
// (OS file drops arrive via onDragDropEvent), which disables HTML5 DnD inside WebView2 on Windows.
// HTML5 drop handling remains only for files dragged from the OS into the browser (web mode).
import { create } from 'zustand';
import { isDirLike } from '../../lib/fileTypes';
import { setActiveSide, useApp } from '../../store/app';
import { getPanel, patchPanel, PARENT, usePanels, viewRows, type Side } from '../../store/panels';
import * as ops from '../../actions/fileOps';

export type DragTarget = { kind: 'panel'; side: Side; dir: string | null } | { kind: 'session'; session: string };

export interface PanelDrag {
  side: Side;
  names: string[];
  x: number;
  y: number;
  move: boolean;
  target: DragTarget | null;
}

export const usePanelDrag = create<{ drag: PanelDrag | null }>(() => ({ drag: null }));

const THRESHOLD = 5;

function hitTest(x: number, y: number, drag: Pick<PanelDrag, 'side' | 'names'>): DragTarget | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) return null;
  const tab = el.closest<HTMLElement>('[data-session-tab]');
  if (tab?.dataset.sessionTab) return { kind: 'session', session: tab.dataset.sessionTab };
  const panelEl = el.closest<HTMLElement>('[data-panel]');
  const side = panelEl?.dataset.panel as Side | undefined;
  if (!side || !el.closest('.ft-body')) return null;
  let dir: string | null = null;
  const rowName = el.closest<HTMLElement>('.ft-row')?.dataset.name;
  if (rowName && rowName !== PARENT) {
    const entry = getPanel(side).entries.find((e) => e.name === rowName);
    const self = side === drag.side && drag.names.includes(rowName);
    if (entry && isDirLike(entry) && !self) dir = rowName;
  }
  // dropping onto the background of the source panel does nothing
  if (side === drag.side && !dir) return null;
  return { kind: 'panel', side, dir };
}

/** Swallows the click that the browser fires after the pointer is released. */
function suppressNextClick() {
  const swallow = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
}

function setBodyCursor(target: DragTarget | null | undefined, active: boolean) {
  document.body.classList.toggle('rc-dragging', active);
  document.body.classList.toggle('rc-drag-none', active && !target);
}

function drop(drag: PanelDrag) {
  const target = drag.target;
  if (!target) return;
  const src = getPanel(drag.side);
  const entries = drag.names.map((n) => src.entries.find((e) => e.name === n)).filter((e): e is NonNullable<typeof e> => !!e);
  if (!entries.length) return;
  if (target.kind === 'panel') {
    const dst = getPanel(target.side);
    const dirEntry = target.dir ? dst.entries.find((e) => e.name === target.dir) : null;
    setActiveSide(target.side);
    ops.copyEntries(drag.side, entries, drag.move, { dstSide: target.side, dstDir: dirEntry?.path ?? dst.path });
    return;
  }
  // session tab: target the folder a panel shows for that session, else the session's start folder
  const panels = usePanels.getState();
  const showing = (['left', 'right'] as Side[]).find((s) => panels[s].session === target.session);
  const session = useApp.getState().sessions.find((s) => s.id === target.session);
  const dstDir = showing ? panels[showing].path : src.lastPaths[target.session] || panels.left.lastPaths[target.session] || panels.right.lastPaths[target.session] || session?.initialDir || session?.home || '/';
  ops.copyEntries(drag.side, entries, drag.move, { dstSession: target.session, dstDir });
}

/**
 * Called on pointerdown on a file row. Nothing happens until the pointer moves more than a few pixels,
 * so plain clicks and double-clicks keep working.
 */
export function armPointerDrag(e: PointerEvent, captureEl: HTMLElement, side: Side, rowName: string) {
  if (e.button !== 0 || e.pointerType === 'touch' || rowName === PARENT) return;
  const startX = e.clientX;
  const startY = e.clientY;
  const pointerId = e.pointerId;
  let started = false;
  let cancelled = false;

  const update = (x: number, y: number, move: boolean) => {
    const cur = usePanelDrag.getState().drag;
    if (!cur) return;
    const target = hitTest(x, y, cur);
    usePanelDrag.setState({ drag: { ...cur, x, y, move, target } });
    setBodyCursor(target, true);
  };

  const start = (x: number, y: number, move: boolean) => {
    const p = getPanel(side);
    let names: string[];
    if (p.selected.has(rowName)) {
      const rows = viewRows(p, useApp.getState().settings?.showHidden ?? false);
      names = rows.filter((r) => p.selected.has(r.name)).map((r) => r.name);
    } else {
      names = [rowName];
      patchPanel(side, { cursor: rowName, anchor: rowName, selected: new Set() });
    }
    started = true;
    try {
      captureEl.setPointerCapture(pointerId);
    } catch {
      /* pointer already released */
    }
    usePanelDrag.setState({ drag: { side, names, x, y, move, target: null } });
    update(x, y, move);
  };

  const cleanup = () => {
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onCancel, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKey, true);
    try {
      if (captureEl.hasPointerCapture(pointerId)) captureEl.releasePointerCapture(pointerId);
    } catch {
      /* ignore */
    }
    usePanelDrag.setState({ drag: null });
    setBodyCursor(null, false);
  };

  const onMove = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId || cancelled) return;
    if (!started) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < THRESHOLD) return;
      if ((ev.buttons & 1) === 0) {
        cleanup();
        return;
      }
      start(ev.clientX, ev.clientY, ev.shiftKey);
      return;
    }
    ev.preventDefault();
    update(ev.clientX, ev.clientY, ev.shiftKey);
  };

  const onUp = (ev: PointerEvent) => {
    if (ev.pointerId !== pointerId) return;
    const drag = usePanelDrag.getState().drag;
    if (started) suppressNextClick();
    cleanup();
    if (started && drag && !cancelled) drop({ ...drag, move: ev.shiftKey, target: hitTest(ev.clientX, ev.clientY, drag) });
  };

  const onCancel = (ev: PointerEvent) => {
    if (ev.pointerId === pointerId) cleanup();
  };

  const onKey = (ev: KeyboardEvent) => {
    if (!started) {
      if (ev.type === 'keydown' && ev.key === 'Escape') cleanup();
      return;
    }
    if (cancelled) return;
    if (ev.key === 'Escape' && ev.type === 'keydown') {
      // cancel now, but keep listening until the button is released so its click is swallowed
      ev.preventDefault();
      ev.stopPropagation();
      cancelled = true;
      usePanelDrag.setState({ drag: null });
      setBodyCursor(null, false);
      return;
    }
    if (ev.key === 'Shift') {
      const cur = usePanelDrag.getState().drag;
      if (cur) usePanelDrag.setState({ drag: { ...cur, move: ev.type === 'keydown' } });
    }
  };

  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onCancel, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKey, true);
}
