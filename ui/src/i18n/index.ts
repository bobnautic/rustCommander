import { useCallback } from 'react';
import { create } from 'zustand';
import { en } from './en';
import { de } from './de';
import { setFormatLocale } from '../lib/format';

export type Lang = 'en' | 'de';
export type TKey = keyof typeof en;
export type TVars = Record<string, string | number | null | undefined>;
export type TFn = (key: TKey, vars?: TVars) => string;

const dicts: Record<Lang, Record<TKey, string>> = { en, de };

function detect(): Lang {
  const l = (typeof navigator !== 'undefined' ? navigator.language : 'en').toLowerCase();
  return l.startsWith('de') ? 'de' : 'en';
}

export const useI18n = create<{ lang: Lang }>(() => ({ lang: 'en' }));

function applyLocale(lang: Lang) {
  const nav = typeof navigator !== 'undefined' ? navigator.language : '';
  setFormatLocale(nav.toLowerCase().startsWith(lang) ? nav : lang === 'de' ? 'de-DE' : 'en-US');
  document.documentElement.lang = lang;
}

export function applyLanguage(setting: 'auto' | 'en' | 'de' | undefined) {
  const lang: Lang = !setting || setting === 'auto' ? detect() : setting;
  applyLocale(lang);
  if (useI18n.getState().lang !== lang) useI18n.setState({ lang });
}

applyLanguage('auto');

export function translate(lang: Lang, key: TKey, vars?: TVars): string {
  let s: string = dicts[lang][key] ?? en[key] ?? key;
  if (vars) {
    // "one|other" plural forms, chosen by vars.n
    if (s.includes('|') && typeof vars.n === 'number') {
      const [one, other] = s.split('|');
      s = vars.n === 1 ? one : other ?? one;
    }
    s = s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars && vars[k] !== null && vars[k] !== undefined ? String(vars[k]) : m));
  }
  return s;
}

/** Translate outside of React components (uses the current language). */
export function tr(key: TKey, vars?: TVars): string {
  return translate(useI18n.getState().lang, key, vars);
}

/** Hook returning a translate function; components re-render when the language changes. */
export function useT(): TFn {
  const lang = useI18n((s) => s.lang);
  return useCallback((key: TKey, vars?: TVars) => translate(lang, key, vars), [lang]);
}

export function hasKey(key: string): key is TKey {
  return key in en;
}
