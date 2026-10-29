import { useEffect, useState } from 'react';
import {
  ClipboardCopy, Command, Play, Plus, Route, Save, Search, Share2, ShieldCheck, Square, Trash2, Users, Globe, KeyRound, TriangleAlert,
} from 'lucide-react';
import type { CustomCommand, TunnelKind } from '../../api/types';
import { call } from '../../api/client';
import { useT } from '../../i18n';
import { formatBytes, fromDatetimeLocal, parseSize } from '../../lib/format';
import { load, save } from '../../lib/storage';
import { reloadCommands, showDock, useApp } from '../../store/app';
import type { DialogPropsMap } from '../../store/dialogs';
import { beginSearch, removeBg, upsertBg, useBg, useNearby, useSearch } from '../../store/misc';
import { attempt, toast } from '../../store/toasts';
import { copyText, runCustomCommand } from '../../actions/fileOps';
import { Badge, Button, Checkbox, Dialog, DialogButtons, Field, IconButton, NumberInput, Segmented, Select, TextInput, cx } from '../ui';

type DP<K extends keyof DialogPropsMap> = { props: DialogPropsMap[K]; close: () => void };

// ---------------------------------------------------------------- find files

interface FindForm {
  nameMask: string;
  contentText: string;
  caseSensitive: boolean;
  minSize: string;
  maxSize: string;
  after: string;
  before: string;
  includeHidden: boolean;
  includeDirs: boolean;
  maxDepth: string;
}

