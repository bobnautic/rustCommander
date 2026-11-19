// Skins: validation and resolution. Pure functions (no DOM), unit-tested in tests/unit.mjs.
//
// A skin is a JSON object (see docs/src/guide/creating-skins.md and skin.schema.json):
//
//   { "id": "ocean", "name": "Ocean", "extends": "default",
//     "style": { "radius": 4, "density": "compact" },
//     "light": { "accent": "#0077b6" },
//     "dark":  { "accent": "#48cae4", "bg": "#03111f" } }
//
// Resolving a skin walks its `extends` chain down to "default", merges the variant (light
// or dark) of every skin in the chain, derives the tokens that were left out (tokens.ts) and
// turns everything into CSS custom properties.
import { contrast, formatColor, normalizeColor, over, parseColor, type RGBA } from './color';
import { EVAL_ORDER, TOKEN_MAP, type Scheme, type TokenDef } from './tokens';

export type { Scheme } from './tokens';
export type Density = 'compact' | 'normal' | 'comfortable';
export const DENSITIES: Density[] = ['compact', 'normal', 'comfortable'];
export type TokenValues = Record<string, string>;

export interface SkinStyle {
  /** CSS font-family of the user interface. */
  fontUi?: string;
  /** CSS font-family for paths, permissions, editor and terminal-like text. */
  fontMono?: string;
  /** Corner radius of buttons and inputs, px (0–16). */
  radius?: number;
  /** Corner radius of panels, menus and dialogs, px (0–24). */
  panelRadius?: number;
  /** Row height of the file lists. */
  density?: Density;
  /** Font size of the file lists, px (10–20). */
  listFontSize?: number;
  /** Alternating row backgrounds in the file lists. */
  stripes?: boolean;
}

export interface Skin {
  id: string;
  name: string;
  description?: string;
  author?: string;
  version?: string;
  license?: string;
  /** Skin this one builds on (default: "default"). */
  extends?: string;
  style?: SkinStyle;
  light?: TokenValues;
  dark?: TokenValues;
}

/** The user's adjustments on top of the skin (Settings.appearance). */
export interface AppearanceOverrides {
  accent?: string | null;
  density?: Density | null;
  listFontSize?: number | null;
  radius?: number | null;
  stripes?: boolean | null;
  fontUi?: string | null;
  fontMono?: string | null;
}

export interface Resolved {
  id: string;
  /** Variant in use (a dark-only skin is dark even when light is requested). */
  scheme: Scheme;
  /** Token values (colors normalized). */
  tokens: TokenValues;
  style: Required<SkinStyle>;
  /** CSS custom properties, names with the leading `--`. */
  vars: Record<string, string>;
  /** Classes for the root element (`rc-stripes`). */
  classes: string[];
  /** Row height of the file lists in px. */
  rowHeight: number;
}

