import { useMemo, useState } from 'react';
import {
  ArrowDownToLine, ArrowUpFromLine, ChevronDown, ChevronRight, CircleAlert, CircleCheck, CircleX, ExternalLink, Inbox, Pause, Play, Radar,
  RotateCcw, Square, Trash2, ArrowLeftRight, Eraser, TriangleAlert, Clock, FolderSync, X,
} from 'lucide-react';
import type { Job } from '../../api/types';
import { call } from '../../api/client';
import { useT, type TKey } from '../../i18n';
import { formatBytes, formatDuration, formatNumber, formatSpeed, percent } from '../../lib/format';
import * as P from '../../lib/paths';
import { useApp } from '../../store/app';
import { clearFinishedClientJobs, isFinished, removeClientJob, reopenConflict, useJobs, type ClientJob } from '../../store/jobs';
import { removeBg, useBg } from '../../store/misc';
import { attempt } from '../../store/toasts';
import { openDialog } from '../../store/dialogs';
import { Badge, Button, EmptyState, IconButton, ProgressBar, cx } from '../ui';

type AnyJob = (Job & { client?: false }) | (ClientJob & { client: true; kind: 'upload' | 'download' });

const STATE_TONE: Record<string, 'muted' | 'accent' | 'ok' | 'warn' | 'err'> = {
  queued: 'muted', running: 'accent', paused: 'warn', waiting: 'warn', completed: 'ok', failed: 'err', cancelled: 'muted',
};

function JobIcon({ job }: { job: AnyJob }) {
  if (job.state === 'completed') return <CircleCheck size={16} className="ok" />;
  if (job.state === 'failed') return <CircleAlert size={16} className="err" />;
  if (job.state === 'cancelled') return <CircleX size={16} className="muted" />;
  if (job.state === 'waiting') return <TriangleAlert size={16} className="warn" />;
  if (job.state === 'queued') return <Clock size={16} className="muted" />;
  if (job.kind === 'delete') return <Trash2 size={16} className="accent" />;
  if (job.kind === 'sync') return <FolderSync size={16} className="accent" />;
  if (job.kind === 'upload') return <ArrowUpFromLine size={16} className="accent" />;
  if (job.kind === 'download') return <ArrowDownToLine size={16} className="accent" />;
  return <ArrowLeftRight size={16} className="accent" />;
}

