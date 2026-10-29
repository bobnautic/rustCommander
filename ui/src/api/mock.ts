// In-memory fake backend. Implements (almost) the whole RpcMethods contract and emits events,
// so the UI can be developed, tested and demoed without the Rust backend (?mock=1).
import type * as T from './types';
import { SECRET_PLACEHOLDER } from './types';
import { compileMask, matchTransferMask } from '../lib/mask';
import * as P from '../lib/paths';
import { bytesToBase64, utf8ToBase64 } from '../lib/base64';
import { TEXT, logoSvg, now, photoSvg, rand } from './mockData';

export interface MockOptions {
  webMode: boolean;
  locked: boolean;
  login: boolean;
  fast: boolean;
}

export interface MockBackend {
  call(method: string, params: unknown): Promise<unknown>;
  webInfo(): { name: string; version: string; authRequired: boolean; authenticated: boolean };
  webLogin(password: string): boolean;
  upload(session: string, path: string, file: File, onProgress: (done: number) => void, signal: AbortSignal): Promise<void>;
  download(session: string, paths: string[]): Promise<{ blob: Blob; name: string }>;
}

type Emit = (name: string, payload: unknown) => void;
type Dict = Record<string, unknown>;

class MockError extends Error {
  constructor(public code: T.RpcError['code'], message: string) {
    super(message);
  }
}

const fail = (code: T.RpcError['code'], message: string): never => {
  throw new MockError(code, message);
};

// ---------------------------------------------------------------- in-memory file system

interface MNode {
  name: string;
  kind: 'file' | 'dir' | 'symlink';
  size: number;
  modified: number;
  permissions: number;
  owner: string;
  group: string;
  content?: string;
  svg?: string;
  children?: Map<string, MNode>;
  linkTarget?: string;
  targetKind?: T.FileKind;
  /** Listing/reading is refused (permission denied). */
  denied?: boolean;
  /** Writing into this directory is refused. */
  readonly?: boolean;
}

interface NodeOpts {
  age?: number;
  perm?: number;
  owner?: string;
  group?: string;
  denied?: boolean;
  readonly?: boolean;
}

const enc = new TextEncoder();
const byteLen = (s: string) => enc.encode(s).length;
const ago = (secs: number) => now - Math.floor(secs);
const randAge = () => Math.floor(rand() * 86400 * 120) + 600;

let defaultOwner = 'demo';
function mk(name: string, kind: MNode['kind'], o: NodeOpts = {}): MNode {
  return {
    name,
    kind,
    size: 0,
    modified: ago(o.age ?? randAge()),
    permissions: o.perm ?? (kind === 'dir' ? 0o755 : 0o644),
    owner: o.owner ?? defaultOwner,
    group: o.group ?? o.owner ?? defaultOwner,
    denied: o.denied,
    readonly: o.readonly,
  };
}

function dir(name: string, children: MNode[], o: NodeOpts = {}): MNode {
  const n = mk(name, 'dir', o);
  n.size = 4096;
  n.children = new Map(children.map((c) => [c.name, c]));
  return n;
}

function file(name: string, content: string | number, o: NodeOpts = {}): MNode {
  const n = mk(name, 'file', o);
  if (typeof content === 'string') {
    n.content = content;
    n.size = byteLen(content);
  } else n.size = content;
  return n;
}

function image(name: string, svg: string, size: number, o: NodeOpts = {}): MNode {
  const n = mk(name, 'file', o);
  n.svg = svg;
  n.size = size;
  return n;
}

function link(name: string, target: string, targetKind: T.FileKind, o: NodeOpts = {}): MNode {
  const n = mk(name, 'symlink', { perm: 0o777, ...o });
  n.linkTarget = target;
  n.targetKind = targetKind;
  n.size = target.length;
  return n;
}

function cloneNode(n: MNode): MNode {
  const c: MNode = { ...n };
  if (n.children) c.children = new Map([...n.children].map(([k, v]) => [k, cloneNode(v)]));
  return c;
}

class MemFs {
  constructor(
    public root: MNode,
    public home: string,
    public user: string,
    public totalBytes: number,
  ) {}

  private walk(path: string, followLast: boolean, depth = 0): MNode | null {
    if (depth > 8) return null;
    const n = P.normalize(path);
    const segs = n.split('/').filter(Boolean);
    let cur: MNode = this.root;
    let curPath = '/';
    for (let i = 0; i < segs.length; i++) {
      if (cur.kind === 'symlink') {
        const t = this.walk(P.resolve(P.dirname(curPath), cur.linkTarget ?? ''), true, depth + 1);
        if (!t) return null;
        cur = t;
      }
      if (cur.kind !== 'dir' || !cur.children) return null;
      const next = cur.children.get(segs[i]);
      if (!next) return null;
      cur = next;
      curPath = P.join(curPath, segs[i]);
    }
    if (followLast && cur.kind === 'symlink') {
      return this.walk(P.resolve(P.dirname(curPath), cur.linkTarget ?? ''), true, depth + 1);
    }
    return cur;
  }

  get(path: string, follow = true): MNode | null {
    return this.walk(path, follow);
  }

  must(path: string, follow = true): MNode {
    return this.get(path, follow) ?? fail('not_found', `No such file or directory: ${path}`);
  }

  dirNode(path: string): MNode {
    const n = this.must(path);
    if (n.kind !== 'dir') fail('not_a_directory', `Not a directory: ${path}`);
    return n;
  }

  entry(n: MNode, path: string): T.FileEntry {
    const e: T.FileEntry = {
      name: n.name,
      path,
      kind: n.kind,
      size: n.kind === 'dir' ? 0 : n.size,
      modified: n.modified,
      permissions: n.permissions,
      owner: n.owner,
      group: n.group,
      hidden: n.name.startsWith('.'),
    };
    if (n.kind === 'symlink') {
      e.linkTarget = n.linkTarget;
      const t = this.get(path, true);
      e.targetKind = t ? t.kind : n.targetKind;
    }
    return e;
  }

  list(path: string): T.FileEntry[] {
    const d = this.dirNode(path);
    if (d.denied) fail('permission_denied', `Permission denied: ${path}`);
    return [...d.children!.values()].map((c) => this.entry(c, P.join(path, c.name)));
  }

  parentFor(path: string): { dir: MNode; name: string } {
    const par = P.parent(path) ?? fail('invalid_input', 'Cannot modify the root directory');
    const d = this.get(par);
    if (!d) fail('not_found', `No such directory: ${par}`);
    if (d!.kind !== 'dir') fail('not_a_directory', `Not a directory: ${par}`);
    return { dir: d!, name: P.basename(path) };
  }

  checkWritable(dirNode: MNode, path: string) {
    if (dirNode.readonly || dirNode.denied) fail('permission_denied', `Permission denied: ${path}`);
  }

  put(path: string, node: MNode) {
    const { dir: d, name } = this.parentFor(path);
    this.checkWritable(d, P.dirname(path));
    node.name = name;
    d.children!.set(name, node);
    d.modified = now + Math.floor((Date.now() / 1000) - now);
  }

  mkdir(path: string, parents: boolean) {
    const existing = this.get(path);
    if (existing) {
      if (parents && existing.kind === 'dir') return;
      fail('already_exists', `Already exists: ${path}`);
    }
    if (parents) {
      const par = P.parent(path);
      if (par && !this.get(par)) this.mkdir(par, true);
    }
    const n = mk(P.basename(path), 'dir', { age: 0, owner: this.user });
    n.size = 4096;
    n.children = new Map();
    this.put(path, n);
  }

  remove(path: string) {
    const { dir: d, name } = this.parentFor(path);
    this.checkWritable(d, P.dirname(path));
    if (!d.children!.delete(name)) fail('not_found', `No such file: ${path}`);
  }

  usedBytes(n: MNode = this.root): number {
    if (n.kind === 'dir') return [...n.children!.values()].reduce((s, c) => s + this.usedBytes(c), 0);
    return n.size;
  }
}

// ---------------------------------------------------------------- fake trees

function buildLocalFs(): MemFs {
  defaultOwner = 'demo';
  const photos = Array.from({ length: 12 }, (_, i) => {
    const name = `IMG_${String(2041 + i).padStart(4, '0')}.jpg`;
    return image(name, photoSvg(i, name), 2_400_000 + Math.floor(rand() * 3_000_000), { age: 86400 * (40 + i) });
  });
  const website = dir('website', [
    file('index.html', TEXT.indexHtml('ACME Corp', '\n    <p>New: <a href="contact.html">contact us</a>.</p>'), { age: 3600 * 2 }),
    file('about.html', TEXT.indexHtml('About ACME'), { age: 86400 * 3 }),
    file('contact.html', TEXT.indexHtml('Contact'), { age: 3600 * 5 }),
    dir('css', [file('style.css', TEXT.css('#e8743b'), { age: 3600 * 3 })]),
    dir('js', [file('app.js', TEXT.appJs, { age: 86400 * 20 })]),
    dir('img', [image('logo.svg', logoSvg('#e8743b', 'ACME'), 812, { age: 86400 * 60 }), image('hero.jpg', photoSvg(3, 'hero.jpg'), 384_211, { age: 86400 * 9 })]),
    file('README.md', TEXT.readmeSite, { age: 86400 * 30 }),
    file('package.json', TEXT.packageJson, { age: 86400 * 30 }),
    file('.gitignore', TEXT.gitignore, { age: 86400 * 90 }),
    file('deploy.sh', TEXT.deploySh, { age: 86400 * 14, perm: 0o755 }),
  ]);
  const root = dir('/', [
    dir('home', [
      dir('demo', [
        file('.bashrc', TEXT.bashrc, { age: 86400 * 200 }),
        file('.profile', TEXT.profile, { age: 86400 * 400 }),
        dir('.ssh', [
          file('config', TEXT.sshConfig, { perm: 0o600 }),
          file('id_ed25519', TEXT.privKey, { perm: 0o600, age: 86400 * 300 }),
          file('id_ed25519.pub', TEXT.pubKey, { age: 86400 * 300 }),
          file('known_hosts', TEXT.knownHosts, { perm: 0o600 }),
        ], { perm: 0o700 }),
        dir('.config', [dir('rcmd', [file('settings.json', '{\n  "theme": "system"\n}\n')])]),
        dir('Desktop', [file('todo.txt', TEXT.todo, { age: 3600 * 20 }), file('servers.json', '{\n  "web": { "host": "web.example.com", "port": 22 },\n  "db": { "host": "db.example.com", "port": 5432 },\n  "web": { "host": "web2.example.com" },\n}\n', { age: 3600 * 2 })]),
        dir('Documents', [
          file('Invoice-2026-0142.pdf', 184_220),
          file('Quarterly report Q3.docx', 1_288_002),
          file('budget-2027.xlsx', 96_511),
          file('meeting-notes.md', TEXT.notesMd, { age: 3600 * 30 }),
          dir('Contracts', [file('nda-acme.pdf', 220_481), file('hosting-agreement.pdf', 402_119)]),
        ]),
        dir('Downloads', [
          file('ubuntu-24.04.1-live-server-amd64.iso', 2_773_874_688, { age: 86400 * 12 }),
          file('rust-commander-0.9.0-x86_64.tar.gz', 14_838_211, { age: 86400 * 2 }),
          file('photos-2025.zip', 734_003_200, { age: 86400 * 50 }),
          file('setup.exe', 88_221_734),
          file('docker-compose.yml', TEXT.compose, { age: 86400 * 4 }),
        ]),
        dir('Pictures', [
          ...photos,
          image('screenshot-2026-10-27.png', photoSvg(5, 'screenshot'), 512_330, { age: 86400 * 2 }),
          dir('Wallpapers', [image('mountains.jpg', photoSvg(1, 'mountains.jpg'), 4_120_000), image('sea.jpg', photoSvg(4, 'sea.jpg'), 3_900_000)]),
        ]),
        dir('Music', [file('01 - Intro.mp3', 4_210_334), file('02 - Northern Lights.mp3', 7_838_100), file('03 - Outro.flac', 31_002_441)]),
        dir('Videos', [file('drone-flight.mp4', 512_884_221), file('talk-rustconf.mkv', 1_402_331_993)]),
        dir('projects', [
          website,
          dir('rust-commander', [
            file('Cargo.toml', TEXT.cargoToml, { age: 3600 * 8 }),
            dir('src', [file('main.rs', TEXT.mainRs, { age: 3600 }), file('lib.rs', TEXT.libRs, { age: 3600 * 4 })]),
            file('README.md', '# Rust Commander\n\nA dual-pane file manager written in Rust.\n'),
            dir('target', [file('.rustc_info.json', '{}\n')]),
          ]),
          link('current-site', '/home/demo/projects/website', 'dir'),
        ]),
        file('notes.txt', TEXT.notesTxt, { age: 3600 * 50 }),
        file('backup-2026-10-01.tar.gz', 1_220_331_872, { age: 86400 * 28 }),
        link('www', 'projects/website', 'dir'),
      ], { perm: 0o750 }),
    ], { owner: 'root' }),
    dir('etc', [file('hosts', TEXT.hosts('demo-workstation'), { owner: 'root' }), file('hostname', 'demo-workstation\n', { owner: 'root' })], { owner: 'root', readonly: true }),
    dir('tmp', [], { perm: 0o1777, owner: 'root' }),
    dir('var', [dir('log', [file('syslog', TEXT.deployLog, { owner: 'root', perm: 0o640 })], { owner: 'root' })], { owner: 'root' }),
    dir('root', [], { owner: 'root', perm: 0o700, denied: true }),
  ], { owner: 'root' });
  return new MemFs(root, '/home/demo', 'demo', 512 * 1024 ** 3);
}

