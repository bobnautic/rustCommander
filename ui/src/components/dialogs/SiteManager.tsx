import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, ChevronDown, ChevronRight, Copy, Download, Eye, EyeOff, FilePlus2, Folder, FolderOpen, FolderPen, FolderPlus, FileUp, LogIn,
  MoreHorizontal, Network, Plus, Save, Search, Trash2, Upload, X, Zap,
} from 'lucide-react';
import type { FtpEncryption, ImportFormat, Protocol, ProxyKind, SiteConfig } from '../../api/types';
import { SECRET_PLACEHOLDER } from '../../api/types';
import { call } from '../../api/client';
import { isTauri, pickNativeFile } from '../../api/desktop';
import { useT, type TKey } from '../../i18n';
import { load, save } from '../../lib/storage';
import { useApp } from '../../store/app';
import { confirmDialog, inputDialog, type DialogPropsMap } from '../../store/dialogs';
import { toast } from '../../store/toasts';
import { connect } from '../../actions/sessions';
import { copyText } from '../../actions/fileOps';
import { MenuList, type MenuItem } from '../Menu';
import { PROTOCOL_ICON } from '../panel/Panel';
import { Button, Checkbox, Dialog, EmptyState, Field, IconButton, NumberInput, Select, Spinner, Tabs, TextInput, cx, type TabDef } from '../ui';

const DEFAULT_PORT: Record<Protocol, number> = { local: 0, sftp: 22, scp: 22, ftp: 21, webdav: 443, s3: 443, azure: 443, gcs: 443, rcmd: 8822 };
const COLORS = ['#e5484d', '#f76b15', '#ffb224', '#30a46c', '#12a594', '#0090ff', '#3e63dd', '#8e4ec6', '#d6409f', '#8b8d98'];
const SFTP_SERVERS = ['sudo -n /usr/lib/openssh/sftp-server', 'sudo -n /usr/libexec/openssh/sftp-server', 'sudo -n /usr/lib/sftp-server', '/usr/lib/openssh/sftp-server'];

type Sel = { type: 'site'; id: string } | { type: 'folder'; path: string } | { type: 'new' } | null;
type FormTab = 'session' | 'proto' | 'proxy' | 'advanced' | 'notes';

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function defaultPort(s: SiteConfig): number {
  if (s.protocol === 'ftp' && s.ftp.encryption === 'implicit') return 990;
  if (s.protocol === 'webdav' && !s.webdav.https) return 80;
  if (s.protocol === 'rcmd') return 8822;
  return DEFAULT_PORT[s.protocol];
}

// ---------------------------------------------------------------- secret fields

