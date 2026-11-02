// One level of undo for renames and moves within one session (Ctrl+Z).
//
// A rename is undone by renaming back. A move job is remembered when it starts and becomes
// undoable once it completed; undoing moves the items back, but only those that are still
// where the move put them (same kind and size), so a later change is never overwritten.
import { create } from 'zustand';
import type { FileEntry, Job } from '../api/types';
import { call } from '../api/client';
import { tr } from '../i18n';
import * as P from '../lib/paths';
import { refreshWhere } from '../store/panels';
import { toast } from '../store/toasts';

interface Moved {
  from: string;
  to: string;
  kind: FileEntry['kind'];
  size: number;
}

export type UndoEntry =
  | { kind: 'rename'; session: string; from: string; to: string }
  | { kind: 'move'; session: string; items: Moved[] };

interface UndoStore {
  last: UndoEntry | null;
}

export const useUndo = create<UndoStore>(() => ({ last: null }));

/** Move jobs that become undoable when they complete. */
const pendingMoves = new Map<string, UndoEntry>();

export function recordRename(session: string, from: string, to: string) {
  useUndo.setState({ last: { kind: 'rename', session, from, to } });
}

/** Remember a move within one session; it is undoable after `jobId` completed. */
export function recordMove(jobId: string, session: string, entries: FileEntry[], dstDir: string, newName?: string | null) {
  const items = entries.map((e) => ({
    from: e.path,
    to: P.join(dstDir, entries.length === 1 && newName ? newName : e.name),
    kind: e.kind,
    size: e.size,
  }));
  pendingMoves.set(jobId, { kind: 'move', session, items });
}

/** Called for every job update (see boot.ts). */
export function onJobForUndo(job: Job) {
  const entry = pendingMoves.get(job.id);
  if (!entry) return;
  if (job.state === 'completed') {
    pendingMoves.delete(job.id);
    useUndo.setState({ last: entry });
  } else if (job.state === 'failed' || job.state === 'cancelled') {
    pendingMoves.delete(job.id);
  }
}

export function undoLabel(e: UndoEntry | null = useUndo.getState().last): string | null {
  if (!e) return null;
  if (e.kind === 'rename') return tr('undo.rename', { name: P.basename(e.to) });
  const what = e.items.length === 1 ? P.basename(e.items[0].to) : tr('undo.items', { n: e.items.length });
  return tr('undo.move', { what });
}

export async function undoLast() {
  const e = useUndo.getState().last;
  if (!e) return toast.info(tr('undo.nothing'));
  const label = undoLabel(e) ?? '';
  useUndo.setState({ last: null });
  try {
    if (e.kind === 'rename') {
      await call('fs.rename', { session: e.session, from: e.to, to: e.from });
      refreshWhere(e.session, P.dirname(e.from));
      toast.success(tr('undo.done'), label);
      return;
    }
    // Only items that are still exactly where the move left them.
    const back: Moved[] = [];
    for (const it of e.items) {
      try {
        const st = await call('fs.stat', { session: e.session, path: it.to });
        const sameKind = (st.kind === 'dir') === (it.kind === 'dir');
        if (sameKind && (it.kind === 'dir' || st.size === it.size)) back.push(it);
      } catch {
        /* gone or not reachable: skipped */
      }
    }
    if (!back.length) return toast.warning(tr('undo.changed'), label);
    // One move job per original directory; names are kept (or restored for a renamed item).
    const groups = new Map<string, Moved[]>();
    for (const it of back) {
      const dir = P.dirname(it.from);
      groups.set(dir, [...(groups.get(dir) ?? []), it]);
    }
    for (const [dir, items] of groups) {
      const single = items.length === 1 && P.basename(items[0].from) !== P.basename(items[0].to);
      await call('transfer.start', {
        srcSession: e.session,
        srcPaths: items.map((x) => x.to),
        dstSession: e.session,
        dstDir: dir,
        options: { move: true, overwrite: 'ask', newName: single ? P.basename(items[0].from) : null },
      });
    }
    toast.success(tr('undo.done'), back.length < e.items.length ? `${label}\n${tr('undo.partly', { n: e.items.length - back.length })}` : label);
  } catch (err) {
    toast.error(err, tr('undo.failed'));
  }
}
