// "Open file…" (Ctrl+P): type a path in any connected session – local or remote – with completion
// from the directory listing, or pick one of the recently edited files.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Clock, File as FileIcon, FilePlus, Folder, FolderOpen } from 'lucide-react';
import type { FileEntry } from '../../api/types';
import { call } from '../../api/client';
import { normalizeError } from '../../api/errors';
import { useT } from '../../i18n';
import { isDirLike } from '../../lib/fileTypes';
import { formatBytes } from '../../lib/format';
import * as P from '../../lib/paths';
import { useApp } from '../../store/app';
import { confirmDialog, type DialogPropsMap } from '../../store/dialogs';
import { openFile, recentFiles, sessionForKey } from '../../store/editors';
import { getPanel } from '../../store/panels';
import { toast } from '../../store/toasts';
import { Checkbox, Dialog, DialogButtons, Field, Select, TextInput, cx } from '../ui';

const MAX_SUGGESTIONS = 200;

/** Directory part and name prefix of an absolute path ('/etc/ng' -> ['/etc', 'ng']). */
function splitTyped(path: string): [string, string] {
  if (!path) return ['', ''];
  if (path.endsWith('/')) return [P.normalize(path), ''];
  return [P.dirname(path), P.basename(path)];
}

/** A directory path with a trailing '/', ready for typing a name. */
const asDir = (p: string) => {
  const n = P.normalize(p);
  return n.endsWith('/') ? n : n + '/';
};

