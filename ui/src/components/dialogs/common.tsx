import { useEffect, useState } from 'react';
import type { OverwriteMode, TransferOptions } from '../../api/types';
import { useT } from '../../i18n';
import { formatOctal, parseOctal } from '../../lib/format';
import { Checkbox, Field, NumberInput, Select, Segmented, TextInput, cx } from '../ui';

// ---------------------------------------------------------------- permission grid

export interface PermState {
  value: number;
  /** Bits whose value differs across a multi-selection (shown as indeterminate). */
  mixed: number;
}

const ROWS: { key: 'owner' | 'group' | 'others'; shift: number }[] = [
  { key: 'owner', shift: 6 },
  { key: 'group', shift: 3 },
  { key: 'others', shift: 0 },
];
const BITS: { key: 'r' | 'w' | 'x'; bit: number }[] = [
  { key: 'r', bit: 4 },
  { key: 'w', bit: 2 },
  { key: 'x', bit: 1 },
];
const SPECIAL: { key: 'setuid' | 'setgid' | 'sticky'; bit: number }[] = [
  { key: 'setuid', bit: 0o4000 },
  { key: 'setgid', bit: 0o2000 },
  { key: 'sticky', bit: 0o1000 },
];

export function PermGrid({ state, onChange, disabled, compact }: { state: PermState; onChange: (s: PermState) => void; disabled?: boolean; compact?: boolean }) {
  const t = useT();
  const [octal, setOctal] = useState(state.mixed ? '' : formatOctal(state.value));
  useEffect(() => {
    setOctal(state.mixed ? '' : formatOctal(state.value));
  }, [state.value, state.mixed]);
  const setBit = (bit: number, on: boolean) => onChange({ value: on ? state.value | bit : state.value & ~bit, mixed: state.mixed & ~bit });
  return (
    <div className={cx('perm-grid', compact && 'compact', disabled && 'disabled')}>
      <div className="perm-table" role="group" aria-label={t('perm.title')}>
        <span />
        {BITS.map((b) => (
          <span key={b.key} className="perm-col">{t(`perm.${b.key}`)}</span>
        ))}
        {ROWS.map((r) => (
          <PermRow key={r.key} label={t(`perm.${r.key}`)}>
            {BITS.map((b) => {
              const bit = b.bit << r.shift;
              return (
                <Checkbox
                  key={b.key}
                  checked={(state.value & bit) !== 0}
                  indeterminate={(state.mixed & bit) !== 0}
                  disabled={disabled}
                  onChange={(v) => setBit(bit, v)}
                  title={`${t(`perm.${r.key}`)} – ${t(`perm.${b.key}`)}`}
                />
              );
            })}
          </PermRow>
        ))}
      </div>
      <div className="perm-side">
        <Field label={t('perm.octal')}>
          <TextInput
            className="input-octal mono"
            value={octal}
            disabled={disabled}
            placeholder={state.mixed ? t('perm.mixed') : '0644'}
            maxLength={4}
            onChange={(e) => {
              setOctal(e.target.value);
              const v = parseOctal(e.target.value);
              if (v !== null) onChange({ value: v, mixed: 0 });
            }}
            aria-label={t('perm.octal')}
          />
        </Field>
        <div className="perm-special">
          {SPECIAL.map((s) => (
            <Checkbox key={s.key} label={t(`perm.${s.key}`)} checked={(state.value & s.bit) !== 0} indeterminate={(state.mixed & s.bit) !== 0} disabled={disabled} onChange={(v) => setBit(s.bit, v)} />
          ))}
        </div>
      </div>
    </div>
  );
}

function PermRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span className="perm-row-label">{label}</span>
      {children}
    </>
  );
}

/** Combine permissions of several entries into value + mixed mask. */
export function combinePerms(values: (number | null | undefined)[]): PermState {
  const defined = values.filter((v): v is number => v !== null && v !== undefined).map((v) => v & 0o7777);
  if (!defined.length) return { value: 0o644, mixed: 0 };
  const first = defined[0];
  let mixed = 0;
  for (const v of defined) mixed |= v ^ first;
  return { value: first & ~mixed, mixed };
}

// ---------------------------------------------------------------- transfer options

const OVERWRITE: OverwriteMode[] = ['ask', 'overwrite', 'skip', 'newer', 'differentSize', 'differentChecksum', 'resume', 'rename'];

