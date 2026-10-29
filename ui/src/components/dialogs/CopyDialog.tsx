import { useEffect, useMemo, useState } from 'react';
import { Copy, MoveRight, Folder, File as FileIcon, Fingerprint } from 'lucide-react';
import type { TransferOptions } from '../../api/types';
import { call } from '../../api/client';
import { useT } from '../../i18n';
import { isDirLike } from '../../lib/fileTypes';
import { formatBytes } from '../../lib/format';
import { load, save } from '../../lib/storage';
import * as P from '../../lib/paths';
import { saveSettings, sessionById, setLayout, useApp } from '../../store/app';
import { openDialog, type CopyProps } from '../../store/dialogs';
import { setSkipCopyDialog } from '../../actions/fileOps';
import { selectNone, getPanel } from '../../store/panels';
import { toast } from '../../store/toasts';
import { Button, Checkbox, Collapsible, Dialog, DialogButtons, Field, TextInput } from '../ui';
import { summarizeOptions, TransferOptionsForm } from './common';
import { SessionDot } from '../panel/Panel';

export default function CopyDialog({ props, close }: { props: CopyProps; close: () => void }) {
  const t = useT();
  const settings = useApp((s) => s.settings);
  const [move, setMove] = useState(props.move);
  const [dstDir, setDstDir] = useState(props.dstDir);
  const single = props.entries.length === 1;
  const [newName, setNewName] = useState(single ? props.entries[0].name : '');
  const [opts, setOpts] = useState<TransferOptions | null>(settings ? { ...settings.transfer } : null);
  const [showOpts, setShowOpts] = useState(load('copyOptsOpen', false));
  const [remember, setRemember] = useState(false);
  const [skip, setSkip] = useState(false);
  const [busy, setBusy] = useState(false);
  const src = sessionById(props.srcSession);
  const dst = sessionById(props.dstSession);

  useEffect(() => {
    if (opts) return;
    call('transfer.defaults').then(setOpts).catch(() => undefined);
  }, [opts]);

  const totals = useMemo(() => {
    let files = 0;
    let dirs = 0;
    let bytes = 0;
    for (const e of props.entries) {
      if (isDirLike(e)) dirs++;
      else {
        files++;
        bytes += e.size;
      }
    }
    return { files, dirs, bytes };
  }, [props.entries]);

  const sameTarget = props.srcSession === props.dstSession && P.normalize(dstDir) === P.dirname(props.entries[0].path) && (!single || newName === props.entries[0].name);

  const submit = async () => {
    if (!opts || busy) return;
    if (sameTarget) {
      toast.warning(t('copy.sameTarget'));
      return;
    }
    setBusy(true);
    const options: Partial<TransferOptions> = { ...opts, move, newName: single && newName.trim() && newName.trim() !== props.entries[0].name ? newName.trim() : null };
    try {
      await call('transfer.start', { srcSession: props.srcSession, srcPaths: props.entries.map((e) => e.path), dstSession: props.dstSession, dstDir: P.normalize(dstDir), options });
      if (remember && settings) void saveSettings({ ...settings, transfer: { ...opts, move: false, newName: null } });
      if (skip) setSkipCopyDialog(true);
      save('copyOptsOpen', showOpts);
      for (const side of ['left', 'right'] as const) {
        const p = getPanel(side);
        if (p.session === props.srcSession && props.entries.some((e) => P.dirname(e.path) === p.path)) selectNone(side);
      }
      if (!useApp.getState().dockOpen) setLayout({ dockOpen: true, dockTab: 'queue' });
      close();
    } catch (e) {
      toast.error(e, move ? t('copy.moveTitle') : t('copy.copyTitle'));
      setBusy(false);
    }
  };

  const compareFingerprints = () => {
    if (sameTarget) return toast.warning(t('copy.sameTarget'));
    openDialog('fingerprint', {
      srcSession: props.srcSession,
      srcPaths: props.entries.map((e) => e.path),
      dstSession: props.dstSession,
      dstDir: P.normalize(dstDir),
      newName: single && newName.trim() && newName.trim() !== props.entries[0].name ? newName.trim() : null,
      options: { ...(opts ?? {}), move },
      onCopied: close,
    });
  };

  const what = single
    ? props.entries[0].name
    : t('copy.items', { n: props.entries.length });
  return (
    <Dialog
      title={move ? t('copy.moveTitle') : t('copy.copyTitle')}
      icon={move ? MoveRight : Copy}
      onClose={close}
      onSubmit={() => void submit()}
      width={560}
      className="copy-dialog"
      footer={
        <DialogButtons
          onCancel={close}
          okLabel={move ? t('ops.move') : t('ops.copy')}
          busy={busy}
          okDisabled={!opts}
          extra={
            <>
              <Button size="sm" icon={Fingerprint} onClick={compareFingerprints} title={t('fp.copyHint')} data-testid="copy-fingerprints">
                {t('fp.compare')}
              </Button>
              <Checkbox label={t('copy.skipDialog')} checked={skip} onChange={setSkip} title={t('copy.skipHint')} />
            </>
          }
        />
      }
    >
      <div className="copy-summary">
        <div className="copy-what">
          {single ? isDirLike(props.entries[0]) ? <Folder size={16} className="fi-dir" /> : <FileIcon size={16} /> : <Copy size={16} />}
          <span className="copy-name" title={props.entries.map((e) => e.path).join('\n')}>{what}</span>
          <span className="muted">
            {totals.files > 0 && t('copy.filesSize', { n: totals.files, size: formatBytes(totals.bytes) })}
            {totals.dirs > 0 && `${totals.files > 0 ? ', ' : ''}${t('copy.dirs', { n: totals.dirs })}`}
          </span>
        </div>
        <div className="copy-route">
          <span className="route-session">
            <SessionDot color={src?.color} />
            {src?.id === 'local' ? t('session.local') : src?.name}
          </span>
          <MoveRight size={14} className="muted" />
          <span className="route-session">
            <SessionDot color={dst?.color} />
            {dst?.id === 'local' ? t('session.local') : dst?.name}
          </span>
          <label className="check move-toggle">
            <input type="checkbox" checked={move} onChange={(e) => setMove(e.target.checked)} />
            <span>{t('copy.moveToggle')}</span>
          </label>
        </div>
      </div>
      <Field label={t('copy.targetDir')}>
        <TextInput value={dstDir} onChange={(e) => setDstDir(e.target.value)} data-autofocus data-testid="copy-target" />
      </Field>
      {single && (
        <Field label={t('copy.newName')}>
          <TextInput value={newName} onChange={(e) => setNewName(e.target.value)} data-select="none" />
        </Field>
      )}
      {opts && (
        <Collapsible title={t('copy.settings')} open={showOpts} onToggle={() => setShowOpts(!showOpts)} extra={!showOpts ? <span className="muted">{summarizeOptions(opts, t)}</span> : undefined}>
          <TransferOptionsForm value={opts} onChange={setOpts} upload={props.dstSession !== 'local'} />
          <Checkbox label={t('copy.remember')} checked={remember} onChange={setRemember} className="remember" />
        </Collapsible>
      )}
    </Dialog>
  );
}
