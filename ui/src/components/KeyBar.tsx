// The function key bar of the classic commanders ("1Help 2Menu 3View …"): shows what F1–F10
// do in the active keyboard layout, switches to the Shift/Ctrl/Alt layer while a modifier is
// held, and runs the command when a key is clicked.
import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { KEY_BAR_KEYS, keyBarLayer } from '../lib/keymaps';
import { useApp } from '../store/app';
import { COMMANDS, isAvailable, runCommand } from '../actions/commands';
import { keyLabel, useKeymap } from '../actions/shortcuts';
import { cx } from './ui';

interface Mods {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const NONE: Mods = { ctrl: false, alt: false, shift: false };

function useHeldModifiers(): Mods {
  const [mods, setMods] = useState<Mods>(NONE);
  useEffect(() => {
    const update = (e: KeyboardEvent) => {
      const next = { ctrl: e.ctrlKey || e.metaKey, alt: e.altKey, shift: e.shiftKey };
      setMods((p) => (p.ctrl === next.ctrl && p.alt === next.alt && p.shift === next.shift ? p : next));
    };
    const reset = () => setMods(NONE);
    window.addEventListener('keydown', update, true);
    window.addEventListener('keyup', update, true);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', update, true);
      window.removeEventListener('keyup', update, true);
      window.removeEventListener('blur', reset);
    };
  }, []);
  return mods;
}

export function KeyBar() {
  const t = useT();
  const km = useKeymap();
  const show = useApp((s) => s.settings?.showKeyBar ?? true);
  const narrow = useApp((s) => s.narrow);
  // availability depends on the mode and the features of the backend
  useApp((s) => s.info);
  const mods = useHeldModifiers();
  if (!show || narrow) return null;
  const layer = keyBarLayer(mods);
  return (
    <div className={cx('keybar', layer && 'keybar-layer')} role="toolbar" aria-label={t('keybar.title')} data-testid="keybar" data-layer={layer || undefined}>
      {KEY_BAR_KEYS.map((k, i) => {
        const combo = layer + k;
        const cmd = km.bindings[combo];
        const on = !!cmd && isAvailable(cmd);
        return (
          <button
            key={k}
            type="button"
            className="kb-key"
            disabled={!on}
            title={on ? `${keyLabel(combo)} – ${t(COMMANDS[cmd].label)}` : keyLabel(combo)}
            data-testid={`keybar-${k}`}
            // keep the keyboard focus in the file panel
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => on && runCommand(cmd)}
          >
            <span className="kb-num">{i + 1}</span>
            <span className="kb-label">
              <span>{on ? t(COMMANDS[cmd].short) : ''}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