export function TransferOptionsForm({ value, onChange, upload }: { value: TransferOptions; onChange: (v: TransferOptions) => void; upload?: boolean }) {
  const t = useT();
  const set = <K extends keyof TransferOptions>(k: K, v: TransferOptions[K]) => onChange({ ...value, [k]: v });
  const permMode: 'preserve' | 'default' | 'set' = value.permissions !== null && value.permissions !== undefined ? 'set' : value.preservePermissions ? 'preserve' : 'default';
  return (
    <div className="topts">
      <div className="form-grid">
        <Field label={t('topt.overwrite')}>
          <Select value={value.overwrite} onChange={(e) => set('overwrite', e.target.value as OverwriteMode)}>
            {OVERWRITE.map((m) => (
              <option key={m} value={m}>
                {t(`overwrite.${m}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('topt.mode')}>
          <Segmented
            size="sm"
            value={value.mode}
            onChange={(v) => set('mode', v)}
            options={[
              { value: 'binary', label: t('topt.binary') },
              { value: 'text', label: t('topt.text') },
              { value: 'auto', label: t('topt.auto') },
            ]}
          />
        </Field>
        {value.mode === 'auto' && (
          <Field label={t('topt.textMasks')} className="span2">
            <TextInput value={value.textMasks} onChange={(e) => set('textMasks', e.target.value)} placeholder="*.txt; *.html; *.php" />
          </Field>
        )}
        <Field label={t('topt.fileMask')} className="span2" hint={t('topt.fileMaskHint')}>
          <TextInput value={value.fileMask} onChange={(e) => set('fileMask', e.target.value)} placeholder="*.jpg; *.png | thumbs/; *.tmp" />
        </Field>
        <Field label={t('topt.speedLimit')}>
          <div className="input-suffix">
            <NumberInput value={Math.round(value.speedLimit / 1024)} min={0} onChange={(v) => set('speedLimit', Math.max(0, v) * 1024)} />
            <span>KB/s</span>
          </div>
        </Field>
        <Field label={t('topt.parallel')}>
          <NumberInput value={value.parallel} min={1} max={8} onChange={(v) => set('parallel', Math.max(1, Math.min(8, v)))} />
        </Field>
      </div>
      <div className="topts-perm">
        <div className="field-label">{t('topt.permissions')}</div>
        <div className="radio-row">
          {(['preserve', 'default', 'set'] as const).map((m) => (
            <label key={m} className="check">
              <input
                type="radio"
                name="permMode"
                checked={permMode === m}
                onChange={() => onChange({ ...value, preservePermissions: m === 'preserve', permissions: m === 'set' ? (value.permissions ?? 0o644) : null })}
              />
              <span>{t(`topt.perm.${m}`)}</span>
            </label>
          ))}
        </div>
        {permMode === 'set' && <PermGrid compact state={{ value: value.permissions ?? 0o644, mixed: 0 }} onChange={(s) => set('permissions', s.value)} />}
      </div>
      <div className="check-grid">
        <Checkbox label={t('topt.preserveTimestamps')} checked={value.preserveTimestamps} onChange={(v) => set('preserveTimestamps', v)} />
        <Checkbox label={t('topt.excludeHidden')} checked={value.excludeHidden} onChange={(v) => set('excludeHidden', v)} />
        <Checkbox label={t('topt.tempUpload')} checked={value.tempUpload} onChange={(v) => set('tempUpload', v)} title={upload === false ? t('topt.tempUploadHint') : undefined} />
        <Checkbox label={t('topt.verifyChecksum')} checked={value.verifyChecksum} onChange={(v) => set('verifyChecksum', v)} />
        <Checkbox label={t('topt.followSymlinks')} checked={value.followSymlinks} onChange={(v) => set('followSymlinks', v)} />
      </div>
    </div>
  );
}

export function summarizeOptions(o: TransferOptions, t: ReturnType<typeof useT>): string {
  const parts: string[] = [t(`overwrite.${o.overwrite}`)];
  if (o.mode !== 'binary') parts.push(t(`topt.${o.mode}`));
  if (o.fileMask) parts.push(o.fileMask);
  if (o.speedLimit) parts.push(`≤ ${Math.round(o.speedLimit / 1024)} KB/s`);
  if (o.permissions != null) parts.push(formatOctal(o.permissions));
  if (o.excludeHidden) parts.push(t('topt.noHiddenShort'));
  if (o.verifyChecksum) parts.push(t('topt.verifyShort'));
  return parts.join(' · ');
}
