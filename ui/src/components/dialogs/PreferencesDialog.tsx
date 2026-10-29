import { useEffect, useState } from 'react';
import { ArrowLeftRight, Code2, Globe, KeyRound, Lock, Radar, Settings, Shield, SquareTerminal, Trash2, Search } from 'lucide-react';
import type { FormatterInfo, KnownHost, Settings as SettingsT } from '../../api/types';
import { call } from '../../api/client';
import { tr, useT } from '../../i18n';
import { formatDate } from '../../lib/format';
import { installedFormatters } from '../../lib/editor/format';
import { load, save } from '../../lib/storage';
import { saveSettings, useApp } from '../../store/app';
import { confirmDialog, type DialogPropsMap } from '../../store/dialogs';
import { useNearby } from '../../store/misc';
import { attempt, toast } from '../../store/toasts';
import { Badge, Button, Checkbox, Dialog, DialogButtons, Field, IconButton, NumberInput, Segmented, Select, Spinner, Tabs, TextInput, type TabDef } from '../ui';
import { TransferOptionsForm } from './common';

type Tab = 'general' | 'transfer' | 'discovery' | 'server' | 'editor' | 'terminal' | 'security';

/** Built-in formatters plus the ones found on the host. */
function InstalledFormatters() {
  const t = useT();
  const [list, setList] = useState<FormatterInfo[] | null>(null);
  useEffect(() => {
    void installedFormatters().then(setList);
  }, []);
  return (
    <div className="span2 prefs-formatters">
      <div className="field-label">{t('prefs.formatters')}</div>
      <div className="muted small">{t('prefs.formattersBuiltin')}</div>
      <div className="row gap wrap">
        {list === null ? (
          <Spinner size={14} />
        ) : list.length ? (
          list.map((f) => (
            <Badge key={f.id} tone="ok" title={`${f.path} – ${f.languages.join(', ')}`}>
              {f.id}
            </Badge>
          ))
        ) : (
          <span className="muted small">{t('prefs.formattersNone')}</span>
        )}
      </div>
    </div>
  );
}

