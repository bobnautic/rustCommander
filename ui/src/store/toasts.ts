import { create } from 'zustand';
import { normalizeError, RpcCallError } from '../api/errors';
import { hasKey, tr } from '../i18n';

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
  action?: ToastAction;
  timeout: number;
}

interface ToastStore {
  toasts: Toast[];
}

export const useToasts = create<ToastStore>(() => ({ toasts: [] }));

let seq = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export function dismissToast(id: number) {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
  useToasts.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
}

export function pauseToast(id: number) {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.delete(id);
}

export function resumeToast(id: number) {
  const toast = useToasts.getState().toasts.find((x) => x.id === id);
  if (toast && toast.timeout > 0 && !timers.has(id)) timers.set(id, setTimeout(() => dismissToast(id), 2500));
}

export function showToast(kind: ToastKind, title: string, message?: string, opts: { timeout?: number; action?: ToastAction } = {}): number {
  const id = seq++;
  const timeout = opts.timeout ?? (kind === 'error' ? 8000 : kind === 'warning' ? 6000 : 3500);
  useToasts.setState((s) => {
    // collapse identical consecutive toasts
    const dup = s.toasts.find((x) => x.title === title && x.message === message && x.kind === kind);
    if (dup) dismissToast(dup.id);
    return { toasts: [...s.toasts.filter((x) => x.id !== dup?.id), { id, kind, title, message, action: opts.action, timeout }].slice(-5) };
  });
  if (timeout > 0) timers.set(id, setTimeout(() => dismissToast(id), timeout));
  return id;
}

/** Friendly text for an error code. */
export function errorTitle(e: unknown): string {
  const err = normalizeError(e);
  const key = `err.${err.code}`;
  return hasKey(key) ? tr(key) : tr('err.other');
}

export function errorText(e: unknown): string {
  const err = normalizeError(e);
  return err.message;
}

export const toast = {
  info: (title: string, message?: string, opts?: { timeout?: number; action?: ToastAction }) => showToast('info', title, message, opts),
  success: (title: string, message?: string, opts?: { timeout?: number; action?: ToastAction }) => showToast('success', title, message, opts),
  warning: (title: string, message?: string, opts?: { timeout?: number; action?: ToastAction }) => showToast('warning', title, message, opts),
  error(e: unknown, context?: string, opts?: { action?: ToastAction }) {
    const err = normalizeError(e);
    if (err.code === 'cancelled') return -1;
    const title = context ? `${context}: ${errorTitle(err)}` : errorTitle(err);
    const msg = err.message && err.message !== title ? err.message : undefined;
    return showToast('error', title, msg, opts);
  },
};

/** Runs an async action, showing an error toast on failure. Returns undefined on error. */
export async function attempt<T>(fn: () => Promise<T>, context?: string): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof RpcCallError) || e.code !== 'cancelled') toast.error(e, context);
    return undefined;
  }
}
