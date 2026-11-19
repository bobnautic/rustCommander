// A miniature Rust Commander drawn with a skin's tokens: the gallery thumbnails and the
// skin editor's preview. The tokens are set as CSS custom properties on the preview's root,
// so everything inside uses the skin without touching the rest of the page.
import type { CSSProperties } from 'react';
import { Archive, FileCode2, FileText, Folder, Image, ScrollText, Terminal } from 'lucide-react';
import type { Resolved } from '../lib/skins/engine';
import { cx } from './ui';

interface Row {
  name: string;
  cat: 'dir' | 'code' | 'image' | 'archive' | 'text' | 'document' | 'script';
  size?: string;
  cursor?: boolean;
  selected?: boolean;
}

const ICONS = { dir: Folder, code: FileCode2, image: Image, archive: Archive, text: FileText, document: FileText, script: ScrollText };

const LEFT: Row[] = [
  { name: '..', cat: 'dir' },
  { name: 'Documents', cat: 'dir' },
  { name: 'projects', cat: 'dir', cursor: true },
  { name: 'backup.tar.gz', cat: 'archive', size: '1.2 GB' },
  { name: 'main.rs', cat: 'code', size: '8.4 KB' },
  { name: 'photo.jpg', cat: 'image', size: '2.1 MB', selected: true },
  { name: 'notes.md', cat: 'text', size: '3 KB' },
  { name: 'report.pdf', cat: 'document', size: '640 KB' },
];
const RIGHT: Row[] = [
  { name: '..', cat: 'dir' },
  { name: 'www', cat: 'dir' },
  { name: 'index.html', cat: 'code', size: '12 KB' },
  { name: 'logo.png', cat: 'image', size: '48 KB', selected: true },
  { name: 'deploy.sh', cat: 'script', size: '1 KB' },
  { name: 'style.css', cat: 'code', size: '9 KB' },
  { name: 'access.log', cat: 'text', size: '5 MB' },
  { name: 'site.tar', cat: 'archive', size: '30 MB' },
];
const KEYS = ['Help', 'Menu', 'View', 'Edit', 'Copy', 'Move', 'Mkdir', 'Delete'];

export function skinStyle(r: Resolved): CSSProperties {
  return { ...(r.vars as CSSProperties), colorScheme: r.scheme };
}

function Panel({ rows, path, active, stripes }: { rows: Row[]; path: string; active: boolean; stripes: boolean }) {
  return (
    <div className={cx('skp-panel', active && 'active')}>
      <div className="skp-head">
        <span className="skp-session">{active ? 'local' : 'web-01'}</span>
      </div>
      <div className="skp-path">{path}</div>
      <div className="skp-rows">
        {rows.map((r, i) => {
          const Icon = ICONS[r.cat];
          return (
            <div key={r.name} className={cx('skp-row', stripes && i % 2 === 1 && 'odd', r.cat === 'dir' && 'dir', r.selected && 'sel', r.cursor && active && 'cursor', r.cursor && !active && 'cursor-inactive')}>
              <span className={cx('fi', `fi-${r.cat}`)}>
                <Icon size={13} strokeWidth={1.7} />
              </span>
              <span className="skp-name">{r.name}</span>
              <span className="skp-size">{r.size ?? ''}</span>
            </div>
          );
        })}
      </div>
      <div className="skp-status">{active ? '1 of 7 marked · 2.1 MB' : '1 of 7 marked'}</div>
    </div>
  );
}

function Code() {
  return (
    <pre className="skp-code">
      <span className="ln">1</span><span className="s-comment">{'// copy only what changed'}</span>{'\n'}
      <span className="ln">2</span><span className="s-keyword">fn</span> <span className="s-function">sync</span>(<span className="s-variable">src</span><span className="s-operator">:</span> <span className="s-operator">&amp;</span><span className="s-type">Path</span>) <span className="s-operator">-&gt;</span> <span className="s-type">Result</span>{'<'}<span className="s-type">u64</span>{'> {'}{'\n'}
      <span className="ln active">3</span><span className="skp-active-line">{'    '}<span className="s-keyword">let</span> <span className="s-variable">limit</span> <span className="s-operator">=</span> <span className="s-number">4096</span>;</span>{'\n'}
      <span className="ln">4</span>{'    '}<span className="s-function">println!</span>(<span className="s-string">"done: {'{'}limit{'}'}"</span>);{'\n'}
      <span className="ln">5</span>{'    '}<span className="s-keyword">return</span> <span className="s-constant">true</span>;{'\n'}
      <span className="ln">6</span>{'}'}
    </pre>
  );
}

function Term() {
  return (
    <pre className="skp-term">
      <span className="t-green">demo@web-01</span>:<span className="t-blue">~</span>$ ls{'\n'}
      <span className="t-blue">app</span>  <span className="t-blue">logs</span>  <span className="t-red">site.tar</span>  <span className="t-green">deploy.sh</span>{'\n'}
      <span className="t-yellow">warning:</span> <span className="t-gray">disk 81% full</span>{'\n'}
      <span className="t-green">demo@web-01</span>:<span className="t-blue">~</span>$ <span className="skp-term-cursor"> </span>
    </pre>
  );
}

/** `size="card"`: thumbnail for the gallery; `"full"`: with editor, terminal and controls. */
export function SkinPreview({ resolved, size = 'full', className }: { resolved: Resolved; size?: 'card' | 'full'; className?: string }) {
  const stripes = resolved.style.stripes;
  const keys = size === 'card' ? KEYS.slice(0, 6) : KEYS;
  return (
    <div className={cx('skp', `skp-${size}`, className)} style={skinStyle(resolved)} aria-hidden="true">
      <div className="skp-menubar">
        <span className="skp-logo" />
        {['File', 'Edit', 'View', 'Go', 'Tools'].map((m) => (
          <span key={m} className="skp-menu">
            {m}
          </span>
        ))}
      </div>
      <div className="skp-tabs">
        <span className="skp-tab on">local</span>
        <span className="skp-tab">web-01</span>
        <span className="skp-tab">s3 backup</span>
      </div>
      <div className="skp-panels">
        <Panel rows={LEFT} path="/home/demo" active stripes={stripes} />
        <Panel rows={RIGHT} path="/var/www/html" active={false} stripes={stripes} />
      </div>
      {size === 'full' && (
        <div className="skp-extras">
          <div className="skp-box">
            <div className="skp-box-head">main.rs</div>
            <Code />
          </div>
          <div className="skp-box skp-box-term">
            <div className="skp-box-head">
              <Terminal size={11} /> web-01
            </div>
            <Term />
          </div>
          <div className="skp-box skp-controls">
            <div className="skp-box-head">Copy</div>
            <div className="skp-controls-body">
              <span className="skp-input">*.txt; *.md</span>
              <div className="skp-badges">
                <span className="badge badge-ok">identical</span>
                <span className="badge badge-warn">different</span>
                <span className="badge badge-err">failed</span>
              </div>
              <div className="skp-progress">
                <span />
              </div>
              <div className="skp-buttons">
                <span className="btn btn-sm">Cancel</span>
                <span className="btn btn-sm btn-primary">Copy</span>
              </div>
            </div>
          </div>
        </div>
      )}
      <div className="skp-keybar">
        {keys.map((k, i) => (
          <span key={k} className="skp-key">
            <b>{i + 1}</b>
            <span>{k}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
