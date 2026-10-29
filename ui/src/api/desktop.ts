// Desktop-only helpers. Tauri modules are imported lazily so web mode never loads them.
import { mode } from './client';

export const isTauri = mode === 'desktop';

/** Native "open file" dialog. Returns the chosen path or null. */
export async function pickNativeFile(opts: { title?: string; directory?: boolean; defaultPath?: string; filters?: { name: string; extensions: string[] }[] } = {}): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const r = await open({ multiple: false, directory: !!opts.directory, title: opts.title, defaultPath: opts.defaultPath, filters: opts.filters });
  if (Array.isArray(r)) return r[0] ?? null;
  return r ?? null;
}

export interface OsDropEvent {
  type: 'over' | 'drop' | 'leave';
  paths: string[];
  /** Position in CSS pixels relative to the window. */
  x: number;
  y: number;
}

/** Subscribes to files dragged from the OS onto the window (desktop only). */
export async function onOsDragDrop(cb: (e: OsDropEvent) => void): Promise<() => void> {
  if (!isTauri) return () => {};
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  const webview = getCurrentWebview();
  let paths: string[] = [];
  const unlisten = await webview.onDragDropEvent((event) => {
    const p = event.payload;
    const ratio = window.devicePixelRatio || 1;
    if (p.type === 'enter') {
      paths = p.paths;
      cb({ type: 'over', paths, x: p.position.x / ratio, y: p.position.y / ratio });
    } else if (p.type === 'over') {
      cb({ type: 'over', paths, x: p.position.x / ratio, y: p.position.y / ratio });
    } else if (p.type === 'drop') {
      cb({ type: 'drop', paths: p.paths, x: p.position.x / ratio, y: p.position.y / ratio });
      paths = [];
    } else {
      cb({ type: 'leave', paths: [], x: 0, y: 0 });
      paths = [];
    }
  });
  return unlisten;
}