export const DEFAULT_SKIN_ID = 'default';
export const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FONT_RE = /^[\w\s"',.-]{1,300}$/;
const SHADOW_RE = /^[\w\s#(),.%+-]{1,400}$/;
const META_KEYS = ['description', 'author', 'version', 'license'] as const;
const TOP_KEYS = new Set(['$schema', 'id', 'name', 'extends', 'style', 'light', 'dark', ...META_KEYS]);

export const STYLE_LIMITS = {
  radius: [0, 16],
  panelRadius: [0, 24],
  listFontSize: [10, 20],
} as const;

const ROW_FACTOR: Record<Density, number> = { compact: 1.5, normal: 1.7, comfortable: 2.05 };

export function rowHeightFor(style: Pick<Required<SkinStyle>, 'density' | 'listFontSize'>): number {
  return Math.round(style.listFontSize * ROW_FACTOR[style.density]);
}

// ---------------------------------------------------------------- validation

/** A token value as it may be applied, or null when it is not valid for the token. */
export function sanitizeValue(def: TokenDef, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (def.kind === 'color') return normalizeColor(value);
  const v = value.trim();
  if (v === 'none') return v;
  // shadows: lengths, colors and commas only (no url(), no var(), no expressions)
  if (!SHADOW_RE.test(v) || /url|var|expression|image|attr/i.test(v)) return null;
  return v.replace(/\s+/g, ' ');
}

export function sanitizeFont(value: unknown): string | null {
  return typeof value === 'string' && FONT_RE.test(value.trim()) ? value.trim() : null;
}

function inRange(v: unknown, [lo, hi]: readonly [number, number]): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : null;
}

function sanitizeStyle(raw: unknown, warn: (m: string) => void): SkinStyle | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn('"style" must be an object');
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const out: SkinStyle = {};
  for (const [k, v] of Object.entries(r)) {
    switch (k) {
      case 'fontUi':
      case 'fontMono': {
        const f = sanitizeFont(v);
        if (f) out[k] = f;
        else warn(`style.${k}: not a usable font-family list`);
        break;
      }
      case 'radius':
      case 'panelRadius':
      case 'listFontSize': {
        const n = inRange(v, STYLE_LIMITS[k]);
        if (n === null) warn(`style.${k}: expected a number`);
        else {
          if (n !== v) warn(`style.${k}: ${String(v)} adjusted to ${n}`);
          out[k] = n;
        }
        break;
      }
      case 'density':
        if (DENSITIES.includes(v as Density)) out.density = v as Density;
        else warn(`style.density: expected ${DENSITIES.join(', ')}`);
        break;
      case 'stripes':
        if (typeof v === 'boolean') out.stripes = v;
        else warn('style.stripes: expected true or false');
        break;
      default:
        warn(`style.${k}: unknown setting (ignored)`);
    }
  }
  return out;
}

function sanitizeTokens(raw: unknown, where: Scheme, warn: (m: string) => void): TokenValues | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    warn(`"${where}" must be an object of token values`);
    return undefined;
  }
  const out: TokenValues = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const name = k.startsWith('--') ? k.slice(2) : k;
    const def = TOKEN_MAP.get(name);
    if (!def) {
      warn(`${where}.${k}: unknown token (ignored)`);
      continue;
    }
    const value = sanitizeValue(def, v);
    if (value === null) warn(`${where}.${k}: ${JSON.stringify(v)} is not a valid ${def.kind === 'color' ? 'color' : 'shadow'} (ignored)`);
    else out[name] = value;
  }
  return out;
}

export interface Validation {
  skin: Skin | null;
  errors: string[];
  warnings: string[];
}

/** Checks a skin from a file or the network. Problems with single values are warnings
 * (the value is dropped); a skin without a usable id or name is an error. */
export function validateSkin(raw: unknown): Validation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const warn = (m: string) => warnings.push(m);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { skin: null, errors: ['a skin must be a JSON object'], warnings };
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : '';
  if (!ID_RE.test(id)) errors.push(`"id" must be 1–64 characters a-z, 0-9, - or _ (got ${JSON.stringify(r.id ?? null)})`);
  const name = typeof r.name === 'string' ? r.name.trim().slice(0, 80) : '';
  if (!name) errors.push('"name" is missing');
  for (const k of Object.keys(r)) if (!TOP_KEYS.has(k)) warn(`${k}: unknown key (ignored)`);
  const skin: Skin = { id, name };
  for (const k of META_KEYS) {
    if (r[k] === undefined) continue;
    if (typeof r[k] === 'string') skin[k] = (r[k] as string).slice(0, 500);
    else warn(`${k}: expected a string`);
  }
  if (r.extends !== undefined) {
    if (typeof r.extends === 'string' && ID_RE.test(r.extends) && r.extends !== id) skin.extends = r.extends;
    else warn('extends: expected the id of another skin');
  }
  const style = sanitizeStyle(r.style, warn);
  if (style && Object.keys(style).length) skin.style = style;
  const light = sanitizeTokens(r.light, 'light', warn);
  const dark = sanitizeTokens(r.dark, 'dark', warn);
  if (light) skin.light = light;
  if (dark) skin.dark = dark;
  return { skin: errors.length ? null : skin, errors, warnings };
}

// ---------------------------------------------------------------- resolution

export type SkinLookup = (id: string) => Skin | undefined;

