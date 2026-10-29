import { useMemo, useState } from 'react';
import { Copy as CopyIcon, File as FileIcon } from 'lucide-react';
import type { ConflictAction, FileEntry, Job } from '../api/types';
import { call } from '../api/client';
import { useT } from '../i18n';
import { formatBytes, formatDate, formatNumber } from '../lib/format';
import * as P from '../lib/paths';
import { useApp } from '../store/app';
import { markAnswered, useJobs } from '../store/jobs';
import { toast } from '../store/toasts';
import { Badge, Button, Checkbox, Dialog, TextInput, cx } from './ui';

function Side({ label, e, newer, larger, session }: { label: string; e: FileEntry; newer: boolean; larger: boolean; session: string }) {
  const t = useT();
  return (
    <div className={cx('conflict-side', newer && 'newer')}>
      <div className="conflict-label">
        {label}
        {newer && <Badge tone="ok">{t('conflict.newer')}</Badge>}
      </div>
      <div className="conflict-name">
        <FileIcon size={14} /> <span title={e.path}>{e.name}</span>
      </div>
      <div className="muted small" title={e.path}>{session}: {P.dirname(e.path)}</div>
      <div className="kv small">
        <span>{t('col.size')}</span>
        <span className={cx(larger && 'strong')}>
          {formatBytes(e.size)} <span className="muted">({formatNumber(e.size)} B)</span>
        </span>
        <span>{t('col.modified')}</span>
        <span className={cx(newer && 'strong ok')}>{formatDate(e.modified)}</span>
      </div>
    </div>
  );
}

function ConflictDialog({ job }: { job: Job }) {
  const t = useT();
  const c = job.conflict!;
  const sessions = useApp((s) => s.sessions);
  const [applyAll, setApplyAll] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(() => {
    const [stem, ext] = P.splitExt(c.target.name);
    return `${stem} (1)${ext}`;
  });
  const [busy, setBusy] = useState(false);
  const sname = (id?: string | null) => (id ? (sessions.find((s) => s.id === id)?.name ?? id) : '');
  const srcNewer = (c.source.modified ?? 0) > (c.target.modified ?? 0);
  const tgtNewer = (c.target.modified ?? 0) > (c.source.modified ?? 0);
  const canResume = c.target.size < c.source.size && c.target.size > 0;

  const answer = async (action: ConflictAction) => {
    if (busy) return;
    setBusy(true);
    markAnswered(c.id);
    try {
      await call('jobs.resolveConflict', { id: job.id, conflictId: c.id, action, applyToAll: applyAll, newName: action === 'rename' ? newName.trim() || null : null });
    } catch (e) {
      toast.error(e);
    }
  };
  const remaining = useMemo(() => Math.max(0, job.filesTotal - job.filesDone - 1), [job]);

  return (
    <Dialog
      layer="top"
      width={600}
      icon={CopyIcon}
      title={t('conflict.title')}
      onClose={() => markAnswered(c.id)}
      onSubmit={() => void answer(renaming ? 'rename' : 'overwrite')}
      headerExtra={<span className="muted small">{job.title}</span>}
      className="conflict-dialog"
      footer={
        <>
          {remaining > 0 && (
            <div className="dlg-foot-extra">
              <Checkbox label={t('conflict.applyAll', { n: remaining })} checked={applyAll} onChange={setApplyAll} />
            </div>
          )}
          <div className="dlg-foot-buttons wrap">
            {renaming ? (
              <>
                <Button variant="primary" onClick={() => void answer('rename')} busy={busy}>
                  {t('conflict.rename')}
                </Button>
                <Button onClick={() => setRenaming(false)}>{t('common.back')}</Button>
              </>
            ) : (
              <>
                <Button variant="primary" onClick={() => void answer('overwrite')} busy={busy} data-testid="conflict-overwrite">
                  {t('conflict.overwrite')}
                </Button>
                <Button onClick={() => void answer('newer')}>{t('conflict.overwriteNewer')}</Button>
                <Button onClick={() => void answer('skip')} data-testid="conflict-skip">
                  {t('conflict.skip')}
                </Button>
                {canResume && <Button onClick={() => void answer('resume')}>{t('conflict.resume')}</Button>}
                <Button onClick={() => setRenaming(true)}>{t('conflict.renameDots')}</Button>
                <Button variant="ghost" onClick={() => void answer('cancel')}>
                  {t('conflict.cancelJob')}
                </Button>
              </>
            )}
          </div>
        </>
      }
    >
      <p className="prompt-text">{t('conflict.text', { name: c.target.name })}</p>
      <div className="conflict-grid">
        <Side label={t('conflict.source')} e={c.source} newer={srcNewer} larger={c.source.size > c.target.size} session={sname(job.srcSession)} />
        <Side label={t('conflict.target')} e={c.target} newer={tgtNewer} larger={c.target.size > c.source.size} session={sname(job.dstSession)} />
      </div>
      {renaming && (
        <div className="conflict-rename">
          <label className="field-label">{t('conflict.newName')}</label>
          <TextInput value={newName} onChange={(e) => setNewName(e.target.value)} data-autofocus data-select-stem="1" />
        </div>
      )}
    </Dialog>
  );
}

export function ConflictHost() {
  const jobs = useJobs((s) => s.jobs);
  const answered = useJobs((s) => s.answered);
  const job = Object.values(jobs).find((j) => j.state === 'waiting' && j.conflict && !answered[j.conflict.id]);
  if (!job) return null;
  return <ConflictDialog key={job.conflict!.id} job={job} />;
}
