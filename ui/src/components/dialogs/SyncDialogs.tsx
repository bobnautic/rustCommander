import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft, ArrowLeftRight, ArrowRight, CircleAlert, File as FileIcon, Folder, FolderSync, Play, Radar, Square, Trash2, ArrowRightLeft,
} from 'lucide-react';
import type { SyncAction, SyncActionKind, SyncDirection, SyncParams } from '../../api/types';
import { call, on } from '../../api/client';
import { useT, type TKey } from '../../i18n';
import { formatBytes, formatDate, formatNumber } from '../../lib/format';
import { load, save } from '../../lib/storage';
import { setLayout, useApp } from '../../store/app';
import { openDialog, type DialogPropsMap } from '../../store/dialogs';
import { upsertBg, removeBg, useBg } from '../../store/misc';
import { getPanel } from '../../store/panels';
import { attempt, toast } from '../../store/toasts';
import { Badge, Button, Checkbox, Dialog, DialogButtons, EmptyState, Field, IconButton, NumberInput, ProgressBar, Radio, Segmented, Select, TextInput, cx } from '../ui';

type DP<K extends keyof DialogPropsMap> = { props: DialogPropsMap[K]; close: () => void };

function SessionSelect({ value, onChange, remoteOnly, id }: { value: string; onChange: (v: string) => void; remoteOnly?: boolean; id?: string }) {
  const t = useT();
  const sessions = useApp((s) => s.sessions);
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
      {sessions
        .filter((s) => !remoteOnly || s.id !== 'local')
        .map((s) => (
          <option key={s.id} value={s.id}>
            {s.id === 'local' ? t('session.local') : s.name}
          </option>
        ))}
    </Select>
  );
}

// ---------------------------------------------------------------- synchronize (options)

