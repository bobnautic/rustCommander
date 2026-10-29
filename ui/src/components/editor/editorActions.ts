// Commands of the editor window that work on the CodeMirror view of a tab: format, save (with
// format on save), text tools, zoom. Part of the lazily loaded editor chunk.
import type { EditorView } from '@codemirror/view';
import { EditorSelection, type ChangeSpec } from '@codemirror/state';
import { diff } from '@codemirror/merge';
import { normalizeError } from '../../api/errors';
import { tr } from '../../i18n';
import { formatterFor, installedFormatters, type Formatter } from '../../lib/editor/format';
import { sortJsonKeys } from '../../lib/editor/jsonCheck';
import { load, save } from '../../lib/storage';
import { useApp } from '../../store/app';
import { getTab, saveTab, setTabOptions, type EditorTab } from '../../store/editors';
import { toast } from '../../store/toasts';
import { create } from 'zustand';

const views = new Map<string, EditorView>();

export function registerView(id: string, view: EditorView | null) {
  if (view) views.set(id, view);
  else views.delete(id);
}

export function viewOf(id: string): EditorView | undefined {
  return views.get(id);
}

// ---------------------------------------------------------------- zoom

export const useEditorZoom = create<{ zoom: number }>(() => ({ zoom: load('editorZoom', 0) }));

export function zoomEditor(step: -1 | 0 | 1): boolean {
  const zoom = step === 0 ? 0 : Math.max(-6, Math.min(16, useEditorZoom.getState().zoom + step));
  useEditorZoom.setState({ zoom });
  save('editorZoom', zoom);
  return true;
}

// ---------------------------------------------------------------- formatting

export async function formatterOf(tab: EditorTab): Promise<Formatter | null> {
  return formatterFor(tab.language, tab.name, await installedFormatters());
}

/** Replace the document with `next` as a set of small changes, so the cursor and undo history stay sensible. */
function applyText(view: EditorView, next: string, userEvent: string) {
  const cur = view.state.doc.toString();
  const changes: ChangeSpec[] = diff(cur, next, { scanLimit: 20000 }).map((c) => ({ from: c.fromA, to: c.toA, insert: next.slice(c.fromB, c.toB) }));
  view.dispatch({ changes, userEvent });
}

/** Format the whole document. `quiet`: no toasts for "nothing to do" (format on save). Throws on syntax errors. */
async function runFormat(id: string, quiet: boolean): Promise<'formatted' | 'unchanged' | 'unsupported'> {
  const tab = getTab(id);
  const view = views.get(id);
  if (!tab || !view || tab.readOnly) return 'unsupported';
  const formatter = await formatterOf(tab);
  if (!formatter) {
    if (!quiet) toast.info(tab.language ? tr('editor.noFormatter', { lang: tab.language }) : tr('editor.noFormatterPlain'));
    return 'unsupported';
  }
  const text = view.state.doc.toString();
  const out = await formatter.format(text, {
    fileName: tab.name,
    language: tab.language!,
    tabSize: tab.indent.size,
    useTabs: tab.indent.tabs,
    printWidth: useApp.getState().settings?.editor.printWidth ?? 80,
  });
  // typed while the formatter ran: do not throw the typing away
  if (view.state.doc.toString() !== text) return 'unchanged';
  if (out === text) {
    if (!quiet) toast.info(tr('editor.alreadyFormatted'));
    return 'unchanged';
  }
  applyText(view, out, 'format');
  if (!quiet) toast.success(tr('editor.formatted', { formatter: formatter.label }));
  return 'formatted';
}

function formatError(e: unknown): string {
  return normalizeError(e).message.split('\n')[0];
}

export async function formatDocument(id: string) {
  try {
    await runFormat(id, false);
  } catch (e) {
    toast.error(formatError(e), tr('editor.formatFailed'));
  }
}

/** Save, running the formatter first when "format on save" is on. */
export async function saveWithFormat(id: string) {
  const tab = getTab(id);
  if (!tab || tab.readOnly || tab.saving) return;
  if (useApp.getState().settings?.editor.formatOnSave) {
    try {
      await runFormat(id, true);
    } catch (e) {
      toast.warning(tr('editor.savedUnformatted'), formatError(e));
    }
  }
  await saveTab(id);
}

