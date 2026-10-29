// Lazy chunk: CodeMirror 6 editor + viewer for images / PDFs / binary files.
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { gotoLine, openSearchPanel } from '@codemirror/search';
import { openLintPanel } from '@codemirror/lint';
import { toggleComment } from '@codemirror/commands';
import {
  ArrowDownAZ, Braces, CaseLower, CaseUpper, ClipboardCopy, Download, Edit3, Eraser, ExternalLink, Eye, FileCode, FileWarning, FolderOpen,
  GitCompare, IndentIncrease, ListFilter, LocateFixed, Maximize, MessageSquareCode, Minimize, Minimize2, Pilcrow, Plus, RefreshCw, Save,
  Search, WandSparkles, Wrench, WrapText, X, ZoomIn, ZoomOut, CircleX, TriangleAlert, Info, Columns2,
} from 'lucide-react';
import { useT } from '../../i18n';
import { formatBytes, formatDate } from '../../lib/format';
import { LANGUAGE_NAMES, detectLanguage, setLanguageOverride } from '../../lib/editor/languages';
import { load, save } from '../../lib/storage';
import * as P from '../../lib/paths';
import { sessionById, setActiveSide, useApp } from '../../store/app';
import { openDialog } from '../../store/dialogs';
import {
  closeAllTabs, closeTab, compareWithServer, getContent, openFile, reloadTab, setActiveTab, setEditorVisible, setTabOptions, useEditors,
  useEditorStatus, type EditorTab,
} from '../../store/editors';
import { getPanel, navigate, other, type Side } from '../../store/panels';
import { copyText } from '../../actions/fileOps';
import { keyLabel } from '../../actions/shortcuts';
import { showContextMenu, type MenuItem } from '../Menu';
import { Badge, Button, EmptyState, IconButton, Spinner, TextInput, cx } from '../ui';
import { formatDocument, formatterOf, saveWithFormat, setIndent, textTools, viewOf, zoomEditor } from './editorActions';
import { TextEditor } from './TextEditor';

