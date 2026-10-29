// Which CodeMirror language a file gets: the user's choice for that kind of file, then the file
// name, then the content.
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { load, save } from '../storage';
import { languageFromContent, languageFromName } from './detect';

export const LANGUAGE_NAMES: string[] = languages.map((l) => l.name).sort((a, b) => a.localeCompare(b));

/** Key for remembering a language choice: the extension, or the whole name for files without one. */
function overrideKey(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot).toLowerCase() : fileName;
}

type Overrides = Record<string, string>;

/** '' = plain text chosen explicitly; undefined = no choice made. */
export function languageOverride(fileName: string): string | undefined {
  return load<Overrides>('editorLanguages', {})[overrideKey(fileName)];
}

export function setLanguageOverride(fileName: string, language: string | null) {
  const all = load<Overrides>('editorLanguages', {});
  const key = overrideKey(fileName);
  if (language === null) delete all[key];
  else all[key] = language;
  save('editorLanguages', all);
}

export function describe(name: string | null | undefined): LanguageDescription | null {
  if (!name) return null;
  return languages.find((l) => l.name === name) ?? LanguageDescription.matchLanguageName(languages, name, false);
}

export function detectLanguage(fileName: string, path: string, content: string): LanguageDescription | null {
  const override = languageOverride(fileName);
  if (override !== undefined) return describe(override);
  // specific file name patterns (Dockerfile, nginx*.conf, CMakeLists.txt ...)
  const special = languages.find((l) => l.filename?.test(fileName));
  if (special) return special;
  const byName = languageFromName(fileName);
  if (byName) {
    if (byName === 'Properties files' && /\.conf$/i.test(fileName) && (/\/nginx\//.test(path) || languageFromContent(content) === 'Nginx')) return describe('Nginx');
    return describe(byName);
  }
  const byExt = LanguageDescription.matchFilename(languages, fileName);
  if (byExt) return byExt;
  if (/\/nginx\/(sites-(available|enabled)|conf\.d|snippets)\//.test(path)) return describe('Nginx');
  return describe(languageFromContent(content));
}
