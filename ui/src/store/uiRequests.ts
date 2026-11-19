// Requests to open a piece of UI that keeps its open state locally (the menu bar, the
// dropdowns of a panel, the quick filter), sent by keyboard commands.
import { useEffect, useRef } from 'react';
import { create } from 'zustand';

interface UiRequest {
  key: string | null;
  n: number;
}

const useUiRequest = create<UiRequest>(() => ({ key: null, n: 0 }));

/** Asks the component listening for `key` to open. */
export function requestUi(key: string) {
  useUiRequest.setState((s) => ({ key, n: s.n + 1 }));
}

/** Runs `fn` whenever `requestUi(key)` is called after the component mounted. */
export function useOnUiRequest(key: string | undefined, fn: () => void) {
  const n = useUiRequest((s) => (key && s.key === key ? s.n : 0));
  const seen = useRef(n);
  const cb = useRef(fn);
  cb.current = fn;
  useEffect(() => {
    if (n && n !== seen.current) {
      seen.current = n;
      cb.current();
    }
  }, [n]);
}

/**
 * Remembers the focused element (the file list, when a menu opens from the keyboard) and
 * returns a function that gives the focus back – unless something else took it meanwhile,
 * such as a dialog opened from the menu.
 */
export function rememberFocus(): () => void {
  const prev = document.activeElement as HTMLElement | null;
  return () =>
    setTimeout(() => {
      const now = document.activeElement as HTMLElement | null;
      const free = !now || now === document.body || !!now.closest?.('.menu');
      if (free && prev && prev !== document.body && document.contains(prev)) prev.focus({ preventScroll: true });
    });
}
