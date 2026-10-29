import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { ChevronRight } from 'lucide-react';
import { call } from '../../api/client';
import { normalizeError } from '../../api/errors';
import { useT } from '../../i18n';
import * as P from '../../lib/paths';
import { sessionById } from '../../store/app';
import { getPanel, navigate, type Side } from '../../store/panels';
import { toast } from '../../store/toasts';

export const usePathEdit = create<{ side: Side | null }>(() => ({ side: null }));

export function focusPathBar(side: Side) {
  usePathEdit.setState({ side });
}

async function submitPath(side: Side, input: string) {
  const p = getPanel(side);
  const s = sessionById(p.session);
  const target = P.resolve(p.path, input, s?.home);
  try {
    // check first, so a mistyped path keeps the panel where it is (and a file path selects the file)
    await call('fs.list', { session: p.session, path: target });
    await navigate(side, p.session, target);
  } catch (e) {
    const err = normalizeError(e);
    if (err.code === 'not_a_directory') {
      const par = P.parent(target);
      if (par !== null) await navigate(side, p.session, par, { select: P.basename(target) });
      return;
    }
    toast.error(err, target);
  }
}

export function PathBar({ side, path, session }: { side: Side; path: string; session: string }) {
  const t = useT();
  const editSide = usePathEdit((s) => s.side);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(path);
  const inputRef = useRef<HTMLInputElement>(null);
  const crumbsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (editSide === side) {
      setValue(path);
      setEditing(true);
      usePathEdit.setState({ side: null });
    }
  }, [editSide, side, path]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  useLayoutEffect(() => {
    const el = crumbsRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [path, editing]);

  const stop = (focusTable = true) => {
    setEditing(false);
    if (focusTable) document.querySelector<HTMLElement>(`[data-panel="${side}"] .ft-body`)?.focus();
  };

  if (editing) {
    return (
      <div className="pathbar editing">
        <input
          ref={inputRef}
          className="pathbar-input"
          value={value}
          spellCheck={false}
          autoComplete="off"
          aria-label={t('panel.path')}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              e.preventDefault();
              const v = value;
              stop();
              void submitPath(side, v);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              stop();
            }
          }}
        />
      </div>
    );
  }

  const crumbs = P.crumbs(path || '/');
  return (
    <div
      className="pathbar"
      title={t('panel.pathEditHint')}
      onClick={(e) => {
        if (e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('pathbar-crumbs')) {
          setValue(path);
          setEditing(true);
        }
      }}
    >
      <div className="pathbar-crumbs" ref={crumbsRef} data-session={session}>
        {crumbs.map((c, i) => (
          <span key={c.path} className="crumb-wrap">
            {i > 0 && i > 1 && <ChevronRight size={12} className="crumb-sep" />}
            {i === 1 && crumbs[0].label !== '/' && <ChevronRight size={12} className="crumb-sep" />}
            <button
              type="button"
              className={i === crumbs.length - 1 ? 'crumb last' : 'crumb'}
              onClick={(e) => {
                e.stopPropagation();
                if (c.path !== path) void navigate(side, session, c.path, { select: crumbs[i + 1]?.label ?? null });
              }}
              title={c.path}
            >
              {c.label}
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
