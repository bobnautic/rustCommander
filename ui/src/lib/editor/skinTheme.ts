// Editor colors from the skin: the editor and the diff view read the `editor-*` and `syn-*`
// tokens as CSS custom properties, so a skin change recolors open editors without
// re-creating them. Only the light/dark flag (for CodeMirror's own base styles) needs the
// scheme.
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

const v = (name: string) => `var(--${name})`;

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.self], color: v('syn-keyword') },
  { tag: [t.string, t.special(t.string), t.character, t.inserted], color: v('syn-string') },
  { tag: [t.number, t.integer, t.float], color: v('syn-number') },
  { tag: [t.bool, t.null, t.atom, t.unit, t.constant(t.name), t.standard(t.name), t.color], color: v('syn-constant') },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: v('syn-comment'), fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.macroName], color: v('syn-function') },
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: v('syn-type') },
  { tag: [t.propertyName, t.definition(t.propertyName)], color: v('syn-property') },
  { tag: [t.variableName, t.definition(t.variableName), t.labelName, t.special(t.variableName)], color: v('syn-variable') },
  { tag: [t.operator, t.derefOperator, t.arithmeticOperator, t.logicOperator, t.bitwiseOperator, t.compareOperator, t.updateOperator, t.definitionOperator, t.typeOperator, t.controlOperator], color: v('syn-operator') },
  { tag: [t.tagName, t.angleBracket], color: v('syn-tag') },
  { tag: t.attributeName, color: v('syn-attribute') },
  { tag: t.heading, color: v('syn-heading'), fontWeight: 'bold' },
  { tag: [t.link, t.url], color: v('syn-link'), textDecoration: 'underline' },
  { tag: [t.invalid, t.deleted], color: v('syn-invalid') },
  { tag: [t.meta, t.annotation, t.processingInstruction, t.documentMeta], color: v('syn-meta') },
  { tag: [t.regexp, t.escape], color: v('syn-regexp') },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
]);

function editorTheme(dark: boolean): Extension {
  return EditorView.theme(
    {
      '&': { backgroundColor: v('editor-bg'), color: v('editor-fg') },
      '.cm-content': { caretColor: v('editor-cursor') },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: v('editor-cursor') },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: v('editor-selection'),
      },
      '.cm-gutters': { backgroundColor: v('editor-gutter-bg'), color: v('editor-gutter-fg'), borderRight: `1px solid ${v('border-soft')}` },
      '.cm-activeLine': { backgroundColor: v('editor-active-line') },
      '.cm-activeLineGutter': { backgroundColor: v('editor-active-line'), color: v('text-2') },
      '.cm-foldPlaceholder': { backgroundColor: v('surface-3'), border: 'none', color: v('muted') },
      '.cm-searchMatch': { backgroundColor: v('warn-weak'), outline: `1px solid ${v('warn')}` },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: v('accent-weak-2') },
      '.cm-selectionMatch': { backgroundColor: v('accent-weak') },
      '&.cm-focused .cm-matchingBracket': { backgroundColor: v('accent-weak-2'), outline: `1px solid ${v('accent-border')}` },
      '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: v('err-weak') },
      '.cm-panels': { backgroundColor: v('surface-2'), color: v('text') },
      '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${v('border')}` },
      '.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${v('border')}` },
      '.cm-tooltip': { backgroundColor: v('surface'), color: v('text'), border: `1px solid ${v('border')}` },
      '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: v('accent'), color: v('accent-fg') },
    },
    { dark },
  );
}

const LIGHT: Extension = [editorTheme(false), syntaxHighlighting(highlight)];
const DARK: Extension = [editorTheme(true), syntaxHighlighting(highlight)];

/** Editor theme for the skin's scheme (colors follow the skin live). */
export function skinEditorTheme(scheme: 'light' | 'dark'): Extension {
  return scheme === 'dark' ? DARK : LIGHT;
}
