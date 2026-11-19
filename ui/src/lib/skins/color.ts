// Small color toolkit for skins: parse the CSS color notations skins may use, mix colors,
// and measure contrast (WCAG 2). Output is always normalized (#rrggbb or rgba()), so a
// value that reaches the DOM can never carry anything but a color.

export interface RGBA {
  /** 0–255 */
  r: number;
  g: number;
  b: number;
  /** 0–1 */
  a: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function hex(s: string): RGBA | null {
  const m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
  if (h.length !== 6 && h.length !== 8) return null;
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? Math.round((n(6) / 255) * 1000) / 1000 : 1 };
}

/** "50%" → 0.5 (of `scale`), "0.5" → 0.5 */
function num(part: string, scale: number): number | null {
  const p = part.trim();
  if (!/^-?(\d+\.?\d*|\.\d+)%?$/.test(p)) return null;
  const v = parseFloat(p);
  return p.endsWith('%') ? (v / 100) * scale : v;
}

function args(s: string, fn: string): string[] | null {
  const m = new RegExp(`^${fn}a?\\(([^()]*)\\)$`, 'i').exec(s);
  if (!m) return null;
  const body = m[1].trim();
  // rgb(1, 2, 3, 0.5) | rgb(1 2 3 / 50%)
  const [main, alpha] = body.includes('/') ? body.split('/') : [body, undefined];
  const parts = main.includes(',') ? main.split(',') : main.trim().split(/\s+/);
  if (alpha !== undefined) parts.push(alpha);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** Parses #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba(), hsl()/hsla(), black, white, transparent. */
export function parseColor(input: string): RGBA | null {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (s === 'black') return { r: 0, g: 0, b: 0, a: 1 };
  if (s === 'white') return { r: 255, g: 255, b: 255, a: 1 };
  if (s.startsWith('#')) return hex(s);
  const rgb = args(s, 'rgb');
  if (rgb) {
    if (rgb.length !== 3 && rgb.length !== 4) return null;
    const [r, g, b] = rgb.slice(0, 3).map((p) => num(p, 255));
    const a = rgb.length === 4 ? num(rgb[3], 1) : 1;
    if (r === null || g === null || b === null || a === null) return null;
    return { r: clamp(Math.round(r), 0, 255), g: clamp(Math.round(g), 0, 255), b: clamp(Math.round(b), 0, 255), a: clamp(a, 0, 1) };
  }
  const hsl = args(s, 'hsl');
  if (hsl) {
    if (hsl.length !== 3 && hsl.length !== 4) return null;
    const h = num(hsl[0].replace(/deg$/, ''), 360);
    const sat = num(hsl[1].endsWith('%') ? hsl[1] : `${hsl[1]}%`, 1);
    const l = num(hsl[2].endsWith('%') ? hsl[2] : `${hsl[2]}%`, 1);
    const a = hsl.length === 4 ? num(hsl[3], 1) : 1;
    if (h === null || sat === null || l === null || a === null) return null;
    const [r, g, b] = hslToRgb(((h % 360) + 360) % 360, clamp(sat, 0, 1), clamp(l, 0, 1));
    return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a: clamp(a, 0, 1) };
  }
  return null;
}

const h2 = (n: number) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');

/** #rrggbb when opaque, rgba(r, g, b, a) otherwise. */
export function formatColor(c: RGBA): string {
  if (c.a >= 1) return `#${h2(c.r)}${h2(c.g)}${h2(c.b)}`;
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${Math.round(clamp(c.a, 0, 1) * 1000) / 1000})`;
}

/** The value normalized, or null when it is not a color. */
export function normalizeColor(input: string): string | null {
  const c = parseColor(input);
  return c ? formatColor(c) : null;
}

/** `t` = share of `b` (0 → a, 1 → b). */
export function mix(a: RGBA, b: RGBA, t: number): RGBA {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t, a: a.a + (b.a - a.a) * t };
}

export function withAlpha(c: RGBA, a: number): RGBA {
  return { ...c, a };
}

export const WHITE: RGBA = { r: 255, g: 255, b: 255, a: 1 };
export const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 1 };

/** `fg` painted over an opaque `bg`. */
export function over(fg: RGBA, bg: RGBA): RGBA {
  const a = fg.a;
  return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
}

export function luminance(c: RGBA): number {
  const ch = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
}

/** WCAG contrast ratio (1–21) of `fg` on `bg`; translucent colors are composited first. */
export function contrast(fg: RGBA, bg: RGBA): number {
  const b = bg.a < 1 ? over(bg, WHITE) : bg;
  const f = fg.a < 1 ? over(fg, b) : fg;
  const [hi, lo] = [luminance(f), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export function isDark(c: RGBA): boolean {
  return luminance(c) < 0.18;
}

/** White text when it is readable enough on `bg`, a near-black otherwise. */
export function readableOn(bg: RGBA): RGBA {
  return contrast(WHITE, bg) >= 3.2 ? WHITE : { r: 17, g: 19, b: 24, a: 1 };
}

/** Value for `<input type=color>` (#rrggbb, alpha dropped). */
export function toHex6(input: string): string {
  const c = parseColor(input);
  if (!c) return '#000000';
  return formatColor({ ...c, a: 1 });
}