export default function OpenFileDialog({ props, close }: { props: DialogPropsMap['openFile']; close: () => void }) {
  const t = useT();
  const sessions = useApp((s) => s.sessions);
  const active = getPanel(useApp.getState().activeSide);
  const [session, setSession] = useState(props.session ?? active.session);
  const startDir = props.dir ?? (session === active.session ? active.path : '');
  const [path, setPath] = useState(() => (startDir ? asDir(startDir) : ''));
  const [home, setHome] = useState('/');
  const [listing, setListing] = useState<{ dir: string; entries: FileEntry[] | null; error?: string }>({ dir: '', entries: null });
  const [idx, setIdx] = useState(-1);
  const [readOnly, setReadOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const cache = useRef(new Map<string, FileEntry[]>());
  const listRef = useRef<HTMLDivElement>(null);

  // relative input and ~ are resolved against the starting directory / home
  const abs = !path.trim() ? '' : P.isAbsolute(path) ? path : P.resolve(startDir || home, path, home) + (path.endsWith('/') ? '/' : '');
  const [dir, prefix] = splitTyped(abs);

  // list the typed directory (debounced, cached per session)
  useEffect(() => {
    if (!dir) {
      setListing({ dir, entries: null });
      return;
    }
    const key = `${session}\u0000${dir}`;
    const hit = cache.current.get(key);
    if (hit) {
      setListing({ dir, entries: hit });
      return;
    }
    const timer = setTimeout(() => {
      call('fs.list', { session, path: dir }).then(
        (r) => {
          cache.current.set(key, r.entries);
          setListing({ dir, entries: r.entries });
        },
        (e) => setListing({ dir, entries: null, error: normalizeError(e).message }),
      );
    }, 120);
    return () => clearTimeout(timer);
  }, [session, dir]);

  // the session's home: for '~' and as the start when nothing is typed
  useEffect(() => {
    let alive = true;
    void call('fs.home', { session }).then(
      (h) => {
        if (!alive) return;
        setHome(h);
        setPath((p) => p || asDir(h));
      },
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [session]);

  const suggestions = useMemo(() => {
    if (listing.dir !== dir || !listing.entries) return [];
    const q = prefix.toLowerCase();
    const starts = listing.entries.filter((e) => e.name.toLowerCase().startsWith(q));
    const contains = q ? listing.entries.filter((e) => !e.name.toLowerCase().startsWith(q) && e.name.toLowerCase().includes(q)) : [];
    const order = (a: FileEntry, b: FileEntry) => Number(isDirLike(b)) - Number(isDirLike(a)) || a.name.localeCompare(b.name);
    return [...starts.sort(order), ...contains.sort(order)].filter((e) => !e.hidden || q.startsWith('.')).slice(0, MAX_SUGGESTIONS);
  }, [listing, dir, prefix]);

  const recents = useMemo(
    () =>
      recentFiles()
        .map((r) => ({ ...r, session: sessionForKey(r.key) }))
        .filter((r): r is typeof r & { session: string } => !!r.session)
        .slice(0, 8),
    [],
  );

  // with a name typed, Enter takes the best match (an exact name wins)
  useEffect(() => {
    const exact = suggestions.findIndex((e) => e.name === prefix);
    setIdx(prefix && suggestions.length ? Math.max(0, exact) : -1);
  }, [suggestions, prefix]);
  useEffect(() => {
    listRef.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }, [idx]);

  const open = async (s: string, p: string, name: string, size = 0) => {
    close();
    await openFile(s, { name, path: p, size }, readOnly ? 'view' : 'edit');
  };

  const choose = (e: FileEntry) => {
    if (isDirLike(e)) setPath(asDir(e.path));
    else void open(session, e.path, e.name, e.size);
  };

  const submit = async () => {
    if (idx >= 0 && suggestions[idx]) return choose(suggestions[idx]);
    if (!abs) return;
    const target = P.normalize(abs);
    setBusy(true);
    try {
      const st = await call('fs.stat', { session, path: target });
      if (isDirLike(st)) setPath(asDir(target));
      else await open(session, target, P.basename(target), st.size);
    } catch (e) {
      const err = normalizeError(e);
      if (err.code !== 'not_found') {
        toast.error(err.message);
        return;
      }
      const create = await confirmDialog({ title: t('openFile.createTitle'), message: t('openFile.createMessage', { name: P.basename(target) }), okLabel: t('common.create') });
      if (!create) return;
      try {
        await call('fs.createFile', { session, path: target });
        await open(session, target, P.basename(target));
      } catch (e2) {
        toast.error(e2, t('ops.newFile'));
      }
    } finally {
      setBusy(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') setIdx((i) => Math.min(suggestions.length - 1, i + 1));
    else if (e.key === 'ArrowUp') setIdx((i) => Math.max(-1, i - 1));
    else if (e.key === 'Tab' && !e.shiftKey && suggestions.length) {
      const e0 = suggestions[Math.max(0, idx)];
      setPath(isDirLike(e0) ? asDir(e0.path) : e0.path);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <Dialog
      title={t('openFile.title')}
      icon={FolderOpen}
      onClose={close}
      onSubmit={() => void submit()}
      width={620}
      className="open-file-dialog"
      footer={<DialogButtons onCancel={close} okLabel={t('openFile.open')} busy={busy} extra={<Checkbox label={t('openFile.readOnly')} checked={readOnly} onChange={setReadOnly} />} />}
    >
      <div className="row gap">
        <Select value={session} onChange={(e) => {
          setSession(e.target.value);
          setPath('');
        }} className="of-session" aria-label={t('openFile.session')}>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id === 'local' ? t('session.local') : s.name}
            </option>
          ))}
        </Select>
        <TextInput
          className="flex1 mono"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          onKeyDown={onKey}
          data-autofocus
          data-select="none"
          spellCheck={false}
          autoComplete="off"
          placeholder="/etc/nginx/nginx.conf"
          aria-label={t('openFile.path')}
          data-testid="open-file-path"
        />
      </div>
      <div className="of-list" ref={listRef} role="listbox">
        {listing.error && listing.dir === dir ? (
          <div className="of-note err">{listing.error}</div>
        ) : suggestions.length ? (
          suggestions.map((e, i) => (
            <button type="button" key={e.path} role="option" aria-selected={i === idx} className={cx('of-item', i === idx && 'on')} onMouseEnter={() => setIdx(i)} onClick={() => choose(e)}>
              {isDirLike(e) ? <Folder size={14} className="fi-dir" /> : <FileIcon size={14} />}
              <span className="ellipsis">{e.name}{isDirLike(e) ? '/' : ''}</span>
              {!isDirLike(e) && <span className="muted small">{formatBytes(e.size)}</span>}
            </button>
          ))
        ) : listing.entries && listing.dir === dir ? (
          <div className="of-note muted">
            <FilePlus size={14} /> {prefix ? t('openFile.noMatchCreate', { name: prefix }) : t('openFile.emptyDir')}
          </div>
        ) : null}
      </div>
      {recents.length > 0 && (
        <Field label={t('openFile.recent')}>
          <div className="of-recent">
            {recents.map((r) => (
              <button type="button" key={`${r.key}:${r.path}`} className="of-item" onClick={() => void open(r.session, r.path, r.name)} title={r.path}>
                <Clock size={13} className="muted" />
                <span className="ellipsis">{r.name}</span>
                <span className="muted small ellipsis of-recent-path">
                  {r.session === 'local' ? t('session.local') : sessions.find((s) => s.id === r.session)?.name}: {P.dirname(r.path)}
                </span>
              </button>
            ))}
          </div>
        </Field>
      )}
      <div className="muted small">{t('openFile.hint')}</div>
    </Dialog>
  );
}