function buildServerFs(host: string, user: string): MemFs {
  defaultOwner = user || 'deploy';
  const u = user || 'deploy';
  const short = host.split('.')[0];
  const releases = ['2026-10-14', '2026-10-21', '2026-10-28'];
  const homeChildren: MNode[] = [
    file('.bashrc', TEXT.bashrc, { age: 86400 * 500 }),
    file('.profile', TEXT.profile, { age: 86400 * 500 }),
    dir('.ssh', [file('authorized_keys', TEXT.pubKey, { perm: 0o600 })], { perm: 0o700 }),
    dir('app', [
      dir('releases', releases.map((r, i) => dir(r, [file('app.jar', 48_200_000 + i * 100_000), file('VERSION', `2.4.${i}\n`)], { age: 86400 * (14 - i * 7) }))),
      link('current', `/home/${u}/app/releases/${releases[2]}`, 'dir'),
      file('docker-compose.yml', TEXT.compose),
    ]),
    dir('backups', [file('db-2026-10-27.sql.gz', 88_420_113), file('db-2026-10-28.sql.gz', 88_731_002, { age: 3600 * 9 })]),
    file('deploy.log', TEXT.deployLog, { age: 3600 * 9 }),
  ];
  const root = dir('/', [
    dir('home', [dir(u, homeChildren)], { owner: 'root' }),
    dir('var', [
      dir('www', [
        dir('html', [
          file('index.html', TEXT.indexHtml('ACME Corp'), { age: 86400 * 6, owner: 'www-data' }),
          file('about.html', TEXT.indexHtml('About ACME'), { age: 86400 * 3, owner: 'www-data' }),
          dir('css', [file('style.css', TEXT.css('#2f6fde'), { age: 86400 * 6, owner: 'www-data' })], { owner: 'www-data' }),
          dir('js', [file('app.js', TEXT.appJs, { age: 86400 * 20, owner: 'www-data' })], { owner: 'www-data' }),
          dir('img', [image('logo.svg', logoSvg('#e8743b', 'ACME'), 812, { age: 86400 * 60, owner: 'www-data' })], { owner: 'www-data' }),
          file('old-landing.html', TEXT.indexHtml('Old landing page'), { age: 86400 * 300, owner: 'www-data' }),
          file('robots.txt', TEXT.robots, { age: 86400 * 100, owner: 'www-data' }),
          file('.htaccess', 'Options -Indexes\n', { age: 86400 * 100, owner: 'www-data' }),
        ], { owner: 'www-data', group: 'www-data', perm: 0o775 }),
      ], { owner: 'root' }),
      dir('log', [
        dir('nginx', [file('access.log', TEXT.accessLog, { age: 120, owner: 'www-data', group: 'adm', perm: 0o640 }), file('error.log', TEXT.errorLog, { age: 3600, owner: 'www-data', group: 'adm', perm: 0o640 })], { owner: 'root' }),
        file('auth.log', 'restricted\n', { owner: 'syslog', group: 'adm', perm: 0o640 }),
      ], { owner: 'root' }),
    ], { owner: 'root' }),
    dir('etc', [
      dir('nginx', [file('nginx.conf', TEXT.nginxConf, { owner: 'root' }), dir('sites-available', [file('default', TEXT.siteDefault, { owner: 'root' })], { owner: 'root' })], { owner: 'root', readonly: true }),
      dir('ssh', [file('sshd_config', TEXT.sshdConfig, { owner: 'root', perm: 0o600 })], { owner: 'root', readonly: true, denied: true }),
      file('hosts', TEXT.hosts(short), { owner: 'root' }),
      file('hostname', `${short}\n`, { owner: 'root' }),
    ], { owner: 'root', readonly: true }),
    dir('srv', [dir('data', [file('export.csv', 'id,name,amount\n1,Alpha,10\n2,Beta,20\n3,Gamma,30\n')])], { owner: 'root' }),
    dir('tmp', [], { perm: 0o1777, owner: 'root' }),
    dir('root', [], { owner: 'root', perm: 0o700, denied: true }),
    dir('opt', [], { owner: 'root', readonly: true }),
  ], { owner: 'root' });
  return new MemFs(root, `/home/${u}`, u, 80 * 1024 ** 3);
}

function buildBucketFs(bucket: string): MemFs {
  defaultOwner = '';
  const root = dir('/', [
    dir(bucket || 'rc-backups', [
      dir('daily', Array.from({ length: 7 }, (_, i) => file(`backup-2026-10-${String(22 + i).padStart(2, '0')}.tar.zst`, 900_000_000 + i * 12_000_000, { age: 86400 * (7 - i) }))),
      dir('static', [image('logo.svg', logoSvg('#2f6fde', 'S3'), 790), file('index.html', TEXT.indexHtml('Static site'))]),
      file('README.txt', 'Backups are kept for 30 days.\n'),
    ]),
    dir('public-assets', [file('favicon.ico', 15_086)]),
  ]);
  for (const n of walkAll(root)) {
    n.owner = '';
    n.group = '';
    n.permissions = n.kind === 'dir' ? 0o755 : 0o644;
  }
  return new MemFs(root, '/', '', 0);
}

function* walkAll(n: MNode): Generator<MNode> {
  yield n;
  if (n.children) for (const c of n.children.values()) yield* walkAll(c);
}

// ---------------------------------------------------------------- defaults

const ALL_PROTOCOLS: T.Protocol[] = ['sftp', 'scp', 'ftp', 'webdav', 's3', 'azure', 'gcs', 'rcmd'];

const CAPS: Record<T.Protocol, T.Capabilities> = {
  local: { permissions: true, owner: true, symlinks: true, exec: true, terminal: true, tunnels: false, serverCopy: true, resumeUpload: true, resumeDownload: true, setModified: true, serverChecksum: true, diskInfo: true },
  sftp: { permissions: true, owner: true, symlinks: true, exec: true, terminal: true, tunnels: true, serverCopy: true, resumeUpload: true, resumeDownload: true, setModified: true, serverChecksum: true, diskInfo: true },
  scp: { permissions: true, owner: true, symlinks: true, exec: true, terminal: true, tunnels: true, serverCopy: true, resumeUpload: false, resumeDownload: false, setModified: true, serverChecksum: true, diskInfo: true },
  ftp: { permissions: true, owner: false, symlinks: false, exec: false, terminal: false, tunnels: false, serverCopy: false, resumeUpload: true, resumeDownload: true, setModified: true, serverChecksum: false, diskInfo: false },
  webdav: { permissions: false, owner: false, symlinks: false, exec: false, terminal: false, tunnels: false, serverCopy: true, resumeUpload: false, resumeDownload: true, setModified: false, serverChecksum: false, diskInfo: true },
  s3: { permissions: false, owner: false, symlinks: false, exec: false, terminal: false, tunnels: false, serverCopy: true, resumeUpload: false, resumeDownload: true, setModified: false, serverChecksum: true, diskInfo: false },
  azure: { permissions: false, owner: false, symlinks: false, exec: false, terminal: false, tunnels: false, serverCopy: true, resumeUpload: false, resumeDownload: true, setModified: false, serverChecksum: true, diskInfo: false },
  gcs: { permissions: false, owner: false, symlinks: false, exec: false, terminal: false, tunnels: false, serverCopy: true, resumeUpload: false, resumeDownload: true, setModified: false, serverChecksum: true, diskInfo: false },
  rcmd: { permissions: true, owner: true, symlinks: true, exec: true, terminal: true, tunnels: false, serverCopy: true, resumeUpload: true, resumeDownload: true, setModified: true, serverChecksum: true, diskInfo: true },
};

const DEFAULT_PORT: Record<T.Protocol, number> = { local: 0, sftp: 22, scp: 22, ftp: 21, webdav: 443, s3: 443, azure: 443, gcs: 443, rcmd: 8822 };

function defaultTransfer(): T.TransferOptions {
  return {
    move: false,
    overwrite: 'ask',
    preserveTimestamps: true,
    preservePermissions: true,
    permissions: null,
    mode: 'binary',
    textMasks: '*.txt; *.html; *.htm; *.php; *.css; *.js; *.xml; *.sh; *.md; *.conf',
    fileMask: '',
    excludeHidden: false,
    speedLimit: 0,
    tempUpload: true,
    verifyChecksum: false,
    parallel: 2,
    newName: null,
    followSymlinks: false,
  };
}

function defaultSettings(): T.Settings {
  return {
    language: 'auto',
    theme: 'system',
    showHidden: false,
    confirmDelete: true,
    confirmOverwrite: true,
    doubleClickAction: 'edit',
    sizeFormat: 'auto',
    maxConcurrentJobs: 2,
    transfer: defaultTransfer(),
    discovery: { enabled: true, port: 8823, instanceName: 'demo-workstation', intervalSecs: 30 },
    server: { autoStart: false, bind: '0.0.0.0', port: 8822, tls: true, allowTerminal: true },
    editor: { fontSize: 13, wordWrap: false, tabSize: 4, lint: true, formatOnSave: false, printWidth: 80 },
    terminal: { fontSize: 13, fontFamily: 'ui-monospace, "Cascadia Code", "JetBrains Mono", Menlo, Consolas, monospace', scrollback: 5000 },
  };
}

function siteTemplate(protocol: T.Protocol = 'sftp'): T.SiteConfig {
  return {
    id: '',
    name: '',
    folder: '',
    protocol,
    host: '',
    port: 0,
    username: '',
    password: null,
    remoteDir: '',
    localDir: '',
    timeoutSecs: 15,
    keepaliveSecs: 30,
    color: null,
    notes: '',
    ssh: {
      privateKeyPath: null, privateKey: null, passphrase: null, useAgent: true, tryPassword: true, tryKeyboardInteractive: true,
      tryDefaultKeys: true, compression: false, sftpServer: null, jumpSiteId: null, env: [], shell: null, useOpensshKnownHosts: true,
    },
    ftp: { encryption: 'explicit', passive: true, allowInvalidCerts: false, useMlsd: true, maxConnections: 4 },
    webdav: { https: true, root: '/', allowInvalidCerts: false },
    s3: { region: 'us-east-1', endpoint: '', bucket: '', pathStyle: false, sessionToken: null, anonymous: false },
    azure: { account: '', container: '', endpoint: '', sasToken: null },
    gcs: { bucket: '', credentialJson: null, endpoint: '' },
    rcmd: { tls: true, fingerprint: null },
    proxy: { kind: 'none', host: '', port: 0, username: '', password: null },
  };
}

function site(id: string, partial: Partial<T.SiteConfig>): T.SiteConfig {
  return { ...siteTemplate(partial.protocol), id, ...partial };
}

const deepClone = <X>(x: X): X => JSON.parse(JSON.stringify(x)) as X;

function fakeFingerprint(s: string): string {
  let h = 2166136261;
  const out: number[] = [];
  for (let i = 0; i < 32; i++) {
    for (const ch of s + i) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    out.push((h >>> 0) & 0xff);
  }
  return 'SHA256:' + btoa(String.fromCharCode(...out)).replace(/=+$/, '');
}

function fakeHex(s: string, len: number): string {
  let h = 0x811c9dc5;
  let out = '';
  let i = 0;
  while (out.length < len) {
    for (const ch of s + i) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
    out += (h >>> 0).toString(16).padStart(8, '0');
    i++;
  }
  return out.slice(0, len);
}

// ---------------------------------------------------------------- backend

interface MSession {
  summary: T.SessionSummary;
  fs: MemFs;
  site: T.SiteConfig | null;
}

type Step =
  | { t: 'mkdir'; fs: MemFs; path: string; session: string }
  | { t: 'copy'; src: MemFs; srcPath: string; node: MNode; dst: MemFs; dstPath: string; size: number; dstSession: string; checked?: boolean }
  | { t: 'delete'; fs: MemFs; path: string; session: string }
  | { t: 'create'; fs: MemFs; path: string; node: MNode; session: string; size: number };

interface MJob {
  job: T.Job;
  steps: Step[];
  pos: number;
  stepDone: number;
  opts: T.TransferOptions;
  applyAll: T.ConflictAction | null;
  changed: Set<string>;
  rebuild: () => Step[];
  lastEmit: number;
}

interface MTerm {
  info: T.TerminalInfo;
  fs: MemFs;
  cwd: string;
  line: string;
  user: string;
  host: string;
  open: boolean;
}