export function FindDialog({ props, close }: DP<'find'>) {
  const t = useT();
  const sessions = useApp((s) => s.sessions);
  const [session, setSession] = useState(props.session);
  const [root, setRoot] = useState(props.root);
  const [f, setF] = useState<FindForm>(() => ({ nameMask: '*', contentText: '', caseSensitive: false, minSize: '', maxSize: '', after: '', before: '', includeHidden: false, includeDirs: false, maxDepth: '', ...load<Partial<FindForm>>('findForm', {}) }));
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof FindForm>(k: K, v: FindForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const remote = session !== 'local';

  const submit = async () => {
    setBusy(true);
    save('findForm', { ...f, after: '', before: '' });
    const params = {
      session,
      root,
      nameMask: f.nameMask.trim() === '*' ? '' : f.nameMask.trim(),
      contentText: f.contentText.trim() || null,
      caseSensitive: f.caseSensitive,
      minSize: f.minSize ? parseSize(f.minSize) : null,
      maxSize: f.maxSize ? parseSize(f.maxSize) : null,
      modifiedAfter: fromDatetimeLocal(f.after),
      modifiedBefore: fromDatetimeLocal(f.before),
      includeHidden: f.includeHidden,
      includeDirs: f.includeDirs,
      maxDepth: f.maxDepth ? Math.max(1, parseInt(f.maxDepth, 10) || 1) : null,
    };
    try {
      const prev = useSearch.getState().run;
      if (prev?.running) void call('search.cancel', { id: prev.id }).catch(() => undefined);
      const { id } = await call('search.start', { params });
      beginSearch(id, params);
      showDock('search');
      close();
    } catch (e) {
      toast.error(e, t('find.title'));
      setBusy(false);
    }
  };

  return (
    <Dialog title={t('find.title')} icon={Search} onClose={close} onSubmit={() => void submit()} width={600} footer={<DialogButtons onCancel={close} okLabel={t('find.start')} busy={busy} />}>
      <div className="form-grid">
        <Field label={t('find.in')}>
          <Select value={session} onChange={(e) => setSession(e.target.value)}>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id === 'local' ? t('session.local') : s.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('find.root')}>
          <TextInput value={root} onChange={(e) => setRoot(e.target.value)} />
        </Field>
        <Field label={t('find.nameMask')} className="span2" hint={t('find.nameMaskHint')}>
          <TextInput value={f.nameMask} onChange={(e) => set('nameMask', e.target.value)} data-autofocus placeholder="*.log; *.txt" />
        </Field>
        <Field label={t('find.contains')} className="span2" hint={remote && f.contentText ? <span className="warn">{t('find.remoteSlow')}</span> : undefined}>
          <TextInput value={f.contentText} onChange={(e) => set('contentText', e.target.value)} placeholder={t('find.containsPlaceholder')} />
        </Field>
        <Field label={t('find.minSize')}>
          <TextInput value={f.minSize} onChange={(e) => set('minSize', e.target.value)} placeholder="e.g. 10M" />
        </Field>
        <Field label={t('find.maxSize')}>
          <TextInput value={f.maxSize} onChange={(e) => set('maxSize', e.target.value)} placeholder="e.g. 2G" />
        </Field>
        <Field label={t('find.after')}>
          <input type="datetime-local" className="input" value={f.after} onChange={(e) => set('after', e.target.value)} />
        </Field>
        <Field label={t('find.before')}>
          <input type="datetime-local" className="input" value={f.before} onChange={(e) => set('before', e.target.value)} />
        </Field>
        <Field label={t('find.maxDepth')}>
          <TextInput value={f.maxDepth} onChange={(e) => set('maxDepth', e.target.value.replace(/\D/g, ''))} placeholder={t('find.unlimited')} inputMode="numeric" />
        </Field>
      </div>
      <div className="check-grid">
        <Checkbox label={t('find.caseSensitive')} checked={f.caseSensitive} onChange={(v) => set('caseSensitive', v)} />
        <Checkbox label={t('find.includeHidden')} checked={f.includeHidden} onChange={(v) => set('includeHidden', v)} />
        <Checkbox label={t('find.includeDirs')} checked={f.includeDirs} onChange={(v) => set('includeDirs', v)} />
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- tunnels

export function TunnelsDialog({ props, close }: DP<'tunnels'>) {
  const t = useT();
  const sessions = useApp((s) => s.sessions).filter((s) => s.capabilities.tunnels);
  const tunnels = useBg((s) => s.tunnels);
  const [session, setSession] = useState(props.session && sessions.some((s) => s.id === props.session) ? props.session : sessions[0]?.id ?? '');
  const [kind, setKind] = useState<TunnelKind>('local');
  const [bindHost, setBindHost] = useState('127.0.0.1');
  const [bindPort, setBindPort] = useState(8080);
  const [targetHost, setTargetHost] = useState('localhost');
  const [targetPort, setTargetPort] = useState(80);
  const [busy, setBusy] = useState(false);
  const sname = (id: string) => useApp.getState().sessions.find((s) => s.id === id)?.name ?? id;

  useEffect(() => {
    call('tunnel.list').then((l) => l.forEach((x) => upsertBg('tunnels', x))).catch(() => undefined);
  }, []);

  const start = async () => {
    if (!session) return;
    setBusy(true);
    const tn = await attempt(() => call('tunnel.start', { session, kind, bindHost, bindPort, targetHost: kind === 'local' ? targetHost : null, targetPort: kind === 'local' ? targetPort : null }), t('tunnels.title'));
    setBusy(false);
    if (tn) {
      upsertBg('tunnels', tn);
      toast.success(t('tunnels.started', { port: tn.bindPort }));
    }
  };

  return (
    <Dialog title={t('tunnels.title')} icon={Route} onClose={close} onSubmit={() => void start()} width={640} footer={<div className="dlg-foot-buttons"><Button variant="primary" icon={Play} onClick={() => void start()} busy={busy} disabled={!session}>{t('tunnels.start')}</Button><Button onClick={close}>{t('common.close')}</Button></div>}>
      {sessions.length === 0 ? (
        <p className="warn small">{t('tunnels.needSsh')}</p>
      ) : (
        <>
          <div className="form-grid">
            <Field label={t('tunnels.session')}>
              <Select value={session} onChange={(e) => setSession(e.target.value)}>
                {sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('tunnels.kind')}>
              <Segmented value={kind} onChange={setKind} options={[{ value: 'local', label: t('tunnels.local') }, { value: 'dynamic', label: t('tunnels.dynamic') }]} />
            </Field>
            <Field label={t('tunnels.bindHost')}>
              <TextInput value={bindHost} onChange={(e) => setBindHost(e.target.value)} />
            </Field>
            <Field label={t('tunnels.bindPort')}>
              <NumberInput value={bindPort} min={1} max={65535} onChange={setBindPort} />
            </Field>
            {kind === 'local' && (
              <>
                <Field label={t('tunnels.targetHost')} hint={t('tunnels.targetHint')}>
                  <TextInput value={targetHost} onChange={(e) => setTargetHost(e.target.value)} />
                </Field>
                <Field label={t('tunnels.targetPort')}>
                  <NumberInput value={targetPort} min={1} max={65535} onChange={setTargetPort} />
                </Field>
              </>
            )}
          </div>
          <p className="muted small">{kind === 'local' ? t('tunnels.localExplain', { bind: `${bindHost}:${bindPort}`, target: `${targetHost}:${targetPort}` }) : t('tunnels.dynamicExplain', { bind: `${bindHost}:${bindPort}` })}</p>
        </>
      )}
      <div className="section-title">{t('tunnels.active')}</div>
      {Object.values(tunnels).length === 0 ? (
        <div className="muted small">{t('tunnels.none')}</div>
      ) : (
        <div className="watch-list">
          {Object.values(tunnels).map((tn) => (
            <div key={tn.id} className="watch-row">
              <Route size={14} className="accent" />
              <div className="watch-main">
                <div className="mono small">
                  {tn.bindHost}:{tn.bindPort} → {tn.kind === 'dynamic' ? 'SOCKS5' : `${tn.targetHost}:${tn.targetPort}`} <span className="muted">({sname(tn.session)})</span>
                </div>
                <div className="muted small">
                  {t('tunnels.stats', { n: tn.connections, in: formatBytes(tn.bytesIn), out: formatBytes(tn.bytesOut) })}
                  {tn.error && <span className="err"> · {tn.error}</span>}
                </div>
              </div>
              <IconButton icon={Square} title={t('tunnels.stop')} onClick={() => void attempt(() => call('tunnel.stop', { id: tn.id })).then(() => removeBg('tunnels', tn.id))} />
            </div>
          ))}
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------- custom commands

const EMPTY_CMD: CustomCommand = { id: '', name: '', command: '', perFile: false, target: 'session', showOutput: true, refresh: false };

export function CommandsDialog({ props, close }: DP<'commands'>) {
  const t = useT();
  const commands = useApp((s) => s.commands);
  const [selId, setSelId] = useState<string | null>(commands[0]?.id ?? null);
  const [draft, setDraft] = useState<CustomCommand>(() => commands[0] ?? EMPTY_CMD);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof CustomCommand>(k: K, v: CustomCommand[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const select = (c: CustomCommand) => {
    setSelId(c.id);
    setDraft(c);
  };
  const saveCmd = async () => {
    if (!draft.name.trim() || !draft.command.trim()) return toast.warning(t('commands.needNameCommand'));
    setBusy(true);
    const saved = await attempt(() => call('commands.save', { command: draft }));
    setBusy(false);
    if (saved) {
      await reloadCommands();
      setSelId(saved.id);
      setDraft(saved);
      toast.success(t('commands.saved'));
    }
  };
  const remove = async () => {
    if (!selId) return;
    await attempt(() => call('commands.delete', { id: selId }));
    await reloadCommands();
    setSelId(null);
    setDraft(EMPTY_CMD);
  };
  const run = async () => {
    if (!draft.command.trim()) return;
    const side = props.side ?? useApp.getState().activeSide;
    if (draft.id) {
      await runCustomCommand(side, draft);
      return;
    }
    const { getPanel, targets } = await import('../../store/panels');
    const p = getPanel(side);
    try {
      const outputs = await call('commands.run', { command: draft.command, session: draft.target === 'local' ? 'local' : p.session, cwd: p.path, names: targets(side).map((e) => e.name) });
      const { openDialog } = await import('../../store/dialogs');
      openDialog('commandOutput', { title: draft.name || draft.command, outputs });
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Dialog title={t('commands.manage')} icon={Command} onClose={close} onSubmit={() => void saveCmd()} width={760} height={520} bodyClassName="cmd-body" footer={<div className="dlg-foot-buttons"><Button icon={Play} onClick={() => void run()} disabled={!draft.command.trim()}>{t('commands.runOnSelection')}</Button><Button variant="primary" icon={Save} busy={busy} onClick={() => void saveCmd()}>{t('common.save')}</Button><Button onClick={close}>{t('common.close')}</Button></div>}>
      <div className="cmd-list">
        {commands.map((c) => (
          <div key={c.id} className={cx('cmd-item', selId === c.id && 'selected')} onClick={() => select(c)}>
            <Command size={13} />
            <span className="ellipsis">{c.name}</span>
          </div>
        ))}
        {!commands.length && <div className="muted small pad">{t('commands.none')}</div>}
        <div className="cmd-list-actions">
          <Button size="sm" icon={Plus} onClick={() => { setSelId(null); setDraft(EMPTY_CMD); }}>
            {t('common.new')}
          </Button>
          <IconButton icon={Trash2} title={t('common.delete')} disabled={!selId} onClick={() => void remove()} />
        </div>
      </div>
      <div className="cmd-form">
        <Field label={t('commands.name')}>
          <TextInput value={draft.name} onChange={(e) => set('name', e.target.value)} data-autofocus />
        </Field>
        <Field label={t('commands.command')} hint={t('commands.patterns')}>
          <textarea className="input textarea mono" rows={3} value={draft.command} onChange={(e) => set('command', e.target.value)} spellCheck={false} placeholder='tar czf "!.tar.gz" "!"' />
        </Field>
        <Field label={t('commands.target')}>
          <Segmented value={draft.target} onChange={(v) => set('target', v)} options={[{ value: 'session', label: t('commands.onSession') }, { value: 'local', label: t('commands.onLocal') }]} />
        </Field>
        <div className="check-grid">
          <Checkbox label={t('commands.perFile')} checked={draft.perFile} onChange={(v) => set('perFile', v)} />
          <Checkbox label={t('commands.showOutput')} checked={draft.showOutput} onChange={(v) => set('showOutput', v)} />
          <Checkbox label={t('commands.refresh')} checked={draft.refresh} onChange={(v) => set('refresh', v)} />
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- share this instance (embedded web server)

export function ShareDialog({ close }: DP<'share'>) {
  const t = useT();
  const server = useNearby((s) => s.server);
  const settings = useApp((s) => s.settings);
  const [bind, setBind] = useState(server?.bind || settings?.server.bind || '0.0.0.0');
  const [port, setPort] = useState(server?.port || settings?.server.port || 8822);
  const [tls, setTls] = useState(server?.tls ?? settings?.server.tls ?? true);
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    call('server.status').then((s) => useNearby.setState({ server: s })).catch(() => undefined);
  }, []);

  const startStop = async () => {
    setBusy('run');
    try {
      const s = server?.running ? await call('server.stop') : await call('server.start', { bind, port, tls });
      useNearby.setState({ server: s });
      if (s.error) toast.warning(t('share.error'), s.error);
    } catch (e) {
      toast.error(e, t('share.title'));
    } finally {
      setBusy(null);
    }
  };
  const setPassword = async () => {
    if (!pw) return;
    setBusy('pw');
    try {
      useNearby.setState({ server: await call('server.setPassword', { password: pw }) });
      setPw('');
      toast.success(t('share.passwordSet'));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const running = !!server?.running;
  return (
    <Dialog title={t('share.title')} icon={Share2} onClose={close} onSubmit={() => (pw ? void setPassword() : undefined)} width={600} footer={<div className="dlg-foot-buttons"><Button variant={running ? 'danger' : 'primary'} icon={running ? Square : Play} busy={busy === 'run'} onClick={() => void startStop()} data-testid="share-toggle">{running ? t('share.stop') : t('share.start')}</Button><Button onClick={close}>{t('common.close')}</Button></div>}>
      <p className="muted small">{t('share.explain')}</p>
      <div className={cx('share-state', running && 'on')}>
        <Globe size={18} />
        <div>
          <strong>{running ? t('share.running') : t('share.stopped')}</strong>
          {running && (
            <div className="muted small">
              <Users size={11} /> {t('nearby.clients', { n: server?.clients ?? 0 })}
            </div>
          )}
        </div>
        {server?.error && <span className="err small">{server.error}</span>}
      </div>
      {running && (
        <div className="share-urls">
          {server!.urls.map((u) => (
            <div key={u} className="share-url-row">
              <code className="mono">{u}</code>
              <IconButton icon={ClipboardCopy} size={13} title={t('common.copy')} onClick={() => void copyText(u)} />
            </div>
          ))}
          {server!.fingerprint && (
            <div className="fp">
              <span className="fp-label">
                <ShieldCheck size={12} /> {t('share.fingerprint')}
              </span>
              <code className="fp-value" onClick={() => void copyText(server!.fingerprint!)}>{server!.fingerprint}</code>
            </div>
          )}
        </div>
      )}
      {!server?.hasPassword && (
        <p className="warn small">
          <TriangleAlert size={12} /> {t('share.noPassword')}
        </p>
      )}
      <div className="form-grid">
        <Field label={t('share.bind')} hint={t('share.bindHint')}>
          <Select value={bind} onChange={(e) => setBind(e.target.value)} disabled={running}>
            <option value="0.0.0.0">{t('share.bindAll')}</option>
            <option value="127.0.0.1">{t('share.bindLocal')}</option>
            {bind !== '0.0.0.0' && bind !== '127.0.0.1' && <option value={bind}>{bind}</option>}
          </Select>
        </Field>
        <Field label={t('site.port')}>
          <NumberInput value={port} min={1} max={65535} onChange={setPort} disabled={running} />
        </Field>
      </div>
      <Checkbox label={t('share.tls')} checked={tls} onChange={setTls} disabled={running} />
      <div className="section-title">
        <KeyRound size={13} /> {t('share.password')} {server?.hasPassword ? <Badge tone="ok">{t('share.passwordIsSet')}</Badge> : <Badge tone="warn">{t('share.passwordNotSet')}</Badge>}
      </div>
      <div className="input-with-btn">
        <TextInput type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder={t('share.newPassword')} autoComplete="new-password" />
        <Button onClick={() => void setPassword()} disabled={!pw} busy={busy === 'pw'}>
          {t('share.setPassword')}
        </Button>
      </div>
      {!useApp.getState().settings?.server.allowTerminal && <p className="muted small">{t('share.noTerminal')}</p>}
    </Dialog>
  );
}
