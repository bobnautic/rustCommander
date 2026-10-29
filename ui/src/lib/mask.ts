// WinSCP-style file masks: '*.jpg; *.png | thumbs/; *.tmp'
//   left of '|' = include, right = exclude; ';' or ',' separate masks; a trailing '/' targets directories.

interface Matcher {
  re: RegExp;
  dirOnly: boolean;
}

export interface CompiledMask {
  include: Matcher[];
  exclude: Matcher[];
  empty: boolean;
}

export function globToRegExp(glob: string, caseSensitive = false): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end > i) {
        let cls = glob.slice(i + 1, end);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += '[' + cls.replace(/\\/g, '\\\\') + ']';
        i = end;
      } else re += '\\[';
    } else re += c.replace(/[.+^${}()|\\\]]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', caseSensitive ? '' : 'i');
}

function parseList(s: string): Matcher[] {
  return s
    .split(/[;,]/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((m) => {
      const dirOnly = m.endsWith('/');
      const pat = dirOnly ? m.slice(0, -1) : m;
      // '*.*' traditionally means "everything", including names without a dot.
      return { re: pat === '*.*' ? /^.*$/ : globToRegExp(pat), dirOnly };
    });
}

export function compileMask(mask: string): CompiledMask {
  const [inc = '', exc = ''] = mask.split('|');
  const include = parseList(inc);
  const exclude = parseList(exc);
  return { include, exclude, empty: include.length === 0 && exclude.length === 0 };
}

/**
 * For transfers: directories are included unless excluded explicitly (so traversal continues);
 * files must match an include mask (if any) and no exclude mask.
 */
export function matchTransferMask(m: CompiledMask, name: string, isDir: boolean): boolean {
  if (m.empty) return true;
  for (const x of m.exclude) if (x.dirOnly === isDir && x.re.test(name)) return false;
  if (isDir) {
    const dirIncludes = m.include.filter((x) => x.dirOnly);
    return dirIncludes.length === 0 || dirIncludes.some((x) => x.re.test(name));
  }
  const fileIncludes = m.include.filter((x) => !x.dirOnly);
  return fileIncludes.length === 0 || fileIncludes.some((x) => x.re.test(name));
}

/** For selection (+/- dialog): masks without '/' match files and directories alike. */
export function matchSelectMask(m: CompiledMask, name: string, isDir: boolean): boolean {
  if (m.empty) return false;
  for (const x of m.exclude) if ((!x.dirOnly || isDir) && x.re.test(name)) return false;
  if (m.include.length === 0) return true;
  return m.include.some((x) => (!x.dirOnly || isDir) && x.re.test(name));
}
