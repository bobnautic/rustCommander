// Pretty-printer for XML (and SVG, XAML, project files ...). Only whitespace between elements is
// changed: text, CDATA, comments and attribute values stay exactly as they are, and elements with
// mixed content (text next to elements) or xml:space="preserve" are kept verbatim.

type XNode =
  | { type: 'el'; name: string; attrs: string; selfClosing: boolean; children: XNode[]; innerFrom: number; innerTo: number }
  | { type: 'text'; text: string }
  | { type: 'cdata'; text: string }
  | { type: 'raw'; text: string };

export class XmlFormatError extends Error {
  constructor(
    message: string,
    public pos: number,
  ) {
    super(message);
  }
}

function lineOf(text: string, pos: number): number {
  let line = 1;
  for (let i = text.indexOf('\n'); i !== -1 && i < pos; i = text.indexOf('\n', i + 1)) line++;
  return line;
}

function parse(src: string): XNode[] {
  const root: XNode[] = [];
  const stack: { node: Extract<XNode, { type: 'el' }>; from: number }[] = [];
  const add = (n: XNode) => (stack.length ? stack[stack.length - 1].node.children : root).push(n);
  let i = 0;
  const err = (msg: string, pos: number): never => {
    throw new XmlFormatError(`${msg} (line ${lineOf(src, pos)})`, pos);
  };
  const until = (end: string, from: number, what: string) => {
    const j = src.indexOf(end, from);
    if (j === -1) err(`Unterminated ${what}`, i);
    return j + end.length;
  };
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      add({ type: 'text', text: src.slice(i) });
      break;
    }
    if (lt > i) add({ type: 'text', text: src.slice(i, lt) });
    i = lt;
    if (src.startsWith('<!--', i)) {
      const end = until('-->', i + 4, 'comment');
      add({ type: 'raw', text: src.slice(i, end) });
      i = end;
    } else if (src.startsWith('<![CDATA[', i)) {
      const end = until(']]>', i + 9, 'CDATA section');
      add({ type: 'cdata', text: src.slice(i, end) });
      i = end;
    } else if (src.startsWith('<?', i)) {
      const end = until('?>', i + 2, 'processing instruction');
      add({ type: 'raw', text: src.slice(i, end) });
      i = end;
    } else if (src.startsWith('<!', i)) {
      // <!DOCTYPE ...> with an optional [internal subset]
      let j = i + 2;
      let depth = 0;
      for (; j < src.length; j++) {
        const c = src[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      if (j >= src.length) err('Unterminated declaration', i);
      add({ type: 'raw', text: src.slice(i, j + 1) });
      i = j + 1;
    } else if (src[i + 1] === '/') {
      const end = src.indexOf('>', i);
      if (end === -1) err('Unterminated closing tag', i);
      const name = src.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open) err(`Unexpected closing tag </${name}>`, i);
      if (open!.node.name !== name) err(`Closing tag </${name}> does not match <${open!.node.name}>`, i);
      open!.node.innerTo = i;
      i = end + 1;
    } else {
      // start tag: find the closing '>' outside of quoted attribute values
      let j = i + 1;
      let quote = '';
      for (; j < src.length; j++) {
        const c = src[j];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '>') break;
        else if (c === '<') err('Unexpected “<” inside a tag', j);
      }
      if (j >= src.length) err('Unterminated tag', i);
      let body = src.slice(i + 1, j);
      const selfClosing = body.endsWith('/');
      if (selfClosing) body = body.slice(0, -1);
      const m = /^([^\s/>]+)([\s\S]*)$/.exec(body);
      if (!m) err('Invalid tag', i);
      const node: Extract<XNode, { type: 'el' }> = { type: 'el', name: m![1], attrs: m![2], selfClosing, children: [], innerFrom: j + 1, innerTo: j + 1 };
      add(node);
      if (!selfClosing) stack.push({ node, from: i });
      i = j + 1;
    }
  }
  if (stack.length) {
    const open = stack[stack.length - 1];
    err(`<${open.node.name}> is not closed`, open.from);
  }
  return root;
}

/** Attributes separated by single spaces; kept as written when they do not parse cleanly. */
function formatAttrs(attrs: string): string {
  const trimmed = attrs.trim();
  if (!trimmed) return '';
  const parts: string[] = [];
  const re = /([^\s=]+)(\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
  let rest = trimmed;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed))) {
    parts.push(m[3] ? `${m[1]}=${m[3]}` : m[1]);
    rest = rest.replace(m[0], '');
  }
  return rest.trim() ? ' ' + trimmed.replace(/\s+/g, ' ') : ' ' + parts.join(' ');
}

const isBlank = (n: XNode) => n.type === 'text' && !n.text.trim();
const textLike = (n: XNode) => (n.type === 'text' && !!n.text.trim()) || n.type === 'cdata';

export function formatXml(src: string, indentUnit = '  '): string {
  const nodes = parse(src);
  const out: string[] = [];
  const print = (n: XNode, depth: number) => {
    const pad = indentUnit.repeat(depth);
    if (n.type === 'text') {
      if (n.text.trim()) out.push(pad + n.text.trim());
      return;
    }
    if (n.type === 'raw' || n.type === 'cdata') {
      out.push(pad + n.text);
      return;
    }
    const open = `<${n.name}${formatAttrs(n.attrs)}`;
    if (n.selfClosing) {
      out.push(`${pad}${open}/>`);
      return;
    }
    const inner = src.slice(n.innerFrom, n.innerTo);
    const kids = n.children.filter((c) => !isBlank(c));
    const preserve = /\bxml:space\s*=\s*["']preserve["']/.test(n.attrs);
    if (!kids.length) {
      out.push(`${pad}${open}>${inner.trim() ? inner : ''}</${n.name}>`);
    } else if (preserve || kids.some(textLike)) {
      // text content (alone or mixed with elements) is kept exactly
      out.push(`${pad}${open}>${inner}</${n.name}>`);
    } else {
      out.push(`${pad}${open}>`);
      for (const c of kids) print(c, depth + 1);
      out.push(`${pad}</${n.name}>`);
    }
  };
  for (const n of nodes) print(n, 0);
  return out.join('\n') + '\n';
}
