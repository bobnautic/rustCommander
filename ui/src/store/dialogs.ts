import { create } from 'zustand';
import type { ExecOutput, FileEntry, Peer, SiteConfig, SyncPlan, TransferOptions } from '../api/types';
import type { Side } from './panels';

export interface ConfirmProps {
  title: string;
  message: string;
  detail?: string;
  okLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  checkbox?: { label: string; checked: boolean };
  /** A third button: runs `onClick`, then closes the dialog like Cancel. */
  alt?: { label: string; onClick: () => void };
  resolve: (ok: boolean, checked: boolean) => void;
}

export interface InputProps {
  title: string;
  label: string;
  value?: string;
  placeholder?: string;
  okLabel?: string;
  hint?: string;
  selectStem?: boolean;
  multiline?: boolean;
  password?: boolean;
  validate?: (v: string) => string | null;
  resolve: (v: string | null) => void;
}

export interface CopyProps {
  srcSession: string;
  entries: FileEntry[];
  dstSession: string;
  dstDir: string;
  move: boolean;
  srcSide?: Side;
}

/** One side of a comparison: a file in a session, or text (e.g. the editor's content). */
export interface DiffSide {
  label: string;
  /** For syntax highlighting. */
  fileName: string;
  session?: string;
  path?: string;
  text?: string;
}

export interface FingerprintProps {
  srcSession: string;
  srcPaths: string[];
  dstSession: string;
  dstDir: string;
  newName?: string | null;
  /** Transfer options of the copy (mask, hidden files, ...) for "copy changed files". */
  options?: Partial<TransferOptions>;
  /** Called after a copy was started from the dialog (the copy dialog closes itself then). */
  onCopied?: () => void;
}

export interface DialogPropsMap {
  confirm: ConfirmProps;
  input: InputProps;
  copy: CopyProps;
  properties: { session: string; entries: FileEntry[]; side?: Side };
  siteManager: { siteId?: string; draft?: SiteConfig };
  sync: Record<string, never>;
  syncChecklist: { plan: SyncPlan };
  keepUpToDate: Record<string, never>;
  find: { session: string; root: string };
  preferences: { tab?: string };
  tunnels: { session?: string };
  commands: { side?: Side };
  commandOutput: { title: string; outputs: ExecOutput[]; commands?: string[] };
  vault: Record<string, never>;
  about: Record<string, never>;
  share: Record<string, never>;
  connectPeer: { peer: Peer };
  addPeer: Record<string, never>;
  selectMask: { side: Side; select: boolean };
  checksum: { session: string; entry: FileEntry };
  createArchive: { session: string; paths: string[]; dir: string };
  symlink: { session: string; dir: string; target?: string };
  sessionInfo: { sessionId: string };
  shortcuts: Record<string, never>;
  /** `top`: above top-layer dialogs (e.g. opened from the overwrite question). */
  diff: { left: DiffSide; right: DiffSide; title?: string; top?: boolean };
  fingerprint: FingerprintProps;
  openFile: { session?: string; dir?: string };
}

export type DialogKind = keyof DialogPropsMap;

export interface DialogSpec<K extends DialogKind = DialogKind> {
  id: number;
  kind: K;
  props: DialogPropsMap[K];
}

interface DialogStore {
  stack: DialogSpec[];
}

export const useDialogs = create<DialogStore>(() => ({ stack: [] }));

let seq = 1;

export function openDialog<K extends DialogKind>(kind: K, props: DialogPropsMap[K]): number {
  const id = seq++;
  const spec = { id, kind, props } as DialogSpec;
  useDialogs.setState((s) => ({ stack: [...s.stack, spec] }));
  return id;
}

/** Opens a dialog unless one of the same kind is already open (then it is brought to front). */
export function openSingleton<K extends DialogKind>(kind: K, props: DialogPropsMap[K]): number {
  const existing = useDialogs.getState().stack.find((d) => d.kind === kind);
  if (existing) {
    useDialogs.setState((s) => ({ stack: [...s.stack.filter((d) => d.id !== existing.id), { ...existing, props } as DialogSpec] }));
    return existing.id;
  }
  return openDialog(kind, props);
}

export function closeDialog(id: number) {
  useDialogs.setState((s) => ({ stack: s.stack.filter((d) => d.id !== id) }));
}

export function isAnyDialogOpen(): boolean {
  return useDialogs.getState().stack.length > 0;
}

export function confirmDialog(p: Omit<ConfirmProps, 'resolve'>): Promise<boolean> {
  return new Promise((resolve) => openDialog('confirm', { ...p, resolve: (ok) => resolve(ok) }));
}

export function confirmWithCheckbox(p: Omit<ConfirmProps, 'resolve'>): Promise<{ ok: boolean; checked: boolean }> {
  return new Promise((resolve) => openDialog('confirm', { ...p, resolve: (ok, checked) => resolve({ ok, checked }) }));
}

export function inputDialog(p: Omit<InputProps, 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => openDialog('input', { ...p, resolve }));
}
