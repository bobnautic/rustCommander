export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export function utf8ToBase64(s: string): string {
  return bytesToBase64(enc.encode(s));
}

export function base64ToUtf8(b64: string): string {
  return dec.decode(base64ToBytes(b64));
}

/** Classic hex dump: offset, 16 hex bytes, ASCII. */
export function hexDump(bytes: Uint8Array, max = 4096): string {
  const lines: string[] = [];
  const n = Math.min(bytes.length, max);
  for (let off = 0; off < n; off += 16) {
    const row = bytes.subarray(off, Math.min(off + 16, n));
    const hex = Array.from(row, (b) => b.toString(16).padStart(2, '0'));
    while (hex.length < 16) hex.push('  ');
    const ascii = Array.from(row, (b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex.slice(0, 8).join(' ')}  ${hex.slice(8).join(' ')}  |${ascii}|`);
  }
  return lines.join('\n');
}