function SecretField({ value, onChange, multiline, placeholder, id, testId }: { value: string | null | undefined; onChange: (v: string | null) => void; multiline?: boolean; placeholder?: string; id?: string; testId?: string }) {
  const t = useT();
  const [reveal, setReveal] = useState(false);
  const saved = value === SECRET_PLACEHOLDER;
  const shown = saved ? '' : (value ?? '');
  const ph = saved ? t('site.secretSaved') : value === null ? (placeholder ?? t('site.secretNone')) : placeholder;
  return (
    <div className="secret">
      {multiline ? (
        <textarea id={id} className="input textarea mono small" rows={4} value={shown} placeholder={ph} spellCheck={false} onChange={(e) => onChange(e.target.value === '' ? (saved ? SECRET_PLACEHOLDER : null) : e.target.value)} />
      ) : (
        <TextInput id={id} type={reveal ? 'text' : 'password'} value={shown} placeholder={ph} autoComplete="new-password" data-testid={testId} onChange={(e) => onChange(e.target.value === '' ? (saved ? SECRET_PLACEHOLDER : null) : e.target.value)} />
      )}
      {!multiline && !saved && shown && <IconButton icon={reveal ? EyeOff : Eye} size={14} title={reveal ? t('site.hide') : t('site.show')} onClick={() => setReveal(!reveal)} />}
      {(saved || shown) && (
        <button type="button" className="link-btn secret-clear" onClick={() => onChange(null)} title={t('site.clearSecretHint')}>
          {t('common.clear')}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- tree

interface FolderNode {
  name: string;
  path: string;
  folders: FolderNode[];
  sites: SiteConfig[];
}

function buildTree(sites: SiteConfig[], extra: string[]): FolderNode {
  const root: FolderNode = { name: '', path: '', folders: [], sites: [] };
  const ensure = (path: string): FolderNode => {
    if (!path) return root;
    let node = root;
    let acc = '';
    for (const seg of path.split('/').filter(Boolean)) {
      acc = acc ? `${acc}/${seg}` : seg;
      let next = node.folders.find((f) => f.name === seg);
      if (!next) {
        next = { name: seg, path: acc, folders: [], sites: [] };
        node.folders.push(next);
      }
      node = next;
    }
    return node;
  };
  for (const f of extra) ensure(f);
  for (const s of sites) ensure(s.folder).sites.push(s);
  const sort = (n: FolderNode) => {
    n.folders.sort((a, b) => a.name.localeCompare(b.name));
    n.sites.sort((a, b) => a.name.localeCompare(b.name));
    n.folders.forEach(sort);
  };
  sort(root);
  return root;
}

function siteSubtitle(s: SiteConfig): string {
  if (s.protocol === 's3') return `s3://${s.s3.bucket || '*'}${s.s3.endpoint ? ` @ ${s.s3.endpoint}` : ` · ${s.s3.region}`}`;
  if (s.protocol === 'azure') return `${s.azure.account || s.username}/${s.azure.container}`;
  if (s.protocol === 'gcs') return `gs://${s.gcs.bucket}`;
  return `${s.username ? s.username + '@' : ''}${s.host}${s.port ? ':' + s.port : ''}`;
}

function SiteRow({ s, selected, depth, onSelect, onOpen, showFolder }: { s: SiteConfig; selected: boolean; depth: number; onSelect: () => void; onOpen: () => void; showFolder?: boolean }) {
  const Icon = PROTOCOL_ICON[s.protocol];
  return (
    <div
      className={cx('tree-item', 'tree-site', selected && 'selected')}
      style={{ paddingLeft: 8 + depth * 16 }}
      role="treeitem"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-testid={`site-${s.name}`}
      onClick={onSelect}
      onDoubleClick={onOpen}
    >
      <span className="session-dot" style={{ background: s.color || 'transparent', borderColor: s.color || undefined }} />
      <Icon size={14} className="tree-icon" />
      <span className="tree-label">
        <span className="tree-name">{s.name}</span>
        <span className="tree-sub">{showFolder && s.folder ? `${s.folder} · ` : ''}{siteSubtitle(s)}</span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------- main dialog

export default function SiteManager({ props, close }: { props: DialogPropsMap['siteManager']; close: () => void }) {
  const t = useT();
  const info = useApp((s) => s.info);
  const narrow = useApp((s) => s.narrow);
  const [sites, setSites] = useState<SiteConfig[] | null>(null);
  const [extraFolders, setExtraFolders] = useState<string[]>(() => load('siteFolders', []));
  const [expanded, setExpanded] = useState<Record<string, boolean>>(() => load('siteTreeOpen', {}));
  const [sel, setSel] = useState<Sel>(null);
  const [draft, setDraft] = useState<SiteConfig | null>(null);
  const [original, setOriginal] = useState<SiteConfig | null>(null);
  const [tab, setTab] = useState<FormTab>('session');
  const [filter, setFilter] = useState('');
  const [quick, setQuick] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [more, setMore] = useState<DOMRect | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [exportText, setExportText] = useState<string | null>(null);
  const [mobileForm, setMobileForm] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  const dirty = useMemo(() => !!draft && JSON.stringify(draft) !== JSON.stringify(original), [draft, original]);
  const protocols = (info?.features.protocols ?? ['sftp', 'scp', 'ftp', 'webdav', 's3', 'azure', 'gcs', 'rcmd']).filter((p) => p !== 'local');

  const reload = async (selectId?: string) => {
    try {
      const list = await call('sites.list');
      setSites(list);
      if (selectId) {
        const s = list.find((x) => x.id === selectId);
        if (s) {
          setSel({ type: 'site', id: s.id });
          setDraft(clone(s));
          setOriginal(clone(s));
          if (s.folder) setExpanded((e) => openFolderChain(e, s.folder));
        }
      }
      return list;
    } catch (e) {
      toast.error(e);
      setSites([]);
      return [];
    }
  };

  useEffect(() => {
    void reload(props.siteId).then((list) => {
      if (props.draft) {
        setSel({ type: 'new' });
        setDraft(clone(props.draft));
        setOriginal(null);
      } else if (!props.siteId && list.length && !narrow) {
        const last = load<string | null>('lastSite', null);
        const s = list.find((x) => x.id === last) ?? null;
        if (s) {
          setSel({ type: 'site', id: s.id });
          setDraft(clone(s));
          setOriginal(clone(s));
          if (s.folder) setExpanded((e) => openFolderChain(e, s.folder));
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => save('siteTreeOpen', expanded), [expanded]);
  useEffect(() => save('siteFolders', extraFolders), [extraFolders]);

  const tree = useMemo(() => buildTree(sites ?? [], extraFolders), [sites, extraFolders]);
  const folders = useMemo(() => {
    const out: string[] = [];
    const walk = (n: FolderNode) => n.folders.forEach((f) => (out.push(f.path), walk(f)));
    walk(tree);
    return out;
  }, [tree]);

  const confirmDiscard = async () => !dirty || (await confirmDialog({ title: t('site.unsavedTitle'), message: t('site.unsavedText', { name: draft?.name || t('site.newSite') }), okLabel: t('site.discard'), danger: true }));

  const selectSite = async (s: SiteConfig) => {
    if (sel?.type === 'site' && sel.id === s.id) {
      if (narrow) setMobileForm(true);
      return;
    }
    if (!(await confirmDiscard())) return;
    setSel({ type: 'site', id: s.id });
    setDraft(clone(s));
    setOriginal(clone(s));
    save('lastSite', s.id);
    if (narrow) setMobileForm(true);
  };

  const selectFolder = async (path: string) => {
    if (!(await confirmDiscard())) return;
    setSel({ type: 'folder', path });
    setDraft(null);
    setOriginal(null);
  };

  const currentFolder = sel?.type === 'folder' ? sel.path : draft?.folder ?? '';

  const newSite = async (protocol: Protocol = 'sftp') => {
    if (!(await confirmDiscard())) return;
    try {
      const tpl = await call('sites.template', { protocol });
      tpl.folder = currentFolder;
      setSel({ type: 'new' });
      setDraft(tpl);
      setOriginal(null);
      setTab('session');
      if (narrow) setMobileForm(true);
      setTimeout(() => document.querySelector<HTMLInputElement>('#site-host')?.focus(), 30);
    } catch (e) {
      toast.error(e);
    }
  };

  const newFolder = async () => {
    const name = await inputDialog({ title: t('site.newFolder'), label: t('site.folderName'), hint: currentFolder ? t('site.inFolder', { folder: currentFolder }) : undefined, validate: (v) => (v.trim() && !v.includes('/') ? null : t('ops.invalidName')) });
    if (!name) return;
    const path = currentFolder ? `${currentFolder}/${name.trim()}` : name.trim();
    setExtraFolders((f) => [...new Set([...f, path])]);
    setExpanded((e) => ({ ...openFolderChain(e, path) }));
    setSel({ type: 'folder', path });
    setDraft(null);
    setOriginal(null);
  };

  const saveSite = async (asNew = false): Promise<SiteConfig | null> => {
    if (!draft) return null;
    let site = clone(draft);
    let newName: string | null = null;
    if (asNew) {
      newName = await inputDialog({ title: t('site.saveAs'), label: t('site.name'), value: draft.name ? `${draft.name} (2)` : '', okLabel: t('common.save') });
      if (!newName) return null;
      site = { ...site, id: '', name: newName.trim() };
    }
    if (!site.name.trim()) site.name = site.username && site.host ? `${site.username}@${site.host}` : site.host || site.s3.bucket || t('site.newSite');
    setBusy('save');
    try {
      // Stored secrets arrive as placeholders that only resolve against their own site: save
      // the copy over a duplicate of the original so passwords and keys are kept.
      if (newName && draft.id && JSON.stringify(site).includes(SECRET_PLACEHOLDER)) {
        site.id = (await call('sites.duplicate', { id: draft.id })).id;
      }
      const saved = await call('sites.save', { site });
      await reload(saved.id);
      setExtraFolders((f) => f.filter((x) => x !== saved.folder));
      toast.success(t('site.saved', { name: saved.name }));
      return saved;
    } catch (e) {
      toast.error(e, t('common.save'));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const login = async () => {
    if (!draft) return;
    setBusy('login');
    const params = draft.id && !dirty ? { siteId: draft.id } : { site: draft };
    if (draft.id) save('lastSite', draft.id);
    close();
    await connect(params, draft.name || draft.host);
  };

  const quickConnect = async () => {
    const url = quick.trim();
    if (!url) return;
    close();
    await connect({ url }, url);
  };

  const quickFill = async () => {
    const url = quick.trim();
    if (!url || !(await confirmDiscard())) return;
    try {
      const s = await call('sites.fromUrl', { url });
      s.id = '';
      s.folder = currentFolder;
      setSel({ type: 'new' });
      setDraft(s);
      setOriginal(null);
      if (narrow) setMobileForm(true);
    } catch (e) {
      toast.error(e);
    }
  };

  const deleteSelected = async () => {
    if (!sites) return;
    if (sel?.type === 'site') {
      const s = sites.find((x) => x.id === sel.id);
      if (!s || !(await confirmDialog({ title: t('site.deleteTitle'), message: t('site.deleteSite', { name: s.name }), okLabel: t('common.delete'), danger: true }))) return;
      try {
        await call('sites.delete', { id: s.id });
        setSel(null);
        setDraft(null);
        setOriginal(null);
        await reload();
      } catch (e) {
        toast.error(e);
      }
    } else if (sel?.type === 'folder') {
      const inside = sites.filter((s) => s.folder === sel.path || s.folder.startsWith(sel.path + '/'));
      if (inside.length && !(await confirmDialog({ title: t('site.deleteTitle'), message: t('site.deleteFolder', { name: sel.path, n: inside.length }), okLabel: t('common.delete'), danger: true }))) return;
      try {
        for (const s of inside) await call('sites.delete', { id: s.id });
      } catch (e) {
        toast.error(e);
      }
      setExtraFolders((f) => f.filter((x) => x !== sel.path && !x.startsWith(sel.path + '/')));
      setSel(null);
      await reload();
    } else if (sel?.type === 'new') {
      setSel(null);
      setDraft(null);
      setOriginal(null);
    }
  };

  const duplicate = async () => {
    if (sel?.type !== 'site') return;
    try {
      const s = await call('sites.duplicate', { id: sel.id });
      await reload(s.id);
    } catch (e) {
      toast.error(e);
    }
  };

  const renameFolder = async () => {
    const from = sel?.type === 'folder' ? sel.path : null;
    if (!from) return;
    const parts = from.split('/');
    const name = await inputDialog({ title: t('site.renameFolder'), label: t('site.folderName'), value: parts[parts.length - 1], validate: (v) => (v.trim() && !v.includes('/') ? null : t('ops.invalidName')) });
    if (!name) return;
    const to = [...parts.slice(0, -1), name.trim()].join('/');
    try {
      await call('sites.renameFolder', { from, to });
      setExtraFolders((f) => f.map((x) => (x === from ? to : x.startsWith(from + '/') ? to + x.slice(from.length) : x)));
      setSel({ type: 'folder', path: to });
      setExpanded((e) => ({ ...e, [to]: true }));
      await reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const exportSites = async () => {
    const ids = sel?.type === 'folder' ? (sites ?? []).filter((s) => s.folder === sel.path || s.folder.startsWith(sel.path + '/')).map((s) => s.id) : null;
    try {
      const r = await call('sites.export', { ids });
      setExportText(r.content);
    } catch (e) {
      toast.error(e);
    }
  };

  const moreItems = (): MenuItem[] => [
    { label: t('site.duplicate'), icon: Copy, disabled: sel?.type !== 'site', onClick: () => void duplicate() },
    { label: t('site.renameFolder'), icon: FolderPen, disabled: sel?.type !== 'folder', onClick: () => void renameFolder() },
    { label: t('common.delete'), icon: Trash2, danger: true, disabled: !sel, onClick: () => void deleteSelected() },
    { separator: true },
    { label: t('site.import'), icon: Upload, onClick: () => setImportOpen(true) },
    { label: sel?.type === 'folder' ? t('site.exportFolder') : t('site.exportAll'), icon: Download, onClick: () => void exportSites() },
  ];

  // ------------------------------------------------ tree rendering

  const q = filter.trim().toLowerCase();
  const matches = useMemo(
    () => (q ? (sites ?? []).filter((s) => [s.name, s.host, s.username, s.folder, s.s3.bucket].some((x) => x?.toLowerCase().includes(q))) : []),
    [q, sites],
  );

  const renderFolder = (n: FolderNode, depth: number): JSX.Element[] => {
    const out: JSX.Element[] = [];
    for (const f of n.folders) {
      const open = expanded[f.path] ?? depth === 0;
      const selected = sel?.type === 'folder' && sel.path === f.path;
      out.push(
        <div
          key={`f:${f.path}`}
          className={cx('tree-item', 'tree-folder', selected && 'selected')}
          style={{ paddingLeft: 4 + depth * 16 }}
          role="treeitem"
          aria-expanded={open}
          aria-selected={selected}
          onClick={() => void selectFolder(f.path)}
          onDoubleClick={() => setExpanded((e) => ({ ...e, [f.path]: !open }))}
        >
          <button
            type="button"
            className="tree-toggle"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((x) => ({ ...x, [f.path]: !open }));
            }}
            aria-label={open ? t('common.collapse') : t('common.expand')}
          >
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
          {open ? <FolderOpen size={15} className="fi-dir tree-icon" /> : <Folder size={15} className="fi-dir tree-icon" />}
          <span className="tree-label">
            <span className="tree-name">{f.name}</span>
          </span>
          <span className="tree-count">{countSites(f)}</span>
        </div>,
      );
      if (open) out.push(...renderFolder(f, depth + 1));
    }
    for (const s of n.sites) {
      out.push(<SiteRow key={s.id} s={s} depth={depth} selected={sel?.type === 'site' && sel.id === s.id} onSelect={() => void selectSite(s)} onOpen={() => void selectSite(s).then(() => login())} />);
    }
    return out;
  };

  // keyboard navigation in the tree
  const onTreeKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Enter') return;
    const items = Array.from(treeRef.current?.querySelectorAll<HTMLElement>('.tree-item') ?? []);
    const i = items.findIndex((x) => x.classList.contains('selected'));
    if (e.key === 'Enter') {
      if (sel?.type === 'site') {
        e.preventDefault();
        e.stopPropagation();
        void login();
      }
      return;
    }
    e.preventDefault();
    const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    next?.click();
    next?.focus();
  };

  const tabs: TabDef<FormTab>[] = draft
    ? [
        { id: 'session', label: t('site.tab.session') },
        { id: 'proto', label: protoTabLabel(draft.protocol, t) },
        { id: 'proxy', label: t('site.tab.proxy') },
        { id: 'advanced', label: t('site.tab.advanced') },
        { id: 'notes', label: t('site.tab.notes') },
      ]
    : [];

  const showTree = !narrow || !mobileForm;
  const showForm = !narrow || mobileForm;

  return (
    <Dialog
      title={t('sites.manager')}
      icon={Network}
      onClose={() => void confirmDiscard().then((ok) => ok && close())}
      onSubmit={() => void login()}
      width={980}
      height={680}
      className="site-manager"
      bodyClassName="sm-body"
      noEnterSubmit={!draft}
      footer={
        <>
          <div className="dlg-foot-extra sm-foot-left">
            <Button size="sm" variant="ghost" icon={Upload} onClick={() => setImportOpen(true)}>
              {t('site.import')}
            </Button>
            <Button size="sm" variant="ghost" icon={Download} onClick={() => void exportSites()}>
              {t('site.export')}
            </Button>
          </div>
          <div className="dlg-foot-buttons">
            <Button icon={Save} disabled={!draft || (!dirty && sel?.type !== 'new')} busy={busy === 'save'} onClick={() => void saveSite()} data-testid="site-save">
              {t('common.save')}
            </Button>
            <Button disabled={!draft} onClick={() => void saveSite(true)} className="hide-narrow">
              {t('site.saveAs')}
            </Button>
            <Button variant="primary" icon={LogIn} disabled={!draft} busy={busy === 'login'} onClick={() => void login()} data-testid="site-login">
              {t('site.login')}
            </Button>
            <Button onClick={() => void confirmDiscard().then((ok) => ok && close())}>{t('common.close')}</Button>
          </div>
        </>
      }
    >
      <div className="sm-quick">
        <Zap size={14} className="accent" />
        <input
          className="input sm-quick-input"
          placeholder={t('site.quickPlaceholder')}
          value={quick}
          onChange={(e) => setQuick(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              void quickConnect();
            }
          }}
          spellCheck={false}
          aria-label={t('site.quickConnect')}
          data-testid="quick-connect"
        />
        <Button size="sm" disabled={!quick.trim()} onClick={() => void quickFill()} title={t('site.quickFillHint')}>
          {t('site.quickFill')}
        </Button>
        <Button size="sm" variant="primary" disabled={!quick.trim()} onClick={() => void quickConnect()}>
          {t('site.connect')}
        </Button>
      </div>
      <div className="sm-main">
        {showTree && (
          <div className="sm-tree-pane">
            <div className="sm-search">
              <Search size={13} className="muted" />
              <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('site.search')} aria-label={t('site.search')} onKeyDown={(e) => e.key === 'Escape' && filter && (e.stopPropagation(), setFilter(''))} />
              {filter && (
                <button type="button" className="qf-clear" onClick={() => setFilter('')}>
                  <X size={12} />
                </button>
              )}
            </div>
            <div className="sm-tree" role="tree" ref={treeRef} onKeyDown={onTreeKey} tabIndex={-1}>
              {!sites ? (
                <div className="center-fill">
                  <Spinner />
                </div>
              ) : q ? (
                matches.length ? (
                  matches.map((s) => <SiteRow key={s.id} s={s} depth={0} showFolder selected={sel?.type === 'site' && sel.id === s.id} onSelect={() => void selectSite(s)} onOpen={() => void selectSite(s).then(() => login())} />)
                ) : (
                  <div className="muted small pad">{t('site.noMatch')}</div>
                )
              ) : (
                <>
                  {renderFolder(tree, 0)}
                  {sel?.type === 'new' && (
                    <div className="tree-item tree-site selected" style={{ paddingLeft: 8 }}>
                      <Plus size={14} className="tree-icon" />
                      <span className="tree-label">
                        <span className="tree-name">{draft?.name || t('site.newSite')}</span>
                      </span>
                    </div>
                  )}
                  {sites.length === 0 && sel?.type !== 'new' && <div className="muted small pad">{t('site.noSites')}</div>}
                </>
              )}
            </div>
            <div className="sm-tree-actions">
              <Button size="sm" icon={FilePlus2} onClick={() => void newSite()} data-testid="site-new">
                {t('site.newSite')}
              </Button>
              <IconButton icon={FolderPlus} title={t('site.newFolder')} onClick={() => void newFolder()} />
              <IconButton icon={Trash2} title={t('common.delete')} disabled={!sel} onClick={() => void deleteSelected()} />
              <IconButton ref={moreRef} icon={MoreHorizontal} title={t('common.more')} onClick={() => setMore(moreRef.current!.getBoundingClientRect())} />
            </div>
          </div>
        )}
        {showForm && (
          <div className="sm-form-pane">
            {narrow && (
              <button type="button" className="link-btn sm-back" onClick={() => setMobileForm(false)}>
                <ArrowLeft size={13} /> {t('common.back')}
              </button>
            )}
            {draft ? (
              <>
                <div className="sm-form-head">
                  <span className="session-dot big" style={{ background: draft.color || 'transparent', borderColor: draft.color || undefined }} />
                  <div className="sm-form-title">
                    <div className="sm-form-name">
                      {draft.name || t('site.newSite')}
                      {dirty && <span className="dirty-dot" title={t('site.unsaved')} />}
                    </div>
                    <div className="muted small">{siteSubtitle(draft) || protoTabLabel(draft.protocol, t)}</div>
                  </div>
                </div>
                <Tabs tabs={tabs} value={tab} onChange={setTab} className="sm-tabs" />
                <div className="sm-form">
                  <SiteForm tab={tab} draft={draft} setDraft={setDraft} protocols={protocols} folders={folders} sites={sites ?? []} />
                </div>
              </>
            ) : (
              <EmptyState
                icon={Network}
                title={sel?.type === 'folder' ? sel.path : t('site.selectOrCreate')}
                action={
                  <Button icon={Plus} onClick={() => void newSite()}>
                    {t('site.newSite')}
                  </Button>
                }
              >
                {sel?.type === 'folder' ? t('site.folderHint') : t('site.emptyHint')}
              </EmptyState>
            )}
          </div>
        )}
      </div>
      {more && (
        <>
          <div className="menu-catcher" onMouseDown={() => setMore(null)} />
          <MenuList items={moreItems()} x={more.left} y={more.bottom} anchor={more} onClose={() => setMore(null)} />
        </>
      )}
      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} onDone={(n, firstId) => { setImportOpen(false); toast.success(t('site.imported', { n })); void reload(firstId); }} />}
      {exportText !== null && <ExportDialog content={exportText} onClose={() => setExportText(null)} />}
    </Dialog>
  );
}

function countSites(n: FolderNode): number {
  return n.sites.length + n.folders.reduce((s, f) => s + countSites(f), 0);
}

function openFolderChain(e: Record<string, boolean>, folder: string): Record<string, boolean> {
  const next = { ...e };
  let acc = '';
  for (const seg of folder.split('/').filter(Boolean)) {
    acc = acc ? `${acc}/${seg}` : seg;
    next[acc] = true;
  }
  return next;
}

function protoTabLabel(p: Protocol, t: (k: TKey) => string): string {
  if (p === 'sftp' || p === 'scp') return 'SSH';
  if (p === 'ftp') return 'FTP';
  if (p === 'webdav') return 'WebDAV';
  if (p === 's3') return 'S3';
  if (p === 'azure') return 'Azure';
  if (p === 'gcs') return 'GCS';
  if (p === 'rcmd') return t('proto.rcmd');
  return p;
}

// ---------------------------------------------------------------- form

function SiteForm({ tab, draft, setDraft, protocols, folders, sites }: { tab: FormTab; draft: SiteConfig; setDraft: (s: SiteConfig) => void; protocols: Protocol[]; folders: string[]; sites: SiteConfig[] }) {
  const t = useT();
  const set = <K extends keyof SiteConfig>(k: K, v: SiteConfig[K]) => setDraft({ ...draft, [k]: v });
  const setSub = <K extends 'ssh' | 'ftp' | 'webdav' | 's3' | 'azure' | 'gcs' | 'rcmd' | 'proxy'>(k: K, patch: Partial<SiteConfig[K]>) => setDraft({ ...draft, [k]: { ...draft[k], ...patch } });
  const p = draft.protocol;
  const cloud = p === 's3' || p === 'azure' || p === 'gcs';
  const userLabel = p === 's3' ? t('site.accessKey') : p === 'azure' ? t('site.accountName') : t('site.username');
  const passLabel = p === 's3' ? t('site.secretKey') : p === 'azure' ? t('site.accountKey') : p === 'rcmd' ? t('site.peerPassword') : t('site.password');
  const keyFileInput = useRef<HTMLInputElement>(null);
  const credInput = useRef<HTMLInputElement>(null);

  if (tab === 'session') {
    return (
      <div className="form-grid">
        <Field label={t('site.protocol')} htmlFor="site-proto">
          <Select id="site-proto" value={p} onChange={(e) => setDraft({ ...draft, protocol: e.target.value as Protocol, port: 0 })} data-testid="site-protocol">
            {protocols.map((x) => (
              <option key={x} value={x}>
                {t(`proto.${x}` as TKey)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('site.name')} htmlFor="site-name">
          <TextInput id="site-name" value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder={draft.host || t('site.namePlaceholder')} />
        </Field>
        {!cloud && (
          <>
            <Field label={t('site.host')} htmlFor="site-host" className="grow2">
              <TextInput id="site-host" value={draft.host} onChange={(e) => set('host', e.target.value.trim())} placeholder="example.com" data-testid="site-host" />
            </Field>
            <Field label={t('site.port')} htmlFor="site-port">
              <NumberInput id="site-port" value={draft.port || null} min={0} max={65535} placeholder={String(defaultPort(draft))} onChange={(v) => set('port', Math.max(0, Math.min(65535, v)))} />
            </Field>
          </>
        )}
        {p === 's3' && (
          <>
            <Field label={t('site.bucket')}>
              <TextInput value={draft.s3.bucket} onChange={(e) => setSub('s3', { bucket: e.target.value })} placeholder={t('site.bucketAll')} />
            </Field>
            <Field label={t('site.region')}>
              <TextInput value={draft.s3.region} onChange={(e) => setSub('s3', { region: e.target.value })} placeholder="us-east-1" />
            </Field>
          </>
        )}
        {p === 'azure' && (
          <Field label={t('site.container')} className="span2">
            <TextInput value={draft.azure.container} onChange={(e) => setSub('azure', { container: e.target.value })} />
          </Field>
        )}
        {p === 'gcs' && (
          <Field label={t('site.bucket')} className="span2">
            <TextInput value={draft.gcs.bucket} onChange={(e) => setSub('gcs', { bucket: e.target.value })} />
          </Field>
        )}
        {p !== 'gcs' && !(p === 's3' && draft.s3.anonymous) && (
          <>
            {p !== 'rcmd' && (
              <Field label={userLabel} htmlFor="site-user">
                <TextInput id="site-user" value={draft.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" data-testid="site-user" />
              </Field>
            )}
            <Field label={passLabel} htmlFor="site-pass" className={p === 'rcmd' ? 'span2' : undefined}>
              <SecretField id="site-pass" value={draft.password} onChange={(v) => set('password', v)} testId="site-password" />
            </Field>
          </>
        )}
        <Field label={t('site.remoteDir')} hint={t('site.remoteDirHint')}>
          <TextInput value={draft.remoteDir} onChange={(e) => set('remoteDir', e.target.value)} placeholder={cloud ? '/' : t('site.homePlaceholder')} />
        </Field>
        <Field label={t('site.localDir')} hint={t('site.localDirHint')}>
          <div className="input-with-btn">
            <TextInput value={draft.localDir} onChange={(e) => set('localDir', e.target.value)} />
            {isTauri && (
              <Button size="sm" onClick={() => void pickNativeFile({ directory: true, title: t('site.localDir') }).then((d) => d && set('localDir', d))}>
                …
              </Button>
            )}
          </div>
        </Field>
        <Field label={t('site.folder')}>
          <TextInput value={draft.folder} onChange={(e) => set('folder', e.target.value.replace(/^\/+|\/+$/g, ''))} list="site-folders" placeholder={t('site.rootFolder')} />
          <datalist id="site-folders">
            {folders.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </Field>
        <Field label={t('site.color')}>
          <div className="swatches" role="radiogroup" aria-label={t('site.color')}>
            <button type="button" className={cx('swatch none', !draft.color && 'on')} onClick={() => set('color', null)} title={t('site.noColor')} aria-checked={!draft.color} role="radio" />
            {COLORS.map((c) => (
              <button key={c} type="button" className={cx('swatch', draft.color === c && 'on')} style={{ background: c }} onClick={() => set('color', c)} aria-checked={draft.color === c} role="radio" title={c} />
            ))}
          </div>
        </Field>
      </div>
    );
  }

  if (tab === 'proto') {
    if (p === 'sftp' || p === 'scp') {
      const s = draft.ssh;
      const jumpCandidates = sites.filter((x) => (x.protocol === 'sftp' || x.protocol === 'scp') && x.id !== draft.id);
      return (
        <div className="form-stack">
          <div className="section-title">{t('ssh.auth')}</div>
          <div className="form-grid">
            <Field label={t('ssh.keyFile')} className="span2" hint={t('ssh.keyFileHint')}>
              <div className="input-with-btn">
                <TextInput value={s.privateKeyPath ?? ''} onChange={(e) => setSub('ssh', { privateKeyPath: e.target.value || null })} placeholder="~/.ssh/id_ed25519" />
                {isTauri && (
                  <Button size="sm" onClick={() => void pickNativeFile({ title: t('ssh.keyFile') }).then((f) => f && setSub('ssh', { privateKeyPath: f }))}>
                    {t('common.browse')}
                  </Button>
                )}
              </div>
            </Field>
            <Field label={t('ssh.keyPaste')} className="span2">
              <SecretField multiline value={s.privateKey} onChange={(v) => setSub('ssh', { privateKey: v })} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
              <div className="row gap">
                <button type="button" className="link-btn" onClick={() => keyFileInput.current?.click()}>
                  <FileUp size={12} /> {t('ssh.loadKey')}
                </button>
                <input
                  ref={keyFileInput}
                  type="file"
                  hidden
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) setSub('ssh', { privateKey: await f.text() });
                    e.target.value = '';
                  }}
                />
              </div>
            </Field>
            <Field label={t('ssh.passphrase')} className="span2">
              <SecretField value={s.passphrase} onChange={(v) => setSub('ssh', { passphrase: v })} />
            </Field>
          </div>
          <div className="check-grid">
            <Checkbox label={t('ssh.useAgent')} checked={s.useAgent} onChange={(v) => setSub('ssh', { useAgent: v })} />
            <Checkbox label={t('ssh.tryPassword')} checked={s.tryPassword} onChange={(v) => setSub('ssh', { tryPassword: v })} />
            <Checkbox label={t('ssh.tryKbd')} checked={s.tryKeyboardInteractive} onChange={(v) => setSub('ssh', { tryKeyboardInteractive: v })} />
            <Checkbox label={t('ssh.tryDefaultKeys')} checked={s.tryDefaultKeys} onChange={(v) => setSub('ssh', { tryDefaultKeys: v })} />
          </div>
          <div className="section-title">{t('ssh.connection')}</div>
          <div className="form-grid">
            <Field label={t('ssh.jumpHost')} hint={t('ssh.jumpHint')}>
              <Select value={s.jumpSiteId ?? ''} onChange={(e) => setSub('ssh', { jumpSiteId: e.target.value || null })}>
                <option value="">{t('ssh.noJump')}</option>
                {jumpCandidates.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.folder ? `${x.folder}/` : ''}
                    {x.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('ssh.sftpServer')} hint={t('ssh.sftpServerHint')}>
              <TextInput value={s.sftpServer ?? ''} onChange={(e) => setSub('ssh', { sftpServer: e.target.value || null })} list="sftp-servers" placeholder={t('ssh.sftpDefault')} />
              <datalist id="sftp-servers">
                {SFTP_SERVERS.map((x) => (
                  <option key={x} value={x} />
                ))}
              </datalist>
            </Field>
            {p === 'scp' && (
              <Field label={t('ssh.shell')}>
                <TextInput value={s.shell ?? ''} onChange={(e) => setSub('ssh', { shell: e.target.value || null })} placeholder="/bin/sh" />
              </Field>
            )}
          </div>
          <div className="check-grid">
            <Checkbox label={t('ssh.compression')} checked={s.compression} onChange={(v) => setSub('ssh', { compression: v })} />
            <Checkbox label={t('ssh.opensshKnownHosts')} checked={s.useOpensshKnownHosts} onChange={(v) => setSub('ssh', { useOpensshKnownHosts: v })} />
          </div>
          <div className="section-title">{t('ssh.env')}</div>
          <EnvEditor value={s.env} onChange={(env) => setSub('ssh', { env })} />
        </div>
      );
    }
    if (p === 'ftp') {
      const f = draft.ftp;
      return (
        <div className="form-stack">
          <div className="form-grid">
            <Field label={t('ftp.encryption')}>
              <Select value={f.encryption} onChange={(e) => setSub('ftp', { encryption: e.target.value as FtpEncryption })}>
                <option value="none">{t('ftp.enc.none')}</option>
                <option value="explicit">{t('ftp.enc.explicit')}</option>
                <option value="implicit">{t('ftp.enc.implicit')}</option>
              </Select>
            </Field>
            <Field label={t('ftp.maxConnections')}>
              <NumberInput value={f.maxConnections} min={1} max={16} onChange={(v) => setSub('ftp', { maxConnections: Math.max(1, Math.min(16, v)) })} />
            </Field>
          </div>
          <div className="check-grid">
            <Checkbox label={t('ftp.passive')} checked={f.passive} onChange={(v) => setSub('ftp', { passive: v })} />
            <Checkbox label={t('ftp.mlsd')} checked={f.useMlsd} onChange={(v) => setSub('ftp', { useMlsd: v })} />
            <Checkbox label={t('site.allowInvalidCerts')} checked={f.allowInvalidCerts} onChange={(v) => setSub('ftp', { allowInvalidCerts: v })} />
          </div>
          {f.encryption === 'none' && <p className="warn small">{t('ftp.plainWarning')}</p>}
        </div>
      );
    }
    if (p === 'webdav') {
      const w = draft.webdav;
      return (
        <div className="form-stack">
          <Field label={t('webdav.root')} hint={t('webdav.rootHint')}>
            <TextInput value={w.root} onChange={(e) => setSub('webdav', { root: e.target.value })} placeholder="/remote.php/dav/files/user" />
          </Field>
          <div className="check-grid">
            <Checkbox label={t('webdav.https')} checked={w.https} onChange={(v) => setSub('webdav', { https: v })} />
            <Checkbox label={t('site.allowInvalidCerts')} checked={w.allowInvalidCerts} onChange={(v) => setSub('webdav', { allowInvalidCerts: v })} />
          </div>
        </div>
      );
    }
    if (p === 's3') {
      const s = draft.s3;
      return (
        <div className="form-stack">
          <div className="form-grid">
            <Field label={t('site.region')}>
              <TextInput value={s.region} onChange={(e) => setSub('s3', { region: e.target.value })} placeholder="us-east-1" />
            </Field>
            <Field label={t('site.bucket')}>
              <TextInput value={s.bucket} onChange={(e) => setSub('s3', { bucket: e.target.value })} placeholder={t('site.bucketAll')} />
            </Field>
            <Field label={t('s3.endpoint')} className="span2" hint={t('s3.endpointHint')}>
              <TextInput value={s.endpoint} onChange={(e) => setSub('s3', { endpoint: e.target.value })} placeholder="https://minio.example.com:9000" />
            </Field>
            <Field label={t('s3.sessionToken')} className="span2">
              <SecretField value={s.sessionToken} onChange={(v) => setSub('s3', { sessionToken: v })} />
            </Field>
          </div>
          <div className="check-grid">
            <Checkbox label={t('s3.pathStyle')} checked={s.pathStyle} onChange={(v) => setSub('s3', { pathStyle: v })} />
            <Checkbox label={t('s3.anonymous')} checked={s.anonymous} onChange={(v) => setSub('s3', { anonymous: v })} />
          </div>
        </div>
      );
    }
    if (p === 'azure') {
      const a = draft.azure;
      return (
        <div className="form-grid">
          <Field label={t('azure.account')}>
            <TextInput value={a.account} onChange={(e) => setSub('azure', { account: e.target.value })} placeholder={draft.username} />
          </Field>
          <Field label={t('site.container')}>
            <TextInput value={a.container} onChange={(e) => setSub('azure', { container: e.target.value })} />
          </Field>
          <Field label={t('s3.endpoint')} className="span2" hint={t('azure.endpointHint')}>
            <TextInput value={a.endpoint} onChange={(e) => setSub('azure', { endpoint: e.target.value })} placeholder="http://127.0.0.1:10000/devstoreaccount1" />
          </Field>
          <Field label={t('azure.sas')} className="span2" hint={t('azure.sasHint')}>
            <SecretField value={a.sasToken} onChange={(v) => setSub('azure', { sasToken: v })} />
          </Field>
        </div>
      );
    }
    if (p === 'gcs') {
      const g = draft.gcs;
      return (
        <div className="form-stack">
          <div className="form-grid">
            <Field label={t('site.bucket')}>
              <TextInput value={g.bucket} onChange={(e) => setSub('gcs', { bucket: e.target.value })} />
            </Field>
            <Field label={t('s3.endpoint')}>
              <TextInput value={g.endpoint} onChange={(e) => setSub('gcs', { endpoint: e.target.value })} placeholder="https://storage.googleapis.com" />
            </Field>
          </div>
          <Field label={t('gcs.credentials')} hint={t('gcs.credentialsHint')}>
            <SecretField multiline value={g.credentialJson} onChange={(v) => setSub('gcs', { credentialJson: v })} placeholder='{ "type": "service_account", … }' />
            <button type="button" className="link-btn" onClick={() => credInput.current?.click()}>
              <FileUp size={12} /> {t('gcs.loadJson')}
            </button>
            <input
              ref={credInput}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) setSub('gcs', { credentialJson: await f.text() });
                e.target.value = '';
              }}
            />
          </Field>
        </div>
      );
    }
    if (p === 'rcmd') {
      const r = draft.rcmd;
      return (
        <div className="form-stack">
          <Checkbox label={t('rcmd.tls')} checked={r.tls} onChange={(v) => setSub('rcmd', { tls: v })} />
          <Field label={t('rcmd.fingerprint')} hint={t('rcmd.fingerprintHint')}>
            <TextInput className="mono" value={r.fingerprint ?? ''} onChange={(e) => setSub('rcmd', { fingerprint: e.target.value || null })} placeholder="AB:12:…" disabled={!r.tls} />
          </Field>
        </div>
      );
    }
    return null;
  }

  if (tab === 'proxy') {
    const x = draft.proxy;
    return (
      <div className="form-stack">
        <Field label={t('proxy.type')}>
          <Select value={x.kind} onChange={(e) => setSub('proxy', { kind: e.target.value as ProxyKind })}>
            <option value="none">{t('proxy.none')}</option>
            <option value="socks5">SOCKS5</option>
            <option value="http">HTTP CONNECT</option>
          </Select>
        </Field>
        {x.kind !== 'none' && (
          <div className="form-grid">
            <Field label={t('site.host')} className="grow2">
              <TextInput value={x.host} onChange={(e) => setSub('proxy', { host: e.target.value })} />
            </Field>
            <Field label={t('site.port')}>
              <NumberInput value={x.port || null} placeholder={x.kind === 'socks5' ? '1080' : '3128'} onChange={(v) => setSub('proxy', { port: v })} />
            </Field>
            <Field label={t('site.username')}>
              <TextInput value={x.username} onChange={(e) => setSub('proxy', { username: e.target.value })} />
            </Field>
            <Field label={t('site.password')}>
              <SecretField value={x.password} onChange={(v) => setSub('proxy', { password: v })} />
            </Field>
          </div>
        )}
      </div>
    );
  }

  if (tab === 'advanced') {
    return (
      <div className="form-grid">
        <Field label={t('site.timeout')} hint={t('site.seconds')}>
          <NumberInput value={draft.timeoutSecs} min={1} max={600} onChange={(v) => set('timeoutSecs', Math.max(1, v))} />
        </Field>
        <Field label={t('site.keepalive')} hint={t('site.keepaliveHint')}>
          <NumberInput value={draft.keepaliveSecs} min={0} max={3600} onChange={(v) => set('keepaliveSecs', Math.max(0, v))} />
        </Field>
      </div>
    );
  }

  return (
    <Field label={t('site.notes')}>
      <textarea className="input textarea" rows={10} value={draft.notes} onChange={(e) => set('notes', e.target.value)} placeholder={t('site.notesPlaceholder')} />
    </Field>
  );
}

function EnvEditor({ value, onChange }: { value: [string, string][]; onChange: (v: [string, string][]) => void }) {
  const t = useT();
  return (
    <div className="env-editor">
      {value.map(([k, v], i) => (
        <div key={i} className="env-row">
          <TextInput className="mono" value={k} placeholder="NAME" onChange={(e) => onChange(value.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} />
          <span className="muted">=</span>
          <TextInput className="mono" value={v} placeholder={t('ssh.envValue')} onChange={(e) => onChange(value.map((x, j) => (j === i ? [x[0], e.target.value] : x)))} />
          <IconButton icon={X} size={13} title={t('common.remove')} onClick={() => onChange(value.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Button size="sm" variant="ghost" icon={Plus} onClick={() => onChange([...value, ['', '']])}>
        {t('ssh.addEnv')}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------- import / export

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: (n: number, firstId?: string) => void }) {
  const t = useT();
  const [format, setFormat] = useState<ImportFormat>('openssh');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const submit = async () => {
    setBusy(true);
    try {
      const r = await call('sites.import', { format, content: content.trim() ? content : format === 'openssh' ? null : '' });
      onDone(r.imported, r.sites[0]?.id);
    } catch (e) {
      toast.error(e, t('site.import'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title={t('site.import')} icon={Upload} onClose={onClose} onSubmit={() => void submit()} width={560} noEnterSubmit footer={<div className="dlg-foot-buttons"><Button variant="primary" busy={busy} onClick={() => void submit()} disabled={format !== 'openssh' && !content.trim()}>{t('site.importNow')}</Button><Button onClick={onClose}>{t('common.cancel')}</Button></div>}>
      <Field label={t('site.importFormat')}>
        <Select value={format} onChange={(e) => setFormat(e.target.value as ImportFormat)}>
          <option value="openssh">{t('import.openssh')}</option>
          <option value="filezilla">{t('import.filezilla')}</option>
          <option value="json">{t('import.json')}</option>
        </Select>
      </Field>
      <div className="row gap">
        <Button size="sm" icon={FileUp} onClick={() => fileRef.current?.click()}>
          {t('site.chooseFile')}
        </Button>
        <span className="muted small">{format === 'openssh' && !content ? t('import.opensshDefault') : t('import.orPaste')}</span>
        <input
          ref={fileRef}
          type="file"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) setContent(await f.text());
            e.target.value = '';
          }}
        />
      </div>
      <textarea className="input textarea mono small" rows={10} value={content} onChange={(e) => setContent(e.target.value)} placeholder={t(`import.placeholder.${format}`)} spellCheck={false} />
    </Dialog>
  );
}

function ExportDialog({ content, onClose }: { content: string; onClose: () => void }) {
  const t = useT();
  const download = () => {
    const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'rust-commander-sites.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };
  return (
    <Dialog title={t('site.export')} icon={Download} onClose={onClose} onSubmit={onClose} width={620} footer={<div className="dlg-foot-buttons"><Button icon={Copy} onClick={() => void copyText(content, t('site.exportCopied'))}>{t('common.copy')}</Button><Button icon={Download} onClick={download}>{t('common.download')}</Button><Button variant="primary" onClick={onClose}>{t('common.close')}</Button></div>}>
      <p className="muted small">{t('site.exportHint')}</p>
      <textarea className="input textarea mono small" rows={16} readOnly value={content} />
    </Dialog>
  );
}
