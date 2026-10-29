// Lazy chunk: CodeMirror 6 editor + viewer for images / PDFs / binary files.
import { useEffect, useMemo, useRef, useState } from 'react';
import CodeMirror, { EditorView, keymap, type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { openSearchPanel } from '@codemirror/search';
import {
  Download, Edit3, ExternalLink, Eye, FileWarning, Maximize, Minimize2, RefreshCw, Save, Search, WrapText, X, ZoomIn, ZoomOut, FileCode,
} from 'lucide-react';
import { useT } from '../../i18n';
import { formatBytes, formatDate } from '../../lib/format';
import { sessionById, useApp } from '../../store/app';
import {
  closeAllTabs, closeTab, getContent, openFile, reloadTab, saveTab, setActiveTab, setContent, setEditorVisible, useEditors, type EditorTab,
} from '../../store/editors';
import { getPanel } from '../../store/panels';
import { Badge, Button, EmptyState, IconButton, Spinner, cx } from '../ui';

function useLanguage(name: string): { ext: Extension | null; label: string | null } {
  const [state, setState] = useState<{ ext: Extension | null; label: string | null }>({ ext: null, label: null });
  useEffect(() => {
    let alive = true;
    const desc = LanguageDescription.matchFilename(languages, name);
    if (!desc) {
      setState({ ext: null, label: null });
      return;
    }
    desc
      .load()
      .then((support) => alive && setState({ ext: support, label: desc.name }))
      .catch(() => alive && setState({ ext: null, label: desc.name }));
    return () => {
      alive = false;
    };
  }, [name]);
  return state;
}

function TextEditor({ tab, wrap, onView }: { tab: EditorTab; wrap: boolean; onView: (v: EditorView | null, lang: string | null) => void }) {
  const theme = useApp((s) => s.resolvedTheme);
  const editorSettings = useApp((s) => s.settings?.editor);
  const { ext, label } = useLanguage(tab.name);
  const ref = useRef<ReactCodeMirrorRef>(null);
  const initial = useMemo(() => getContent(tab.id), [tab.id, tab.version]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    onView(ref.current?.view ?? null, label);
  });

  const extensions = useMemo(() => {
    const list: Extension[] = [
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              void saveTab(tab.id);
              return true;
            },
          },
        ]),
      ),
      EditorState.tabSize.of(editorSettings?.tabSize ?? 4),
    ];
    if (ext) list.push(ext);
    if (wrap) list.push(EditorView.lineWrapping);
    if (tab.readOnly) list.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
    return list;
  }, [ext, wrap, tab.readOnly, tab.id, editorSettings?.tabSize]);

  return (
    <CodeMirror
      key={`${tab.id}:${tab.version}`}
      ref={ref}
      value={initial}
      height="100%"
      className="cm-host"
      style={{ fontSize: editorSettings?.fontSize ?? 13 }}
      theme={theme === 'dark' ? 'dark' : 'light'}
      extensions={extensions}
      autoFocus
      basicSetup={{ highlightActiveLine: !tab.readOnly, foldGutter: true, searchKeymap: true, tabSize: editorSettings?.tabSize ?? 4 }}
      onChange={(v) => setContent(tab.id, v)}
    />
  );
}

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

export default function EditorWindow() {
  const t = useT();
  const tabs = useEditors((s) => s.tabs);
  const activeId = useEditors((s) => s.active);
  const settingsWrap = useApp((s) => s.settings?.editor.wordWrap ?? false);
  const info = useApp((s) => s.info);
  const [wrap, setWrap] = useState(settingsWrap);
  const viewRef = useRef<EditorView | null>(null);
  const [lang, setLang] = useState<string | null>(null);
  const tab = tabs.find((x) => x.id === activeId) ?? tabs[0];
  const session = tab ? sessionById(tab.session) : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's' && tab) {
        e.preventDefault();
        void saveTab(tab.id);
      } else if (e.key === 'Escape' && !(e.target as HTMLElement)?.closest?.('.cm-panels, .dlg')) {
        if (document.querySelector('.dlg-backdrop')) return;
        e.preventDefault();
        setEditorVisible(false);
      } else if (mod && e.key === 'F4' && tab) {
        e.preventDefault();
        void closeTab(tab.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tab]);

  if (!tab) return null;
  const download = async () => {
    const { downloadToComputer } = await import('../../api/web');
    await downloadToComputer(tab.session, [{ name: tab.name, path: tab.path, kind: 'file', size: tab.size }]);
  };
  const external = async () => {
    const { externalEdit } = await import('../../actions/fileOps');
    const side = getPanel('left').session === tab.session ? 'left' : 'right';
    await externalEdit(side, { name: tab.name, path: tab.path, kind: 'file', size: tab.size, hidden: false });
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
        <div className="flex1" />
        <IconButton icon={Minimize2} title={t('editor.minimize')} shortcut="Esc" onClick={() => setEditorVisible(false)} />
        <IconButton icon={X} title={t('editor.closeAll')} onClick={() => void closeAllTabs()} />
      </div>
      <div className="editor-toolbar">
        {tab.kind === 'text' && !tab.readOnly && (
          <Button size="sm" variant={tab.dirty ? 'primary' : 'default'} icon={Save} busy={tab.saving} disabled={!tab.dirty} onClick={() => void saveTab(tab.id)} data-testid="editor-save">
            {t('editor.save')}
          </Button>
        )}
        {tab.mode === 'view' && tab.kind === 'text' && (
          <Button size="sm" icon={Edit3} onClick={() => void openFile(tab.session, { name: tab.name, path: tab.path, size: tab.size }, 'edit')}>
            {t('ops.edit')}
          </Button>
        )}
        <IconButton icon={RefreshCw} title={t('editor.reload')} onClick={() => void reloadTab(tab.id)} />
        {tab.kind === 'text' && (
          <>
            <IconButton icon={Search} title={t('editor.find')} shortcut="Ctrl+F" onClick={() => viewRef.current && openSearchPanel(viewRef.current)} />
            <IconButton icon={WrapText} title={t('editor.wordWrap')} active={wrap} onClick={() => setWrap(!wrap)} />
          </>
        )}
        {info?.mode === 'web' && <IconButton icon={Download} title={t('web.download')} onClick={() => void download()} />}
        {info?.mode === 'desktop' && info.features.externalEdit && tab.session !== 'local' && <IconButton icon={ExternalLink} title={t('ops.editExternal')} onClick={() => void external()} />}
        <div className="flex1" />
        <span className="editor-meta">
          <span className="ellipsis" title={tab.path}>
            {session && session.id !== 'local' ? `${session.name}: ` : ''}
            {tab.path}
          </span>
          {lang && tab.kind === 'text' && <Badge tone="muted">{lang}</Badge>}
          {tab.kind === 'text' && <Badge tone="muted">{tab.encoding.toUpperCase()}</Badge>}
          <span className="muted">{formatBytes(tab.size)}</span>
          {tab.modified ? <span className="muted hide-narrow">{formatDate(tab.modified)}</span> : null}
          {tab.readOnly && <Badge tone="warn">{t('editor.readOnly')}</Badge>}
          {tab.truncated && <Badge tone="err">{t('editor.truncated')}</Badge>}
        </span>
      </div>
      <div className="editor-body">
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
        ) : (
          <TextEditor
            tab={tab}
            wrap={wrap}
            onView={(v, l) => {
              viewRef.current = v;
              if (l !== lang) setLang(l);
            }}
          />
        )}
      </div>
    </div>
  );
}