/** `[default, …, parent, skin]`; unknown parents and cycles end the chain at "default". */
export function chainOf(skin: Skin, lookup: SkinLookup): Skin[] {
  const chain: Skin[] = [];
  const seen = new Set<string>();
  let cur: Skin | undefined = skin;
  while (cur && !seen.has(cur.id) && chain.length < 10) {
    seen.add(cur.id);
    chain.unshift(cur);
    if (cur.id === DEFAULT_SKIN_ID) return chain;
    cur = lookup(cur.extends ?? DEFAULT_SKIN_ID);
  }
  const root = lookup(DEFAULT_SKIN_ID);
  if (root && chain[0]?.id !== DEFAULT_SKIN_ID) chain.unshift(root);
  return chain;
}

/** The variants a skin offers. A skin without its own variants offers those of its parent. */
export function variantsOf(skin: Skin, lookup: SkinLookup): Scheme[] {
  for (const s of [...chainOf(skin, lookup)].reverse()) {
    const v: Scheme[] = [];
    if (s.light) v.push('light');
    if (s.dark) v.push('dark');
    if (v.length) return v;
  }
  return ['light', 'dark'];
}

const BASE_STYLE: Required<SkinStyle> = {
  fontUi: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', 'Noto Sans', Arial, sans-serif",
  fontMono: "ui-monospace, 'SF Mono', 'Cascadia Code', 'JetBrains Mono', Menlo, Consolas, 'Liberation Mono', monospace",
  radius: 6,
  panelRadius: 9,
  density: 'normal',
  listFontSize: 13,
  stripes: false,
};

/** Resolves `skin` for the `requested` scheme (or the one it has) plus the user's overrides. */
export function resolveSkin(skin: Skin, lookup: SkinLookup, requested: Scheme, overrides: AppearanceOverrides = {}): Resolved {
  const variants = variantsOf(skin, lookup);
  const scheme: Scheme = variants.includes(requested) ? requested : variants[0];
  const chain = chainOf(skin, lookup);
  const root = chain[0]?.id === DEFAULT_SKIN_ID ? chain[0] : undefined;
  const defaults: TokenValues = (root?.[scheme] ?? {}) as TokenValues;

  // values set by the skin (and its parents other than "default") and by the user
  const explicit: TokenValues = {};
  for (const s of chain) if (s !== root) Object.assign(explicit, s[scheme] ?? {});
  const accent = overrides.accent ? normalizeColor(overrides.accent) : null;
  if (accent) explicit.accent = accent;

  const tokens: TokenValues = {};
  const parsed = new Map<string, RGBA>();
  const changed = new Set(Object.keys(explicit));
  const ctx = {
    dark: scheme === 'dark',
    c(name: string): RGBA {
      let v = parsed.get(name);
      if (!v) {
        v = parseColor(tokens[name] ?? defaults[name] ?? '') ?? { r: 128, g: 128, b: 128, a: 1 };
        parsed.set(name, v);
      }
      return v;
    },
  };
  for (const t of EVAL_ORDER) {
    let value: string | undefined = explicit[t.name];
    if (value === undefined && t.derive && t.from?.some((f) => changed.has(f))) {
      value = formatColor(t.derive(ctx));
      changed.add(t.name);
    }
    if (value === undefined && !t.optional) value = defaults[t.name];
    if (value !== undefined) tokens[t.name] = value;
  }

  const style: Required<SkinStyle> = { ...BASE_STYLE };
  for (const s of chain) Object.assign(style, s.style ?? {});
  if (overrides.density && DENSITIES.includes(overrides.density)) style.density = overrides.density;
  const lfs = inRange(overrides.listFontSize, STYLE_LIMITS.listFontSize);
  if (lfs !== null) style.listFontSize = lfs;
  const radius = inRange(overrides.radius, STYLE_LIMITS.radius);
  if (radius !== null) {
    style.radius = radius;
    style.panelRadius = Math.min(STYLE_LIMITS.panelRadius[1], Math.round(radius * 1.5));
  }
  if (typeof overrides.stripes === 'boolean') style.stripes = overrides.stripes;
  const fontUi = sanitizeFont(overrides.fontUi);
  if (fontUi) style.fontUi = fontUi;
  const fontMono = sanitizeFont(overrides.fontMono);
  if (fontMono) style.fontMono = fontMono;

  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(tokens)) vars[`--${k}`] = v;
  vars['--font'] = style.fontUi;
  vars['--mono'] = style.fontMono;
  vars['--radius'] = `${style.radius}px`;
  vars['--radius-panel'] = `${style.panelRadius}px`;
  vars['--radius-lg'] = `${style.panelRadius + 1}px`;
  vars['--list-font-size'] = `${style.listFontSize}px`;
  const rowHeight = rowHeightFor(style);
  vars['--row-h'] = `${rowHeight}px`;

  return { id: skin.id, scheme, tokens, style, vars, classes: style.stripes ? ['rc-stripes'] : [], rowHeight };
}

