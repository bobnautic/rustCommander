import type { FileKind } from '../api/types';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

let locale = 'en';
export function setFormatLocale(l: string) {
  if (l !== locale) {
    locale = l;
    dateFmt = null;
    numFmt = null;
  }
}

let numFmt: Intl.NumberFormat | null = null;
function nf(): Intl.NumberFormat {
  return (numFmt ??= new Intl.NumberFormat(locale));
}

export function formatNumber(n: number): string {
  return nf().format(n);
}

/** Human readable size (1024-based). */
export function formatBytes(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  let v = n;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
  }
  // Decide the decimals on the rounded value: 99.97 KB shows as "100 KB", and
  // 1023.99 KB moves up to "1.0 MB" instead of "1,024 KB".
  const rounded = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
  let d = v >= 100 ? 0 : digits;
  if (rounded(v, d) >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u++;
    d = digits;
  }
  if (rounded(v, d) >= 100) d = 0;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: d, minimumFractionDigits: d }).format(v)} ${UNITS[u]}`;
}

export function formatSize(n: number, mode: 'auto' | 'bytes' = 'auto'): string {
  return mode === 'bytes' ? formatNumber(n) : formatBytes(n);
}

export function formatSpeed(bps: number): string {
  if (!bps || bps <= 0) return '';
  return `${formatBytes(bps)}/s`;
}

let dateFmt: ((d: Date) => string) | null = null;
/** Compact, sortable-looking date: '2026-09-13 09:41' (en) / '13.09.2026 09:41' (de). */
export function formatDate(ts: number | null | undefined): string {
  if (!ts) return '';
  if (!dateFmt) {
    const p = (x: number) => String(x).padStart(2, '0');
    dateFmt = locale.toLowerCase().startsWith('de')
      ? (d) => `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`
      : (d) => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  return dateFmt(new Date(ts * 1000));
}

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const p = (x: number, w = 2) => String(x).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function formatDuration(secs: number | null | undefined): string {
  if (secs === null || secs === undefined || !Number.isFinite(secs) || secs < 0) return '';
  const s = Math.round(secs);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${String(s % 60).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}

export function relativeTime(ts: number, now = Date.now() / 1000): { value: number; unit: Intl.RelativeTimeFormatUnit } {
  const diff = Math.round(ts - now);
  const abs = Math.abs(diff);
  if (abs < 60) return { value: diff, unit: 'second' };
  if (abs < 3600) return { value: Math.round(diff / 60), unit: 'minute' };
  if (abs < 86400) return { value: Math.round(diff / 3600), unit: 'hour' };
  return { value: Math.round(diff / 86400), unit: 'day' };
}

export function formatRelative(ts: number): string {
  const { value, unit } = relativeTime(ts);
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(value, unit);
}

/** 'drwxr-xr-x' style. */
export function formatPerms(mode: number | null | undefined, kind?: FileKind): string {
  if (mode === null || mode === undefined) return '';
  const t = kind === 'dir' ? 'd' : kind === 'symlink' ? 'l' : '-';
  const chars = ['r', 'w', 'x'];
  let s = '';
  for (let i = 8; i >= 0; i--) {
    const bit = (mode >> i) & 1;
    const who = Math.floor((8 - i) / 3); // 0 owner, 1 group, 2 other
    const c = chars[(8 - i) % 3];
    if (c === 'x') {
      const special = who === 0 ? mode & 0o4000 : who === 1 ? mode & 0o2000 : mode & 0o1000;
      const sc = who === 2 ? 't' : 's';
      s += special ? (bit ? sc : sc.toUpperCase()) : bit ? 'x' : '-';
    } else {
      s += bit ? c : '-';
    }
  }
  return t + s;
}

export function formatOctal(mode: number | null | undefined): string {
  if (mode === null || mode === undefined) return '';
  const m = mode & 0o7777;
  return m.toString(8).padStart(m > 0o777 ? 4 : 3, '0');
}

export function parseOctal(s: string): number | null {
  const t = s.trim();
  if (!/^[0-7]{1,4}$/.test(t)) return null;
  return parseInt(t, 8);
}

export function toDatetimeLocal(ts: number | null | undefined): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fromDatetimeLocal(s: string): number | null {
  if (!s) return null;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/** Parses '10M', '1.5 GB', '512k', '1000' into bytes. */
export function parseSize(s: string): number | null {
  const m = /^\s*(\d+(?:[.,]\d+)?)\s*([kmgt]?)i?b?\s*$/i.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase() as '' | 'k' | 'm' | 'g' | 't'];
  return Math.round(n * mult);
}

export function percent(done: number, total: number): number {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, (done / total) * 100));
}