export function SyncDialog({ close }: DP<'sync'>) {
  const t = useT();
  const [prm, setPrm] = useState<SyncParams>(() => {
    const L = getPanel('left');
    const R = getPanel('right');
    const saved = load<Partial<SyncParams>>('syncOpts', {});
    return {
      leftSession: L.session, leftPath: L.path, rightSession: R.session, rightPath: R.path,
      direction: saved.direction ?? 'leftToRight', mode: saved.mode ?? 'update', deleteObsolete: saved.deleteObsolete ?? false,
      compareSize: saved.compareSize ?? true, compareTime: saved.compareTime ?? true, compareChecksum: saved.compareChecksum ?? false,
      timeTolerance: saved.timeTolerance ?? 2, fileMask: saved.fileMask ?? '', excludeHidden: saved.excludeHidden ?? false, nonRecursive: saved.nonRecursive ?? false,
    };
  });
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ scannedLeft: number; scannedRight: number; current: string } | null>(null);
  const set = <K extends keyof SyncParams>(k: K, v: SyncParams[K]) => setPrm((p) => ({ ...p, [k]: v }));

  useEffect(() => (busy ? on('sync.progress', setProgress) : undefined), [busy]);

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setProgress(null);
    const { leftSession: _l, leftPath: _lp, rightSession: _r, rightPath: _rp, ...opts } = prm;
    save('syncOpts', opts);
    try {
      const plan = await call('sync.compare', { params: prm });
      close();
      openDialog('syncChecklist', { plan });
    } catch (e) {
      toast.error(e, t('sync.title'));
      setBusy(false);
    }
  };

  const dirOptions: { value: SyncDirection; label: string }[] = [
    { value: 'leftToRight', label: t('sync.leftToRight') },
    { value: 'rightToLeft', label: t('sync.rightToLeft') },
    { value: 'both', label: t('sync.both') },
  ];

  return (
    <Dialog title={t('sync.title')} icon={FolderSync} onClose={close} onSubmit={() => void submit()} width={640} footer={<DialogButtons onCancel={close} okLabel={t('sync.compare')} busy={busy} />}>
      <div className="sync-sides">
        <div className="sync-side">
          <div className="field-label">{t('sync.left')}</div>
          <SessionSelect value={prm.leftSession} onChange={(v) => set('leftSession', v)} />
          <TextInput value={prm.leftPath} onChange={(e) => set('leftPath', e.target.value)} aria-label={t('sync.leftPath')} />
        </div>
        <div className="sync-arrow">
          {prm.direction === 'leftToRight' ? <ArrowRight size={20} /> : prm.direction === 'rightToLeft' ? <ArrowLeft size={20} /> : <ArrowLeftRight size={20} />}
        </div>
        <div className="sync-side">
          <div className="field-label">{t('sync.right')}</div>
          <SessionSelect value={prm.rightSession} onChange={(v) => set('rightSession', v)} />
          <TextInput value={prm.rightPath} onChange={(e) => set('rightPath', e.target.value)} aria-label={t('sync.rightPath')} />
        </div>
      </div>
      <Field label={t('sync.direction')}>
        <Segmented value={prm.direction} onChange={(v) => setPrm((p) => ({ ...p, direction: v, deleteObsolete: v === 'both' ? false : p.deleteObsolete }))} options={dirOptions} />
      </Field>
      <div className="form-grid">
        <Field label={t('sync.mode')}>
          <div className="radio-col">
            <Radio name="syncmode" value="update" current={prm.mode} onChange={(v) => set('mode', v)} label={t('sync.update')} />
            <Radio name="syncmode" value="mirror" current={prm.mode} onChange={(v) => set('mode', v)} label={t('sync.mirror')} disabled={prm.direction === 'both'} />
          </div>
        </Field>
        <Field label={t('sync.compareBy')}>
          <div className="radio-col">
            <Checkbox label={t('sync.byTime')} checked={prm.compareTime} onChange={(v) => set('compareTime', v)} />
            <Checkbox label={t('sync.bySize')} checked={prm.compareSize} onChange={(v) => set('compareSize', v)} />
            <Checkbox label={t('sync.byChecksum')} checked={prm.compareChecksum} onChange={(v) => set('compareChecksum', v)} />
          </div>
        </Field>
        <Field label={t('topt.fileMask')} hint={t('topt.fileMaskHint')}>
          <TextInput value={prm.fileMask} onChange={(e) => set('fileMask', e.target.value)} placeholder="*.* | .git/; node_modules/" />
        </Field>
        <Field label={t('sync.tolerance')}>
          <div className="input-suffix">
            <NumberInput value={prm.timeTolerance} min={0} max={7200} onChange={(v) => set('timeTolerance', Math.max(0, v))} />
            <span>{t('sync.seconds')}</span>
          </div>
        </Field>
      </div>
      <div className="check-grid">
        <Checkbox label={t('sync.deleteObsolete')} checked={prm.deleteObsolete} disabled={prm.direction === 'both'} onChange={(v) => set('deleteObsolete', v)} />
        <Checkbox label={t('topt.excludeHidden')} checked={prm.excludeHidden} onChange={(v) => set('excludeHidden', v)} />
        <Checkbox label={t('sync.nonRecursive')} checked={prm.nonRecursive} onChange={(v) => set('nonRecursive', v)} />
      </div>
      {busy && (
        <div className="sync-progress">
          <ProgressBar value={0} indeterminate />
          <span className="muted small">
            {t('sync.scanning', { left: formatNumber(progress?.scannedLeft ?? 0), right: formatNumber(progress?.scannedRight ?? 0) })}
            {progress?.current ? ` · ${progress.current}` : ''}
          </span>
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------- checklist

const KIND_ICON: Record<SyncActionKind, typeof ArrowRight> = {
  copyLeftToRight: ArrowRight,
  copyRightToLeft: ArrowLeft,
  deleteLeft: Trash2,
  deleteRight: Trash2,
  conflict: CircleAlert,
};
const KINDS: SyncActionKind[] = ['copyLeftToRight', 'copyRightToLeft', 'deleteLeft', 'deleteRight', 'conflict'];

function actionBytes(a: SyncAction): number {
  if (a.isDir) return 0;
  if (a.action === 'copyLeftToRight') return a.left?.size ?? 0;
  if (a.action === 'copyRightToLeft') return a.right?.size ?? 0;
  if (a.action === 'conflict') return Math.max(a.left?.size ?? 0, a.right?.size ?? 0);
  return 0;
}

export function SyncChecklistDialog({ props, close }: DP<'syncChecklist'>) {
  const t = useT();
  const plan = props.plan;
  const sessions = useApp((s) => s.sessions);
  const [checked, setChecked] = useState<Set<string>>(() => new Set(plan.actions.filter((a) => a.action !== 'conflict').map((a) => a.id)));
  const [hidden, setHidden] = useState<Set<SyncActionKind>>(new Set());
  const [busy, setBusy] = useState(false);
  const counts = useMemo(() => {
    const c = {} as Record<SyncActionKind, number>;
    for (const k of KINDS) c[k] = 0;
    for (const a of plan.actions) c[a.action]++;
    return c;
  }, [plan]);
  const visible = plan.actions.filter((a) => !hidden.has(a.action));
  const selected = plan.actions.filter((a) => checked.has(a.id));
  const bytes = selected.reduce((s, a) => s + actionBytes(a), 0);
  const sname = (id: string) => (id === 'local' ? t('session.local') : (sessions.find((s) => s.id === id)?.name ?? id));
  const toggle = (id: string) => setChecked((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });

  const cancel = () => {
    void call('sync.discard', { planId: plan.id }).catch(() => undefined);
    close();
  };
  const execute = async () => {
    if (!selected.length || busy) return;
    setBusy(true);
    try {
      await call('sync.execute', { planId: plan.id, actionIds: selected.map((a) => a.id) });
      setLayout({ dockOpen: true, dockTab: 'queue' });
      toast.info(t('sync.started'), t('sync.startedText', { n: selected.length }));
      close();
    } catch (e) {
      toast.error(e, t('sync.title'));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t('sync.checklist')}
      icon={FolderSync}
      onClose={cancel}
      onSubmit={() => void execute()}
      width={980}
      height={640}
      className="sync-checklist"
      bodyClassName="sc-body"
      footer={
        <DialogButtons
          onCancel={cancel}
          okLabel={t('sync.execute')}
          okDisabled={!selected.length}
          busy={busy}
          extra={
            <span className="muted small" data-testid="sync-total">
              {t('sync.selectedTotal', { n: selected.length, total: plan.actions.length, size: formatBytes(bytes) })}
            </span>
          }
        />
      }
    >
      <div className="sc-head">
        <div className="sc-route">
          <span className="route-session">{sname(plan.params.leftSession)}</span>
          <span className="mono-soft small">{plan.params.leftPath}</span>
          {plan.params.direction === 'leftToRight' ? <ArrowRight size={14} /> : plan.params.direction === 'rightToLeft' ? <ArrowLeft size={14} /> : <ArrowRightLeft size={14} />}
          <span className="route-session">{sname(plan.params.rightSession)}</span>
          <span className="mono-soft small">{plan.params.rightPath}</span>
        </div>
        <span className="muted small">{t('sync.stats', { identical: formatNumber(plan.identical), left: formatNumber(plan.scannedLeft), right: formatNumber(plan.scannedRight) })}</span>
      </div>
      <div className="sc-filters">
        {KINDS.filter((k) => counts[k] > 0).map((k) => {
          const Icon = KIND_ICON[k];
          return (
            <button
              key={k}
              type="button"
              className={cx('chip', `sc-${k}`, !hidden.has(k) && 'on')}
              onClick={() => setHidden((h) => {
                const n = new Set(h);
                if (n.has(k)) n.delete(k);
                else n.add(k);
                return n;
              })}
              aria-pressed={!hidden.has(k)}
            >
              <Icon size={13} /> {t(`sync.kind.${k}` as TKey)} <span className="chip-count">{counts[k]}</span>
            </button>
          );
        })}
        <div className="flex1" />
        <Button size="sm" variant="ghost" onClick={() => setChecked(new Set([...checked, ...visible.map((a) => a.id)]))}>
          {t('sync.selectAll')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setChecked(new Set([...checked].filter((id) => !visible.some((a) => a.id === id))))}>
          {t('sync.selectNone')}
        </Button>
      </div>
      {plan.actions.length === 0 ? (
        <EmptyState icon={FolderSync} title={t('sync.identical')}>{t('sync.identicalText')}</EmptyState>
      ) : (
        <div className="sc-table" role="grid">
          <div className="sc-row sc-th" role="row">
            <span />
            <span />
            <span>{t('col.name')}</span>
            <span className="num">{t('sync.leftSize')}</span>
            <span>{t('sync.leftTime')}</span>
            <span />
            <span className="num">{t('sync.rightSize')}</span>
            <span>{t('sync.rightTime')}</span>
            <span>{t('sync.reason')}</span>
          </div>
          {visible.map((a) => {
            const Icon = KIND_ICON[a.action];
            return (
              <div key={a.id} className={cx('sc-row', `sc-${a.action}`, !checked.has(a.id) && 'unchecked')} role="row" onClick={() => toggle(a.id)} data-testid="sync-row">
                <span onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" checked={checked.has(a.id)} onChange={() => toggle(a.id)} aria-label={a.relPath} />
                </span>
                <span className="sc-icon" title={t(`sync.kind.${a.action}` as TKey)}>
                  <Icon size={14} />
                </span>
                <span className="sc-name" title={a.relPath}>
                  {a.isDir ? <Folder size={13} className="fi-dir" /> : <FileIcon size={13} className="muted" />}
                  <span>{a.relPath}{a.isDir ? '/' : ''}</span>
                </span>
                <span className="num">{a.left && !a.isDir ? formatBytes(a.left.size) : a.left ? '' : '—'}</span>
                <span className="muted">{a.left ? formatDate(a.left.modified) : ''}</span>
                <span className="sc-dir">{a.action === 'copyLeftToRight' ? '→' : a.action === 'copyRightToLeft' ? '←' : a.action === 'conflict' ? '⇄' : '✕'}</span>
                <span className="num">{a.right && !a.isDir ? formatBytes(a.right.size) : a.right ? '' : '—'}</span>
                <span className="muted">{a.right ? formatDate(a.right.modified) : ''}</span>
                <span>
                  <Badge tone={a.reason === 'obsolete' ? 'err' : a.reason === 'bothChanged' ? 'warn' : a.reason === 'new' ? 'ok' : 'muted'}>{t(`sync.reason.${a.reason}` as TKey)}</Badge>
                </span>
              </div>
            );
          })}
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------- keep remote directory up to date

export function KeepUpToDateDialog({ close }: DP<'keepUpToDate'>) {
  const t = useT();
  const sessions = useApp((s) => s.sessions);
  const watches = useBg((s) => s.watches);
  const L = getPanel('left');
  const R = getPanel('right');
  const localPanel = L.session === 'local' ? L : R.session === 'local' ? R : null;
  const remotePanel = L.session !== 'local' ? L : R.session !== 'local' ? R : null;
  const [localPath, setLocalPath] = useState(localPanel?.path ?? '');
  const [remoteSession, setRemoteSession] = useState(remotePanel?.session ?? sessions.find((s) => s.id !== 'local')?.id ?? '');
  const [remotePath, setRemotePath] = useState(remotePanel?.path ?? '/');
  const [deleteRemote, setDeleteRemote] = useState(false);
  const [initialSync, setInitialSync] = useState(true);
  const [fileMask, setFileMask] = useState('');
  const [busy, setBusy] = useState(false);
  const hasRemote = sessions.some((s) => s.id !== 'local');
  const sname = (id: string) => sessions.find((s) => s.id === id)?.name ?? id;

  const start = async () => {
    if (!hasRemote || busy) return;
    setBusy(true);
    const w = await attempt(() => call('watch.start', { localPath, remoteSession, remotePath, deleteRemote, fileMask, initialSync }));
    setBusy(false);
    if (w) {
      upsertBg('watches', w);
      toast.success(t('watch.started'));
    }
  };

  return (
    <Dialog title={t('watch.title')} icon={Radar} onClose={close} onSubmit={() => void start()} width={620} footer={<div className="dlg-foot-buttons"><Button variant="primary" icon={Play} onClick={() => void start()} busy={busy} disabled={!hasRemote || !localPath}>{t('watch.start')}</Button><Button onClick={close}>{t('common.close')}</Button></div>}>
      <p className="muted small">{t('watch.explain')}</p>
      {!hasRemote && <p className="warn small">{t('watch.needRemote')}</p>}
      <div className="form-grid">
        <Field label={t('watch.localDir')} className="span2">
          <TextInput value={localPath} onChange={(e) => setLocalPath(e.target.value)} data-autofocus />
        </Field>
        <Field label={t('watch.remoteSession')}>
          <SessionSelect value={remoteSession} onChange={setRemoteSession} remoteOnly />
        </Field>
        <Field label={t('watch.remoteDir')}>
          <TextInput value={remotePath} onChange={(e) => setRemotePath(e.target.value)} />
        </Field>
        <Field label={t('topt.fileMask')} className="span2">
          <TextInput value={fileMask} onChange={(e) => setFileMask(e.target.value)} placeholder="| *.tmp; .git/" />
        </Field>
      </div>
      <div className="check-grid">
        <Checkbox label={t('watch.deleteRemote')} checked={deleteRemote} onChange={setDeleteRemote} />
        <Checkbox label={t('watch.initialSync')} checked={initialSync} onChange={setInitialSync} />
      </div>
      <div className="section-title">{t('watch.active')}</div>
      {Object.values(watches).length === 0 ? (
        <div className="muted small">{t('watch.none')}</div>
      ) : (
        <div className="watch-list">
          {Object.values(watches).map((w) => (
            <div key={w.id} className="watch-row">
              <Radar size={14} className="accent" />
              <div className="watch-main">
                <div className="ellipsis">
                  <span className="mono small">{w.localPath}</span> → <span className="mono small">{sname(w.remoteSession)}:{w.remotePath}</span>
                </div>
                <div className="muted small">
                  {w.lastEvent ?? ''} · {t('edit.uploads', { n: w.uploads })}
                  {w.error && <span className="err"> · {w.error}</span>}
                </div>
              </div>
              <IconButton icon={Square} title={t('watch.stop')} onClick={() => void attempt(() => call('watch.stop', { id: w.id })).then(() => removeBg('watches', w.id))} />
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}
