import { useMemo, useState } from 'react';
import { Calculator, ClipboardCopy, Info } from 'lucide-react';
import type { ChecksumAlgo, FileEntry } from '../../api/types';
import { call } from '../../api/client';
import { useT } from '../../i18n';
import { CATEGORY_ICON, categoryOf, isDirLike } from '../../lib/fileTypes';
import { formatBytes, formatDate, formatNumber, formatOctal, formatPerms, fromDatetimeLocal, toDatetimeLocal } from '../../lib/format';
import * as P from '../../lib/paths';
import { sessionById, useApp } from '../../store/app';
import type { DialogPropsMap } from '../../store/dialogs';
import { refreshWhere } from '../../store/panels';
import { toast } from '../../store/toasts';
import { copyText } from '../../actions/fileOps';
import { Button, Checkbox, Dialog, DialogButtons, Field, Segmented, Spinner, TextInput, cx } from '../ui';
import { combinePerms, PermGrid, type PermState } from './common';
import { typeLabel } from '../panel/FileTable';

const INITIAL_DIR_PERMS: PermState = { value: 0o755, mixed: 0 };

function common<T>(values: T[]): T | null {
  if (!values.length) return null;
  return values.every((v) => v === values[0]) ? values[0] : null;
}

export default function PropertiesDialog({ props, close }: { props: DialogPropsMap['properties']; close: () => void }) {
  const t = useT();
  const entries = props.entries;
  const single = entries.length === 1;
  const e0 = entries[0];
  const session = sessionById(props.session);
  const caps = session?.capabilities;
  const sizeFormat = useApp((s) => s.settings?.sizeFormat ?? 'auto');
  const files = entries.filter((e) => !isDirLike(e));
  const dirs = entries.filter((e) => isDirLike(e));

  const initialPerms = useMemo(() => combinePerms(entries.map((e) => e.permissions)), [entries]);
  const [perms, setPerms] = useState<PermState>(initialPerms);
  const [recursive, setRecursive] = useState(false);
  const [initialFilePerms] = useState<PermState>(() => (files.length ? combinePerms(files.map((e) => e.permissions)) : { value: 0o644, mixed: 0 }));
  const [filePerms, setFilePerms] = useState<PermState>(initialFilePerms);
  const [dirPerms, setDirPerms] = useState<PermState>(INITIAL_DIR_PERMS);
  const initOwner = common(entries.map((e) => e.owner ?? '')) ?? '';
  const initGroup = common(entries.map((e) => e.group ?? '')) ?? '';
  const [owner, setOwner] = useState(initOwner);
  const [group, setGroup] = useState(initGroup);
  const initModified = single ? toDatetimeLocal(e0.modified) : '';
  const [modified, setModified] = useState(initModified);
  const [dirSize, setDirSize] = useState<{ size: number; files: number; dirs: number } | null>(null);
  const [calc, setCalc] = useState(false);
  const [busy, setBusy] = useState(false);
  const [algo, setAlgo] = useState<ChecksumAlgo>('sha256');
  const [sum, setSum] = useState<{ algo: ChecksumAlgo; value: string } | null>(null);
  const [summing, setSumming] = useState(false);

  const totalFileBytes = files.reduce((s, e) => s + e.size, 0);
  const cat = single ? categoryOf(e0) : 'file';
  const Icon = CATEGORY_ICON[cat];
  const canPerms = !!caps?.permissions;
  const canOwner = !!caps?.owner;
  const canTime = !!caps?.setModified && single;

  const calculate = async () => {
    setCalc(true);
    try {
      let size = totalFileBytes;
      let nf = files.length;
      let nd = 0;
      for (const d of dirs) {
        const r = await call('fs.dirSize', { session: props.session, path: d.path });
        size += r.size;
        nf += r.files;
        nd += r.dirs + 1;
      }
      setDirSize({ size, files: nf, dirs: nd });
    } catch (e) {
      toast.error(e);
    } finally {
      setCalc(false);
    }
  };

  const checksum = async () => {
    setSumming(true);
    try {
      setSum({ algo, value: await call('fs.checksum', { session: props.session, path: e0.path, algo }) });
    } catch (e) {
      toast.error(e);
    } finally {
      setSumming(false);
    }
  };

  const permsChanged = perms.value !== initialPerms.value || perms.mixed !== initialPerms.mixed;

  const apply = async () => {
    const base = { session: props.session };
    const calls: Parameters<typeof call<'fs.setAttributes'>>[1][] = [];
    const ownerChanged = canOwner && owner.trim() && owner.trim() !== initOwner;
    const groupChanged = canOwner && group.trim() && group.trim() !== initGroup;
    const mod = canTime && modified !== initModified ? fromDatetimeLocal(modified) : null;
    const treePermsEdited =
      filePerms.value !== initialFilePerms.value || filePerms.mixed !== initialFilePerms.mixed ||
      dirPerms.value !== INITIAL_DIR_PERMS.value || dirPerms.mixed !== INITIAL_DIR_PERMS.mixed;
    // "Recursive" to change only the owner (chown -R) must not reset every mode in the tree.
    if (canPerms && recursive && dirs.length && (treePermsEdited || !(ownerChanged || groupChanged))) {
      calls.push({ ...base, paths: entries.map((e) => e.path), permissions: filePerms.value, dirPermissions: dirPerms.value, recursive: true });
    } else if (canPerms && permsChanged) {
      if (perms.mixed) {
        // keep bits that differ per item, apply the rest
        const groups = new Map<number, string[]>();
        for (const e of entries) {
          const m = ((e.permissions ?? 0) & perms.mixed) | (perms.value & ~perms.mixed);
          groups.set(m, [...(groups.get(m) ?? []), e.path]);
        }
        for (const [m, paths] of groups) calls.push({ ...base, paths, permissions: m });
      } else calls.push({ ...base, paths: entries.map((e) => e.path), permissions: perms.value });
    }
    if (ownerChanged || groupChanged || mod !== null) {
      calls.push({ ...base, paths: entries.map((e) => e.path), owner: ownerChanged ? owner.trim() : null, group: groupChanged ? group.trim() : null, modified: mod, recursive: recursive && (ownerChanged || groupChanged) ? true : undefined });
    }
    if (!calls.length) {
      close();
      return;
    }
    setBusy(true);
    try {
      for (const c of calls) await call('fs.setAttributes', c);
      for (const d of new Set(entries.map((e) => P.dirname(e.path)))) refreshWhere(props.session, d);
      toast.success(t('props.applied'));
      close();
    } catch (e) {
      toast.error(e, t('props.title'));
      setBusy(false);
    }
  };

  const sizeText = dirSize
    ? `${formatBytes(dirSize.size)} (${formatNumber(dirSize.size)} B) · ${t('props.counts', { files: formatNumber(dirSize.files), dirs: formatNumber(dirSize.dirs) })}`
    : files.length
      ? `${formatBytes(totalFileBytes)}${sizeFormat === 'auto' ? ` (${formatNumber(totalFileBytes)} B)` : ''}${dirs.length ? ` + ${t('copy.dirs', { n: dirs.length })}` : ''}`
      : '—';

  return (
    <Dialog
      title={t('props.title')}
      icon={Info}
      onClose={close}
      onSubmit={() => void apply()}
      width={560}
      className="props-dialog"
      footer={<DialogButtons onCancel={close} busy={busy} okLabel={t('common.apply')} />}
    >
      <div className="props-head">
        <span className={cx('fi', 'fi-big', `fi-${cat}`)}>
          <Icon size={30} strokeWidth={1.4} />
        </span>
        <div className="props-title">
          <div className="props-name">{single ? e0.name : t('props.multi', { n: entries.length })}</div>
          <div className="muted small">{single ? typeLabel(e0, t) : t('props.mixedKinds', { files: files.length, dirs: dirs.length })}</div>
        </div>
      </div>
      <div className="kv props-kv">
        <span>{t('props.location')}</span>
        <span className="mono small break" title={P.dirname(e0.path)}>
          {session?.id === 'local' ? '' : `${session?.name}: `}
          {P.dirname(e0.path)}
        </span>
        <span>{t('col.size')}</span>
        <span className="row gap">
          <span>{sizeText}</span>
          {dirs.length > 0 && !dirSize && (
            <Button size="sm" variant="ghost" icon={Calculator} busy={calc} onClick={() => void calculate()}>
              {t('props.calculate')}
            </Button>
          )}
        </span>
        {single && e0.kind === 'symlink' && (
          <>
            <span>{t('props.linkTarget')}</span>
            <span className="mono small break">{e0.linkTarget}</span>
          </>
        )}
        <span>{t('col.modified')}</span>
        {canTime ? (
          <span>
            <input type="datetime-local" step={1} className="input input-date" value={modified} onChange={(e) => setModified(e.target.value)} />
          </span>
        ) : (
          <span>{single ? formatDate(e0.modified) : common(entries.map((e) => formatDate(e.modified))) ?? t('perm.mixed')}</span>
        )}
        {(canOwner || initOwner) && (
          <>
            <span>{t('props.owner')}</span>
            <span className="row gap">
              <TextInput value={owner} onChange={(e) => setOwner(e.target.value)} disabled={!canOwner} placeholder={initOwner ? undefined : t('perm.mixed')} className="input-sm" aria-label={t('props.owner')} />
              <span className="muted">:</span>
              <TextInput value={group} onChange={(e) => setGroup(e.target.value)} disabled={!canOwner} placeholder={initGroup ? undefined : t('perm.mixed')} className="input-sm" aria-label={t('props.group')} />
            </span>
          </>
        )}
      </div>

      {(canPerms || entries.some((e) => e.permissions != null)) && (
        <div className="props-perms">
          <div className="section-title">
            {t('perm.title')}
            {!initialPerms.mixed && <span className="mono muted small"> {formatPerms(initialPerms.value, single ? e0.kind : undefined)} · {formatOctal(initialPerms.value)}</span>}
          </div>
          {!canPerms && <p className="muted small">{t('props.noPerms')}</p>}
          {recursive && dirs.length ? (
            <div className="perm-pair">
              <div>
                <div className="field-label">{t('props.filesPerm')}</div>
                <PermGrid state={filePerms} onChange={setFilePerms} compact disabled={!canPerms} />
              </div>
              <div>
                <div className="field-label">{t('props.dirsPerm')}</div>
                <PermGrid state={dirPerms} onChange={setDirPerms} compact disabled={!canPerms} />
              </div>
            </div>
          ) : (
            <PermGrid state={perms} onChange={setPerms} disabled={!canPerms} />
          )}
          {dirs.length > 0 && canPerms && (
            <Checkbox label={t('props.recursive')} checked={recursive} onChange={setRecursive} />
          )}
        </div>
      )}

      {single && !isDirLike(e0) && (
        <div className="props-checksum">
          <div className="section-title">{t('checksum.title')}</div>
          <div className="row gap">
            <Segmented size="sm" value={algo} onChange={setAlgo} options={(['md5', 'sha1', 'sha256'] as const).map((a) => ({ value: a, label: a.toUpperCase() }))} />
            <Button size="sm" onClick={() => void checksum()} busy={summing}>
              {t('checksum.compute')}
            </Button>
          </div>
          {summing && !sum && <Spinner size={14} />}
          {sum && (
            <div className="checksum-out">
              <code className="mono small">{sum.algo.toUpperCase()}: {sum.value}</code>
              <Button size="sm" icon={ClipboardCopy} onClick={() => void copyText(sum.value)}>
                {t('common.copy')}
              </Button>
            </div>
          )}
        </div>
      )}
      {!single && (
        <Field label={t('props.items')}>
          <div className="props-list">
            {entries.slice(0, 50).map((e: FileEntry) => (
              <div key={e.path} className="ellipsis small">
                {e.name}
                {isDirLike(e) ? '/' : ''}
              </div>
            ))}
            {entries.length > 50 && <div className="muted small">… +{entries.length - 50}</div>}
          </div>
        </Field>
      )}
    </Dialog>
  );
}
