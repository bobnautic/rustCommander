// Compare fingerprints (checksums) of source and target files before copying: which files are
// identical, which differ and which are new. Checksums are computed on the servers where the
// protocol allows it (sha256sum over SSH, FTP HASH, peers), so nothing has to be downloaded.
import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleCheck, CirclePlus, ClipboardCopy, Copy, Diff, Fingerprint, GitCompare, Loader2, MoveRight, RefreshCw, TriangleAlert } from 'lucide-react';
import type { ChecksumAlgo, FilePair } from '../../api/types';
import { call } from '../../api/client';
import { normalizeError } from '../../api/errors';
import { useT, type TFn } from '../../i18n';
import { formatBytes, formatDate } from '../../lib/format';
import * as P from '../../lib/paths';
import { sessionById, setLayout, useApp } from '../../store/app';
import { openDialog, type FingerprintProps } from '../../store/dialogs';
import { toast } from '../../store/toasts';
import { copyText } from '../../actions/fileOps';
import { SessionDot } from '../panel/Panel';
import { Badge, Button, Dialog, EmptyState, IconButton, ProgressBar, Segmented, Select, Spinner, cx } from '../ui';

type Status = 'pending' | 'hashing' | 'identical' | 'different' | 'sizeDiffers' | 'new' | 'typeDiffers' | 'error';

interface Row {
  pair: FilePair;
  status: Status;
  src?: string;
  dst?: string;
  error?: string;
}

type Filter = 'all' | 'different' | 'identical' | 'new';

const PARALLEL = 4;

function initialStatus(p: FilePair): Status {
  if (!p.target) return 'new';
  if (p.target.kind === 'dir' || p.target.targetKind === 'dir') return 'typeDiffers';
  if (p.target.size !== p.source.size) return 'sizeDiffers';
  return 'pending';
}

const differs = (s: Status) => s === 'different' || s === 'sizeDiffers' || s === 'typeDiffers';

function StatusChip({ row, t }: { row: Row; t: TFn }) {
  switch (row.status) {
    case 'pending':
      return <span className="fp-status muted">{t('fp.pending')}</span>;
    case 'hashing':
      return (
        <span className="fp-status muted">
          <Loader2 size={13} className="spin" /> {t('fp.hashing')}
        </span>
      );
    case 'identical':
      return (
        <span className="fp-status ok">
          <CircleCheck size={13} /> {t('fp.identical')}
        </span>
      );
    case 'different':
      return (
        <span className="fp-status err">
          <Diff size={13} /> {t('fp.different')}
        </span>
      );
    case 'sizeDiffers':
      return (
        <span className="fp-status err" title={t('fp.sizeDiffersHint')}>
          <Diff size={13} /> {t('fp.sizeDiffers')}
        </span>
      );
    case 'new':
      return (
        <span className="fp-status accent">
          <CirclePlus size={13} /> {t('fp.new')}
        </span>
      );
    case 'typeDiffers':
      return (
        <span className="fp-status warn">
          <TriangleAlert size={13} /> {t('fp.typeDiffers')}
        </span>
      );
    default:
      return (
        <span className="fp-status warn" title={row.error}>
          <TriangleAlert size={13} /> {t('fp.error')}
        </span>
      );
  }
}

function Hash({ value }: { value?: string }) {
  if (!value) return <span className="muted">—</span>;
  return (
    <button type="button" className="fp-hash mono" title={value} onClick={() => void copyText(value)}>
      {value.slice(0, 12)}…
    </button>
  );
}

