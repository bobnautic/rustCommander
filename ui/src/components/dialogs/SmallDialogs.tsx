import { useEffect, useState } from 'react';
import {
  Archive, CircleCheck, CircleX, ClipboardCopy, Hash, Info, Keyboard, Link2, ListChecks, Lock, Plug, Plus, Radar, ShieldCheck,
  SquareTerminal, TriangleAlert, Sparkles,
} from 'lucide-react';
import type { ChecksumAlgo, ExecOutput, Peer, SessionInfo } from '../../api/types';
import { call, mode } from '../../api/client';
import { useT } from '../../i18n';
import * as P from '../../lib/paths';
import { useApp } from '../../store/app';
import type { ConfirmProps, DialogPropsMap, InputProps } from '../../store/dialogs';
import { navigate, getPanel, selectByMask, type Side } from '../../store/panels';
import { attempt, toast } from '../../store/toasts';
import { copyText } from '../../actions/fileOps';
import { connectPeer } from '../../actions/sessions';
import { keyLabel } from '../../actions/shortcuts';
import { Badge, Button, Checkbox, Dialog, DialogButtons, Field, Segmented, Spinner, TextInput } from '../ui';

type DP<K extends keyof DialogPropsMap> = { props: DialogPropsMap[K]; close: () => void };

// ---------------------------------------------------------------- confirm / input

export function ConfirmDialog({ props, close }: { props: ConfirmProps; close: () => void }) {
  const [checked, setChecked] = useState(props.checkbox?.checked ?? false);
  const done = (ok: boolean) => {
    close();
    props.resolve(ok, checked);
  };
  return (
    <Dialog
      title={props.title}
      icon={props.danger ? TriangleAlert : Info}
      tone={props.danger ? 'warn' : undefined}
      onClose={() => done(false)}
      onSubmit={() => done(true)}
      width={440}
      footer={
        <DialogButtons
          onCancel={() => done(false)}
          okLabel={props.okLabel}
          cancelLabel={props.cancelLabel}
          danger={props.danger}
          extra={props.checkbox ? <Checkbox label={props.checkbox.label} checked={checked} onChange={setChecked} /> : undefined}
        />
      }
    >
      <p className="prompt-text">{props.message}</p>
      {props.detail && <pre className="detail-box">{props.detail}</pre>}
    </Dialog>
  );
}

export function InputDialog({ props, close }: { props: InputProps; close: () => void }) {
  const [value, setValue] = useState(props.value ?? '');
  const [touched, setTouched] = useState(false);
  const error = props.validate ? props.validate(value) : null;
  const done = (v: string | null) => {
    close();
    props.resolve(v);
  };
  return (
    <Dialog
      title={props.title}
      onClose={() => done(null)}
      onSubmit={() => {
        setTouched(true);
        if (!error) done(value);
      }}
      width={420}
      noEnterSubmit={props.multiline}
      footer={<DialogButtons onCancel={() => done(null)} okLabel={props.okLabel} okDisabled={!!error && touched} />}
    >
      <Field label={props.label} hint={(touched || value !== (props.value ?? '')) && error ? <span className="err">{error}</span> : props.hint}>
        {props.multiline ? (
          <textarea className="input textarea" rows={6} value={value} onChange={(e) => setValue(e.target.value)} data-autofocus spellCheck={false} />
        ) : (
          <TextInput
            type={props.password ? 'password' : 'text'}
            value={value}
            placeholder={props.placeholder}
            onChange={(e) => setValue(e.target.value)}
            data-autofocus
            data-select-stem={props.selectStem ? '1' : undefined}
            data-testid="input-dialog"
          />
        )}
      </Field>
    </Dialog>
  );
}

// ---------------------------------------------------------------- select by mask

const maskHistory: string[] = [];