function ImageViewer({ tab }: { tab: EditorTab }) {
  const t = useT();
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const z = zoom === 'fit' ? null : zoom;
  return (
    <div className="image-viewer">
      <div className="iv-toolbar">
        <IconButton icon={ZoomOut} title={t('viewer.zoomOut')} onClick={() => setZoom(Math.max(0.1, (z ?? 1) / 1.25))} />
        <span className="iv-zoom">{z ? `${Math.round(z * 100)}%` : ''}</span>
        <IconButton icon={ZoomIn} title={t('viewer.zoomIn')} onClick={() => setZoom(Math.min(16, (z ?? 1) * 1.25))} />
        <Button size="sm" variant="ghost" onClick={() => setZoom('fit')} icon={Minimize2}>
          {t('viewer.fit')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setZoom(1)} icon={Maximize}>
          100%
        </Button>
        {natural && <span className="muted small">{natural.w} × {natural.h} px</span>}
      </div>
      <div className={cx('iv-canvas', zoom === 'fit' && 'fit')} onWheel={(e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        setZoom(Math.max(0.1, Math.min(16, (z ?? 1) * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
      }}>
        {tab.dataUrl && (
          <img
            src={tab.dataUrl}
            alt={tab.name}
            onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
            style={z && natural ? { width: natural.w * z, height: natural.h * z } : undefined}
            draggable={false}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- language picker

function LanguagePicker({ tab, anchor, onClose }: { tab: EditorTab; anchor: DOMRect; onClose: () => void }) {
  const t = useT();
  const [q, setQ] = useState('');
  const [idx, setIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const items: { value: string | null; label: string }[] = [
    { value: null, label: t('editor.lang.auto') },
    { value: '', label: t('editor.lang.plain') },
    ...LANGUAGE_NAMES.map((n) => ({ value: n, label: n })),
  ].filter((x) => !q || x.label.toLowerCase().includes(q.toLowerCase()));
  const pick = (value: string | null) => {
    setLanguageOverride(tab.name, value);
    // null: back to automatic detection
    const language = value === null ? (detectLanguage(tab.name, tab.path, getContent(tab.id))?.name ?? null) : value || null;
    setTabOptions(tab.id, { language });
    onClose();
  };
  useEffect(() => {
    listRef.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }, [idx]);
  const style = { left: Math.max(8, Math.min(anchor.left, window.innerWidth - 268)), bottom: window.innerHeight - anchor.top + 4 };
  return (
    <>
      <div className="menu-catcher" onMouseDown={onClose} />
      <div className="lang-picker" style={style} data-testid="lang-picker">
        <TextInput
          autoFocus
          value={q}
          placeholder={t('editor.lang.filter')}
          onChange={(e) => {
            setQ(e.target.value);
            setIdx(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') setIdx((i) => Math.min(items.length - 1, i + 1));
            else if (e.key === 'ArrowUp') setIdx((i) => Math.max(0, i - 1));
            else if (e.key === 'Enter' && items[idx]) pick(items[idx].value);
            else if (e.key === 'Escape') onClose();
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        />
        <div className="lang-list" ref={listRef}>
          {items.map((x, i) => (
            <button type="button" key={x.label} className={cx('lang-item', i === idx && 'on', (x.value ?? '') === (tab.language ?? '') && x.value !== null && 'current')} onMouseEnter={() => setIdx(i)} onClick={() => pick(x.value)}>
              {x.label}
            </button>
          ))}
        </div>
        <div className="lang-hint muted small">{t('editor.lang.remember', { ext: P.splitExt(tab.name)[1] || tab.name })}</div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- status bar

function StatusBar({ tab, onLanguage }: { tab: EditorTab; onLanguage: (r: DOMRect) => void }) {
  const t = useT();
  const st = useEditorStatus();
  const [formatter, setFormatter] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void formatterOf(tab).then((f) => alive && setFormatter(f?.label ?? null));
    return () => {
      alive = false;
    };
  }, [tab.language, tab.name]); // eslint-disable-line react-hooks/exhaustive-deps
  const menuAt = (e: MouseEvent<HTMLButtonElement>, items: MenuItem[]) => {
    const r = e.currentTarget.getBoundingClientRect();
    showContextMenu(r.left, r.top - 4, items);
  };
  const ro = tab.readOnly;
  const indentMenu = (e: MouseEvent<HTMLButtonElement>) =>
    menuAt(e, [
      { label: t('editor.indent.spaces'), checked: !tab.indent.tabs, onClick: () => setIndent(tab.id, false, tab.indent.size, false) },
      { label: t('editor.indent.tabs'), checked: tab.indent.tabs, onClick: () => setIndent(tab.id, true, tab.indent.size, false) },
      { separator: true },
      ...[2, 4, 8].map((n) => ({ label: t('editor.indent.width', { n }), checked: tab.indent.size === n, onClick: () => setIndent(tab.id, tab.indent.tabs, n, false) })),
      { separator: true },
      { label: t('editor.indent.toSpaces'), disabled: ro, onClick: () => setIndent(tab.id, false, tab.indent.size, true) },
      { label: t('editor.indent.toTabs'), disabled: ro, onClick: () => setIndent(tab.id, true, tab.indent.size, true) },
    ]);
  const eolMenu = (e: MouseEvent<HTMLButtonElement>) =>
    menuAt(e, [
      { header: true, label: t('editor.eol.title') },
      { label: 'LF (Linux, macOS)', checked: tab.eol === '\n', disabled: ro, onClick: () => setTabOptions(tab.id, { eol: '\n' }) },
      { label: 'CRLF (Windows)', checked: tab.eol === '\r\n', disabled: ro, onClick: () => setTabOptions(tab.id, { eol: '\r\n' }) },
    ]);
  const encMenu = (e: MouseEvent<HTMLButtonElement>) =>
    menuAt(e, [
      { header: true, label: t('editor.enc.title') },
      { label: 'UTF-8', checked: tab.encoding === 'utf-8' && !tab.bom, disabled: ro, onClick: () => setTabOptions(tab.id, { encoding: 'utf-8', bom: false }) },
      { label: 'UTF-8 BOM', checked: tab.encoding === 'utf-8' && tab.bom, disabled: ro, onClick: () => setTabOptions(tab.id, { encoding: 'utf-8', bom: true }) },
      { label: 'ISO-8859-1 (Latin-1)', checked: tab.encoding === 'latin1', disabled: ro, onClick: () => setTabOptions(tab.id, { encoding: 'latin1', bom: false }) },
    ]);
  const problems = st.errors + st.warnings + st.infos;
  return (
    <div className="editor-status" data-testid="editor-status">
      <button type="button" className="es-item" title={t('editor.goToLine')} onClick={() => {
        const v = viewOf(tab.id);
        if (v) gotoLine(v);
      }}>
        {t('editor.position', { line: st.line, col: st.col })}
        {st.selected > 0 && <span className="muted"> {t('editor.selected', { n: st.selected })}</span>}
        {st.selections > 1 && <span className="muted"> · {t('editor.cursors', { n: st.selections })}</span>}
      </button>
      <button type="button" className={cx('es-item', st.errors > 0 && 'err', !st.errors && st.warnings > 0 && 'warn')} title={t('editor.problems')} onClick={() => {
        const v = viewOf(tab.id);
        if (v) openLintPanel(v);
      }} data-testid="editor-problems">
        <CircleX size={13} /> {st.errors}
        <TriangleAlert size={13} /> {st.warnings}
        {st.infos > 0 && (
          <>
            <Info size={13} /> {st.infos}
          </>
        )}
        {problems === 0 && <span className="muted">{t('editor.noProblems')}</span>}
      </button>
      <div className="flex1" />
      <button type="button" className="es-item" onClick={indentMenu} title={t('editor.indent.title')}>
        {tab.indent.tabs ? t('editor.indent.tabsN', { n: tab.indent.size }) : t('editor.indent.spacesN', { n: tab.indent.size })}
      </button>
      <button type="button" className="es-item" onClick={eolMenu} title={tab.eolMixed ? t('editor.eol.mixed') : t('editor.eol.title')} data-testid="editor-eol">
        {tab.eol === '\r\n' ? 'CRLF' : 'LF'}
        {tab.eolMixed && <TriangleAlert size={12} className="warn" />}
      </button>
      <button type="button" className="es-item" onClick={encMenu} title={t('editor.enc.title')}>
        {tab.encoding === 'latin1' ? 'Latin-1' : tab.bom ? 'UTF-8 BOM' : 'UTF-8'}
      </button>
      <button type="button" className="es-item" onClick={(e) => onLanguage(e.currentTarget.getBoundingClientRect())} title={t('editor.lang.title')} data-testid="editor-language">
        {tab.language ?? t('editor.lang.plain')}
      </button>
      {formatter && (
        <span className="es-item static muted hide-narrow" title={t('editor.formatWith', { formatter })}>
          <WandSparkles size={12} /> {formatter}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- window

function showInPanel(tab: EditorTab) {
  const st = useApp.getState();
  const side: Side = getPanel(st.activeSide).session === tab.session ? st.activeSide : getPanel(other(st.activeSide)).session === tab.session ? other(st.activeSide) : st.activeSide;
  void navigate(side, tab.session, P.dirname(tab.path), { select: tab.name });
  setActiveSide(side);
  setEditorVisible(false);
}

/** The file with the same name in the panel the editor's file is not shown in. */
function otherPanelFile(tab: EditorTab): { session: string; path: string } | null {
  for (const side of ['left', 'right'] as Side[]) {
    const p = getPanel(side);
    const path = P.join(p.path, tab.name);
    if ((p.session !== tab.session || path !== tab.path) && p.entries.some((e) => e.name === tab.name && e.kind !== 'dir')) return { session: p.session, path };
  }
  return null;
}

export default function EditorWindow() {
  const t = useT();
  const tabs = useEditors((s) => s.tabs);
  const activeId = useEditors((s) => s.active);
  const settingsWrap = useApp((s) => s.settings?.editor.wordWrap ?? false);
  const info = useApp((s) => s.info);
  const [wrap, setWrap] = useState(settingsWrap);
  const [whitespace, setWhitespace] = useState(() => load('editorWhitespace', false));
  const [changes, setChanges] = useState<Record<string, boolean>>({});
  const [picker, setPicker] = useState<DOMRect | null>(null);
  const tab = tabs.find((x) => x.id === activeId) ?? tabs[0];
  const session = tab ? sessionById(tab.session) : undefined;
  const openFileDialog = () => openDialog('openFile', tab ? { session: tab.session, dir: P.dirname(tab.path) } : {});

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const mod = e.ctrlKey || e.metaKey;
      if (document.querySelector('.dlg-backdrop')) return;
      if (mod && e.key.toLowerCase() === 's' && tab) {
        e.preventDefault();
        void saveWithFormat(tab.id);
      } else if (mod && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        openFileDialog();
      } else if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest?.('.cm-panels, .dlg, .lang-picker')) {
        e.preventDefault();
        setEditorVisible(false);
      } else if (mod && e.key === 'F4' && tab) {
        e.preventDefault();
        void closeTab(tab.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  if (!tab) return null;
  const view = () => viewOf(tab.id);
  const isText = tab.kind === 'text' && !tab.loading && !tab.error;
  const download = async () => {
    const { downloadToComputer } = await import('../../api/web');
    await downloadToComputer(tab.session, [{ name: tab.name, path: tab.path, kind: 'file', size: tab.size }]);
  };
  const external = async () => {
    const { externalEdit } = await import('../../actions/fileOps');
    const side = getPanel('left').session === tab.session ? 'left' : 'right';
    await externalEdit(side, { name: tab.name, path: tab.path, kind: 'file', size: tab.size, hidden: false });
  };
  const toggleWhitespace = () => {
    save('editorWhitespace', !whitespace);
    setWhitespace(!whitespace);
  };
  const run = (fn: (v: NonNullable<ReturnType<typeof view>>) => void) => () => {
    const v = view();
    if (v) {
      fn(v);
      v.focus();
    }
  };
  const json = tab.language === 'JSON';
  const ro = tab.readOnly;
  const toolsMenu = (e: MouseEvent<HTMLButtonElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const peer = otherPanelFile(tab);
    showContextMenu(r.left, r.bottom + 2, [
      { label: t('editor.format'), icon: WandSparkles, shortcut: keyLabel('Shift+Alt+F'), disabled: ro, onClick: () => void formatDocument(tab.id) },
      { label: t('editor.tools.comment'), icon: MessageSquareCode, shortcut: keyLabel('Ctrl+/'), disabled: ro, onClick: run((v) => toggleComment(v)) },
      { separator: true },
      { label: t('editor.tools.sortLines'), icon: ArrowDownAZ, disabled: ro, onClick: run((v) => textTools.sortLines(v)) },
      { label: t('editor.tools.sortLinesDesc'), disabled: ro, onClick: run((v) => textTools.sortLines(v, true)) },
      { label: t('editor.tools.uniqueLines'), icon: ListFilter, disabled: ro, onClick: run((v) => textTools.uniqueLines(v)) },
      { label: t('editor.tools.trimTrailing'), icon: Eraser, disabled: ro, onClick: run((v) => textTools.trimTrailing(v)) },
      { label: t('editor.tools.upper'), icon: CaseUpper, disabled: ro, onClick: run((v) => textTools.upperCase(v)) },
      { label: t('editor.tools.lower'), icon: CaseLower, disabled: ro, onClick: run((v) => textTools.lowerCase(v)) },
      { label: t('editor.tools.reindent'), icon: IndentIncrease, disabled: ro, onClick: run((v) => textTools.convertIndentation(v, tab)) },
      { separator: true, hidden: !json },
      { label: t('editor.tools.sortKeys'), icon: Braces, hidden: !json, disabled: ro, onClick: run((v) => textTools.sortJsonKeys(v, tab)) },
      { label: t('editor.tools.minify'), icon: Minimize, hidden: !json, disabled: ro, onClick: run((v) => textTools.minifyJson(v)) },
      { separator: true },
      { label: t('editor.compareServer'), icon: GitCompare, onClick: () => compareWithServer(tab.id) },
      {
        label: t('editor.compareOther'),
        icon: Columns2,
        disabled: !peer,
        onClick: () =>
          peer &&
          openDialog('diff', {
            left: { label: `${sessionById(peer.session)?.name ?? peer.session}: ${peer.path}`, session: peer.session, path: peer.path, fileName: tab.name },
            right: { label: t('diff.inEditor'), text: getContent(tab.id), fileName: tab.name },
          }),
      },
      { separator: true },
      { label: t('editor.showInPanel'), icon: LocateFixed, onClick: () => showInPanel(tab) },
      { label: t('ops.copyPath'), icon: ClipboardCopy, onClick: () => void copyText(tab.path) },
      { separator: true },
      { label: t('editor.zoomIn'), icon: ZoomIn, shortcut: keyLabel('Ctrl+='), onClick: () => zoomEditor(1) },
      { label: t('editor.zoomOut'), icon: ZoomOut, shortcut: keyLabel('Ctrl+-'), onClick: () => zoomEditor(-1) },
      { label: t('editor.zoomReset'), shortcut: keyLabel('Ctrl+0'), onClick: () => zoomEditor(0) },
    ]);
  };

  return (
    <div className="editor-overlay" role="dialog" aria-label={t('editor.title')} data-testid="editor">
      <div className="editor-tabs">
        {tabs.map((x) => (
          <div key={x.id} className={cx('editor-tab', x.id === tab.id && 'on')} onClick={() => setActiveTab(x.id)} onAuxClick={(e) => e.button === 1 && void closeTab(x.id)} title={`${sessionById(x.session)?.name ?? x.session}: ${x.path}`}>
            {x.mode === 'view' ? <Eye size={13} /> : <FileCode size={13} />}
            <span className="editor-tab-name">{x.name}</span>
            {x.dirty && <span className="dirty-dot" title={t('editor.modified')} />}
            <button type="button" className="editor-tab-close" onClick={(e) => { e.stopPropagation(); void closeTab(x.id); }} aria-label={t('common.close')}>
              <X size={12} />
            </button>
          </div>
        ))}
        <IconButton icon={Plus} title={t('openFile.title')} shortcut={keyLabel('Ctrl+P')} onClick={openFileDialog} data-testid="editor-open-file" />
        <div className="flex1" />
        <IconButton icon={Minimize2} title={t('editor.minimize')} shortcut="Esc" onClick={() => setEditorVisible(false)} />
        <IconButton icon={X} title={t('editor.closeAll')} onClick={() => void closeAllTabs()} />
      </div>
      <div className="editor-toolbar">
        {tab.kind === 'text' && !ro && (
          <Button size="sm" variant={tab.dirty ? 'primary' : 'default'} icon={Save} busy={tab.saving} disabled={!tab.dirty} onClick={() => void saveWithFormat(tab.id)} data-testid="editor-save">
            {t('editor.save')}
          </Button>
        )}
        {tab.mode === 'view' && tab.kind === 'text' && (
          <Button size="sm" icon={Edit3} onClick={() => void openFile(tab.session, { name: tab.name, path: tab.path, size: tab.size }, 'edit')}>
            {t('ops.edit')}
          </Button>
        )}
        <IconButton icon={RefreshCw} title={t('editor.reload')} onClick={() => void reloadTab(tab.id)} />
        {isText && (
          <>
            <IconButton icon={Search} title={t('editor.find')} shortcut={keyLabel('Ctrl+F')} onClick={run((v) => openSearchPanel(v))} />
            <IconButton icon={WandSparkles} title={t('editor.format')} shortcut={keyLabel('Shift+Alt+F')} disabled={ro} onClick={() => void formatDocument(tab.id)} data-testid="editor-format" />
            <IconButton icon={GitCompare} title={t('editor.showChanges')} active={!!changes[tab.id]} onClick={() => setChanges({ ...changes, [tab.id]: !changes[tab.id] })} data-testid="editor-changes" />
            <IconButton icon={WrapText} title={t('editor.wordWrap')} active={wrap} onClick={() => setWrap(!wrap)} />
            <IconButton icon={Pilcrow} title={t('editor.whitespace')} active={whitespace} onClick={toggleWhitespace} />
            <IconButton icon={Wrench} title={t('editor.tools')} onClick={toolsMenu} data-testid="editor-tools" />
          </>
        )}
        {info?.mode === 'web' && <IconButton icon={Download} title={t('web.download')} onClick={() => void download()} />}
        {info?.mode === 'desktop' && info.features.externalEdit && tab.session !== 'local' && <IconButton icon={ExternalLink} title={t('ops.editExternal')} onClick={() => void external()} />}
        <IconButton icon={FolderOpen} title={t('editor.showInPanel')} onClick={() => showInPanel(tab)} />
        <div className="flex1" />
        <span className="editor-meta">
          <span className="ellipsis" title={tab.path}>
            {session && session.id !== 'local' ? `${session.name}: ` : ''}
            {tab.path}
          </span>
          {!isText && <span className="muted">{formatBytes(tab.size)}</span>}
          {tab.modified ? <span className="muted hide-narrow" title={t('col.modified')}>{formatDate(tab.modified)}</span> : null}
          {ro && tab.kind === 'text' && <Badge tone="warn">{t('editor.readOnly')}</Badge>}
          {tab.truncated && <Badge tone="err">{t('editor.truncated')}</Badge>}
        </span>
      </div>
      <div className="editor-body">
        {tabs
          .filter((x) => x.kind === 'text' && !x.loading && !x.error && x.version > 0)
          .map((x) => (
            <div key={x.id} className={cx('cm-wrap', x.id !== tab.id && 'cm-hidden')}>
              <TextEditor tab={x} active={x.id === tab.id} options={{ wrap, whitespace, showChanges: !!changes[x.id] }} onOpenFile={openFileDialog} />
            </div>
          ))}
        {tab.loading ? (
          <div className="center-fill">
            <Spinner />
          </div>
        ) : tab.error ? (
          <EmptyState icon={FileWarning} title={t('editor.loadFailed')} action={<Button size="sm" icon={RefreshCw} onClick={() => void reloadTab(tab.id)}>{t('common.retry')}</Button>}>
            {tab.error}
          </EmptyState>
        ) : tab.kind === 'image' ? (
          <ImageViewer tab={tab} />
        ) : tab.kind === 'pdf' ? (
          <iframe className="pdf-frame" src={tab.dataUrl} title={tab.name} />
        ) : tab.kind === 'binary' ? (
          <div className="binary-view">
            <div className="binary-note">
              <FileWarning size={16} /> {t('editor.binary', { size: formatBytes(tab.size) })}
            </div>
            {tab.hex && <pre className="hex">{tab.hex}</pre>}
          </div>
        ) : null}
      </div>
      {isText && <StatusBar tab={tab} onLanguage={setPicker} />}
      {picker && isText && <LanguagePicker tab={tab} anchor={picker} onClose={() => {
        setPicker(null);
        viewOf(tab.id)?.focus();
      }} />}
    </div>
  );
}