export default function FingerprintDialog({ props, close }: { props: FingerprintProps; close: () => void }) {
  const t = useT();
  const [algo, setAlgo] = useState<ChecksumAlgo>('sha256');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = useRef(0);
  const src = sessionById(props.srcSession);
  const dst = sessionById(props.dstSession);
  const name = (s: typeof src, id: string) => (id === 'local' ? t('session.local') : (s?.name ?? id));

  // 1. which target files a copy would touch
  useEffect(() => {
    let alive = true;
    setRows(null);
    setError(null);
    call('compare.pairs', {
      srcSession: props.srcSession, srcPaths: props.srcPaths, dstSession: props.dstSession, dstDir: props.dstDir, newName: props.newName ?? null,
      fileMask: props.options?.fileMask ?? '', excludeHidden: props.options?.excludeHidden ?? false,
    }).then(
      (r) => {
        if (!alive) return;
        setTruncated(r.truncated);
        setRows(r.pairs.map((pair) => ({ pair, status: initialStatus(pair) })));
      },
      (e) => alive && setError(normalizeError(e).message),
    );
    return () => {
      alive = false;
    };
  }, [props]);

  // 2. checksums of both sides for files of equal size, a few at a time
  const hashAll = async (list: Row[], which: ChecksumAlgo) => {
    const id = ++run.current;
    const todo = list.map((r, i) => (r.status === 'pending' ? i : -1)).filter((i) => i >= 0);
    if (!todo.length) return;
    setRunning(true);
    let next = 0;
    const update = (i: number, p: Partial<Row>) => setRows((cur) => (cur && run.current === id ? cur.map((r, j) => (j === i ? { ...r, ...p } : r)) : cur));
    const worker = async () => {
      while (next < todo.length && run.current === id) {
        const i = todo[next++];
        const { pair } = list[i];
        update(i, { status: 'hashing' });
        try {
          const [a, b] = await Promise.all([
            call('fs.checksum', { session: props.srcSession, path: pair.source.path, algo: which }),
            call('fs.checksum', { session: props.dstSession, path: pair.targetPath, algo: which }),
          ]);
          update(i, { status: a === b ? 'identical' : 'different', src: a, dst: b });
        } catch (e) {
          update(i, { status: 'error', error: normalizeError(e).message });
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    if (run.current === id) setRunning(false);
  };

  const started = useRef(false);
  useEffect(() => {
    if (!rows || started.current) return;
    started.current = true;
    void hashAll(rows, algo);
  }, [rows]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => void ++run.current, []);

  const rehash = (which: ChecksumAlgo) => {
    setAlgo(which);
    if (!rows) return;
    const reset = rows.map((r) => (r.status === 'identical' || r.status === 'different' || r.status === 'error' || r.status === 'hashing' ? { pair: r.pair, status: 'pending' as Status } : r));
    setRows(reset);
    void hashAll(reset, which);
  };
  const stop = () => {
    run.current++;
    setRunning(false);
    setRows((cur) => cur?.map((r) => (r.status === 'hashing' ? { ...r, status: 'pending' } : r)) ?? cur);
  };

  const counts = useMemo(() => {
    const c = { identical: 0, different: 0, new: 0, open: 0, error: 0 };
    for (const r of rows ?? []) {
      if (r.status === 'identical') c.identical++;
      else if (differs(r.status)) c.different++;
      else if (r.status === 'new') c.new++;
      else if (r.status === 'error') c.error++;
      else c.open++;
    }
    return c;
  }, [rows]);
  const total = rows?.length ?? 0;
  const done = total - counts.open;
  const shown = (rows ?? []).filter((r) => filter === 'all' || (filter === 'identical' ? r.status === 'identical' : filter === 'new' ? r.status === 'new' : differs(r.status)));
  const toCopy = counts.different + counts.new + counts.error;
  const move = !!props.options?.move;

  const copyChanged = async () => {
    setBusy(true);
    try {
      // the transfer re-checks every existing file and skips those with equal content
      await call('transfer.start', {
        srcSession: props.srcSession, srcPaths: props.srcPaths, dstSession: props.dstSession, dstDir: props.dstDir,
        options: { ...props.options, newName: props.newName ?? null, overwrite: 'differentChecksum' },
      });
      if (!useApp.getState().dockOpen) setLayout({ dockOpen: true, dockTab: 'queue' });
      props.onCopied?.();
      close();
    } catch (e) {
      toast.error(e, t('fp.copyChanged', { n: toCopy }));
      setBusy(false);
    }
  };

  const report = () => {
    const lines = [`# ${t('fp.title')} (${algo}) – ${name(src, props.srcSession)} → ${name(dst, props.dstSession)}: ${props.dstDir}`];
    for (const r of rows ?? []) {
      const state = r.status === 'identical' ? 'identical' : differs(r.status) ? 'different' : r.status === 'new' ? 'new' : r.status;
      lines.push([state.padEnd(10), r.src ?? '-', r.dst ?? '-', r.pair.rel].join('  '));
    }
    void copyText(lines.join('\n') + '\n', t('fp.reportCopied', { n: total }));
  };

  const showDiff = (r: Row) =>
    openDialog('diff', {
      left: { label: `${name(src, props.srcSession)}: ${r.pair.source.path}`, session: props.srcSession, path: r.pair.source.path, fileName: r.pair.source.name },
      right: { label: `${name(dst, props.dstSession)}: ${r.pair.targetPath}`, session: props.dstSession, path: r.pair.targetPath, fileName: P.basename(r.pair.targetPath) },
    });

  return (
    <Dialog
      title={t('fp.title')}
      icon={Fingerprint}
      onClose={close}
      width={880}
      className="fp-dialog"
      bodyClassName="fp-body"
      noEnterSubmit
      footer={
        <>
          <div className="dlg-foot-extra row gap">
            <Button size="sm" icon={ClipboardCopy} onClick={report} disabled={!rows?.length}>
              {t('fp.copyReport')}
            </Button>
          </div>
          <div className="dlg-foot-buttons">
            <Button variant="primary" icon={move ? MoveRight : Copy} disabled={!rows || running || toCopy === 0} busy={busy} onClick={() => void copyChanged()} data-testid="fp-copy-changed">
              {toCopy === 0 && rows && !running ? t('fp.nothingToCopy') : move ? t('fp.moveChanged', { n: toCopy }) : t('fp.copyChanged', { n: toCopy })}
            </Button>
            <Button onClick={close}>{t('common.close')}</Button>
          </div>
        </>
      }
    >
      <div className="copy-route fp-route">
        <span className="route-session">
          <SessionDot color={src?.color} />
          {name(src, props.srcSession)}
        </span>
        <MoveRight size={14} className="muted" />
        <span className="route-session" title={props.dstDir}>
          <SessionDot color={dst?.color} />
          {name(dst, props.dstSession)}: <span className="mono-soft ellipsis">{props.dstDir}</span>
        </span>
        <div className="flex1" />
        <label className="row gap-sm small muted">
          {t('fp.algorithm')}
          <Select value={algo} onChange={(e) => rehash(e.target.value as ChecksumAlgo)} disabled={!rows} className="fp-algo">
            <option value="sha256">SHA-256</option>
            <option value="sha1">SHA-1</option>
            <option value="md5">MD5</option>
          </Select>
        </label>
      </div>
      {error ? (
        <EmptyState icon={Fingerprint} title={t('fp.failed')}>
          {error}
        </EmptyState>
      ) : !rows ? (
        <div className="center-fill">
          <Spinner /> <span>{t('fp.scanning')}</span>
        </div>
      ) : (
        <>
          <div className="fp-summary" data-testid="fp-summary">
            <Segmented
              size="sm"
              value={filter}
              onChange={setFilter}
              options={[
                { value: 'all', label: `${t('fp.all')} ${total}` },
                { value: 'different', label: `${t('fp.different')} ${counts.different}` },
                { value: 'identical', label: `${t('fp.identical')} ${counts.identical}` },
                { value: 'new', label: `${t('fp.new')} ${counts.new}` },
              ]}
            />
            <div className="flex1" />
            {running ? (
              <>
                <span className="muted small">{t('fp.progress', { done, total })}</span>
                <Button size="sm" variant="ghost" onClick={stop}>
                  {t('common.stop')}
                </Button>
              </>
            ) : counts.open > 0 ? (
              <Button size="sm" icon={RefreshCw} onClick={() => void hashAll(rows, algo)}>
                {t('fp.continue')}
              </Button>
            ) : (
              total > 0 && (
                <Badge tone={counts.different + counts.error ? 'warn' : 'ok'}>
                  {counts.different + counts.new === 0 && !counts.error ? t('fp.allIdentical') : t('fp.summary', { different: counts.different, new: counts.new })}
                </Badge>
              )
            )}
          </div>
          {running && <ProgressBar value={total ? done / total : 0} thin />}
          {truncated && <div className="diff-note">{t('fp.truncated', { n: total })}</div>}
          {total === 0 ? (
            <EmptyState icon={Fingerprint} title={t('fp.noFiles')} />
          ) : (
            <div className="fp-table" role="table">
              <div className="fp-row fp-head" role="row">
                <span>{t('fp.status')}</span>
                <span>{t('fp.file')}</span>
                <span className="num">{t('fp.source')}</span>
                <span className="num">{t('fp.target')}</span>
                <span>{t('fp.fingerprint')}</span>
                <span />
              </div>
              {shown.map((r) => (
                <div key={r.pair.rel} className={cx('fp-row', `fp-${r.status}`)} role="row" data-testid="fp-row" data-status={r.status}>
                  <StatusChip row={r} t={t} />
                  <span className="ellipsis" title={r.error ?? r.pair.rel}>
                    {r.pair.rel}
                  </span>
                  <span className="num muted small" title={formatDate(r.pair.source.modified)}>
                    {formatBytes(r.pair.source.size)}
                  </span>
                  <span className="num muted small" title={r.pair.target ? formatDate(r.pair.target.modified) : undefined}>
                    {r.pair.target ? formatBytes(r.pair.target.size) : '—'}
                  </span>
                  <span className="fp-hashes">
                    {r.status === 'identical' ? (
                      <Hash value={r.src} />
                    ) : (
                      <>
                        <Hash value={r.src} />
                        {r.dst && <Hash value={r.dst} />}
                      </>
                    )}
                  </span>
                  <span>
                    {(r.status === 'different' || r.status === 'sizeDiffers') && (
                      <IconButton icon={GitCompare} size={14} title={t('fp.showDiff')} onClick={() => showDiff(r)} data-testid="fp-diff" />
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}