function JobRow({ job }: { job: AnyJob }) {
  const t = useT();
  const sessions = useApp((s) => s.sessions);
  const [open, setOpen] = useState(false);
  const finished = isFinished(job.state);
  const pct = job.bytesTotal > 0 ? percent(job.bytesDone, job.bytesTotal) : percent(job.filesDone, job.filesTotal);
  const scanning = !job.client && (job as Job).scanning;
  const id = job.id;
  const act = (m: 'jobs.pause' | 'jobs.resume' | 'jobs.cancel' | 'jobs.remove') => () => void attempt(() => call(m, { id }));
  const name = (sid?: string | null) => (sid ? (sessions.find((s) => s.id === sid)?.name ?? sid) : '');
  const route = !job.client && (job as Job).dstSession ? `${name((job as Job).srcSession)} → ${name((job as Job).dstSession)}` : job.client ? name(job.session) : name((job as Job).srcSession);
  const tone = job.state === 'failed' ? 'err' : job.state === 'paused' || job.state === 'waiting' ? 'warn' : job.state === 'completed' ? 'ok' : undefined;
  return (
    <div className={cx('job', `job-${job.state}`)} data-testid="job" data-state={job.state}>
      <div className="job-icon">
        <JobIcon job={job} />
      </div>
      <div className="job-main">
        <div className="job-line1">
          <span className="job-title" title={job.title}>{job.title}</span>
          <Badge tone={STATE_TONE[job.state]}>{scanning ? t('queue.scanning') : t(`jobstate.${job.state}` as TKey)}</Badge>
          {job.client && <Badge tone="muted">{t('queue.browser')}</Badge>}
        </div>
        <div className="job-progress">
          <ProgressBar value={finished ? (job.state === 'completed' ? 100 : pct) : pct} indeterminate={scanning || (job.state === 'running' && job.bytesTotal === 0 && job.filesTotal === 0)} tone={tone === 'err' ? 'err' : tone === 'warn' ? 'warn' : tone === 'ok' ? 'ok' : undefined} />
        </div>
        <div className="job-line2">
          <span>
            {job.bytesTotal > 0 ? `${formatBytes(job.bytesDone)} / ${formatBytes(job.bytesTotal)}` : ''}
            {job.filesTotal > 0 ? `${job.bytesTotal > 0 ? ' · ' : ''}${t('queue.files', { done: formatNumber(job.filesDone), total: formatNumber(job.filesTotal) })}` : ''}
          </span>
          {job.state === 'running' && job.speed > 0 && <span>{formatSpeed(job.speed)}</span>}
          {job.state === 'running' && job.eta != null && <span>{t('queue.eta', { eta: formatDuration(job.eta) })}</span>}
          {route && <span className="muted job-route">{route}</span>}
          {job.currentFile && !finished && <span className="job-current" title={job.currentFile}>{P.basename(job.currentFile)}</span>}
        </div>
        {job.errors.length > 0 && (
          <div className="job-errors">
            <button type="button" className="link-btn err" onClick={() => setOpen(!open)}>
              {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              {t('queue.errors', { n: job.errors.length })}
            </button>
            {open && (
              <ul>
                {job.errors.slice(0, 200).map((e, i) => (
                  <li key={i}>
                    <span className="mono-soft">{e.path}</span> — {e.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      <div className="job-actions">
        {job.client ? (
          <>
            {!finished && job.cancel && <IconButton icon={Square} title={t('queue.cancel')} onClick={() => job.cancel?.()} />}
            {finished && <IconButton icon={X} title={t('queue.remove')} onClick={() => removeClientJob(job.id)} />}
          </>
        ) : (
          <>
            {job.state === 'waiting' && (job as Job).conflict && (
              <Button size="sm" variant="primary" onClick={() => reopenConflict((job as Job).conflict!.id)}>
                {t('queue.answer')}
              </Button>
            )}
            {(job.state === 'running' || job.state === 'queued') && <IconButton icon={Pause} title={t('queue.pause')} onClick={act('jobs.pause')} />}
            {job.state === 'paused' && <IconButton icon={Play} title={t('queue.resume')} onClick={act('jobs.resume')} />}
            {!finished && <IconButton icon={Square} title={t('queue.cancel')} onClick={act('jobs.cancel')} data-testid="job-cancel" />}
            {(job.state === 'failed' || job.state === 'cancelled') && <IconButton icon={RotateCcw} title={t('queue.retry')} onClick={() => void attempt(() => call('jobs.retry', { id }))} />}
            {finished && <IconButton icon={X} title={t('queue.remove')} onClick={act('jobs.remove')} />}
          </>
        )}
      </div>
    </div>
  );
}

function Background() {
  const t = useT();
  const edits = useBg((s) => s.edits);
  const watches = useBg((s) => s.watches);
  const sessions = useApp((s) => s.sessions);
  const list = [...Object.values(edits).map((e) => ({ type: 'edit' as const, e })), ...Object.values(watches).map((w) => ({ type: 'watch' as const, w }))];
  if (!list.length) return null;
  const sname = (id: string) => sessions.find((s) => s.id === id)?.name ?? id;
  return (
    <div className="bg-tasks">
      {Object.values(edits).map((e) => (
        <div key={e.id} className="bg-task" title={e.localPath}>
          <ExternalLink size={13} className="accent" />
          <span className="bg-task-title">{t('edit.externalItem', { name: P.basename(e.remotePath) })}</span>
          <span className="muted">{sname(e.session)} · {t('edit.uploads', { n: e.uploads })}</span>
          {e.lastError && <span className="err">{e.lastError}</span>}
          <IconButton icon={Square} title={t('edit.stop')} size={13} onClick={() => void attempt(() => call('edit.stop', { id: e.id })).then(() => removeBg('edits', e.id))} />
        </div>
      ))}
      {Object.values(watches).map((w) => (
        <div key={w.id} className="bg-task" title={`${w.localPath} → ${w.remotePath}`}>
          <Radar size={13} className="accent" />
          <span className="bg-task-title">{t('watch.item', { local: P.basename(w.localPath) || w.localPath, remote: `${sname(w.remoteSession)}:${w.remotePath}` })}</span>
          <span className="muted">{w.lastEvent ?? ''} · {t('edit.uploads', { n: w.uploads })}</span>
          {w.error && <span className="err">{w.error}</span>}
          <IconButton icon={Square} title={t('watch.stop')} size={13} onClick={() => void attempt(() => call('watch.stop', { id: w.id })).then(() => removeBg('watches', w.id))} />
        </div>
      ))}
      <button type="button" className="link-btn" onClick={() => openDialog('keepUpToDate', {})}>{t('watch.manage')}</button>
    </div>
  );
}

export function QueueView() {
  const t = useT();
  const jobs = useJobs((s) => s.jobs);
  const client = useJobs((s) => s.client);
  const list = useMemo(() => {
    const all: AnyJob[] = [...Object.values(jobs), ...Object.values(client).map((c) => ({ ...c, client: true as const }))];
    const rank = (j: AnyJob) => (j.state === 'waiting' ? 0 : j.state === 'running' ? 1 : j.state === 'paused' ? 2 : j.state === 'queued' ? 3 : 4);
    return all.sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt);
  }, [jobs, client]);
  const finished = list.filter((j) => isFinished(j.state)).length;

  return (
    <div className="queue">
      <div className="dock-toolbar">
        <span className="muted">{t('queue.count', { active: list.length - finished, finished })}</span>
        <div className="flex1" />
        <Button size="sm" variant="ghost" icon={Eraser} disabled={!finished} onClick={() => {
          clearFinishedClientJobs();
          void attempt(() => call('jobs.clearFinished'));
        }}>
          {t('queue.clearFinished')}
        </Button>
      </div>
      <Background />
      <div className="queue-list">
        {list.length === 0 ? (
          <EmptyState icon={Inbox} title={t('queue.empty')}>{t('queue.emptyHint')}</EmptyState>
        ) : (
          list.map((j) => <JobRow key={j.id} job={j} />)
        )}
      </div>
    </div>
  );
}
