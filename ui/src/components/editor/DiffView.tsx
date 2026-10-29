// Read-only comparison of two texts: side by side (MergeView) or unified, with syntax highlighting.
import { useEffect, useRef, useState } from 'react';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, highlightSpecialChars, lineNumbers } from '@codemirror/view';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { MergeView, getChunks, goToNextChunk, goToPreviousChunk, unifiedMergeView } from '@codemirror/merge';
import { oneDark } from '@codemirror/theme-one-dark';
import { detectLanguage } from '../../lib/editor/languages';
import { useApp } from '../../store/app';

export interface DiffNav {
  next(): void;
  prev(): void;
}

interface Props {
  a: string;
  b: string;
  fileName: string;
  mode: 'split' | 'unified';
  collapse: boolean;
  onChunks: (n: number) => void;
  navRef: { current: DiffNav | null };
}

const layout = EditorView.theme({
  '&': { height: '100%' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.5' },
});

export function DiffView({ a, b, fileName, mode, collapse, onChunks, navRef }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const dark = useApp((s) => s.resolvedTheme === 'dark');
  const fontSize = useApp((s) => s.settings?.editor.fontSize ?? 13);
  const [lang, setLang] = useState<Extension | null>(null);

  useEffect(() => {
    let alive = true;
    const desc = detectLanguage(fileName, '', b);
    if (desc) void desc.load().then((ext) => alive && setLang(ext), () => undefined);
    return () => {
      alive = false;
    };
  }, [fileName, b]);

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const ext: Extension[] = [
      lineNumbers(),
      highlightSpecialChars(),
      drawSelection(),
      layout,
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      dark ? oneDark : syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    ];
    if (lang) ext.push(lang);
    const collapseUnchanged = collapse ? { margin: 3, minSize: 6 } : undefined;
    if (mode === 'split') {
      const mv = new MergeView({ a: { doc: a, extensions: ext }, b: { doc: b, extensions: ext }, parent, collapseUnchanged, gutter: true });
      navRef.current = { next: () => goToNextChunk(mv.b), prev: () => goToPreviousChunk(mv.b) };
      onChunks(mv.chunks.length);
      return () => {
        navRef.current = null;
        mv.destroy();
      };
    }
    const view = new EditorView({
      parent,
      state: EditorState.create({ doc: b, extensions: [...ext, unifiedMergeView({ original: a, mergeControls: false, gutter: true, collapseUnchanged })] }),
    });
    navRef.current = { next: () => goToNextChunk(view), prev: () => goToPreviousChunk(view) };
    onChunks(getChunks(view.state)?.chunks.length ?? 0);
    return () => {
      navRef.current = null;
      view.destroy();
    };
  }, [a, b, mode, collapse, dark, lang]); // eslint-disable-line react-hooks/exhaustive-deps

  return <div ref={host} className={`diff-host diff-${mode}`} style={{ fontSize }} data-testid="diff-view" />;
}
