// CodeMirror for one text tab: detected language, linting, indentation, the "changes" view and
// the editor's keyboard commands.
import { useEffect, useMemo, useState } from 'react';
import CodeMirror, { EditorView, keymap } from '@uiw/react-codemirror';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { highlightTrailingWhitespace, highlightWhitespace } from '@codemirror/view';
import { indentUnit, type LanguageDescription } from '@codemirror/language';
import { forEachDiagnostic, lintGutter, linter, setDiagnosticsEffect } from '@codemirror/lint';
import { gotoLine } from '@codemirror/search';
import { unifiedMergeView } from '@codemirror/merge';
import { detectLanguage, describe } from '../../lib/editor/languages';
import { lintSource } from '../../lib/editor/lint';
import { useApp } from '../../store/app';
import { getContent, getOriginal, setContent, setTabOptions, useEditorStatus, useEditors, type EditorTab } from '../../store/editors';
import { formatDocument, registerView, saveWithFormat, useEditorZoom, viewOf, zoomEditor } from './editorActions';

export interface ViewOptions {
  wrap: boolean;
  whitespace: boolean;
  showChanges: boolean;
}

/** Language of the tab: detected when the text is (re)loaded, or the one picked in the status bar. */
function useLanguage(tab: EditorTab): Extension | null {
  const [support, setSupport] = useState<{ name: string; ext: Extension } | null>(null);
  // detect once per load; the status bar's picker sets tab.language afterwards
  const detected = useMemo<LanguageDescription | null>(
    () => detectLanguage(tab.name, tab.path, getContent(tab.id)),
    [tab.id, tab.version], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    setTabOptions(tab.id, { language: detected?.name ?? null });
  }, [tab.id, detected]);
  const desc = useMemo(() => (tab.language === (detected?.name ?? null) ? detected : describe(tab.language)), [tab.language, detected]);
  useEffect(() => {
    let alive = true;
    if (!desc) {
      setSupport(null);
      return;
    }
    if (support?.name === desc.name) return;
    desc
      .load()
      .then((ext) => alive && setSupport({ name: desc.name, ext }))
      .catch(() => alive && setSupport(null));
    return () => {
      alive = false;
    };
  }, [desc]); // eslint-disable-line react-hooks/exhaustive-deps
  return desc && support?.name === desc.name ? support.ext : null;
}

function reportStatus(view: EditorView, id: string) {
  if (useEditors.getState().active !== id) return;
  const { state } = view;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  let selected = 0;
  for (const r of state.selection.ranges) selected += r.to - r.from;
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  forEachDiagnostic(state, (d) => {
    if (d.severity === 'error') errors++;
    else if (d.severity === 'warning') warnings++;
    else infos++;
  });
  useEditorStatus.setState({ line: line.number, col: head - line.from + 1, selected, selections: state.selection.ranges.length, errors, warnings, infos });
}

/** One per open text tab; inactive ones stay mounted (hidden) so undo history, selection and scroll position survive tab switches. */
export function TextEditor({ tab, active, options, onOpenFile }: { tab: EditorTab; active: boolean; options: ViewOptions; onOpenFile: () => void }) {
  const theme = useApp((s) => s.resolvedTheme);
  const settings = useApp((s) => s.settings?.editor);
  const zoom = useEditorZoom((s) => s.zoom);
  const lang = useLanguage(tab);
  const initial = useMemo(() => getContent(tab.id), [tab.id, tab.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const lintOn = settings?.lint !== false;

  useEffect(() => () => registerView(tab.id, null), [tab.id]);
  useEffect(() => {
    const view = viewOf(tab.id);
    if (!active || !view) return;
    view.requestMeasure();
    view.focus();
    reportStatus(view, tab.id);
  }, [active, tab.id]);

  const commands = useMemo(
    () =>
      Prec.highest(
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => (void saveWithFormat(tab.id), true) },
          { key: 'Shift-Alt-f', preventDefault: true, run: () => (void formatDocument(tab.id), true) },
          { key: 'Mod-g', preventDefault: true, run: gotoLine },
          { key: 'Mod-p', preventDefault: true, run: () => (onOpenFile(), true) },
          { key: 'Mod-=', preventDefault: true, run: () => zoomEditor(1) },
          { key: 'Mod-+', preventDefault: true, run: () => zoomEditor(1) },
          { key: 'Mod--', preventDefault: true, run: () => zoomEditor(-1) },
          { key: 'Mod-0', preventDefault: true, run: () => zoomEditor(0) },
        ]),
      ),
    [tab.id, onOpenFile],
  );

  const lintExt = useMemo<Extension>(
    () => (lintOn ? [linter(lintSource({ language: tab.language, fileName: tab.name, tabs: tab.indent.tabs }), { delay: 600 }), lintGutter()] : []),
    [lintOn, tab.language, tab.name, tab.indent.tabs],
  );

  const changesExt = useMemo<Extension>(
    () => (options.showChanges ? unifiedMergeView({ original: getOriginal(tab.id), mergeControls: !tab.readOnly, gutter: true }) : []),
    [options.showChanges, tab.id, tab.version, tab.savedVersion, tab.readOnly], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const extensions = useMemo(() => {
    const list: Extension[] = [
      commands,
      EditorState.tabSize.of(tab.indent.size),
      indentUnit.of(tab.indent.tabs ? '\t' : ' '.repeat(tab.indent.size)),
      lintExt,
      changesExt,
      EditorView.updateListener.of((u) => {
        if (u.selectionSet || u.docChanged || u.focusChanged || u.transactions.some((t) => t.effects.some((e) => e.is(setDiagnosticsEffect)))) reportStatus(u.view, tab.id);
      }),
    ];
    if (lang) list.push(lang);
    if (options.wrap) list.push(EditorView.lineWrapping);
    if (options.whitespace) list.push(highlightWhitespace(), highlightTrailingWhitespace());
    if (tab.readOnly) list.push(EditorState.readOnly.of(true), EditorView.editable.of(false));
    return list;
  }, [commands, tab.indent, tab.id, lintExt, changesExt, lang, options.wrap, options.whitespace, tab.readOnly]);

  return (
    <CodeMirror
      key={`${tab.id}:${tab.version}`}
      value={initial}
      height="100%"
      className="cm-host"
      style={{ fontSize: Math.max(8, (settings?.fontSize ?? 13) + zoom) }}
      theme={theme === 'dark' ? 'dark' : 'light'}
      extensions={extensions}
      autoFocus={active}
      basicSetup={{ highlightActiveLine: !tab.readOnly, foldGutter: true, searchKeymap: true, tabSize: tab.indent.size }}
      onCreateEditor={(view) => {
        registerView(tab.id, view);
        reportStatus(view, tab.id);
      }}
      onChange={(v) => setContent(tab.id, v)}
    />
  );
}
