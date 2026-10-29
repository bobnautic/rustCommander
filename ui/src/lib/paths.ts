// Path helpers for '/'-separated session paths ('/home/x', 'C:/Users/x').

const DRIVE_RE = /^[A-Za-z]:/;

export function isDrivePath(p: string): boolean {
  return DRIVE_RE.test(p);
}

export function normalize(p: string): string {
  if (!p) return '/';
  let s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (DRIVE_RE.test(s)) {
    if (s.length === 2) return s + '/';
  } else if (!s.startsWith('/')) {
    s = '/' + s;
  }
  if (s.length > 1 && s.endsWith('/') && !/^[A-Za-z]:\/$/.test(s)) s = s.slice(0, -1);
  return s;
}

export function isRoot(p: string): boolean {
  return p === '/' || p === '' || /^[A-Za-z]:\/?$/.test(p);
}

/** Parent directory, or null when `p` is a root. */
export function parent(p: string): string | null {
  const n = normalize(p);
  if (isRoot(n)) return null;
  const i = n.lastIndexOf('/');
  if (i <= 0) return '/';
  const head = n.slice(0, i);
  if (/^[A-Za-z]:$/.test(head)) return head + '/';
  return head;
}

export function basename(p: string): string {
  const n = normalize(p);
  if (isRoot(n)) return n;
  return n.slice(n.lastIndexOf('/') + 1);
}

export function dirname(p: string): string {
  return parent(p) ?? normalize(p);
}

export function join(dir: string, ...names: string[]): string {
  let out = normalize(dir);
  for (const name of names) {
    if (!name) continue;
    out = out.endsWith('/') ? out + name : out + '/' + name;
  }
  return normalize(out);
}

export function isAbsolute(p: string): boolean {
  return p.startsWith('/') || DRIVE_RE.test(p) || p.startsWith('\\');
}

/** Resolve user input (absolute or relative, with `.`/`..`) against `base`. `~` = `home`. */
export function resolve(base: string, input: string, home?: string): string {
  let s = input.trim().replace(/\\/g, '/');
  if (!s) return normalize(base);
  if (home && (s === '~' || s.startsWith('~/'))) s = home + s.slice(1);
  const abs = isAbsolute(s) ? s : join(base, s);
  const n = normalize(abs);
  let prefix = '';
  let rest = n;
  const m = /^([A-Za-z]:)\/?(.*)$/.exec(n);
  if (m) {
    prefix = m[1];
    rest = m[2];
  } else {
    rest = n.slice(1);
  }
  const out: string[] = [];
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return prefix ? `${prefix}/${out.join('/')}` : '/' + out.join('/');
}

export interface Crumb {
  label: string;
  path: string;
}

export function crumbs(p: string): Crumb[] {
  const n = normalize(p);
  const res: Crumb[] = [];
  let acc: string;
  let rest: string;
  const m = /^([A-Za-z]:)\/?(.*)$/.exec(n);
  if (m) {
    acc = m[1] + '/';
    res.push({ label: m[1], path: acc });
    rest = m[2];
  } else {
    acc = '/';
    res.push({ label: '/', path: '/' });
    rest = n.slice(1);
  }
  for (const seg of rest.split('/')) {
    if (!seg) continue;
    acc = join(acc, seg);
    res.push({ label: seg, path: acc });
  }
  return res;
}

/** Path of `p` relative to `base` ('' when equal), or null when `p` is not below `base`. */
export function relativeTo(base: string, p: string): string | null {
  const b = normalize(base);
  const n = normalize(p);
  if (b === n) return '';
  const prefix = b.endsWith('/') ? b : b + '/';
  if (!n.startsWith(prefix)) return null;
  return n.slice(prefix.length);
}

/** Lower-case extension without the dot ('' if none). Dotfiles have no extension. */
export function extname(name: string): string {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

/** Splits 'name.ext' into ['name', '.ext'] (for selecting the stem when renaming). */
export function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf('.');
  if (i <= 0) return [name, ''];
  return [name.slice(0, i), name.slice(i)];
}

export function isValidName(name: string): boolean {
  return !!name && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0');
}