// ---------------------------------------------------------------- text tools

/** Lines touched by the selection, or the whole document when nothing is selected. */
function lineRange(view: EditorView): { from: number; to: number } {
  const { state } = view;
  const sel = state.selection.main;
  if (sel.empty) return { from: 0, to: state.doc.length };
  const from = state.doc.lineAt(sel.from).from;
  const endLine = state.doc.lineAt(sel.to);
  // a selection ending at the start of a line does not include that line
  const to = sel.to === endLine.from && sel.to > sel.from ? state.doc.lineAt(sel.to - 1).to : endLine.to;
  return { from, to };
}

function transformLines(view: EditorView, fn: (lines: string[]) => string[]) {
  const { from, to } = lineRange(view);
  const text = view.state.sliceDoc(from, to);
  const next = fn(text.split('\n')).join('\n');
  if (next === text) return;
  view.dispatch({ changes: { from, to, insert: next }, selection: EditorSelection.range(from, from + next.length), userEvent: 'input' });
}

/** Each selection (or the word at an empty cursor). */
function transformSelection(view: EditorView, fn: (s: string) => string) {
  const { state } = view;
  view.dispatch(state.changeByRange((r) => {
    const target = r.empty ? (state.wordAt(r.head) ?? r) : r;
    const insert = fn(state.sliceDoc(target.from, target.to));
    return { changes: { from: target.from, to: target.to, insert }, range: EditorSelection.range(target.from, target.from + insert.length) };
  }));
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const textTools = {
  sortLines(view: EditorView, desc = false) {
    transformLines(view, (lines) => [...lines].sort((a, b) => (desc ? -1 : 1) * collator.compare(a, b)));
  },
  uniqueLines(view: EditorView) {
    transformLines(view, (lines) => lines.filter((l, i) => lines.indexOf(l) === i));
  },
  trimTrailing(view: EditorView) {
    transformLines(view, (lines) => lines.map((l) => l.replace(/[ \t]+$/, '')));
  },
  upperCase(view: EditorView) {
    transformSelection(view, (s) => s.toUpperCase());
  },
  lowerCase(view: EditorView) {
    transformSelection(view, (s) => s.toLowerCase());
  },
  /** Re-indent leading whitespace with the tab's indentation style. */
  convertIndentation(view: EditorView, tab: EditorTab) {
    const size = tab.indent.size;
    transformLines(view, (lines) =>
      lines.map((l) => {
        const ws = /^[ \t]*/.exec(l)![0];
        if (!ws) return l;
        let width = 0;
        for (const c of ws) width = c === '\t' ? width - (width % size) + size : width + 1;
        const lead = tab.indent.tabs ? '\t'.repeat(Math.floor(width / size)) + ' '.repeat(width % size) : ' '.repeat(width);
        return lead + l.slice(ws.length);
      }),
    );
  },
  sortJsonKeys(view: EditorView, tab: EditorTab) {
    try {
      const value = JSON.parse(view.state.doc.toString());
      const indent = tab.indent.tabs ? '\t' : tab.indent.size;
      applyText(view, JSON.stringify(sortJsonKeys(value), null, indent) + '\n', 'input');
    } catch (e) {
      toast.error(formatError(e), tr('editor.tools.sortKeys'));
    }
  },
  minifyJson(view: EditorView) {
    try {
      applyText(view, JSON.stringify(JSON.parse(view.state.doc.toString())), 'input');
    } catch (e) {
      toast.error(formatError(e), tr('editor.tools.minify'));
    }
  },
};

/** Switch the tab between tabs and spaces (and convert the existing indentation on request). */
export function setIndent(id: string, tabs: boolean, size: number, convert: boolean) {
  const tab = getTab(id);
  if (!tab) return;
  setTabOptions(id, { indent: { tabs, size } });
  const view = views.get(id);
  if (convert && view && !tab.readOnly) textTools.convertIndentation(view, { ...tab, indent: { tabs, size } });
}
