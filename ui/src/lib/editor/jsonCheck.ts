// A strict JSON validator with exact error positions (JSON.parse messages and positions differ
// between WebView engines). Also reports duplicate keys, and optionally accepts the comments and
// trailing commas of "JSON with comments" files (tsconfig.json, VS Code settings, *.jsonc).

export type JsonProblemCode =
  | 'unexpectedEnd' | 'unexpectedChar' | 'expectedColon' | 'expectedComma' | 'expectedKey' | 'trailingComma'
  | 'comment' | 'badEscape' | 'controlChar' | 'badNumber' | 'unterminatedString' | 'duplicateKey' | 'extraContent' | 'tooDeep';

export interface JsonProblem {
  from: number;
  to: number;
  code: JsonProblemCode;
  severity: 'error' | 'warning';
  /** The offending character or the duplicated key. */
  detail?: string;
}

export interface JsonCheckOptions {
  comments: boolean;
  trailingCommas: boolean;
}

class Stop extends Error {}

export function checkJson(text: string, opts: JsonCheckOptions): JsonProblem[] {
  const problems: JsonProblem[] = [];
  let i = 0;
  const n = text.length;

  const fail = (code: JsonProblemCode, from = i, to = Math.min(from + 1, n), detail?: string): never => {
    problems.push({ from, to: Math.max(to, from), code, severity: 'error', detail });
    throw new Stop();
  };

  const skip = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) {
        i++;
      } else if (c === 47 /* / */ && (text[i + 1] === '/' || text[i + 1] === '*')) {
        const start = i;
        if (text[i + 1] === '/') {
          const end = text.indexOf('\n', i);
          i = end === -1 ? n : end;
        } else {
          const end = text.indexOf('*/', i + 2);
          if (end === -1) fail('unexpectedEnd', n, n);
          i = end + 2;
        }
        if (!opts.comments) fail('comment', start, i);
      } else if (c === 0xfeff && i === 0) {
        i++;
      } else break;
    }
  };

  const unexpected = (): never => {
    if (i >= n) fail('unexpectedEnd', n, n);
    const cp = text.codePointAt(i)!;
    return fail('unexpectedChar', i, i + (cp > 0xffff ? 2 : 1), String.fromCodePoint(cp));
  };

  const string = (): string => {
    const start = i;
    i++; // opening quote
    let out = '';
    let chunk = i;
    while (true) {
      if (i >= n) fail('unterminatedString', start, n);
      const c = text.charCodeAt(i);
      if (c === 34 /* " */) {
        out += text.slice(chunk, i);
        i++;
        return out;
      }
      if (c === 10 || c === 13) fail('unterminatedString', start, i);
      if (c < 32) fail('controlChar', i, i + 1);
      if (c === 92 /* \ */) {
        out += text.slice(chunk, i);
        const e = text[i + 1];
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail('badEscape', i, Math.min(i + 6, n));
          out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16));
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) {
          out += e;
          i += 2;
        } else {
          fail('badEscape', i, Math.min(i + 2, n));
        }
        chunk = i;
        continue;
      }
      i++;
    }
  };

  const number = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
    if (!m) fail('badNumber', i, i + 1);
    const end = i + m![0].length;
    // "01", "1.", "1e" and "-" are not numbers
    if (end < n && /[\d.eE+\-]/.test(text[end])) {
      let j = end;
      while (j < n && /[\w.+-]/.test(text[j])) j++;
      fail('badNumber', i, j);
    }
    i = end;
  };

  const value = (depth: number) => {
    if (depth > 1000) fail('tooDeep');
    skip();
    const c = text[i];
    if (c === '{') return object(depth);
    if (c === '[') return array(depth);
    if (c === '"') return void string();
    if (c === '-' || (c >= '0' && c <= '9')) return number();
    for (const word of ['true', 'false', 'null']) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return;
      }
    }
    unexpected();
  };

  const object = (depth: number) => {
    i++; // {
    const keys = new Map<string, number>();
    skip();
    if (text[i] === '}') {
      i++;
      return;
    }
    while (true) {
      skip();
      if (text[i] !== '"') fail('expectedKey');
      const keyStart = i;
      const key = string();
      if (keys.has(key)) problems.push({ from: keyStart, to: i, code: 'duplicateKey', severity: 'warning', detail: key });
      keys.set(key, keyStart);
      skip();
      if (text[i] !== ':') fail('expectedColon');
      i++;
      value(depth + 1);
      skip();
      if (text[i] === ',') {
        const comma = i;
        i++;
        skip();
        if (text[i] === '}') {
          if (!opts.trailingCommas) fail('trailingComma', comma, comma + 1);
          i++;
          return;
        }
        continue;
      }
      if (text[i] === '}') {
        i++;
        return;
      }
      if (i >= n) fail('unexpectedEnd', n, n);
      fail('expectedComma', i, i + 1, '}');
    }
  };

  const array = (depth: number) => {
    i++; // [
    skip();
    if (text[i] === ']') {
      i++;
      return;
    }
    while (true) {
      value(depth + 1);
      skip();
      if (text[i] === ',') {
        const comma = i;
        i++;
        skip();
        if (text[i] === ']') {
          if (!opts.trailingCommas) fail('trailingComma', comma, comma + 1);
          i++;
          return;
        }
        continue;
      }
      if (text[i] === ']') {
        i++;
        return;
      }
      if (i >= n) fail('unexpectedEnd', n, n);
      fail('expectedComma', i, i + 1, ']');
    }
  };

  try {
    skip();
    if (i >= n) return problems; // empty file
    value(0);
    skip();
    if (i < n) fail('extraContent', i, n);
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
  }
  return problems;
}

/** File names that are "JSON with comments" by convention. */
export function isJsonWithComments(fileName: string): boolean {
  return /\.jsonc$|^(ts|js)config(\..+)?\.json$|^\.(eslintrc|babelrc|swcrc|jshintrc)(\.json)?$|^(settings|keybindings|launch|tasks|extensions|devcontainer|\.devcontainer)\.json$|\.code-workspace$/i.test(fileName);
}

/** Sorts object keys recursively (stable for arrays). */
export function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort((a, b) => a.localeCompare(b))) out[k] = sortJsonKeys((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}