export function SelectMaskDialog({ props, close }: DP<'selectMask'>) {
  const t = useT();
  const [mask, setMask] = useState(maskHistory[0] ?? '*.*');
  const submit = () => {
    const n = selectByMask(props.side as Side, mask, props.select);
    if (!maskHistory.includes(mask)) maskHistory.unshift(mask);
    toast.info(props.select ? t('select.selectedN', { n }) : t('select.unselectedN', { n }));
    close();
  };
  return (
    <Dialog title={props.select ? t('select.byMask') : t('select.unselectByMask')} icon={ListChecks} onClose={close} onSubmit={submit} width={400} footer={<DialogButtons onCancel={close} />}>
      <Field label={t('select.mask')} hint={t('select.maskHint')}>
        <TextInput value={mask} onChange={(e) => setMask(e.target.value)} data-autofocus list="mask-history" />
        <datalist id="mask-history">
          {maskHistory.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </Field>
    </Dialog>
  );
}

// ---------------------------------------------------------------- checksum

export function ChecksumDialog({ props, close }: DP<'checksum'>) {
  const t = useT();
  const [algo, setAlgo] = useState<ChecksumAlgo>('sha256');
  const [result, setResult] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [expected, setExpected] = useState('');
  const compute = async (a: ChecksumAlgo) => {
    setBusy(true);
    try {
      const r = await call('fs.checksum', { session: props.session, path: props.entry.path, algo: a });
      setResult((x) => ({ ...x, [a]: r }));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void compute('sha256');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const value = result[algo];
  const match = expected.trim() && value ? expected.trim().toLowerCase() === value.toLowerCase() : null;
  return (
    <Dialog title={t('checksum.title')} icon={Hash} onClose={close} onSubmit={close} width={560} footer={<div className="dlg-foot-buttons"><Button variant="primary" onClick={close}>{t('common.close')}</Button></div>}>
      <div className="muted small ellipsis" title={props.entry.path}>{props.entry.path}</div>
      <div className="row gap">
        <Segmented
          value={algo}
          onChange={(a) => {
            setAlgo(a);
            if (!result[a]) void compute(a);
          }}
          options={(['md5', 'sha1', 'sha256'] as const).map((a) => ({ value: a, label: a.toUpperCase() }))}
        />
        {busy && <Spinner size={14} />}
      </div>
      <div className="checksum-out">
        <code className="mono">{value ?? (busy ? t('checksum.computing') : '')}</code>
        <Button size="sm" icon={ClipboardCopy} disabled={!value} onClick={() => value && void copyText(value)}>
          {t('common.copy')}
        </Button>
      </div>
      <Field label={t('checksum.compare')} hint={match === null ? t('checksum.compareHint') : match ? <span className="ok"><CircleCheck size={12} /> {t('checksum.match')}</span> : <span className="err"><CircleX size={12} /> {t('checksum.mismatch')}</span>}>
        <TextInput value={expected} onChange={(e) => setExpected(e.target.value)} placeholder={t('checksum.paste')} />
      </Field>
    </Dialog>
  );
}

// ---------------------------------------------------------------- archives / symlinks

export function CreateArchiveDialog({ props, close }: DP<'createArchive'>) {
  const t = useT();
  const base = props.paths.length === 1 ? P.basename(props.paths[0]) : P.basename(props.dir) || 'archive';
  const [format, setFormat] = useState<'zip' | 'tar' | 'tar.gz'>('zip');
  const [name, setName] = useState(base);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const job = await attempt(() => call('archive.create', { session: props.session, paths: props.paths, dst: P.join(props.dir, `${name.trim()}.${format}`), format }));
    setBusy(false);
    if (job) close();
  };
  return (
    <Dialog title={t('archive.create')} icon={Archive} onClose={close} onSubmit={() => void submit()} width={440} footer={<DialogButtons onCancel={close} okLabel={t('common.create')} busy={busy} okDisabled={!P.isValidName(name.trim())} />}>
      <p className="muted small">{t('archive.items', { n: props.paths.length })}</p>
      <Field label={t('archive.name')}>
        <div className="input-suffix">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
          <span>.{format}</span>
        </div>
      </Field>
      <Field label={t('archive.format')}>
        <Segmented value={format} onChange={setFormat} options={[{ value: 'zip', label: 'ZIP' }, { value: 'tar', label: 'TAR' }, { value: 'tar.gz', label: 'TAR.GZ' }]} />
      </Field>
    </Dialog>
  );
}

export function SymlinkDialog({ props, close }: DP<'symlink'>) {
  const t = useT();
  const [target, setTarget] = useState(props.target ?? '');
  const [name, setName] = useState(props.target ? `${P.basename(props.target)}-link` : '');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    const r = await attempt(() => call('fs.symlink', { session: props.session, target: target.trim(), link: P.join(props.dir, name.trim()) }));
    setBusy(false);
    if (r !== undefined) {
      close();
      for (const side of ['left', 'right'] as const) {
        const p = getPanel(side);
        if (p.session === props.session && p.path === props.dir) void navigate(side, p.session, p.path, { history: false, select: name.trim() });
      }
    }
  };
  return (
    <Dialog title={t('ops.createLink')} icon={Link2} onClose={close} onSubmit={() => void submit()} width={480} footer={<DialogButtons onCancel={close} okLabel={t('common.create')} busy={busy} okDisabled={!target.trim() || !P.isValidName(name.trim())} />}>
      <Field label={t('link.name')} hint={t('link.nameHint', { dir: props.dir })}>
        <TextInput value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
      </Field>
      <Field label={t('link.target')} hint={t('link.targetHint')}>
        <TextInput value={target} onChange={(e) => setTarget(e.target.value)} />
      </Field>
    </Dialog>
  );
}

// ---------------------------------------------------------------- session info

export function SessionInfoDialog({ props, close }: DP<'sessionInfo'>) {
  const t = useT();
  const s = useApp((st) => st.sessions.find((x) => x.id === props.sessionId));
  const [info, setInfo] = useState<SessionInfo | null>(null);
  useEffect(() => {
    call('session.info', { id: props.sessionId }).then(setInfo).catch((e) => toast.error(e));
  }, [props.sessionId]);
  const caps = s ? (Object.entries(s.capabilities) as [string, boolean][]) : [];
  return (
    <Dialog title={t('session.info')} icon={Info} onClose={close} onSubmit={close} width={520} footer={<div className="dlg-foot-buttons"><Button variant="primary" onClick={close}>{t('common.close')}</Button></div>}>
      {s && (
        <div className="kv">
          <span>{t('session.name')}</span>
          <span>{s.name}</span>
          <span>URL</span>
          <span className="mono small">{s.url}</span>
          <span>{t('session.home')}</span>
          <span className="mono small">{s.home}</span>
        </div>
      )}
      {!info ? <Spinner /> : (
        <div className="kv">
          {info.items.map(([k, v]) => (
            <span key={k} className="contents">
              <span>{k}</span>
              <span className="mono small">{v}</span>
            </span>
          ))}
        </div>
      )}
      <div className="caps">
        {caps.map(([k, v]) => (
          <Badge key={k} tone={v ? 'ok' : 'muted'}>
            {v ? '✓' : '–'} {k}
          </Badge>
        ))}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- command output

export function CommandOutputDialog({ props, close }: DP<'commandOutput'>) {
  const t = useT();
  const all = props.outputs.map((o: ExecOutput) => o.stdout + (o.stderr ? `\n${o.stderr}` : '')).join('\n');
  return (
    <Dialog title={props.title} icon={SquareTerminal} onClose={close} onSubmit={close} width={680} footer={<div className="dlg-foot-buttons"><Button icon={ClipboardCopy} onClick={() => void copyText(all)}>{t('common.copy')}</Button><Button variant="primary" onClick={close}>{t('common.close')}</Button></div>}>
      {props.outputs.map((o, i) => (
        <div key={i} className="cmd-out">
          {props.outputs.length > 1 && <div className="muted small">#{i + 1}</div>}
          {o.stdout && <pre className="cmd-stdout">{o.stdout}</pre>}
          {o.stderr && <pre className="cmd-stderr">{o.stderr}</pre>}
          {!o.stdout && !o.stderr && <div className="muted">{t('commands.noOutput')}</div>}
          {o.exitCode !== null && o.exitCode !== undefined && <Badge tone={o.exitCode === 0 ? 'ok' : 'err'}>{t('commands.exitCode', { code: o.exitCode })}</Badge>}
        </div>
      ))}
    </Dialog>
  );
}

// ---------------------------------------------------------------- about & shortcuts

export function AboutDialog({ close }: DP<'about'>) {
  const t = useT();
  const info = useApp((s) => s.info);
  return (
    <Dialog title={t('help.about')} icon={Sparkles} onClose={close} onSubmit={close} width={440} footer={<div className="dlg-foot-buttons"><Button variant="primary" onClick={close}>{t('common.close')}</Button></div>}>
      <div className="about">
        <svg viewBox="0 0 64 64" width="56" height="56" aria-hidden>
          <rect x="4" y="4" width="56" height="56" rx="13" fill="var(--brand)" />
          <rect x="13" y="16" width="17" height="32" rx="3" fill="#fff" opacity=".95" />
          <rect x="34" y="16" width="17" height="32" rx="3" fill="#fff" opacity=".7" />
        </svg>
        <div>
          <h3>Rust Commander</h3>
          <div className="muted">{t('about.version', { v: info?.version ?? '?' })}</div>
          <div className="muted small">
            {t('about.mode')}: {mode === 'mock' ? t('status.demo') : info?.mode === 'web' ? t('status.web') : t('status.desktop')} · {info?.os}/{info?.arch}
          </div>
        </div>
      </div>
      <p>{t('about.text')}</p>
      <p className="muted small">{t('about.credits')}</p>
    </Dialog>
  );
}

const SHORTCUT_DOCS: [string, string][] = [
  ['F2', 'ops.rename'], ['F3', 'ops.view'], ['F4', 'ops.edit'], ['Shift+F4', 'ops.newFile'], ['F5', 'ops.copy'], ['Shift+F5', 'help.copyNoDialog'],
  ['F6', 'ops.move'], ['Shift+F6', 'help.moveNoDialog'], ['F7', 'ops.newFolder'], ['F8', 'common.delete'], ['Alt+Enter', 'ops.properties'],
  ['Ctrl+R', 'common.refresh'], ['Ctrl+H', 'view.showHidden'], ['Ctrl+N', 'session.newSession'], ['Ctrl+T', 'terminal.open'], ['Ctrl+F', 'find.title'],
  ['Ctrl+L', 'help.focusPath'], ['Ctrl+D', 'bookmarks.add'], ['Ctrl+Shift+S', 'sync.title'], ['Ctrl+B', 'sidebar.toggle'], ['Ctrl+Shift+E', 'explorer.title'], ['Ctrl+J', 'dock.title'],
  ['Ctrl+Shift+C', 'ops.copyPath'], ['Ctrl+,', 'prefs.title'], ['Alt+←/→', 'help.backForward'],
  ['Tab', 'help.switchPanel'], ['Insert / Space', 'help.toggleSelect'], ['Ctrl+A', 'panel.selectAll'], ['+ / −', 'select.byMask'], ['*', 'select.invert'],
  ['Backspace', 'nav.up'], ['Enter', 'ops.open'], ['A–Z', 'help.typeAhead'], ['Ctrl+S', 'editor.save'],
];

export function ShortcutsDialog({ close }: DP<'shortcuts'>) {
  const t = useT();
  return (
    <Dialog title={t('help.shortcuts')} icon={Keyboard} onClose={close} onSubmit={close} width={620} footer={<div className="dlg-foot-buttons"><Button variant="primary" onClick={close}>{t('common.close')}</Button></div>}>
      <div className="shortcut-grid">
        {SHORTCUT_DOCS.map(([k, label]) => (
          <div key={k} className="shortcut-row">
            <kbd className="kbd">{keyLabel(k)}</kbd>
            <span>{t(label as Parameters<typeof t>[0])}</span>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- vault

export function VaultDialog({ close }: DP<'vault'>) {
  const t = useT();
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const v = await call('vault.unlock', { password: pw });
      useApp.setState({ vault: v });
      if (!v.locked) close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t('vault.unlockTitle')} icon={Lock} onClose={close} onSubmit={() => void submit()} width={420} footer={<DialogButtons onCancel={close} cancelLabel={t('vault.later')} okLabel={t('vault.unlock')} busy={busy} okDisabled={!pw} />}>
      <p className="prompt-text">{t('vault.unlockText')}</p>
      <Field label={t('vault.masterPassword')} hint={error ? <span className="err">{error}</span> : mode === 'mock' ? t('vault.demoHint') : undefined}>
        <TextInput type="password" value={pw} onChange={(e) => setPw(e.target.value)} data-autofocus autoComplete="current-password" data-testid="vault-password" />
      </Field>
    </Dialog>
  );
}

// ---------------------------------------------------------------- peers

export function ConnectPeerDialog({ props, close }: DP<'connectPeer'>) {
  const t = useT();
  const peer: Peer = props.peer;
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    close();
    await connectPeer(peer, pw);
    setBusy(false);
  };
  return (
    <Dialog title={t('nearby.connectTitle', { name: peer.name })} icon={Plug} onClose={close} onSubmit={() => void submit()} width={460} footer={<DialogButtons onCancel={close} okLabel={t('nearby.connect')} busy={busy} />}>
      <div className="kv">
        <span>{t('nearby.address')}</span>
        <span className="mono">{peer.addresses[0]}:{peer.web?.port}</span>
        <span>{t('nearby.security')}</span>
        <span>{peer.web?.tls ? <><ShieldCheck size={12} className="ok" /> TLS</> : <span className="warn">{t('nearby.noTls')}</span>}</span>
        {peer.web?.fingerprint && (
          <>
            <span>{t('prompt.fingerprint')}</span>
            <span className="mono small break">{peer.web.fingerprint}</span>
          </>
        )}
      </div>
      <Field label={t('nearby.peerPassword')} hint={t('nearby.peerPasswordHint')}>
        <TextInput type="password" value={pw} onChange={(e) => setPw(e.target.value)} data-autofocus data-testid="peer-password" />
      </Field>
    </Dialog>
  );
}

export function AddPeerDialog({ close }: DP<'addPeer'>) {
  const t = useT();
  const [addr, setAddr] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const p = await call('discovery.add', { address: addr.trim() });
      toast.success(t('nearby.added', { name: p.name }));
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t('nearby.addByAddress')} icon={Radar} onClose={close} onSubmit={() => void submit()} width={440} footer={<DialogButtons onCancel={close} okLabel={t('common.add')} busy={busy} okDisabled={!addr.trim()} />}>
      <Field label={t('nearby.addressLabel')} hint={error ? <span className="err">{error}</span> : t('nearby.addressHint')}>
        <TextInput value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="192.168.1.50:8822" data-autofocus />
      </Field>
      <p className="muted small">
        <Plus size={11} /> {t('nearby.addExplain')}
      </p>
    </Dialog>
  );
}
