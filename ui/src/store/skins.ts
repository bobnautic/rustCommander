// Skins: the built-in ones, the user's (files in <config dir>/skins/, see `skins.list`) and
// the look that is currently applied.
import { create } from 'zustand';
import { call } from '../api/client';
import type { AppearanceSettings, Settings } from '../api/types';
import { BUILTIN_IDS, BUILTIN_SKINS } from '../skins';
import { DEFAULT_SKIN_ID, resolveSkin, validateSkin, variantsOf, type Resolved, type Scheme, type Skin } from '../lib/skins/engine';
import { applyToDocument, cacheLook } from '../lib/skins/apply';
import { tr } from '../i18n';
import { useApp } from './app';

export interface SkinEntry {
  skin: Skin;
  builtin: boolean;
  /** File name in the skins folder (user skins). */
  file?: string;
  warnings: string[];
}

export interface SkinProblem {
  file: string;
  message: string;
}

interface SkinsState {
  user: SkinEntry[];
  /** `skins.list` answered at least once. */
  loaded: boolean;
  /** The skins folder on the machine that runs the backend. */
  dir: string | null;
  /** Files that could not be loaded. */
  problems: SkinProblem[];
  /** The look on screen. */
  current: Resolved;
  /** Previews on screen instead of the saved look (Preferences, skin editor); the last one wins. */
  previews: Preview[];
}

interface Preview {
  owner: string;
  look: Look;
  extra?: Skin;
}

export type Look = Pick<Settings, 'theme'> & { appearance?: AppearanceSettings | null };

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const builtinEntries: SkinEntry[] = BUILTIN_SKINS.map((skin) => ({ skin, builtin: true, warnings: [] }));
const builtinById = new Map(BUILTIN_SKINS.map((s) => [s.id, s]));

export function requestedScheme(theme: Settings['theme'] | undefined): Scheme {
  return theme === 'dark' || (theme !== 'light' && darkQuery.matches) ? 'dark' : 'light';
}

/** Built-in skins win: their ids cannot be taken by user skins. */
export function lookupSkin(id: string, extra?: Skin): Skin | undefined {
  if (extra && extra.id === id) return extra;
  return builtinById.get(id) ?? useSkins.getState().user.find((e) => e.skin.id === id)?.skin;
}

export function allSkins(): SkinEntry[] {
  return [...builtinEntries, ...useSkins.getState().user];
}

/** Resolves a look; `extra` is a skin that is not saved yet (skin editor). */
export function resolveLook(look: Look, scheme: Scheme = requestedScheme(look.theme), extra?: Skin): Resolved {
  const app = look.appearance;
  const id = (extra?.id ?? app?.skin) || DEFAULT_SKIN_ID;
  const lookup = (x: string) => lookupSkin(x, extra);
  const skin = lookup(id) ?? lookup(DEFAULT_SKIN_ID)!;
  return resolveSkin(skin, lookup, scheme, app ?? {});
}

export function skinVariants(skin: Skin): Scheme[] {
  return variantsOf(skin, (x) => lookupSkin(x, skin));
}

export const useSkins = create<SkinsState>(() => ({
  user: [],
  loaded: false,
  dir: null,
  problems: [],
  current: resolveSkin(builtinById.get(DEFAULT_SKIN_ID)!, (x) => builtinById.get(x), document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'),
  previews: [],
}));

function show(r: Resolved) {
  applyToDocument(r);
  useSkins.setState({ current: r });
  if (useApp.getState().resolvedTheme !== r.scheme) useApp.setState({ resolvedTheme: r.scheme });
}

/** Applies the saved look (unless a preview is on screen). A user skin is only applied once
 * the user skins are loaded; until then the look of the last start stays (theme-init.js). */
export function applyLook(look: Look) {
  if (useSkins.getState().previews.length) return;
  const id = look.appearance?.skin || DEFAULT_SKIN_ID;
  if (!BUILTIN_IDS.has(id) && !useSkins.getState().loaded) return;
  show(resolveLook(look));
  cacheLook(resolveLook(look, 'light'), resolveLook(look, 'dark'));
}

function showTopPreview(): boolean {
  const list = useSkins.getState().previews;
  const top = list[list.length - 1];
  if (top) show(resolveLook(top.look, requestedScheme(top.look.theme), top.extra));
  return !!top;
}

/** Shows a look without saving it (`extra`: a skin that is not saved yet). `endPreview(owner)`
 * removes it again. */
export function previewLook(owner: string, look: Look, extra?: Skin) {
  useSkins.setState((s) => ({ previews: [...s.previews.filter((p) => p.owner !== owner), { owner, look, extra }] }));
  showTopPreview();
}

/** Ends a preview; with `restore` the previous preview or the saved look comes back. */
export function endPreview(owner: string, restore = true) {
  if (!useSkins.getState().previews.some((p) => p.owner === owner)) return;
  useSkins.setState((s) => ({ previews: s.previews.filter((p) => p.owner !== owner) }));
  if (restore) reapply();
}

function reapply() {
  if (showTopPreview()) return;
  const s = useApp.getState().settings;
  if (s) applyLook(s);
}

darkQuery.addEventListener('change', reapply);

let loading: Promise<void> | null = null;
let lastLoad = 0;
let lastJson = '';

/** Loads the user skins from the backend and applies the look again when they changed. */
export function reloadSkins(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    try {
      const list = await call('skins.list');
      lastLoad = Date.now();
      const json = JSON.stringify(list);
      if (json === lastJson && useSkins.getState().loaded) return;
      lastJson = json;
      const user: SkinEntry[] = [];
      const problems: SkinProblem[] = [...list.errors];
      for (const f of list.skins) {
        const v = validateSkin(f.skin);
        if (!v.skin) problems.push({ file: f.file, message: v.errors.join('; ') });
        else if (BUILTIN_IDS.has(v.skin.id)) problems.push({ file: f.file, message: tr('skins.reservedId', { id: v.skin.id }) });
        else user.push({ skin: v.skin, builtin: false, file: f.file, warnings: v.warnings });
      }
      user.sort((a, b) => a.skin.name.localeCompare(b.skin.name));
      useSkins.setState({ user, problems, dir: list.dir, loaded: true });
    } catch {
      // older backend without skins: only the built-in ones
      useSkins.setState({ loaded: true });
    } finally {
      loading = null;
    }
    reapply();
  })();
  return loading;
}

// Skin authors edit the JSON file in another program: coming back to the window shows the
// changes (cheap: a few small files).
window.addEventListener('focus', () => {
  if (useSkins.getState().loaded && Date.now() - lastLoad > 1500) void reloadSkins();
});

/** Re-reads the skins after a change (a reload that started before the change may still
 * be running; its list would be stale). */
async function reloadAfterChange() {
  if (loading) await loading;
  lastJson = '';
  await reloadSkins();
}

export async function saveUserSkin(skin: Skin): Promise<void> {
  await call('skins.save', { skin });
  await reloadAfterChange();
}

export async function deleteUserSkin(id: string): Promise<void> {
  await call('skins.delete', { id });
  await reloadAfterChange();
}