/** The skin as it would be saved: only what it sets, no empty sections. */
export function compactSkin(skin: Skin): Skin {
  const out: Skin = { id: skin.id, name: skin.name };
  for (const k of META_KEYS) if (skin[k]) out[k] = skin[k];
  if (skin.extends && skin.extends !== DEFAULT_SKIN_ID) out.extends = skin.extends;
  if (skin.style && Object.keys(skin.style).length) out.style = { ...skin.style };
  if (skin.light) out.light = { ...skin.light };
  if (skin.dark) out.dark = { ...skin.dark };
  return out;
}

/** `My Skin!` → `my-skin` */
export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || 'skin';
}

// ---------------------------------------------------------------- contrast

export interface ContrastCheck {
  /** i18n key suffix (`contrast.<what>`). */
  what: string;
  fg: string;
  bg: string;
  min: number;
}

/** What the skin editor and `scripts/skins.mjs check` measure (WCAG contrast ratios). */
export const CONTRAST_CHECKS: ContrastCheck[] = [
  { what: 'text', fg: 'text', bg: 'surface', min: 4.5 },
  { what: 'text2', fg: 'text-2', bg: 'surface', min: 4.5 },
  { what: 'muted', fg: 'muted', bg: 'surface', min: 3 },
  { what: 'chrome', fg: 'text', bg: 'chrome', min: 4.5 },
  { what: 'button', fg: 'accent-fg', bg: 'accent', min: 3 },
  { what: 'marked', fg: 'sel-fg', bg: 'sel-bg', min: 3 },
  { what: 'cursor', fg: 'cursor-fg', bg: 'cursor-bg', min: 4.5 },
  { what: 'terminal', fg: 'term-fg', bg: 'term-bg', min: 4.5 },
  { what: 'comments', fg: 'syn-comment', bg: 'editor-bg', min: 2.5 },
  { what: 'errors', fg: 'err', bg: 'surface', min: 3 },
  { what: 'success', fg: 'ok', bg: 'surface', min: 3 },
];

export interface ContrastResult extends ContrastCheck {
  ratio: number;
  ok: boolean;
}

export function contrastReport(r: Pick<Resolved, 'tokens'>): ContrastResult[] {
  const surface = parseColor(r.tokens.surface ?? '#ffffff') ?? { r: 255, g: 255, b: 255, a: 1 };
  return CONTRAST_CHECKS.map((c) => {
    // the cursor row keeps the normal text color unless the skin sets cursor-fg
    const fgName = c.fg === 'cursor-fg' && !r.tokens['cursor-fg'] ? 'text' : c.fg;
    const fg = parseColor(r.tokens[fgName] ?? '');
    const bgRaw = parseColor(r.tokens[c.bg] ?? '');
    if (!fg || !bgRaw) return { ...c, ratio: 0, ok: false };
    const ratio = Math.round(contrast(fg, over(bgRaw, surface)) * 100) / 100;
    return { ...c, ratio, ok: ratio >= c.min };
  });
}

/** Makes a usable skin id out of anything (`Nord Custom` → `nord-custom`). */
export function normalizeSkinId(id: string): string {
  return (
    id
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[-_]+/, '')
      .slice(0, 64) || 'skin'
  );
}