function KnownHosts() {
  const t = useT();
  const [list, setList] = useState<KnownHost[] | null>(null);
  const [q, setQ] = useState('');
  const reload = () => call('knownHosts.list').then(setList).catch((e) => { toast.error(e); setList([]); });
  useEffect(() => {
    void reload();
  }, []);
  const filtered = (list ?? []).filter((h) => !q || h.key.toLowerCase().includes(q.toLowerCase()) || h.fingerprint.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="known-hosts">
      <div className="row gap">
        <div className="sm-search grow">
          <Search size={13} className="muted" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('prefs.filterHosts')} />
        </div>
      </div>
      <div className="kh-list">
        {!list ? (
          <Spinner />
        ) : filtered.length === 0 ? (
          <div className="muted small pad">{t('prefs.noKnownHosts')}</div>
        ) : (
          filtered.map((h) => (
            <div key={h.key + h.fingerprint} className="kh-row">
              <div className="kh-main">
                <div className="mono small">{h.key}</div>
                <div className="muted small mono">
                  {h.keyType} · {h.fingerprint}
                </div>
              </div>
              <span className="muted small">{formatDate(h.added)}</span>
              <IconButton
                icon={Trash2}
                title={t('common.remove')}
                onClick={async () => {
                  if (!(await confirmDialog({ title: t('prefs.removeHost'), message: t('prefs.removeHostText', { host: h.key }), okLabel: t('common.remove'), danger: true }))) return;
                  await attempt(() => call('knownHosts.remove', { key: h.key, fingerprint: h.fingerprint }));
                  void reload();
                }}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function MasterPassword() {
  const t = useT();
  const vault = useApp((s) => s.vault);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const has = !!vault?.hasMasterPassword;
  const apply = async (remove: boolean) => {
    if (!remove && next !== confirm) return toast.warning(t('vault.mismatch'));
    setBusy(true);
    try {
      const v = await call('vault.setMasterPassword', { current: has ? current : null, newPassword: remove ? null : next });
      useApp.setState({ vault: v });
      setCurrent('');
      setNext('');
      setConfirm('');
      toast.success(remove ? t('vault.removed') : t('vault.set'));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="form-stack">
      <div className="row gap">
        <Lock size={14} />
        <span>{has ? t('vault.statusSet') : t('vault.statusNone')}</span>
        {has && <Badge tone={vault?.locked ? 'warn' : 'ok'}>{vault?.locked ? t('vault.locked') : t('vault.unlocked')}</Badge>}
        <div className="flex1" />
        {has && !vault?.locked && (
          <Button size="sm" icon={Lock} onClick={() => void call('vault.lock').then((v) => useApp.setState({ vault: v })).catch((e) => toast.error(e))}>
            {t('vault.lockNow')}
          </Button>
        )}
      </div>
      <p className="muted small">{t('vault.explain')}</p>
      <div className="form-grid">
        {has && (
          <Field label={t('vault.current')} className="span2">
            <TextInput type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
          </Field>
        )}
        <Field label={t('vault.new')}>
          <TextInput type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
        </Field>
        <Field label={t('vault.confirm')} hint={confirm && next !== confirm ? <span className="err">{t('vault.mismatch')}</span> : undefined}>
          <TextInput type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </Field>
      </div>
      <div className="row gap">
        <Button icon={KeyRound} onClick={() => void apply(false)} disabled={!next || next !== confirm || (has && !current)} busy={busy}>
          {has ? t('vault.change') : t('vault.setButton')}
        </Button>
        {has && (
          <Button variant="danger" onClick={() => void apply(true)} disabled={!current} busy={busy}>
            {t('vault.remove')}
          </Button>
        )}
      </div>
    </div>
  );
}

export default function PreferencesDialog({ props, close }: { props: DialogPropsMap['preferences']; close: () => void }) {
  const t = useT();
  const settings = useApp((s) => s.settings);
  const info = useApp((s) => s.info);
  const discovery = useNearby((s) => s.discovery);
  const [tab, setTab] = useState<Tab>((props.tab as Tab) ?? 'general');
  const [draft, setDraft] = useState<SettingsT | null>(settings ? structuredClone(settings) : null);
  const [skipCopy, setSkipCopy] = useState<boolean>(load('skipCopyDialog', false));
  const [busy, setBusy] = useState(false);
  const narrow = useApp((s) => s.narrow);

  useEffect(() => {
    if (!draft && settings) setDraft(structuredClone(settings));
  }, [settings, draft]);

  if (!draft) return null;
  const set = <K extends keyof SettingsT>(k: K, v: SettingsT[K]) => setDraft({ ...draft, [k]: v });
  const sub = <K extends 'discovery' | 'server' | 'editor' | 'terminal'>(k: K, patch: Partial<SettingsT[K]>) => setDraft({ ...draft, [k]: { ...draft[k], ...patch } });
  const web = info?.mode === 'web';

  const submit = async () => {
    setBusy(true);
    save('skipCopyDialog', skipCopy);
    const r = await saveSettings(draft);
    setBusy(false);
    if (r) {
      toast.success(tr('prefs.saved'));
      close();
    }
  };

  const tabs: TabDef<Tab>[] = [
    { id: 'general', label: t('prefs.general'), icon: Settings },
    { id: 'transfer', label: t('prefs.transfer'), icon: ArrowLeftRight },
    { id: 'discovery', label: t('prefs.discovery'), icon: Radar },
    { id: 'server', label: t('prefs.server'), icon: Globe },
    { id: 'editor', label: t('prefs.editor'), icon: Code2 },
    { id: 'terminal', label: t('prefs.terminal'), icon: SquareTerminal },
    { id: 'security', label: t('prefs.security'), icon: Shield },
  ];

  return (
    <Dialog title={t('prefs.title')} icon={Settings} onClose={close} onSubmit={() => void submit()} width={820} height={600} bodyClassName="prefs-body" footer={<DialogButtons onCancel={close} okLabel={t('common.save')} busy={busy} />}>
      <Tabs tabs={tabs} value={tab} onChange={setTab} vertical={!narrow} className="prefs-tabs" />
      <div className="prefs-content" data-testid="prefs-content">
        {tab === 'general' && (
          <div className="form-stack">
            <div className="form-grid">
              <Field label={t('prefs.language')}>
                <Select value={draft.language} onChange={(e) => set('language', e.target.value as SettingsT['language'])} data-testid="prefs-language">
                  <option value="auto">{t('lang.auto')}</option>
                  <option value="en">English</option>
                  <option value="de">Deutsch</option>
                </Select>
              </Field>
              <Field label={t('view.theme')}>
                <Segmented value={draft.theme} onChange={(v) => set('theme', v)} options={[{ value: 'system', label: t('theme.system') }, { value: 'light', label: t('theme.light') }, { value: 'dark', label: t('theme.dark') }]} />
              </Field>
              <Field label={t('prefs.doubleClick')} hint={t('prefs.doubleClickHint')}>
                <Select value={draft.doubleClickAction} onChange={(e) => set('doubleClickAction', e.target.value as SettingsT['doubleClickAction'])}>
                  <option value="edit">{t('prefs.dc.edit')}</option>
                  <option value="open">{t('prefs.dc.open')}</option>
                  <option value="transfer">{t('prefs.dc.transfer')}</option>
                </Select>
              </Field>
              <Field label={t('prefs.sizeFormat')}>
                <Segmented value={draft.sizeFormat} onChange={(v) => set('sizeFormat', v)} options={[{ value: 'auto', label: t('prefs.size.auto') }, { value: 'bytes', label: t('prefs.size.bytes') }]} />
              </Field>
            </div>
            <div className="check-col">
              <Checkbox label={t('view.showHidden')} checked={draft.showHidden} onChange={(v) => set('showHidden', v)} />
              <Checkbox label={t('prefs.confirmDelete')} checked={draft.confirmDelete} onChange={(v) => set('confirmDelete', v)} />
              <Checkbox label={t('prefs.confirmOverwrite')} checked={draft.confirmOverwrite} onChange={(v) => set('confirmOverwrite', v)} />
              <Checkbox label={t('prefs.showCopyDialog')} checked={!skipCopy} onChange={(v) => setSkipCopy(!v)} />
            </div>
          </div>
        )}
        {tab === 'transfer' && (
          <div className="form-stack">
            <Field label={t('prefs.maxJobs')} hint={t('prefs.maxJobsHint')}>
              <NumberInput value={draft.maxConcurrentJobs} min={1} max={16} onChange={(v) => set('maxConcurrentJobs', Math.max(1, Math.min(16, v)))} />
            </Field>
            <div className="section-title">{t('prefs.transferDefaults')}</div>
            <TransferOptionsForm value={draft.transfer} onChange={(v) => set('transfer', v)} />
          </div>
        )}
        {tab === 'discovery' && (
          <div className="form-stack">
            <p className="muted small">{t('prefs.discoveryExplain')}</p>
            <Checkbox label={t('prefs.discoveryEnabled')} checked={draft.discovery.enabled} onChange={(v) => sub('discovery', { enabled: v })} />
            <div className="form-grid">
              <Field label={t('prefs.instanceName')} hint={t('prefs.instanceNameHint')}>
                <TextInput value={draft.discovery.instanceName} onChange={(e) => sub('discovery', { instanceName: e.target.value })} placeholder={info?.hostname} />
              </Field>
              <Field label={t('prefs.udpPort')}>
                <NumberInput value={draft.discovery.port} min={1} max={65535} onChange={(v) => sub('discovery', { port: v })} />
              </Field>
              <Field label={t('prefs.interval')} hint={t('site.seconds')}>
                <NumberInput value={draft.discovery.intervalSecs} min={5} max={3600} onChange={(v) => sub('discovery', { intervalSecs: Math.max(5, v) })} />
              </Field>
            </div>
            {discovery && (
              <div className="muted small">
                {t('prefs.instanceId')}: <span className="mono">{discovery.instanceId}</span>
                {discovery.error && <div className="err">{discovery.error}</div>}
              </div>
            )}
          </div>
        )}
        {tab === 'server' && (
          <div className="form-stack">
            <p className="muted small">{web ? t('prefs.serverWebNote') : t('prefs.serverExplain')}</p>
            <Checkbox label={t('prefs.serverAutoStart')} checked={draft.server.autoStart} onChange={(v) => sub('server', { autoStart: v })} />
            <div className="form-grid">
              <Field label={t('share.bind')}>
                <TextInput value={draft.server.bind} onChange={(e) => sub('server', { bind: e.target.value })} placeholder="0.0.0.0" />
              </Field>
              <Field label={t('site.port')}>
                <NumberInput value={draft.server.port} min={1} max={65535} onChange={(v) => sub('server', { port: v })} />
              </Field>
            </div>
            <Checkbox label={t('share.tls')} checked={draft.server.tls} onChange={(v) => sub('server', { tls: v })} />
            <Checkbox label={t('prefs.allowTerminal')} checked={draft.server.allowTerminal} onChange={(v) => sub('server', { allowTerminal: v })} />
          </div>
        )}
        {tab === 'editor' && (
          <div className="form-grid">
            <Field label={t('prefs.fontSize')}>
              <NumberInput value={draft.editor.fontSize} min={8} max={32} onChange={(v) => sub('editor', { fontSize: v })} />
            </Field>
            <Field label={t('prefs.tabSize')}>
              <NumberInput value={draft.editor.tabSize} min={1} max={16} onChange={(v) => sub('editor', { tabSize: v })} />
            </Field>
            <Field label={t('prefs.printWidth')} hint={t('prefs.printWidthHint')}>
              <NumberInput value={draft.editor.printWidth} min={40} max={240} onChange={(v) => sub('editor', { printWidth: v })} />
            </Field>
            <div />
            <Checkbox label={t('editor.wordWrap')} checked={draft.editor.wordWrap} onChange={(v) => sub('editor', { wordWrap: v })} />
            <Checkbox label={t('prefs.lint')} checked={draft.editor.lint} onChange={(v) => sub('editor', { lint: v })} />
            <Checkbox label={t('prefs.formatOnSave')} checked={draft.editor.formatOnSave} onChange={(v) => sub('editor', { formatOnSave: v })} />
            <InstalledFormatters />
          </div>
        )}
        {tab === 'terminal' && (
          <div className="form-grid">
            <Field label={t('prefs.fontFamily')} className="span2">
              <TextInput value={draft.terminal.fontFamily} onChange={(e) => sub('terminal', { fontFamily: e.target.value })} className="mono" />
            </Field>
            <Field label={t('prefs.fontSize')}>
              <NumberInput value={draft.terminal.fontSize} min={8} max={32} onChange={(v) => sub('terminal', { fontSize: v })} />
            </Field>
            <Field label={t('prefs.scrollback')}>
              <NumberInput value={draft.terminal.scrollback} min={100} max={100000} step={100} onChange={(v) => sub('terminal', { scrollback: v })} />
            </Field>
          </div>
        )}
        {tab === 'security' && (
          <div className="form-stack">
            <div className="section-title">{t('vault.title')}</div>
            <MasterPassword />
            <div className="section-title">{t('prefs.knownHosts')}</div>
            <KnownHosts />
          </div>
        )}
      </div>
    </Dialog>
  );
}