export function createMockBackend(emit: Emit, opts: MockOptions): MockBackend {
  const fast = opts.fast;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, fast ? Math.min(ms, 10) : ms));
  const latency = () => sleep(25 + Math.floor(Math.random() * 60));
  let idSeq = 1;
  const newId = (p: string) => `${p}${(idSeq++).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

  const localFs = buildLocalFs();
  const serverFs = new Map<string, MemFs>();
  const settings = defaultSettings();
  const vault: T.VaultStatus = { hasMasterPassword: opts.locked, locked: opts.locked };
  let authenticated = !opts.login;

  const instanceId = '7c1e2f9a-4b3d-4e8f-9a21-5d6c7b8e9f01';
  const info: T.AppInfo = {
    version: '0.9.0-demo',
    mode: opts.webMode ? 'web' : 'desktop',
    hostname: 'demo-workstation',
    os: 'linux',
    arch: 'x86_64',
    user: 'demo',
    homeDir: '/home/demo',
    instanceId,
    instanceName: settings.discovery.instanceName,
    features: { terminal: true, localExec: true, externalEdit: !opts.webMode, openLocal: !opts.webMode, protocols: ALL_PROTOCOLS },
  };

  const sessions = new Map<string, MSession>();
  sessions.set('local', {
    fs: localFs,
    site: null,
    summary: {
      id: 'local', name: 'Local', protocol: 'local', siteId: null, host: 'demo-workstation', username: 'demo', color: null,
      url: 'file:///home/demo', home: '/home/demo', initialDir: '/home/demo', localDir: '', capabilities: CAPS.local, connectedAt: now - 3600,
    },
  });

  const sites: T.SiteConfig[] = [
    site('site-web01', { name: 'web-01', folder: 'Production', protocol: 'sftp', host: 'web-01.example.com', username: 'deploy', password: SECRET_PLACEHOLDER, remoteDir: '/var/www/html', localDir: '/home/demo/projects/website', color: '#e5484d', notes: 'Main web server (nginx). Deploy only after review.' }),
    site('site-db01', { name: 'db-01', folder: 'Production', protocol: 'sftp', host: 'db-01.example.com', username: 'admin', color: '#f76b15', ssh: { ...siteTemplate().ssh, privateKeyPath: '~/.ssh/id_ed25519', jumpSiteId: 'site-web01', tryPassword: false } }),
    site('site-staging', { name: 'staging', folder: 'Staging', protocol: 'scp', host: 'staging.example.com', username: 'deploy', remoteDir: '/var/www/html', color: '#30a46c' }),
    site('site-acme', { name: 'ftp.acme.test', folder: 'Customers/ACME', protocol: 'ftp', host: 'ftp.acme.test', username: 'acme', password: SECRET_PLACEHOLDER, ftp: { encryption: 'explicit', passive: true, allowInvalidCerts: false, useMlsd: true, maxConnections: 4 } }),
    site('site-s3', { name: 'S3 backups', folder: 'Cloud', protocol: 's3', host: '', username: 'AKIAIOSFODNN7EXAMPLE', password: SECRET_PLACEHOLDER, s3: { region: 'eu-central-1', endpoint: '', bucket: 'rc-backups', pathStyle: false, sessionToken: null, anonymous: false }, color: '#ffb224' }),
    site('site-dav', { name: 'Nextcloud', folder: 'Cloud', protocol: 'webdav', host: 'cloud.example.org', username: 'demo', password: SECRET_PLACEHOLDER, webdav: { https: true, root: '/remote.php/dav/files/demo', allowInvalidCerts: false } }),
    site('site-pi', { name: 'Raspberry Pi', folder: '', protocol: 'sftp', host: 'pi.local', username: 'pi', password: SECRET_PLACEHOLDER, color: '#8e4ec6' }),
    site('site-changed', { name: 'Reinstalled server (key changed)', folder: 'Staging', protocol: 'sftp', host: 'changed.example.com', username: 'deploy', password: SECRET_PLACEHOLDER }),
  ];

  const knownHosts: T.KnownHost[] = [
    { key: '[db-01.example.com]:22', keyType: 'ssh-ed25519', fingerprint: fakeFingerprint('db-01'), publicKey: 'AAAAC3NzaC1lZDI1NTE5AAAAIM4nqQ7ds0ZgB5g6YgD2bJ8l4m0x0Kc1d1yVb9Xx3f1e', added: now - 86400 * 90 },
    { key: '[changed.example.com]:22', keyType: 'ssh-ed25519', fingerprint: fakeFingerprint('changed-old'), publicKey: 'AAAAC3NzaC1lZDI1NTE5AAAAIOld', added: now - 86400 * 400 },
    { key: '[github.com]:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU', publicKey: 'AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl', added: now - 86400 * 30 },
  ];

  let bookmarks: T.Bookmark[] = [
    { id: 'bm1', name: 'Website project', scope: 'local', path: '/home/demo/projects/website' },
    { id: 'bm2', name: 'Downloads', scope: 'local', path: '/home/demo/Downloads' },
    { id: 'bm3', name: 'Web root', scope: 'site-web01', path: '/var/www/html' },
    { id: 'bm4', name: 'nginx logs', scope: '*', path: '/var/log/nginx' },
  ];

  let commands: T.CustomCommand[] = [
    { id: 'cmd1', name: 'Disk usage', command: 'du -sh !&', perFile: false, target: 'session', showOutput: true, refresh: false },
    { id: 'cmd2', name: 'Tail (last 50 lines)', command: 'tail -n 50 "!"', perFile: true, target: 'session', showOutput: true, refresh: false },
    { id: 'cmd3', name: 'Make executable', command: 'chmod +x "!"', perFile: true, target: 'session', showOutput: false, refresh: true },
    { id: 'cmd4', name: 'Git status', command: 'cd "!/" && git status --short', perFile: false, target: 'local', showOutput: true, refresh: false },
  ];

  const logs: T.LogEntry[] = [];
  function log(level: T.LogLevel, message: string, session: string | null = null) {
    const e: T.LogEntry = { ts: Date.now(), level, session, message };
    logs.push(e);
    if (logs.length > 2000) logs.splice(0, logs.length - 2000);
    emit('log', e);
  }
  log('info', 'Rust Commander 0.9.0-demo started (mock backend)');
  log('info', 'LAN discovery listening on UDP port 8823');
  log('debug', 'Loaded 8 sites, 3 known hosts');

  // ------------------------------------------------ peers & server

  const server: T.ServerStatus = { running: false, bind: '0.0.0.0', port: 8822, tls: true, fingerprint: null, urls: [], hasPassword: true, clients: 0, error: null };
  if (opts.webMode) {
    Object.assign(server, { running: true, fingerprint: 'AB:12:9F:33:E0:71:5C:2A:88:41:D3:6B:0E:F7:19:C4:52:7D:A9:3E:61:B8:04:CF:95:2D:7A:E6:10:8B:3F:47', urls: ['https://192.168.1.23:8822', 'https://demo-workstation.local:8822'], clients: 1 });
  }
  const discovery: T.DiscoveryStatus = { enabled: true, port: 8823, instanceId, instanceName: info.instanceName, error: null };
  const peers: T.Peer[] = [
    { id: 'peer-atlas', name: 'atlas', hostname: 'atlas.lan', version: '0.9.0', os: 'linux', user: 'anna', addresses: ['192.168.1.31', 'fe80::1c2b:3aff:fe11:2233'], web: { port: 8822, tls: true, fingerprint: '5E:9A:21:C7:44:0B:8D:F2:13:6A:B9:E0:77:2C:D5:4F:91:3B:A8:06:CE:12:5F:E4:3D:88:B1:07:69:FA:2E:D3', url: 'https://192.168.1.31:8822' }, lastSeen: now - 4, manual: false, self: false, online: true },
    { id: 'peer-nas', name: 'nas-01', hostname: 'nas-01.lan', version: '0.8.2', os: 'freebsd', user: 'backup', addresses: ['192.168.1.10'], web: { port: 8822, tls: false, fingerprint: null, url: 'http://192.168.1.10:8822' }, lastSeen: now - 12, manual: false, self: false, online: true },
    { id: 'peer-mac', name: "Ben's MacBook", hostname: 'bens-macbook.local', version: '0.9.0', os: 'macos', user: 'ben', addresses: ['192.168.1.44'], web: null, lastSeen: now - 20, manual: false, self: false, online: true },
    { id: 'peer-win', name: 'office-pc', hostname: 'OFFICE-PC', version: '0.7.5', os: 'windows', user: 'reception', addresses: ['192.168.1.62'], web: { port: 8822, tls: true, fingerprint: '0C:77:AE:19:F2:43:8B:D1:60:2A:C5:9E:34:B7:1D:E8:4F:93:06:BA:21:7C:E5:58:A0:13:6F:D9:82:3E:C4:F0', url: 'https://192.168.1.62:8822' }, lastSeen: now - 7200, manual: false, self: false, online: false },
  ];
  function selfPeer(): T.Peer {
    return {
      id: instanceId, name: info.instanceName, hostname: info.hostname, version: info.version, os: info.os, user: info.user,
      addresses: ['192.168.1.23', 'fe80::a00:27ff:fe4e:66a1'],
      web: server.running ? { port: server.port, tls: server.tls, fingerprint: server.fingerprint, url: server.urls[0] ?? '' } : null,
      lastSeen: Math.floor(Date.now() / 1000), manual: false, self: true, online: true,
    };
  }
  const allPeers = () => [selfPeer(), ...peers];
  const emitPeers = () => emit('discovery.peers', allPeers());

  setInterval(() => {
    const t = Math.floor(Date.now() / 1000);
    for (const p of peers) if (p.online) p.lastSeen = t - Math.floor(Math.random() * 6);
    emitPeers();
  }, fast ? 1000 : 15000);

  // ------------------------------------------------ prompts

  const pending = new Map<string, { request: T.PromptRequest; resolve: (r: T.PromptResponse | null) => void }>();
  function ask(request: T.PromptRequest): Promise<T.PromptResponse | null> {
    const id = newId('pr');
    return new Promise((resolve) => {
      pending.set(id, { request, resolve });
      emit('prompt.request', { id, request });
    });
  }

  // ------------------------------------------------ sessions

  function sessionOf(id: string): MSession {
    return sessions.get(id) ?? fail('not_found', `Unknown session '${id}'`);
  }
  const fsOf = (id: string) => sessionOf(id).fs;

  function fsForSite(s: T.SiteConfig): MemFs {
    const key = `${s.protocol}:${s.host}:${s.username}:${s.s3.bucket}`;
    let f = serverFs.get(key);
    if (!f) {
      if (s.protocol === 's3' || s.protocol === 'gcs' || s.protocol === 'azure') f = buildBucketFs(s.s3.bucket || s.gcs.bucket || s.azure.container);
      else f = buildServerFs(s.host || 'server', s.username);
      serverFs.set(key, f);
    }
    return f;
  }

  /** Host entries of the demo ~/.ssh/config (wildcards are skipped, User defaults to the local user). */
  function sshConfigHosts() {
    const hosts: { name: string; host: string; username: string; port: number; jump: string | null }[] = [];
    let cur: (typeof hosts)[number] | null = null;
    for (const raw of TEXT.sshConfig.split('\n')) {
      const m = /^(\S+)\s+(.+)$/.exec(raw.trim());
      if (!m) continue;
      const [k, v] = [m[1].toLowerCase(), m[2].trim()];
      if (k === 'host') {
        cur = v.includes('*') ? null : { name: v, host: v, username: info.user, port: 22, jump: null };
        if (cur) hosts.push(cur);
      } else if (cur) {
        if (k === 'hostname') cur.host = v;
        else if (k === 'user') cur.username = v;
        else if (k === 'port') cur.port = parseInt(v, 10) || 22;
        else if (k === 'proxyjump') cur.jump = v;
      }
    }
    return hosts;
  }

  function parseUrl(url: string): T.SiteConfig {
    let u: URL;
    try {
      u = new URL(url.includes('://') ? url : `sftp://${url}`);
    } catch {
      return fail('invalid_input', `Invalid URL: ${url}`);
    }
    const scheme = u.protocol.replace(':', '').toLowerCase();
    const map: Record<string, T.Protocol> = { sftp: 'sftp', ssh: 'sftp', scp: 'scp', ftp: 'ftp', ftps: 'ftp', ftpes: 'ftp', http: 'webdav', https: 'webdav', dav: 'webdav', davs: 'webdav', webdav: 'webdav', s3: 's3', rcmd: 'rcmd', rcmds: 'rcmd', gs: 'gcs', az: 'azure' };
    const protocol = map[scheme] ?? fail('invalid_input', `Unsupported protocol '${scheme}'`);
    const s = siteTemplate(protocol);
    s.host = decodeURIComponent(u.hostname);
    s.port = u.port ? parseInt(u.port, 10) : 0;
    s.username = decodeURIComponent(u.username);
    s.password = u.password ? decodeURIComponent(u.password) : null;
    s.remoteDir = u.pathname && u.pathname !== '/' ? decodeURIComponent(u.pathname) : '';
    s.name = s.username ? `${s.username}@${s.host}` : s.host;
    if (scheme === 'ftps') s.ftp.encryption = 'implicit';
    if (scheme === 'http' || scheme === 'dav') s.webdav.https = false;
    if (scheme === 'rcmd') s.rcmd.tls = false;
    if (protocol === 's3') {
      s.s3.bucket = s.host;
      s.host = '';
    }
    return s;
  }

  async function openSession(p: { siteId?: string; site?: T.SiteConfig; url?: string; password?: string | null }): Promise<T.SessionSummary> {
    let s: T.SiteConfig;
    if (p.siteId) s = deepClone(sites.find((x) => x.id === p.siteId) ?? fail('not_found', 'Site not found'));
    else if (p.site) s = deepClone(p.site);
    else if (p.url) s = parseUrl(p.url);
    else return fail('invalid_input', 'One of siteId, site or url is required');
    if (p.password) s.password = p.password;
    if (s.protocol === 'local') fail('invalid_input', 'Use the local session');
    const host = s.host || (s.protocol === 's3' ? `s3.${s.s3.region}.amazonaws.com` : s.protocol === 'gcs' ? 'storage.googleapis.com' : s.protocol === 'azure' ? `${s.azure.account || s.username}.blob.core.windows.net` : '');
    if (!host) fail('invalid_input', 'Host name is required');
    const port = s.port || DEFAULT_PORT[s.protocol];
    const label = s.name || host;
    log('info', `Connecting to ${host}:${port} (${s.protocol.toUpperCase()})…`);
    await sleep(350);
    if (host.includes('fail') || host.includes('unreachable')) {
      log('error', `Connection to ${host} failed: connection refused`);
      fail('connection_lost', `Could not connect to ${host}:${port}: Connection refused`);
    }
    if (s.protocol === 'sftp' || s.protocol === 'scp') {
      const key = `[${host}]:${port}`;
      const fp = fakeFingerprint(host);
      const known = knownHosts.find((k) => k.key === key);
      if (!known || known.fingerprint !== fp) {
        log('warn', known ? `HOST KEY FOR ${host} HAS CHANGED!` : `Host key for ${host} is not cached`);
        const r = await ask({ kind: 'host_key', host, port, keyType: 'ssh-ed25519', fingerprint: fp, state: known ? 'changed' : 'new', previousFingerprint: known?.fingerprint });
        if (!r || !r.accepted) {
          log('error', `Host key for ${host} rejected by the user`);
          fail('host_key_rejected', 'Host key verification failed');
        }
        if (r!.remember) {
          const i = knownHosts.findIndex((k) => k.key === key);
          const entry = { key, keyType: 'ssh-ed25519', fingerprint: fp, publicKey: 'AAAAC3NzaC1lZDI1NTE5AAAAI' + fakeHex(host, 30), added: Math.floor(Date.now() / 1000) };
          if (i >= 0) knownHosts[i] = entry;
          else knownHosts.push(entry);
          log('info', `Host key for ${host} saved`);
        }
      }
      log('debug', 'Server version: SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.5');
      if (host.startsWith('bastion') || host.startsWith('pi.')) {
        await ask({ kind: 'banner', host, message: 'Authorized access only.\nAll activity on this system is logged and monitored.' });
      }
    }
    if (s.protocol === 'ftp' && s.ftp.encryption !== 'none' && !s.ftp.allowInvalidCerts && host.endsWith('.test')) {
      const r = await ask({ kind: 'certificate', host, port, fingerprint: '3A:F1:09:BB:72:5E:C4:18:9D:06:E2:47:A5:3C:81:D0:6F:29:B4:E7:15:8A:C3:52:0D:96:7B:E1:44:28:FA:63', subject: `CN=${host}`, issuer: `CN=${host} (self-signed)`, reason: 'The certificate is self-signed and not trusted.', state: 'new' });
      if (!r || !r.accepted) fail('cancelled', 'Certificate rejected');
    }
    if (s.protocol === 'rcmd' && s.rcmd.tls && !s.rcmd.fingerprint) {
      const r = await ask({ kind: 'certificate', host, port, fingerprint: '5E:9A:21:C7:44:0B:8D:F2:13:6A:B9:E0:77:2C:D5:4F:91:3B:A8:06:CE:12:5F:E4:3D:88:B1:07:69:FA:2E:D3', subject: `CN=${host}`, issuer: 'Rust Commander self-signed', reason: 'Self-signed certificate of a Rust Commander instance.', state: 'new' });
      if (!r || !r.accepted) fail('cancelled', 'Certificate rejected');
    }
    const keyAuth = !!(s.ssh.privateKeyPath || s.ssh.privateKey);
    const needsPassword = !keyAuth && !(s.protocol === 's3' && s.s3.anonymous) && s.protocol !== 'gcs' && (s.password === null || s.password === undefined || s.password === '');
    if (needsPassword) {
      let user = s.username;
      if (!user && s.protocol !== 'rcmd') {
        const r = await ask({ kind: 'username', host });
        if (!r || !r.accepted) fail('cancelled', 'Login cancelled');
        user = r!.values[0] ?? '';
        s.username = user;
      }
      if (host.includes('otp')) {
        const r = await ask({ kind: 'keyboard_interactive', host, name: 'Two-factor authentication', instructions: 'Enter your password and the 6-digit code from your authenticator app.', prompts: [{ text: 'Password:', echo: false }, { text: 'Verification code:', echo: true }] });
        if (!r || !r.accepted) fail('cancelled', 'Login cancelled');
      } else {
        const r = await ask({ kind: 'password', host, username: user, message: `Password for ${user || 'Rust Commander'}@${host}` });
        if (!r || !r.accepted) fail('cancelled', 'Login cancelled');
        if (r!.values[0] === 'wrong') {
          log('error', `Authentication for ${user}@${host} failed`);
          fail('auth_failed', 'Access denied: wrong user name or password');
        }
      }
    }
    if (keyAuth && s.ssh.passphrase === undefined && host.includes('passphrase')) {
      const r = await ask({ kind: 'passphrase', keyPath: s.ssh.privateKeyPath ?? 'key' });
      if (!r || !r.accepted) fail('cancelled', 'Login cancelled');
    }
    await sleep(200);
    const fsys = fsForSite(s);
    const id = newId('s');
    const home = fsys.home;
    const initialDir = s.remoteDir && fsys.get(s.remoteDir) ? s.remoteDir : home;
    const user = s.username;
    const summary: T.SessionSummary = {
      id,
      name: label,
      protocol: s.protocol,
      siteId: s.id || null,
      host,
      username: user,
      color: s.color ?? null,
      url: `${s.protocol}://${user ? encodeURIComponent(user) + '@' : ''}${host}${s.port ? ':' + s.port : ''}${initialDir}`,
      home,
      initialDir,
      localDir: s.localDir,
      capabilities: CAPS[s.protocol],
      connectedAt: Math.floor(Date.now() / 1000),
    };
    sessions.set(id, { summary, fs: fsys, site: s });
    log('info', `Authenticated as ${user || 'anonymous'}; session ${label} opened`, id);
    emit('session.opened', summary);
    return summary;
  }

  // ------------------------------------------------ jobs

  const jobs = new Map<string, MJob>();
  const changed = (session: string, path: string) => emit('fs.changed', { session, path });

  function countTree(fsys: MemFs, path: string, follow: boolean): { bytes: number; files: number } {
    const n = fsys.get(path, follow);
    if (!n) return { bytes: 0, files: 0 };
    if (n.kind === 'dir') {
      let bytes = 0;
      let files = 0;
      for (const c of n.children!.values()) {
        const r = countTree(fsys, P.join(path, c.name), follow);
        bytes += r.bytes;
        files += r.files;
      }
      return { bytes, files };
    }
    return { bytes: n.size, files: 1 };
  }

  function planCopy(src: MemFs, srcPath: string, dst: MemFs, dstPath: string, dstSession: string, o: T.TransferOptions, steps: Step[], mask: ReturnType<typeof compileMask>) {
    const n = src.get(srcPath, o.followSymlinks) ?? fail('not_found', `No such file: ${srcPath}`);
    const name = P.basename(srcPath);
    if (o.excludeHidden && name.startsWith('.')) return;
    if (n.kind === 'dir') {
      if (!matchTransferMask(mask, name, true)) return;
      steps.push({ t: 'mkdir', fs: dst, path: dstPath, session: dstSession });
      for (const c of n.children!.values()) planCopy(src, P.join(srcPath, c.name), dst, P.join(dstPath, c.name), dstSession, o, steps, mask);
    } else {
      if (!matchTransferMask(mask, name, false)) return;
      steps.push({ t: 'copy', src, srcPath, node: n, dst, dstPath, size: n.size, dstSession });
    }
  }

  function makeJob(kind: T.JobKind, title: string, extra: Partial<T.Job>, o: T.TransferOptions, rebuild: () => Step[]): MJob {
    const steps = rebuild();
    const job: T.Job = {
      id: newId('job'),
      kind,
      title,
      state: 'queued',
      srcSession: null,
      dstSession: null,
      srcPaths: [],
      dstDir: null,
      bytesTotal: 0,
      bytesDone: 0,
      filesTotal: 0,
      filesDone: 0,
      scanning: true,
      currentFile: null,
      speed: 0,
      eta: null,
      errors: [],
      conflict: null,
      createdAt: Math.floor(Date.now() / 1000),
      startedAt: null,
      finishedAt: null,
      ...extra,
    };
    const mj: MJob = { job, steps, pos: 0, stepDone: 0, opts: o, applyAll: null, changed: new Set(), rebuild, lastEmit: 0 };
    computeTotals(mj);
    jobs.set(job.id, mj);
    emit('job.updated', { ...job });
    setTimeout(() => {
      mj.job.scanning = false;
      emit('job.updated', { ...mj.job });
    }, fast ? 5 : 250);
    ensureTicker();
    return mj;
  }

  function computeTotals(mj: MJob) {
    let bytes = 0;
    let files = 0;
    for (const s of mj.steps) {
      if (s.t === 'copy' || s.t === 'create') {
        bytes += s.size;
        files++;
      } else if (s.t === 'delete') files++;
    }
    mj.job.bytesTotal = bytes;
    mj.job.filesTotal = files;
  }

  let ticker: ReturnType<typeof setInterval> | null = null;
  let lastTick = Date.now();
  function ensureTicker() {
    if (ticker) return;
    lastTick = Date.now();
    ticker = setInterval(tick, fast ? 20 : 100);
  }

  function uniqueName(fsys: MemFs, path: string): string {
    const dirP = P.dirname(path);
    const [stem, ext] = P.splitExt(P.basename(path));
    for (let i = 1; i < 1000; i++) {
      const cand = P.join(dirP, `${stem} (${i})${ext}`);
      if (!fsys.get(cand, false)) return cand;
    }
    return path;
  }

  function finishJob(mj: MJob, state: T.JobState) {
    const j = mj.job;
    j.state = state;
    j.speed = 0;
    j.eta = null;
    j.currentFile = null;
    j.conflict = null;
    j.finishedAt = Math.floor(Date.now() / 1000);
    emit('job.updated', { ...j, errors: [...j.errors] });
    for (const key of mj.changed) {
      const i = key.indexOf('\u0000');
      changed(key.slice(0, i), key.slice(i + 1));
    }
    mj.changed.clear();
    log(state === 'completed' ? 'info' : state === 'cancelled' ? 'warn' : 'error', `${j.title}: ${state}${j.errors.length ? ` (${j.errors.length} error${j.errors.length > 1 ? 's' : ''})` : ''}`, j.dstSession ?? j.srcSession ?? null);
  }

  function markChanged(mj: MJob, session: string, path: string) {
    mj.changed.add(`${session}\u0000${P.dirname(path)}`);
  }

  function tick() {
    const t = Date.now();
    const dt = Math.min(0.5, (t - lastTick) / 1000);
    lastTick = t;
    const all = [...jobs.values()];
    let running = all.filter((j) => j.job.state === 'running' || j.job.state === 'waiting').length;
    for (const mj of all) {
      if (mj.job.state === 'queued' && !mj.job.scanning && running < Math.max(1, settings.maxConcurrentJobs)) {
        mj.job.state = 'running';
        mj.job.startedAt ??= Math.floor(t / 1000);
        running++;
      }
    }
    let active = false;
    for (const mj of all) {
      if (mj.job.state === 'queued' || mj.job.state === 'paused' || mj.job.state === 'waiting') active = true;
      if (mj.job.state !== 'running') continue;
      active = true;
      runJob(mj, dt);
    }
    if (!active && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  function runJob(mj: MJob, dt: number) {
    const j = mj.job;
    const target = fast ? Math.max(j.bytesTotal / 0.4, 1e6) : Math.min(Math.max(j.bytesTotal / 3.5, 2.5e6), 140e6);
    let speed = target * (0.85 + Math.random() * 0.3);
    if (mj.opts.speedLimit > 0) speed = Math.min(speed, mj.opts.speedLimit);
    let budget = speed * dt;
    let fileOps = fast ? 200 : 4;
    const startBytes = j.bytesDone;
    while (mj.pos < mj.steps.length && fileOps > 0) {
      const s = mj.steps[mj.pos];
      try {
        if (s.t === 'mkdir') {
          if (!s.fs.get(s.path)) {
            s.fs.mkdir(s.path, true);
            markChanged(mj, s.session, s.path);
          }
          mj.pos++;
          continue;
        }
        if (s.t === 'delete') {
          j.currentFile = s.path;
          s.fs.remove(s.path);
          markChanged(mj, s.session, s.path);
          j.filesDone++;
          mj.pos++;
          fileOps--;
          continue;
        }
        if (s.t === 'create') {
          const take = Math.min(budget, s.size - mj.stepDone);
          mj.stepDone += take;
          j.bytesDone += take;
          budget -= take;
          j.currentFile = s.path;
          if (mj.stepDone >= s.size) {
            s.fs.put(s.path, s.node);
            markChanged(mj, s.session, s.path);
            j.filesDone++;
            mj.pos++;
            mj.stepDone = 0;
            fileOps--;
            continue;
          }
          break;
        }
        // copy
        if (!s.checked) {
          s.checked = true;
          const existing = s.dst.get(s.dstPath, false);
          if (existing) {
            if (existing.kind === 'dir') {
              j.errors.push({ path: s.dstPath, message: 'A directory with this name already exists' });
              j.bytesDone += s.size;
              j.filesDone++;
              mj.pos++;
              continue;
            }
            const mode = mj.applyAll ?? (mj.opts.overwrite === 'ask' ? 'ask' : mj.opts.overwrite);
            const decision = decideConflict(mode, s, existing);
            if (decision === 'ask') {
              s.checked = false;
              j.state = 'waiting';
              j.speed = 0;
              j.eta = null;
              j.conflict = { id: newId('c'), source: s.src.entry(s.node, s.srcPath), target: s.dst.entry(existing, s.dstPath) };
              emit('job.updated', { ...j });
              log('info', `Waiting for an answer: ${P.basename(s.dstPath)} already exists`, s.dstSession);
              return;
            }
            if (decision === 'skip') {
              j.bytesDone += s.size;
              j.filesDone++;
              mj.pos++;
              continue;
            }
            if (decision === 'resume') {
              mj.stepDone = Math.min(existing.size, s.size);
              j.bytesDone += mj.stepDone;
            }
            if (decision === 'rename') s.dstPath = uniqueName(s.dst, s.dstPath);
          }
          const parentDir = s.dst.get(P.dirname(s.dstPath));
          if (parentDir && (parentDir.readonly || parentDir.denied)) {
            j.errors.push({ path: s.dstPath, message: 'Permission denied' });
            j.bytesDone += s.size - mj.stepDone;
            mj.stepDone = 0;
            j.filesDone++;
            mj.pos++;
            continue;
          }
        }
        j.currentFile = s.srcPath;
        const take = Math.min(budget, s.size - mj.stepDone);
        mj.stepDone += take;
        j.bytesDone += take;
        budget -= take;
        if (mj.stepDone >= s.size) {
          const copy = cloneNode(s.node);
          copy.name = P.basename(s.dstPath);
          copy.owner = s.dst.user || copy.owner;
          copy.group = s.dst.user || copy.group;
          if (!mj.opts.preserveTimestamps) copy.modified = Math.floor(Date.now() / 1000);
          if (mj.opts.permissions !== null && mj.opts.permissions !== undefined) copy.permissions = mj.opts.permissions;
          else if (!mj.opts.preservePermissions) copy.permissions = 0o644;
          s.dst.put(s.dstPath, copy);
          markChanged(mj, s.dstSession, s.dstPath);
          if (mj.opts.move) {
            try {
              s.src.remove(s.srcPath);
              const srcSession = mj.job.srcSession ?? '';
              markChanged(mj, srcSession, s.srcPath);
            } catch (e) {
              j.errors.push({ path: s.srcPath, message: (e as Error).message });
            }
          }
          j.filesDone++;
          mj.pos++;
          mj.stepDone = 0;
          fileOps--;
          continue;
        }
        break;
      } catch (e) {
        j.errors.push({ path: 'path' in s ? s.path : s.t === 'copy' ? s.srcPath : '', message: (e as Error).message });
        if (s.t === 'copy') {
          j.bytesDone += s.size - mj.stepDone;
          j.filesDone++;
        }
        mj.stepDone = 0;
        mj.pos++;
      }
    }
    const moved = j.bytesDone - startBytes;
    j.speed = Math.round(j.speed * 0.6 + (dt > 0 ? moved / dt : 0) * 0.4);
    j.eta = j.speed > 0 ? Math.max(0, (j.bytesTotal - j.bytesDone) / j.speed) : null;
    if (mj.pos >= mj.steps.length) {
      if (mj.opts.move && j.kind === 'transfer') {
        // remove now-empty source directories
        for (const p of j.srcPaths) {
          const src = sessions.get(j.srcSession ?? '')?.fs;
          const n = src?.get(p, false);
          if (src && n && n.kind === 'dir') {
            try {
              src.remove(p);
              markChanged(mj, j.srcSession ?? '', p);
            } catch {
              /* ignore */
            }
          }
        }
      }
      j.bytesDone = Math.max(j.bytesDone, j.bytesTotal);
      finishJob(mj, j.errors.length ? 'failed' : 'completed');
      return;
    }
    const tnow = Date.now();
    if (tnow - mj.lastEmit > (fast ? 30 : 180)) {
      mj.lastEmit = tnow;
      emit('job.updated', { ...j, errors: [...j.errors] });
    }
  }

  function decideConflict(mode: T.OverwriteMode | T.ConflictAction, s: Extract<Step, { t: 'copy' }>, existing: MNode): 'ask' | 'overwrite' | 'skip' | 'resume' | 'rename' {
    switch (mode) {
      case 'ask':
        return 'ask';
      case 'overwrite':
        return 'overwrite';
      case 'skip':
        return 'skip';
      case 'newer':
        return s.node.modified > existing.modified ? 'overwrite' : 'skip';
      case 'differentSize':
        return s.node.size !== existing.size ? 'overwrite' : 'skip';
      case 'differentChecksum':
        return s.node.size !== existing.size || contentKey(s.node) !== contentKey(existing) ? 'overwrite' : 'skip';
      case 'resume':
        return existing.size < s.size ? 'resume' : 'overwrite';
      case 'rename':
        return 'rename';
      default:
        return 'overwrite';
    }
  }

  function startTransfer(p: { srcSession: string; srcPaths: string[]; dstSession: string; dstDir: string; options?: Partial<T.TransferOptions> }): T.Job {
    const src = sessionOf(p.srcSession);
    const dst = sessionOf(p.dstSession);
    const o: T.TransferOptions = { ...settings.transfer, ...(p.options ?? {}) };
    const dstDirNode = dst.fs.get(p.dstDir) ?? fail('not_found', `Target directory does not exist: ${p.dstDir}`);
    if (dstDirNode.kind !== 'dir') fail('not_a_directory', `Not a directory: ${p.dstDir}`);
    for (const sp of p.srcPaths) {
      if (p.srcSession === p.dstSession && (P.normalize(p.dstDir) === P.normalize(sp) || P.relativeTo(sp, p.dstDir) !== null)) {
        fail('invalid_input', `Cannot copy '${P.basename(sp)}' into itself`);
      }
    }
    const mask = compileMask(o.fileMask);
    const rebuild = () => {
      const steps: Step[] = [];
      p.srcPaths.forEach((sp) => {
        const name = p.srcPaths.length === 1 && o.newName ? o.newName : P.basename(sp);
        planCopy(src.fs, sp, dst.fs, P.join(p.dstDir, name), p.dstSession, o, steps, mask);
      });
      return steps;
    };
    const what = p.srcPaths.length === 1 ? `'${P.basename(p.srcPaths[0])}'` : `${p.srcPaths.length} items`;
    const verb = o.move ? 'Move' : src.summary.id === 'local' && dst.summary.id !== 'local' ? 'Upload' : src.summary.id !== 'local' && dst.summary.id === 'local' ? 'Download' : 'Copy';
    const mj = makeJob('transfer', `${verb} ${what} → ${dst.summary.name}:${p.dstDir}`, { srcSession: p.srcSession, dstSession: p.dstSession, srcPaths: [...p.srcPaths], dstDir: p.dstDir }, o, rebuild);
    log('info', `${verb} of ${what} to ${p.dstDir} queued`, p.dstSession);
    return { ...mj.job };
  }

  function startDelete(session: string, paths: string[]): T.Job {
    const s = sessionOf(session);
    const rebuild = () => {
      const steps: Step[] = [];
      const add = (path: string) => {
        const n = s.fs.get(path, false);
        if (!n) return;
        if (n.kind === 'dir') for (const c of n.children!.values()) add(P.join(path, c.name));
        steps.push({ t: 'delete', fs: s.fs, path, session });
      };
      paths.forEach(add);
      return steps;
    };
    for (const p of paths) s.fs.get(p, false) ?? fail('not_found', `No such file: ${p}`);
    const what = paths.length === 1 ? `'${P.basename(paths[0])}'` : `${paths.length} items`;
    const mj = makeJob('delete', `Delete ${what}`, { srcSession: session, srcPaths: [...paths] }, { ...settings.transfer }, rebuild);
    return { ...mj.job };
  }

  // ------------------------------------------------ sync

  const plans = new Map<string, T.SyncPlan>();

  function collect(fsys: MemFs, root: string, prm: T.SyncParams): Map<string, MNode> {
    const out = new Map<string, MNode>();
    const mask = compileMask(prm.fileMask);
    const walk = (path: string, rel: string, depth: number) => {
      const n = fsys.get(path);
      if (!n || n.kind !== 'dir' || n.denied) return;
      for (const c of n.children!.values()) {
        if (prm.excludeHidden && c.name.startsWith('.')) continue;
        const isDir = c.kind === 'dir';
        if (!matchTransferMask(mask, c.name, isDir)) continue;
        const r = rel ? `${rel}/${c.name}` : c.name;
        out.set(r, c);
        if (isDir && !prm.nonRecursive) walk(P.join(path, c.name), r, depth + 1);
      }
    };
    walk(root, '', 0);
    return out;
  }

  async function syncCompare(prm: T.SyncParams): Promise<T.SyncPlan> {
    const L = fsOf(prm.leftSession);
    const R = fsOf(prm.rightSession);
    L.dirNode(prm.leftPath);
    R.dirNode(prm.rightPath);
    const left = collect(L, prm.leftPath, prm);
    const right = collect(R, prm.rightPath, prm);
    const steps = fast ? 2 : 6;
    for (let i = 1; i <= steps; i++) {
      await sleep(140);
      emit('sync.progress', { scannedLeft: Math.round((left.size * i) / steps), scannedRight: Math.round((right.size * i) / steps), current: [...left.keys()][Math.floor(((left.size - 1) * i) / steps)] ?? '' });
    }
    const actions: T.SyncAction[] = [];
    let identical = 0;
    const toLeft = prm.direction === 'rightToLeft' || prm.direction === 'both';
    const toRight = prm.direction === 'leftToRight' || prm.direction === 'both';
    const skipUnder = new Set<string>();
    const under = (rel: string) => {
      for (const s of skipUnder) if (rel.startsWith(s + '/')) return true;
      return false;
    };
    const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
    for (const rel of keys) {
      if (under(rel)) continue;
      const l = left.get(rel);
      const r = right.get(rel);
      const le = l ? L.entry(l, P.join(prm.leftPath, rel)) : null;
      const re = r ? R.entry(r, P.join(prm.rightPath, rel)) : null;
      const isDir = (l ?? r)!.kind === 'dir';
      const push = (action: T.SyncActionKind, reason: T.SyncReason) => actions.push({ id: newId('a'), relPath: rel, isDir, action, reason, left: le, right: re });
      if (l && !r) {
        if (toRight) push('copyLeftToRight', 'new');
        else if (prm.deleteObsolete) push('deleteLeft', 'obsolete');
        if (isDir) skipUnder.add(rel);
        continue;
      }
      if (r && !l) {
        if (toLeft) push('copyRightToLeft', 'new');
        else if (prm.deleteObsolete) push('deleteRight', 'obsolete');
        if (isDir) skipUnder.add(rel);
        continue;
      }
      if (!l || !r || isDir) continue;
      const tol = Math.max(0, prm.timeTolerance);
      const dtime = l.modified - r.modified;
      const sizeDiff = prm.compareSize && l.size !== r.size;
      const contentDiff = prm.compareChecksum && (l.content ?? l.svg ?? String(l.size)) !== (r.content ?? r.svg ?? String(r.size));
      const lNewer = prm.compareTime && dtime > tol;
      const rNewer = prm.compareTime && dtime < -tol;
      if (!lNewer && !rNewer && !sizeDiff && !contentDiff) {
        identical++;
        continue;
      }
      if (prm.direction === 'both') {
        if (lNewer) push('copyLeftToRight', 'newer');
        else if (rNewer) push('copyRightToLeft', 'newer');
        else push('conflict', sizeDiff ? 'bothChanged' : 'checksumDiffers');
      } else if (prm.direction === 'leftToRight') {
        if (lNewer) push('copyLeftToRight', 'newer');
        else if (rNewer) {
          if (prm.mode === 'mirror') push('copyLeftToRight', 'older');
          else identical++;
        } else push('copyLeftToRight', sizeDiff ? 'sizeDiffers' : 'checksumDiffers');
      } else {
        if (rNewer) push('copyRightToLeft', 'newer');
        else if (lNewer) {
          if (prm.mode === 'mirror') push('copyRightToLeft', 'older');
          else identical++;
        } else push('copyRightToLeft', sizeDiff ? 'sizeDiffers' : 'checksumDiffers');
      }
    }
    const plan: T.SyncPlan = { id: newId('plan'), params: prm, actions, scannedLeft: left.size, scannedRight: right.size, identical };
    plans.set(plan.id, plan);
    log('info', `Synchronization compare finished: ${actions.length} differences, ${identical} identical`);
    return plan;
  }

  function syncExecute(planId: string, actionIds: string[], options?: Partial<T.TransferOptions>): T.Job {
    const plan = plans.get(planId) ?? fail('not_found', 'Sync plan not found (expired?)');
    const prm = plan.params;
    const L = sessionOf(prm.leftSession);
    const R = sessionOf(prm.rightSession);
    const ids = new Set(actionIds);
    const chosen = plan.actions.filter((a) => ids.has(a.id));
    const o: T.TransferOptions = { ...settings.transfer, ...(options ?? {}), overwrite: 'overwrite', move: false };
    const rebuild = () => {
      const steps: Step[] = [];
      const mask = compileMask('');
      for (const a of chosen) {
        const lp = P.join(prm.leftPath, a.relPath);
        const rp = P.join(prm.rightPath, a.relPath);
        if (a.action === 'copyLeftToRight' || (a.action === 'conflict' && (a.left?.modified ?? 0) >= (a.right?.modified ?? 0))) {
          steps.push({ t: 'mkdir', fs: R.fs, path: P.dirname(rp), session: R.summary.id });
          planCopy(L.fs, lp, R.fs, rp, R.summary.id, o, steps, mask);
        } else if (a.action === 'copyRightToLeft' || a.action === 'conflict') {
          steps.push({ t: 'mkdir', fs: L.fs, path: P.dirname(lp), session: L.summary.id });
          planCopy(R.fs, rp, L.fs, lp, L.summary.id, o, steps, mask);
        } else if (a.action === 'deleteLeft' || a.action === 'deleteRight') {
          const f = a.action === 'deleteLeft' ? L : R;
          const path = a.action === 'deleteLeft' ? lp : rp;
          const add = (p: string) => {
            const n = f.fs.get(p, false);
            if (!n) return;
            if (n.kind === 'dir') for (const c of n.children!.values()) add(P.join(p, c.name));
            steps.push({ t: 'delete', fs: f.fs, path: p, session: f.summary.id });
          };
          add(path);
        }
      }
      return steps;
    };
    const mj = makeJob('sync', `Synchronize ${prm.leftPath} ⇄ ${R.summary.name}:${prm.rightPath}`, { srcSession: prm.leftSession, dstSession: prm.rightSession, srcPaths: [prm.leftPath], dstDir: prm.rightPath }, o, rebuild);
    plans.delete(planId);
    return { ...mj.job };
  }

  // ------------------------------------------------ search

  const searches = new Map<string, { cancelled: boolean }>();
  function startSearch(prm: T.SearchParams): { id: string } {
    const fsys = fsOf(prm.session);
    fsys.dirNode(prm.root);
    const id = newId('srch');
    const st = { cancelled: false };
    searches.set(id, st);
    const mask = compileMask(prm.nameMask || '');
    const text = prm.contentText ? (prm.caseSensitive ? prm.contentText : prm.contentText.toLowerCase()) : null;
    const found: T.FileEntry[] = [];
    let scanned = 0;
    const walk = (path: string, depth: number) => {
      const n = fsys.get(path);
      if (!n || n.kind !== 'dir' || n.denied) return;
      for (const c of n.children!.values()) {
        if (!prm.includeHidden && c.name.startsWith('.')) continue;
        scanned++;
        const cp = P.join(path, c.name);
        const isDir = c.kind === 'dir';
        let ok = isDir ? prm.includeDirs : true;
        if (ok && !mask.empty) ok = matchTransferMask(mask, c.name, false);
        if (ok && !isDir) {
          if (prm.minSize != null && c.size < prm.minSize) ok = false;
          if (prm.maxSize != null && c.size > prm.maxSize) ok = false;
        }
        if (ok && prm.modifiedAfter != null && c.modified < prm.modifiedAfter) ok = false;
        if (ok && prm.modifiedBefore != null && c.modified > prm.modifiedBefore) ok = false;
        if (ok && text !== null) {
          const body = isDir ? null : c.content ?? null;
          ok = body !== null && (prm.caseSensitive ? body : body.toLowerCase()).includes(text);
        }
        if (ok) found.push(fsys.entry(c, cp));
        if (isDir && (prm.maxDepth == null || depth + 1 < prm.maxDepth)) walk(cp, depth + 1);
      }
    };
    setTimeout(async () => {
      walk(prm.root, 0);
      for (let i = 0; i < found.length; i += 6) {
        if (st.cancelled) break;
        await sleep(90);
        emit('search.result', { id, entries: found.slice(i, i + 6) });
      }
      await sleep(60);
      emit('search.done', { id, scanned, found: st.cancelled ? Math.min(found.length, 6) : found.length, cancelled: st.cancelled, error: null });
      searches.delete(id);
    }, 50);
    return { id };
  }

  // ------------------------------------------------ terminals

  const terms = new Map<string, MTerm>();
  const tw = (t: MTerm, s: string) => emit('terminal.data', { id: t.info.id, data: utf8ToBase64(s) });
  const promptStr = (t: MTerm) => {
    const home = t.fs.home;
    const short = t.cwd === home ? '~' : t.cwd.startsWith(home + '/') ? '~' + t.cwd.slice(home.length) : t.cwd;
    return `\x1b[1;32m${t.user}@${t.host}\x1b[0m:\x1b[1;34m${short}\x1b[0m$ `;
  };

  function runTermCommand(t: MTerm, line: string) {
    const [cmd, ...args] = line.trim().split(/\s+/);
    const arg = args.join(' ');
    const out = (s: string) => tw(t, s.replace(/\n/g, '\r\n'));
    switch (cmd) {
      case undefined:
      case '':
        break;
      case 'help':
        out('Demo shell. Commands: ls [-la], cd, pwd, cat, echo, whoami, hostname, uname, date, df, uptime, clear, exit\n');
        break;
      case 'ls': {
        const long = args.some((a) => a.startsWith('-') && a.includes('l'));
        const all = args.some((a) => a.startsWith('-') && a.includes('a'));
        const target = args.find((a) => !a.startsWith('-'));
        const path = target ? P.resolve(t.cwd, target, t.fs.home) : t.cwd;
        try {
          const entries = t.fs.list(path).filter((e) => all || !e.hidden).sort((a, b) => a.name.localeCompare(b.name));
          const color = (e: T.FileEntry) => (e.kind === 'dir' ? `\x1b[1;34m${e.name}\x1b[0m` : e.kind === 'symlink' ? `\x1b[1;36m${e.name}\x1b[0m` : (e.permissions ?? 0) & 0o111 ? `\x1b[1;32m${e.name}\x1b[0m` : e.name);
          if (long) {
            for (const e of entries) {
              const perm = (e.kind === 'dir' ? 'd' : e.kind === 'symlink' ? 'l' : '-') + ['r', 'w', 'x', 'r', 'w', 'x', 'r', 'w', 'x'].map((c, i) => ((e.permissions ?? 0) >> (8 - i)) & 1 ? c : '-').join('');
              const d = new Date((e.modified ?? 0) * 1000).toDateString().slice(4, 10);
              out(`${perm} ${(e.owner ?? '').padEnd(8)} ${String(e.size).padStart(11)} ${d} ${color(e)}${e.linkTarget ? ' -> ' + e.linkTarget : ''}\n`);
            }
          } else out(entries.map(color).join('  ') + '\n');
        } catch (e) {
          out(`ls: cannot access '${target ?? path}': ${(e as Error).message}\n`);
        }
        break;
      }
      case 'cd': {
        const path = P.resolve(t.cwd, arg || '~', t.fs.home);
        const n = t.fs.get(path);
        if (!n) out(`cd: ${arg}: No such file or directory\n`);
        else if (n.kind !== 'dir') out(`cd: ${arg}: Not a directory\n`);
        else if (n.denied) out(`cd: ${arg}: Permission denied\n`);
        else t.cwd = path;
        break;
      }
      case 'pwd':
        out(t.cwd + '\n');
        break;
      case 'cat': {
        const path = P.resolve(t.cwd, arg, t.fs.home);
        const n = t.fs.get(path);
        if (!n) out(`cat: ${arg}: No such file or directory\n`);
        else if (n.kind === 'dir') out(`cat: ${arg}: Is a directory\n`);
        else out((n.content ?? '(binary data)\n').split('\n').slice(0, 60).join('\n') + (n.content?.endsWith('\n') ? '' : '\n'));
        break;
      }
      case 'echo':
        out(arg.replace(/^["']|["']$/g, '') + '\n');
        break;
      case 'whoami':
        out(t.user + '\n');
        break;
      case 'hostname':
        out(t.host + '\n');
        break;
      case 'uname':
        out(args.includes('-a') ? `Linux ${t.host} 6.8.0-45-generic #45-Ubuntu SMP x86_64 GNU/Linux\n` : 'Linux\n');
        break;
      case 'date':
        out(new Date().toString() + '\n');
        break;
      case 'uptime':
        out(' 14:02:11 up 41 days,  3:12,  1 user,  load average: 0.08, 0.12, 0.09\n');
        break;
      case 'df':
        out('Filesystem      Size  Used Avail Use% Mounted on\n/dev/sda1        80G   49G   31G  62% /\n');
        break;
      case 'clear':
        tw(t, '\x1b[2J\x1b[3J\x1b[H');
        break;
      case 'exit':
      case 'logout':
        out('logout\n');
        t.open = false;
        setTimeout(() => emit('terminal.exit', { id: t.info.id, code: 0 }), 50);
        return;
      default:
        out(`${cmd}: command not found\n`);
    }
    tw(t, promptStr(t));
  }

  function termWrite(id: string, data: string) {
    const t = terms.get(id) ?? fail('not_found', 'Terminal not found');
    if (!t.open) fail('invalid_input', 'Terminal is closed');
    for (let i = 0; i < data.length; i++) {
      const ch = data[i];
      if (ch === '\x1b') {
        // skip escape sequences (arrows etc.)
        const m = /^\x1b\[[0-9;?]*[A-Za-z~]|^\x1bO./.exec(data.slice(i));
        i += (m ? m[0].length : 1) - 1;
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        tw(t, '\r\n');
        const line = t.line;
        t.line = '';
        runTermCommand(t, line);
        if (!t.open) return;
      } else if (ch === '\x7f' || ch === '\b') {
        if (t.line.length) {
          t.line = t.line.slice(0, -1);
          tw(t, '\b \b');
        }
      } else if (ch === '\x03') {
        t.line = '';
        tw(t, '^C\r\n' + promptStr(t));
      } else if (ch === '\x0c') {
        tw(t, '\x1b[2J\x1b[H' + promptStr(t) + t.line);
      } else if (ch === '\t') {
        // naive completion against the cwd
        const word = t.line.split(' ').pop() ?? '';
        try {
          const m = t.fs.list(t.cwd).filter((e) => e.name.startsWith(word));
          if (m.length === 1) {
            const rest = m[0].name.slice(word.length) + (m[0].kind === 'dir' ? '/' : ' ');
            t.line += rest;
            tw(t, rest);
          }
        } catch {
          /* ignore */
        }
      } else if (ch >= ' ') {
        t.line += ch;
        tw(t, ch);
      }
    }
  }

  // ------------------------------------------------ misc state

  const watches = new Map<string, T.Watch>();
  const edits = new Map<string, T.ExternalEdit>();
  const tunnels = new Map<string, T.Tunnel>();
  setInterval(() => {
    for (const tn of tunnels.values()) {
      if (Math.random() < 0.5) continue;
      tn.connections = Math.max(0, tn.connections + (Math.random() < 0.6 ? 1 : -1));
      tn.bytesIn += Math.floor(Math.random() * 90_000);
      tn.bytesOut += Math.floor(Math.random() * 12_000);
      emit('tunnel.updated', { ...tn });
    }
    for (const w of watches.values()) {
      if (Math.random() < 0.7) continue;
      w.uploads++;
      w.lastEvent = `Uploaded ${['index.html', 'css/style.css', 'about.html', 'js/app.js'][w.uploads % 4]}`;
      emit('watch.updated', { ...w });
    }
  }, fast ? 300 : 4000);

  /** What the fake checksums are computed from. */
  function contentKey(n: MNode): string {
    return n.content ?? n.svg ?? `${n.name}:${n.size}`;
  }

  async function sha(algo: 'SHA-1' | 'SHA-256', data: string): Promise<string> {
    try {
      const buf = await crypto.subtle.digest(algo, enc.encode(data));
      return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return fakeHex(algo + data, algo === 'SHA-1' ? 40 : 64);
    }
  }

  function readText(fsys: MemFs, path: string, maxBytes = 5 * 1024 * 1024) {
    const n = fsys.must(path);
    if (n.kind === 'dir') fail('is_a_directory', `Is a directory: ${path}`);
    const parentDir = fsys.get(P.dirname(path));
    if (n.permissions === 0o600 && n.owner === 'root' && fsys.user !== 'root') fail('permission_denied', `Permission denied: ${path}`);
    if (parentDir?.denied) fail('permission_denied', `Permission denied: ${path}`);
    if (n.svg) return { content: n.svg, encoding: 'utf-8' as const, size: n.size, modified: n.modified, binary: false };
    if (n.content === undefined) return { content: '', encoding: 'utf-8' as const, size: n.size, modified: n.modified, binary: true };
    let content = n.content;
    if (n.size > maxBytes) content = content.slice(0, maxBytes);
    return { content, encoding: 'utf-8' as const, size: n.size, modified: n.modified, binary: false };
  }

  function mimeOf(name: string): string {
    const ext = P.extname(name);
    const m: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', txt: 'text/plain', html: 'text/html' };
    return m[ext] ?? 'application/octet-stream';
  }

  function setAttrs(p: { session: string; paths: string[]; permissions?: number | null; dirPermissions?: number | null; owner?: string | null; group?: string | null; modified?: number | null; recursive?: boolean }) {
    const fsys = fsOf(p.session);
    const apply = (path: string, n: MNode, top: boolean) => {
      if (n.owner === 'root' && fsys.user !== 'root' && fsys.user !== 'demo') fail('permission_denied', `Operation not permitted: ${path}`);
      if (n.kind === 'dir') {
        const perm = p.recursive && !top ? (p.dirPermissions ?? p.permissions) : p.dirPermissions != null && p.recursive ? p.dirPermissions : p.permissions;
        if (perm != null) n.permissions = perm;
      } else if (p.permissions != null) n.permissions = p.permissions;
      if (p.owner) n.owner = p.owner;
      if (p.group) n.group = p.group;
      if (p.modified != null) n.modified = p.modified;
      if (p.recursive && n.kind === 'dir') for (const c of n.children!.values()) apply(P.join(path, c.name), c, false);
    };
    for (const path of p.paths) apply(path, fsys.must(path, false), true);
    const dirs = new Set(p.paths.map((x) => P.dirname(x)));
    for (const d of dirs) changed(p.session, d);
    log('info', `Changed attributes of ${p.paths.length} item(s)`, p.session);
  }

  // ------------------------------------------------ method table

  const methods: Record<string, (p: Dict) => unknown | Promise<unknown>> = {
    'app.info': () => info,
    'app.open': (p) => {
      log('info', `Opening ${p.target} with the default application`);
      return null;
    },
    'settings.get': () => deepClone(settings),
    'settings.set': (p) => {
      const s = p.settings as T.Settings;
      Object.assign(settings, deepClone(s));
      info.instanceName = settings.discovery.instanceName || info.instanceName;
      discovery.instanceName = info.instanceName;
      discovery.enabled = settings.discovery.enabled;
      discovery.port = settings.discovery.port;
      return deepClone(settings);
    },
    'vault.status': () => ({ ...vault }),
    'vault.unlock': (p) => {
      if (p.password !== 'demo') fail('auth_failed', 'Wrong master password');
      vault.locked = false;
      return { ...vault };
    },
    'vault.lock': () => {
      if (vault.hasMasterPassword) vault.locked = true;
      return { ...vault };
    },
    'vault.setMasterPassword': (p) => {
      if (vault.hasMasterPassword && p.current !== 'demo') fail('auth_failed', 'Current master password is wrong');
      vault.hasMasterPassword = !!p.newPassword;
      vault.locked = false;
      return { ...vault };
    },

    'sites.list': () => deepClone(sites),
    'sites.template': (p) => siteTemplate((p.protocol as T.Protocol) ?? 'sftp'),
    'sites.save': (p) => {
      const s = deepClone(p.site as T.SiteConfig);
      if (!s.name.trim()) fail('invalid_input', 'The site needs a name');
      const keepSecret = (nv: string | null | undefined, old: string | null | undefined) => (nv === SECRET_PLACEHOLDER ? old ?? null : nv);
      const store = (v: string | null | undefined) => (v ? SECRET_PLACEHOLDER : null);
      const old = sites.find((x) => x.id === s.id);
      s.password = store(keepSecret(s.password, old?.password));
      s.ssh.passphrase = store(keepSecret(s.ssh.passphrase, old?.ssh.passphrase));
      s.ssh.privateKey = store(keepSecret(s.ssh.privateKey, old?.ssh.privateKey));
      s.proxy.password = store(keepSecret(s.proxy.password, old?.proxy.password));
      s.s3.sessionToken = store(keepSecret(s.s3.sessionToken, old?.s3.sessionToken));
      s.azure.sasToken = store(keepSecret(s.azure.sasToken, old?.azure.sasToken));
      s.gcs.credentialJson = store(keepSecret(s.gcs.credentialJson, old?.gcs.credentialJson));
      if (!s.id) {
        s.id = newId('site-');
        sites.push(s);
      } else {
        const i = sites.findIndex((x) => x.id === s.id);
        if (i >= 0) sites[i] = s;
        else sites.push(s);
      }
      log('info', `Site '${s.name}' saved`);
      return deepClone(s);
    },
    'sites.delete': (p) => {
      const i = sites.findIndex((x) => x.id === p.id);
      if (i < 0) fail('not_found', 'Site not found');
      sites.splice(i, 1);
      return null;
    },
    'sites.duplicate': (p) => {
      const s = deepClone(sites.find((x) => x.id === p.id) ?? fail('not_found', 'Site not found'));
      s.id = newId('site-');
      s.name = `${s.name} (copy)`;
      sites.push(s);
      return deepClone(s);
    },
    'sites.renameFolder': (p) => {
      const from = String(p.from);
      const to = String(p.to);
      for (const s of sites) {
        if (s.folder === from) s.folder = to;
        else if (s.folder.startsWith(from + '/')) s.folder = to + s.folder.slice(from.length);
      }
      return null;
    },
    'sites.import': (p) => {
      const format = p.format as T.ImportFormat;
      const content = (p.content as string | null | undefined) ?? (format === 'openssh' ? TEXT.sshConfig : '');
      const imported: T.SiteConfig[] = [];
      if (format === 'openssh') {
        let cur: T.SiteConfig | null = null;
        for (const raw of content.split('\n')) {
          const line = raw.trim();
          const m = /^(\S+)\s+(.+)$/.exec(line);
          if (!m) continue;
          const [k, v] = [m[1].toLowerCase(), m[2].trim()];
          if (k === 'host') {
            if (v.includes('*')) {
              cur = null;
              continue;
            }
            cur = { ...siteTemplate('sftp'), id: newId('site-'), name: v, folder: 'Imported/OpenSSH', host: v };
            imported.push(cur);
          } else if (cur) {
            if (k === 'hostname') cur.host = v;
            else if (k === 'user') cur.username = v;
            else if (k === 'port') cur.port = parseInt(v, 10) || 0;
            else if (k === 'identityfile') cur.ssh.privateKeyPath = v;
          }
        }
      } else if (format === 'json') {
        let arr: unknown;
        try {
          arr = JSON.parse(content);
        } catch {
          fail('invalid_input', 'The content is not valid JSON');
        }
        const list = Array.isArray(arr) ? arr : (arr as { sites?: unknown[] })?.sites ?? [];
        for (const x of list as Partial<T.SiteConfig>[]) imported.push({ ...siteTemplate(x.protocol ?? 'sftp'), ...x, id: newId('site-'), folder: x.folder || 'Imported' } as T.SiteConfig);
      } else {
        if (!content.trim()) fail('invalid_input', 'Nothing to import');
        const folder = 'Imported/FileZilla';
        imported.push({ ...siteTemplate('sftp'), id: newId('site-'), name: 'legacy-server', folder, host: 'legacy.example.com', username: 'admin' });
        imported.push({ ...siteTemplate('ftp'), id: newId('site-'), name: 'old-ftp', folder, host: 'ftp.legacy.example.com', username: 'upload' });
      }
      sites.push(...imported);
      log('info', `Imported ${imported.length} site(s) from ${format}`);
      return { imported: imported.length, sites: deepClone(imported) };
    },
    'sites.export': (p) => {
      const ids = p.ids as string[] | null | undefined;
      const list = deepClone(sites.filter((s) => !ids || ids.includes(s.id))).map((s) => ({
        ...s, password: null, ssh: { ...s.ssh, passphrase: null, privateKey: null }, proxy: { ...s.proxy, password: null },
        s3: { ...s.s3, sessionToken: null }, azure: { ...s.azure, sasToken: null }, gcs: { ...s.gcs, credentialJson: null },
      }));
      return { content: JSON.stringify({ version: 1, sites: list }, null, 2) };
    },
    'sites.fromUrl': (p) => parseUrl(String(p.url)),
    'sites.toUrl': (p) => {
      const s = p.site as T.SiteConfig;
      const path = (p.path as string | null) ?? s.remoteDir ?? '';
      return `${s.protocol}://${s.username ? encodeURIComponent(s.username) + '@' : ''}${s.host}${s.port ? ':' + s.port : ''}${path || '/'}`;
    },

    'session.list': () => [...sessions.values()].map((s) => s.summary),
    'session.open': (p) => openSession(p as never),
    'session.close': (p) => {
      const id = String(p.id);
      if (id === 'local') fail('invalid_input', 'The local session cannot be closed');
      const s = sessionOf(id);
      sessions.delete(id);
      for (const t of terms.values()) {
        if (t.info.session === id && t.open) {
          t.open = false;
          emit('terminal.exit', { id: t.info.id, code: null });
        }
      }
      log('info', `Session ${s.summary.name} closed`, id);
      emit('session.closed', { id, reason: null });
      return null;
    },
    'session.reconnect': async (p) => {
      const s = sessionOf(String(p.id));
      await sleep(400);
      log('info', `Reconnected to ${s.summary.host}`, s.summary.id);
      return s.summary;
    },
    'session.info': (p) => {
      const s = sessionOf(String(p.id));
      const sm = s.summary;
      const items: [string, string][] = [
        ['Protocol', sm.protocol === 'sftp' ? 'SFTP (version 3)' : sm.protocol.toUpperCase()],
        ['Host', `${sm.host}`],
        ['User', sm.username || '–'],
        ['Connected since', new Date(sm.connectedAt * 1000).toLocaleString()],
      ];
      if (sm.protocol === 'sftp' || sm.protocol === 'scp') {
        items.push(['Server', 'SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.5'], ['Cipher', 'chacha20-poly1305@openssh.com'], ['Key exchange', 'curve25519-sha256'], ['Host key', `ssh-ed25519 ${fakeFingerprint(sm.host)}`], ['Compression', s.site?.ssh.compression ? 'zlib@openssh.com' : 'none']);
      }
      if (sm.protocol === 'local') items.push(['Operating system', 'Linux 6.8 x86_64']);
      return { items };
    },

    'explorer.targets': () => {
      const ssh = (p: T.Protocol) => p === 'sftp' || p === 'scp';
      const saved = sites.filter((s) => ssh(s.protocol));
      const out: T.ExplorerTarget[] = saved.map((s) => ({
        id: `site:${s.id}`, source: 'site', name: s.name || s.host, folder: s.folder, protocol: s.protocol, host: s.host, port: s.port || 22,
        username: s.username, siteId: s.id, jump: s.ssh.jumpSiteId ? (sites.find((x) => x.id === s.ssh.jumpSiteId)?.name ?? s.ssh.jumpSiteId) : null, color: s.color ?? null,
      }));
      for (const h of sshConfigHosts()) {
        if (saved.some((s) => s.host === h.host && (s.port || 22) === h.port && s.username === h.username)) continue;
        out.push({ id: `ssh:${h.name}`, source: 'sshConfig', name: h.name, folder: '', protocol: 'sftp', host: h.host, port: h.port, username: h.username, siteId: null, jump: h.jump, color: null });
      }
      return out;
    },
    'explorer.connect': async (p) => {
      const target = p.target ? String(p.target) : '';
      let site: T.SiteConfig;
      if (target.startsWith('site:')) site = deepClone(sites.find((x) => x.id === target.slice(5)) ?? fail('not_found', 'Site not found'));
      else if (target.startsWith('ssh:')) {
        const h = sshConfigHosts().find((x) => x.name === target.slice(4)) ?? fail('not_found', `Host ${target.slice(4)} is not in ~/.ssh/config`);
        const t = siteTemplate('sftp');
        site = { ...t, name: h.name, host: h.host, username: h.username, port: h.port, ssh: { ...t.ssh, privateKeyPath: '~/.ssh/id_ed25519' } };
      } else if (target) return fail('invalid_input', `Unknown explorer target ${target}`);
      else if (p.address) site = parseUrl(String(p.address));
      else return fail('invalid_input', 'target or address required');
      if (site.protocol !== 'sftp' && site.protocol !== 'scp') fail('invalid_input', `${site.name || site.host} is not an SSH target`);
      // Demo of the shell fallback: routers and appliances often run SSH without an SFTP server.
      if (site.protocol === 'sftp' && /^router\b/.test(site.host)) {
        log('info', `SFTP not available on ${site.host} (subsystem request failed), using shell commands`);
        site.protocol = 'scp';
      }
      return openSession({ site, password: (p.password as string | null | undefined) ?? null });
    },
    'explorer.preview': (p) => {
      const fsys = fsOf(String(p.session));
      const path = P.normalize(String(p.path));
      const max = Math.min(Math.max(Number(p.maxBytes) || 64 * 1024, 1), 1024 * 1024);
      const r = readText(fsys, path, max);
      return { path, content: r.binary ? '' : r.content, size: r.size, binary: r.binary, truncated: r.size > max };
    },

    'fs.list': (p) => {
      const fsys = fsOf(String(p.session));
      const path = P.normalize(String(p.path));
      return { path, entries: fsys.list(path) };
    },
    'fs.home': (p) => fsOf(String(p.session)).home,
    'fs.realpath': (p) => {
      const fsys = fsOf(String(p.session));
      const path = P.resolve('/', String(p.path), fsys.home);
      const n = fsys.get(path, false);
      if (n?.kind === 'symlink' && n.linkTarget) return P.resolve(P.dirname(path), n.linkTarget);
      fsys.must(path);
      return path;
    },
    'fs.stat': (p) => {
      const fsys = fsOf(String(p.session));
      const path = P.normalize(String(p.path));
      return fsys.entry(fsys.must(path, false), path);
    },
    'fs.mkdir': (p) => {
      const session = String(p.session);
      const path = String(p.path);
      fsOf(session).mkdir(path, !!p.parents);
      changed(session, P.dirname(path));
      log('info', `Created directory ${path}`, session);
      return null;
    },
    'fs.createFile': (p) => {
      const session = String(p.session);
      const path = String(p.path);
      const fsys = fsOf(session);
      if (fsys.get(path, false)) fail('already_exists', `Already exists: ${path}`);
      fsys.put(path, file(P.basename(path), '', { age: 0, owner: fsys.user }));
      changed(session, P.dirname(path));
      return null;
    },
    'fs.rename': (p) => {
      const session = String(p.session);
      const fsys = fsOf(session);
      const from = String(p.from);
      const to = String(p.to);
      const n = fsys.must(from, false);
      if (fsys.get(to, false)) fail('already_exists', `Already exists: ${P.basename(to)}`);
      fsys.remove(from);
      fsys.put(to, n);
      changed(session, P.dirname(from));
      if (P.dirname(to) !== P.dirname(from)) changed(session, P.dirname(to));
      log('info', `Renamed ${from} to ${to}`, session);
      return null;
    },
    'fs.delete': (p) => startDelete(String(p.session), p.paths as string[]),
    'fs.setAttributes': (p) => {
      setAttrs(p as never);
      return null;
    },
    'fs.symlink': (p) => {
      const session = String(p.session);
      const fsys = fsOf(session);
      const linkPath = String(p.link);
      if (fsys.get(linkPath, false)) fail('already_exists', `Already exists: ${linkPath}`);
      const target = String(p.target);
      const t = fsys.get(P.resolve(P.dirname(linkPath), target));
      fsys.put(linkPath, link(P.basename(linkPath), target, t?.kind ?? 'file', { age: 0, owner: fsys.user }));
      changed(session, P.dirname(linkPath));
      return null;
    },
    'fs.readText': (p) => readText(fsOf(String(p.session)), String(p.path), (p.maxBytes as number | undefined) ?? undefined),
    'fs.writeText': (p) => {
      const session = String(p.session);
      const fsys = fsOf(session);
      const path = String(p.path);
      const content = String(p.content);
      const existing = fsys.get(path);
      if (existing) {
        if (existing.kind === 'dir') fail('is_a_directory', `Is a directory: ${path}`);
        const par = fsys.get(P.dirname(path));
        if (par?.readonly && existing.owner === 'root') fail('permission_denied', `Permission denied: ${path}`);
        existing.content = content;
        existing.svg = undefined;
        existing.size = byteLen(content);
        existing.modified = Math.floor(Date.now() / 1000);
      } else {
        fsys.put(path, file(P.basename(path), content, { age: 0, owner: fsys.user }));
      }
      changed(session, P.dirname(path));
      log('info', `Saved ${path} (${byteLen(content)} bytes)`, session);
      return null;
    },
    'fs.readBase64': (p) => {
      const fsys = fsOf(String(p.session));
      const path = String(p.path);
      const n = fsys.must(path);
      if (n.kind === 'dir') fail('is_a_directory', `Is a directory: ${path}`);
      if (n.svg) return { data: utf8ToBase64(n.svg), mime: 'image/svg+xml', size: n.size };
      if (n.content !== undefined) return { data: utf8ToBase64(n.content.slice(0, (p.maxBytes as number) || undefined)), mime: mimeOf(n.name), size: n.size };
      const len = Math.min(n.size, (p.maxBytes as number | undefined) ?? 4096, 4096);
      const bytes = new Uint8Array(len);
      let h = 0x12345 ^ n.size;
      const magic: number[] = n.name.endsWith('.zip') ? [0x50, 0x4b, 0x03, 0x04] : n.name.endsWith('.gz') ? [0x1f, 0x8b, 0x08, 0x00] : n.name.endsWith('.pdf') ? [...'%PDF-1.7\n'].map((c) => c.charCodeAt(0)) : n.name.endsWith('.exe') ? [0x4d, 0x5a, 0x90, 0x00] : [0x7f, 0x45, 0x4c, 0x46];
      for (let i = 0; i < len; i++) {
        h = Math.imul(h ^ i, 2654435761);
        bytes[i] = i < magic.length ? magic[i] : (h >>> 24) & 0xff;
      }
      return { data: bytesToBase64(bytes), mime: mimeOf(n.name), size: n.size };
    },
    'fs.checksum': async (p) => {
      const fsys = fsOf(String(p.session));
      const path = String(p.path);
      const n = fsys.must(path);
      if (n.kind === 'dir') fail('is_a_directory', 'Checksums can only be computed for files');
      await sleep(Math.min(1500, 200 + n.size / 2e6));
      const data = contentKey(n);
      const algo = p.algo as T.ChecksumAlgo;
      if (algo === 'sha256') return sha('SHA-256', data);
      if (algo === 'sha1') return sha('SHA-1', data);
      return fakeHex('md5' + data, 32);
    },
    'fs.dirSize': async (p) => {
      const fsys = fsOf(String(p.session));
      let size = 0;
      let files = 0;
      let dirs = 0;
      const walk = (n: MNode) => {
        if (n.kind === 'dir') {
          dirs++;
          for (const c of n.children!.values()) walk(c);
        } else {
          files++;
          size += n.size;
        }
      };
      walk(fsys.must(String(p.path)));
      await sleep(300);
      return { size, files, dirs: Math.max(0, dirs - 1) };
    },
    'fs.diskInfo': (p) => {
      const s = sessionOf(String(p.session));
      if (!s.summary.capabilities.diskInfo) return null;
      const total = s.fs.totalBytes;
      const used = Math.min(total * 0.9, s.fs.usedBytes() + total * 0.55);
      const free = Math.max(0, total - used);
      return { total, free, available: free * 0.95 };
    },
    'fs.exec': async (p) => {
      await sleep(250);
      const cmd = String(p.command);
      if (cmd.startsWith('false')) return { stdout: '', stderr: 'command failed', exitCode: 1 };
      return { stdout: `$ ${cmd}\n(mock) executed in ${p.cwd ?? '~'}\n`, stderr: '', exitCode: 0 };
    },

    'compare.pairs': (p) => {
      const src = fsOf(String(p.srcSession));
      const dst = fsOf(String(p.dstSession));
      const paths = p.srcPaths as string[];
      const dstDir = P.normalize(String(p.dstDir));
      const max = Number(p.maxFiles) || 5000;
      const rename = paths.length === 1 && typeof p.newName === 'string' ? p.newName.trim() : '';
      const mask = compileMask(String(p.fileMask ?? ''));
      const pairs: T.FilePair[] = [];
      let truncated = false;
      const visit = (path: string, rel: string, targetPath: string, top: boolean) => {
        const n = src.must(path);
        const name = P.basename(path);
        if (!top && ((p.excludeHidden && name.startsWith('.')) || !matchTransferMask(mask, name, n.kind === 'dir'))) return;
        if (n.kind === 'dir') {
          for (const c of [...n.children!.values()].sort((a, b) => a.name.localeCompare(b.name))) visit(P.join(path, c.name), `${rel}/${c.name}`, P.join(targetPath, c.name), false);
          return;
        }
        if (pairs.length >= max) {
          truncated = true;
          return;
        }
        const t = dst.get(targetPath, false);
        pairs.push({ rel, source: src.entry(n, path), targetPath, target: t ? dst.entry(t, targetPath) : null });
      };
      for (const sp of paths) {
        const name = rename || P.basename(sp);
        visit(P.normalize(sp), name, P.join(dstDir, name), true);
      }
      return { pairs, truncated };
    },

    'archive.extract': (p) => {
      const session = String(p.session);
      const fsys = fsOf(session);
      const path = String(p.path);
      const n = fsys.must(path);
      const stem = P.basename(path).replace(/\.(zip|tar|tar\.gz|tgz|tar\.bz2|tar\.xz|7z|rar)$/i, '');
      const dstDir = P.join(String(p.dstDir), stem);
      const total = n.size;
      const names = ['README.txt', 'data.bin', 'docs/manual.pdf', 'docs/changelog.md'];
      const rebuild = () => {
        const steps: Step[] = [{ t: 'mkdir', fs: fsys, path: dstDir, session }, { t: 'mkdir', fs: fsys, path: P.join(dstDir, 'docs'), session }];
        names.forEach((nm, i) => {
          const size = Math.floor(total * [0.01, 0.7, 0.25, 0.04][i]);
          steps.push({ t: 'create', fs: fsys, path: P.join(dstDir, nm), node: nm.endsWith('.txt') || nm.endsWith('.md') ? file(P.basename(nm), `Extracted from ${P.basename(path)}\n`) : file(P.basename(nm), size), session, size });
        });
        return steps;
      };
      return { ...makeJob('transfer', `Extract '${P.basename(path)}'`, { srcSession: session, dstSession: session, srcPaths: [path], dstDir: String(p.dstDir) }, { ...settings.transfer }, rebuild).job };
    },
    'archive.create': (p) => {
      const session = String(p.session);
      const fsys = fsOf(session);
      const paths = p.paths as string[];
      const dst = String(p.dst);
      if (fsys.get(dst)) fail('already_exists', `Already exists: ${dst}`);
      const total = paths.reduce((s, x) => s + countTree(fsys, x, false).bytes, 0);
      const size = Math.max(200, Math.floor(total * 0.62));
      const rebuild = (): Step[] => [{ t: 'create', fs: fsys, path: dst, node: file(P.basename(dst), size, { age: 0 }), session, size }];
      return { ...makeJob('transfer', `Create archive '${P.basename(dst)}'`, { srcSession: session, dstSession: session, srcPaths: [...paths], dstDir: P.dirname(dst) }, { ...settings.transfer }, rebuild).job };
    },

    'transfer.defaults': () => deepClone(settings.transfer),
    'transfer.start': (p) => startTransfer(p as never),
    'jobs.list': () => [...jobs.values()].map((j) => ({ ...j.job })),
    'jobs.pause': (p) => {
      const mj = jobs.get(String(p.id)) ?? fail('not_found', 'Job not found');
      if (mj.job.state === 'running' || mj.job.state === 'queued') {
        mj.job.state = 'paused';
        mj.job.speed = 0;
        mj.job.eta = null;
        emit('job.updated', { ...mj.job });
      }
      return null;
    },
    'jobs.resume': (p) => {
      const mj = jobs.get(String(p.id)) ?? fail('not_found', 'Job not found');
      if (mj.job.state === 'paused') {
        mj.job.state = 'queued';
        emit('job.updated', { ...mj.job });
        ensureTicker();
      }
      return null;
    },
    'jobs.cancel': (p) => {
      const mj = jobs.get(String(p.id)) ?? fail('not_found', 'Job not found');
      if (!['completed', 'failed', 'cancelled'].includes(mj.job.state)) finishJob(mj, 'cancelled');
      return null;
    },
    'jobs.retry': (p) => {
      const mj = jobs.get(String(p.id)) ?? fail('not_found', 'Job not found');
      mj.steps = mj.rebuild();
      mj.pos = 0;
      mj.stepDone = 0;
      mj.applyAll = null;
      Object.assign(mj.job, { state: 'queued', bytesDone: 0, filesDone: 0, errors: [], conflict: null, finishedAt: null, scanning: false, speed: 0, eta: null });
      computeTotals(mj);
      emit('job.updated', { ...mj.job });
      ensureTicker();
      return { ...mj.job };
    },
    'jobs.remove': (p) => {
      const id = String(p.id);
      const mj = jobs.get(id);
      if (mj && !['completed', 'failed', 'cancelled'].includes(mj.job.state)) finishJob(mj, 'cancelled');
      jobs.delete(id);
      emit('job.removed', { id });
      return null;
    },
    'jobs.clearFinished': () => {
      for (const [id, mj] of jobs) {
        if (['completed', 'failed', 'cancelled'].includes(mj.job.state)) {
          jobs.delete(id);
          emit('job.removed', { id });
        }
      }
      return null;
    },
    'jobs.resolveConflict': (p) => {
      const mj = jobs.get(String(p.id)) ?? fail('not_found', 'Job not found');
      if (!mj.job.conflict || mj.job.conflict.id !== p.conflictId) fail('invalid_input', 'No such conflict');
      const action = p.action as T.ConflictAction;
      if (action === 'cancel') {
        finishJob(mj, 'cancelled');
        return null;
      }
      const step = mj.steps[mj.pos];
      if (step && step.t === 'copy') {
        const existing = step.dst.get(step.dstPath, false);
        step.checked = true;
        if (action === 'skip' || (action === 'newer' && existing && step.node.modified <= existing.modified)) {
          mj.job.bytesDone += step.size;
          mj.job.filesDone++;
          mj.pos++;
        } else if (action === 'resume' && existing) {
          mj.stepDone = Math.min(existing.size, step.size);
          mj.job.bytesDone += mj.stepDone;
        } else if (action === 'rename') {
          const nn = (p.newName as string | null | undefined)?.trim();
          step.dstPath = nn ? P.join(P.dirname(step.dstPath), nn) : uniqueName(step.dst, step.dstPath);
          if (step.dst.get(step.dstPath, false)) step.dstPath = uniqueName(step.dst, step.dstPath);
        }
      }
      if (p.applyToAll) mj.applyAll = action === 'rename' ? 'rename' : action;
      mj.job.conflict = null;
      mj.job.state = 'running';
      emit('job.updated', { ...mj.job });
      ensureTicker();
      return null;
    },

    'sync.defaults': () => ({
      leftSession: 'local', leftPath: '/home/demo', rightSession: 'local', rightPath: '/home/demo', direction: 'leftToRight', mode: 'update',
      deleteObsolete: false, compareSize: true, compareTime: true, compareChecksum: false, timeTolerance: 2, fileMask: '', excludeHidden: false, nonRecursive: false,
    } satisfies T.SyncParams),
    'sync.compare': (p) => syncCompare(p.params as T.SyncParams),
    'sync.execute': (p) => syncExecute(String(p.planId), p.actionIds as string[], p.options as Partial<T.TransferOptions> | undefined),
    'sync.discard': (p) => {
      plans.delete(String(p.planId));
      return null;
    },

    'watch.list': () => [...watches.values()],
    'watch.start': (p) => {
      fsOf('local').dirNode(String(p.localPath));
      const s = sessionOf(String(p.remoteSession));
      s.fs.dirNode(String(p.remotePath));
      const w: T.Watch = { id: newId('w'), localPath: String(p.localPath), remoteSession: String(p.remoteSession), remotePath: String(p.remotePath), deleteRemote: !!p.deleteRemote, fileMask: String(p.fileMask ?? ''), uploads: 0, lastEvent: 'Watching for changes…', error: null };
      watches.set(w.id, w);
      log('info', `Keeping ${w.remotePath} on ${s.summary.name} up to date with ${w.localPath}`, s.summary.id);
      if (p.initialSync) setTimeout(() => {
        w.lastEvent = 'Initial synchronization complete';
        emit('watch.updated', { ...w });
      }, 800);
      return { ...w };
    },
    'watch.stop': (p) => {
      watches.delete(String(p.id));
      return null;
    },

    'search.start': (p) => startSearch(p.params as T.SearchParams),
    'search.cancel': (p) => {
      const s = searches.get(String(p.id));
      if (s) s.cancelled = true;
      return null;
    },

    'terminal.open': (p) => {
      const s = sessionOf(String(p.session));
      if (!s.summary.capabilities.terminal) fail('unsupported', `${s.summary.protocol.toUpperCase()} sessions have no terminal`);
      const id = newId('term');
      const host = s.summary.id === 'local' ? 'demo-workstation' : s.summary.host.split('.')[0];
      const user = s.summary.username || 'demo';
      const cwd = (p.cwd as string | null) && s.fs.get(String(p.cwd)) ? String(p.cwd) : s.fs.home;
      const t: MTerm = { info: { id, session: s.summary.id, title: `${user}@${host}` }, fs: s.fs, cwd, line: '', user, host, open: true };
      terms.set(id, t);
      setTimeout(() => {
        if (s.summary.id !== 'local') tw(t, `Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-45-generic x86_64)\r\n\r\n * Documentation:  https://help.ubuntu.com\r\n\r\nLast login: ${new Date(Date.now() - 86400000).toUTCString()} from 192.168.1.23\r\n`);
        tw(t, `\x1b[2m(Rust Commander demo shell – type 'help')\x1b[0m\r\n`);
        tw(t, promptStr(t));
      }, fast ? 5 : 150);
      return t.info;
    },
    'terminal.list': () => [...terms.values()].filter((t) => t.open).map((t) => t.info),
    'terminal.write': (p) => {
      termWrite(String(p.id), String(p.data));
      return null;
    },
    'terminal.resize': () => null,
    'terminal.close': (p) => {
      const t = terms.get(String(p.id));
      if (t && t.open) {
        t.open = false;
        emit('terminal.exit', { id: t.info.id, code: null });
      }
      terms.delete(String(p.id));
      return null;
    },

    'tunnel.list': () => [...tunnels.values()],
    'tunnel.start': (p) => {
      const s = sessionOf(String(p.session));
      if (!s.summary.capabilities.tunnels) fail('unsupported', 'Tunnels need an SSH session');
      const bindPort = Number(p.bindPort);
      if (bindPort > 0 && bindPort < 1024) fail('permission_denied', `Binding to port ${bindPort} requires elevated privileges`);
      for (const t of tunnels.values()) if (t.bindPort === bindPort) fail('already_exists', `Port ${bindPort} is already in use`);
      const tn: T.Tunnel = { id: newId('tun'), session: s.summary.id, kind: p.kind as T.TunnelKind, bindHost: String(p.bindHost || '127.0.0.1'), bindPort, targetHost: (p.targetHost as string) ?? null, targetPort: (p.targetPort as number) ?? null, connections: 0, bytesIn: 0, bytesOut: 0, error: null };
      tunnels.set(tn.id, tn);
      log('info', `Tunnel ${tn.bindHost}:${tn.bindPort} → ${tn.kind === 'dynamic' ? 'SOCKS5' : `${tn.targetHost}:${tn.targetPort}`} started`, s.summary.id);
      return { ...tn };
    },
    'tunnel.stop': (p) => {
      tunnels.delete(String(p.id));
      return null;
    },

    'bookmarks.list': () => deepClone(bookmarks),
    'bookmarks.save': (p) => {
      const b = { ...(p.bookmark as T.Bookmark) };
      if (!b.id) b.id = newId('bm');
      bookmarks = [...bookmarks.filter((x) => x.id !== b.id), b];
      return b;
    },
    'bookmarks.delete': (p) => {
      bookmarks = bookmarks.filter((x) => x.id !== p.id);
      return null;
    },

    'commands.list': () => deepClone(commands),
    'commands.save': (p) => {
      const c = { ...(p.command as T.CustomCommand) };
      if (!c.id) c.id = newId('cmd');
      const i = commands.findIndex((x) => x.id === c.id);
      if (i >= 0) commands[i] = c;
      else commands = [...commands, c];
      return c;
    },
    'commands.delete': (p) => {
      commands = commands.filter((x) => x.id !== p.id);
      return null;
    },
    'commands.run': async (p) => {
      const c = p.id ? commands.find((x) => x.id === p.id) : null;
      const template = c?.command ?? String(p.command ?? '');
      const names = (p.names as string[]) ?? [];
      await sleep(300);
      const s = sessionOf(String(p.session));
      const expand = (n: string | null) =>
        template.replace(/!!/g, '\u0001').replace(/!&/g, names.map((x) => `"${x}"`).join(' ')).replace(/!\//g, String(p.cwd)).replace(/!@/g, s.summary.host).replace(/!U/g, s.summary.username).replace(/!/g, n ?? names[0] ?? '').replace(/\u0001/g, '!');
      const runs = c?.perFile ? names.map((n) => expand(n)) : [expand(null)];
      log('info', `Running custom command: ${runs.join('; ')}`, s.summary.id);
      return runs.map((cmd) => ({
        stdout: cmd.startsWith('du ') ? names.map((n) => `${(Math.random() * 900).toFixed(0)}M\t${n}`).join('\n') + '\n' : cmd.startsWith('tail') ? TEXT.deployLog.split('\n').slice(-12).join('\n') : `$ ${cmd}\n`,
        stderr: '',
        exitCode: 0,
      }));
    },

    'edit.external': (p) => {
      const e: T.ExternalEdit = { id: newId('ed'), session: String(p.session), remotePath: String(p.path), localPath: `/tmp/rcmd-edit/${newId('')}/${P.basename(String(p.path))}`, uploads: 0, lastError: null };
      edits.set(e.id, e);
      log('info', `Opened ${e.remotePath} in the system editor`, e.session);
      setTimeout(() => {
        if (!edits.has(e.id)) return;
        e.uploads++;
        emit('edit.updated', { ...e });
      }, fast ? 50 : 5000);
      return { ...e };
    },
    'edit.list': () => [...edits.values()],
    // the demo has no formatters installed: Prettier, SQL and XML run in the browser anyway
    'edit.formatters': () => [],
    'edit.format': (p) => fail('unsupported', `no formatter for ${String(p.language)} is installed`),
    'edit.stop': (p) => {
      edits.delete(String(p.id));
      return null;
    },

    'knownHosts.list': () => deepClone(knownHosts),
    'knownHosts.remove': (p) => {
      const i = knownHosts.findIndex((k) => k.key === p.key && (!p.fingerprint || k.fingerprint === p.fingerprint));
      if (i >= 0) knownHosts.splice(i, 1);
      return null;
    },

    'prompt.pending': () => [...pending.entries()].map(([id, x]) => ({ id, request: x.request })),
    'prompt.respond': (p) => {
      const id = String(p.id);
      const x = pending.get(id);
      if (!x) fail('not_found', 'Prompt not found (already answered?)');
      pending.delete(id);
      x!.resolve((p.response as T.PromptResponse | null) ?? null);
      emit('prompt.closed', { id });
      return null;
    },

    'log.recent': () => [...logs],

    'discovery.status': () => ({ ...discovery }),
    'discovery.peers': () => allPeers(),
    'discovery.refresh': () => {
      setTimeout(() => {
        const t = Math.floor(Date.now() / 1000);
        for (const pr of peers) if (pr.online) pr.lastSeen = t;
        emitPeers();
      }, fast ? 20 : 600);
      return null;
    },
    'discovery.add': async (p) => {
      const address = String(p.address).trim();
      await sleep(500);
      if (!address || address.includes('fail')) fail('timeout', `No Rust Commander instance answered at ${address}`);
      let host = address;
      let port = 8822;
      let tls = false;
      try {
        const u = new URL(address.includes('://') ? address : `http://${address}`);
        host = u.hostname;
        if (u.port) port = parseInt(u.port, 10);
        tls = u.protocol === 'https:';
      } catch {
        /* keep */
      }
      const peer: T.Peer = { id: newId('peer-'), name: host, hostname: host, version: '0.9.0', os: 'linux', user: null, addresses: [host], web: { port, tls, fingerprint: tls ? '9C:21:7A:E4:0B:55:13:D8:6F:A2:C9:30:4E:B1:87:F6:2D:58:E0:1A:93:7C:C4:6B:05:D2:B8:3F:61:E7:4A:90' : null, url: `${tls ? 'https' : 'http'}://${host}:${port}` }, lastSeen: Math.floor(Date.now() / 1000), manual: true, self: false, online: true };
      peers.push(peer);
      emitPeers();
      return peer;
    },
    'discovery.remove': (p) => {
      const i = peers.findIndex((x) => x.id === p.id);
      if (i >= 0) peers.splice(i, 1);
      emitPeers();
      return null;
    },

    'server.status': () => ({ ...server }),
    'server.start': async (p) => {
      if (opts.webMode) fail('unsupported', 'Not available in web mode');
      await sleep(400);
      server.bind = (p.bind as string) ?? server.bind;
      server.port = (p.port as number) ?? server.port;
      server.tls = (p.tls as boolean) ?? server.tls;
      server.running = true;
      server.error = null;
      server.fingerprint = server.tls ? 'AB:12:9F:33:E0:71:5C:2A:88:41:D3:6B:0E:F7:19:C4:52:7D:A9:3E:61:B8:04:CF:95:2D:7A:E6:10:8B:3F:47' : null;
      const scheme = server.tls ? 'https' : 'http';
      server.urls = server.bind === '127.0.0.1' ? [`${scheme}://127.0.0.1:${server.port}`] : [`${scheme}://192.168.1.23:${server.port}`, `${scheme}://demo-workstation.local:${server.port}`, `${scheme}://[fe80::a00:27ff:fe4e:66a1]:${server.port}`];
      log('info', `Web UI listening on ${server.urls.join(', ')}`);
      emit('server.status', { ...server });
      emitPeers();
      setTimeout(() => {
        if (!server.running) return;
        server.clients = 1;
        emit('server.status', { ...server });
      }, fast ? 50 : 4000);
      return { ...server };
    },
    'server.stop': () => {
      if (opts.webMode) fail('unsupported', 'Not available in web mode');
      Object.assign(server, { running: false, urls: [], clients: 0, fingerprint: null });
      log('info', 'Web UI stopped');
      emit('server.status', { ...server });
      emitPeers();
      return { ...server };
    },
    'server.setPassword': (p) => {
      server.hasPassword = !!p.password;
      emit('server.status', { ...server });
      return { ...server };
    },
  };

  return {
    async call(method, params) {
      if (opts.login && !authenticated) fail('unauthorized', 'Not logged in');
      const fn = methods[method];
      if (!fn) fail('unknown_method', `Unknown method '${method}'`);
      if (vault.locked && (method.startsWith('sites.') || method === 'session.open' || method === 'explorer.connect')) fail('locked', 'The credential vault is locked');
      await latency();
      try {
        const r = await fn((params ?? {}) as Dict);
        return r === undefined ? null : deepClone(r);
      } catch (e) {
        if (e instanceof MockError) throw { code: e.code, message: e.message };
        throw { code: 'other', message: e instanceof Error ? e.message : String(e) };
      }
    },
    webInfo: () => ({ name: info.instanceName, version: info.version, authRequired: opts.login, authenticated }),
    webLogin(password) {
      if (password === 'demo') authenticated = true;
      return authenticated;
    },
    async upload(session, path, f, onProgress, signal) {
      const fsys = fsOf(session);
      const total = f.size;
      const steps = fast ? 2 : Math.max(4, Math.min(30, Math.ceil(total / 400_000)));
      for (let i = 1; i <= steps; i++) {
        if (signal.aborted) throw new MockError('cancelled', 'Upload cancelled');
        await sleep(fast ? 5 : 120);
        onProgress(Math.round((total * i) / steps));
      }
      let node: MNode;
      if (total < 2_000_000 && (f.type.startsWith('text/') || /\.(txt|md|json|js|ts|css|html|xml|yml|yaml|sh|conf|log|csv)$/i.test(f.name))) node = file(f.name, await f.text(), { age: 0, owner: fsys.user });
      else if (f.type === 'image/svg+xml') node = image(f.name, await f.text(), total, { age: 0, owner: fsys.user });
      else node = file(f.name, total, { age: 0, owner: fsys.user });
      const par = P.dirname(path);
      if (!fsys.get(par)) fsys.mkdir(par, true);
      fsys.put(path, node);
      changed(session, par);
      log('info', `Uploaded ${path} (${total} bytes)`, session);
    },
    async download(session, paths) {
      const fsys = fsOf(session);
      if (paths.length === 1) {
        const n = fsys.must(paths[0]);
        if (n.kind !== 'dir') {
          const body = n.content ?? n.svg ?? `Mock content of ${n.name} (${n.size} bytes)\n`;
          return { blob: new Blob([body], { type: n.svg ? 'image/svg+xml' : 'application/octet-stream' }), name: n.name };
        }
      }
      const listing = paths.map((p) => `${p} (${countTree(fsys, p, false).files} files)`).join('\n');
      return { blob: new Blob([`Mock ZIP archive containing:\n${listing}\n`], { type: 'application/zip' }), name: paths.length === 1 ? `${P.basename(paths[0])}.zip` : 'download.zip' };
    },
  };
}
