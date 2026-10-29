// Rust Commander RPC contract.
//
// This file is the single source of truth for the API between the UI and the Rust
// backend (crates/rc-api). The same methods are reachable
//   * in the desktop app via Tauri:  invoke('rpc', { method, params })
//   * in web mode via HTTP:          POST /api/rpc  { method, params }  -> { result } | { error }
// Events are delivered
//   * in the desktop app via the Tauri event 'rc-event' with payload { name, payload }
//   * in web mode via the WebSocket  /api/events   with messages      { name, payload }
//
// All field names are camelCase; timestamps are Unix seconds unless noted otherwise.

// ---------------------------------------------------------------- basics

export type FileKind = 'file' | 'dir' | 'symlink' | 'other';

export interface FileEntry {
  name: string;
  /** Absolute path inside the session's file system ('/'-separated, 'C:/x' on Windows). */
  path: string;
  kind: FileKind;
  size: number;
  modified?: number;
  /** Permission bits (0o7777 mask). */
  permissions?: number;
  owner?: string;
  group?: string;
  linkTarget?: string;
  /** For symlinks: kind of the target. A symlink with targetKind 'dir' is navigable. */
  targetKind?: FileKind;
  hidden: boolean;
}

export type Protocol = 'local' | 'sftp' | 'scp' | 'ftp' | 'webdav' | 's3' | 'azure' | 'gcs' | 'rcmd';

export interface Capabilities {
  permissions: boolean;
  owner: boolean;
  symlinks: boolean;
  exec: boolean;
  terminal: boolean;
  tunnels: boolean;
  serverCopy: boolean;
  resumeUpload: boolean;
  resumeDownload: boolean;
  setModified: boolean;
  serverChecksum: boolean;
  diskInfo: boolean;
}

export interface DiskInfo { total: number; free: number; available: number }

export interface ExecOutput { stdout: string; stderr: string; exitCode?: number | null }

export type ChecksumAlgo = 'md5' | 'sha1' | 'sha256';

/** Error object returned by failed calls (Tauri reject value / HTTP error body `error`). */
export interface RpcError {
  code:
    | 'not_found' | 'permission_denied' | 'already_exists' | 'not_a_directory' | 'is_a_directory'
    | 'directory_not_empty' | 'unsupported' | 'invalid_input' | 'auth_failed' | 'host_key_rejected'
    | 'cancelled' | 'connection_lost' | 'timeout' | 'protocol' | 'io' | 'locked' | 'other'
    | 'unknown_method' | 'unauthorized' | 'forbidden';
  message: string;
}

// ---------------------------------------------------------------- sites

/** Secret fields (password, passphrase, privateKey, ...) that are stored are returned as this
 * placeholder. Sending the placeholder back on save keeps the stored secret; `null` removes it. */
export const SECRET_PLACEHOLDER = '<<rc:secret>>';

export type FtpEncryption = 'none' | 'explicit' | 'implicit';
export type ProxyKind = 'none' | 'socks5' | 'http';

export interface SiteConfig {
  id: string;            // '' for a new site
  name: string;
  folder: string;        // '/'-separated folder in the site tree, '' = root
  protocol: Protocol;
  host: string;
  port: number;          // 0 = protocol default
  username: string;
  password?: string | null;
  remoteDir: string;
  localDir: string;
  timeoutSecs: number;
  keepaliveSecs: number;
  color?: string | null;
  notes: string;
  ssh: {
    privateKeyPath?: string | null;
    privateKey?: string | null;
    passphrase?: string | null;
    useAgent: boolean;
    tryPassword: boolean;
    tryKeyboardInteractive: boolean;
    tryDefaultKeys: boolean;
    compression: boolean;
    sftpServer?: string | null;   // e.g. 'sudo -n /usr/lib/openssh/sftp-server'
    jumpSiteId?: string | null;   // ProxyJump through another saved site
    env: [string, string][];
    shell?: string | null;
    useOpensshKnownHosts: boolean;
  };
  ftp: { encryption: FtpEncryption; passive: boolean; allowInvalidCerts: boolean; useMlsd: boolean; maxConnections: number };
  webdav: { https: boolean; root: string; allowInvalidCerts: boolean };
  s3: { region: string; endpoint: string; bucket: string; pathStyle: boolean; sessionToken?: string | null; anonymous: boolean };
  azure: { account: string; container: string; endpoint: string; sasToken?: string | null };
  gcs: { bucket: string; credentialJson?: string | null; endpoint: string };
  rcmd: { tls: boolean; fingerprint?: string | null };
  proxy: { kind: ProxyKind; host: string; port: number; username: string; password?: string | null };
}

export type ImportFormat = 'openssh' | 'winscp' | 'filezilla' | 'json';

// ---------------------------------------------------------------- sessions

export interface SessionSummary {
  /** 'local' is always present and cannot be closed. */
  id: string;
  name: string;
  protocol: Protocol;
  siteId?: string | null;
  host: string;
  username: string;
  color?: string | null;
  url: string;
  home: string;
  /** Directory to open initially (site remoteDir or home). */
  initialDir: string;
  /** Local directory the site wants in the other panel ('' = none). */
  localDir: string;
  capabilities: Capabilities;
  connectedAt: number;
}

export interface SessionInfo { items: [string, string][] }

// ---------------------------------------------------------------- transfers & jobs

export type OverwriteMode = 'ask' | 'overwrite' | 'skip' | 'newer' | 'differentSize' | 'resume' | 'rename';
export type TransferMode = 'binary' | 'text' | 'auto';

export interface TransferOptions {
  /** Delete the source after a successful copy (= move). */
  move: boolean;
  overwrite: OverwriteMode;
  preserveTimestamps: boolean;
  /** Copy permission bits from the source where both sides support them. */
  preservePermissions: boolean;
  /** Set these permission bits on uploaded files (overrides preservePermissions). */
  permissions?: number | null;
  mode: TransferMode;
  /** Masks treated as text in 'auto' mode, e.g. '*.txt; *.html; *.php'. */
  textMasks: string;
  /** WinSCP-style file mask: '*.jpg; *.png | thumbs/; *.tmp'  (include | exclude, dirs end with '/'). */
  fileMask: string;
  excludeHidden: boolean;
  /** Bytes per second, 0 = unlimited. */
  speedLimit: number;
  /** Upload to '<name>.filepart' and rename when complete. */
  tempUpload: boolean;
  /** Compare SHA-256 of source and target after each file. */
  verifyChecksum: boolean;
  /** Number of files transferred in parallel within one job (1-8). */
  parallel: number;
  /** For a single source item: name to use at the target. */
  newName?: string | null;
  followSymlinks: boolean;
}

export type JobKind = 'transfer' | 'delete' | 'sync';
export type JobState = 'queued' | 'running' | 'paused' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export interface JobError { path: string; message: string }

export interface ConflictInfo {
  id: string;
  source: FileEntry;
  target: FileEntry;
}

export interface Job {
  id: string;
  kind: JobKind;
  title: string;
  state: JobState;
  srcSession?: string | null;
  dstSession?: string | null;
  srcPaths: string[];
  dstDir?: string | null;
  bytesTotal: number;
  bytesDone: number;
  filesTotal: number;
  filesDone: number;
  /** Still counting the source tree. */
  scanning: boolean;
  currentFile?: string | null;
  /** Bytes per second (smoothed). */
  speed: number;
  /** Seconds remaining (estimated). */
  eta?: number | null;
  errors: JobError[];
  /** Set while state === 'waiting': an overwrite question the user must answer. */
  conflict?: ConflictInfo | null;
  createdAt: number;
  startedAt?: number | null;
  finishedAt?: number | null;
}

export type ConflictAction = 'overwrite' | 'skip' | 'resume' | 'rename' | 'newer' | 'cancel';

// ---------------------------------------------------------------- synchronization

export type SyncDirection = 'leftToRight' | 'rightToLeft' | 'both';
export type SyncMode = 'update' | 'mirror';

export interface SyncParams {
  leftSession: string;
  leftPath: string;
  rightSession: string;
  rightPath: string;
  direction: SyncDirection;
  /** update: copy new + newer files; mirror: make target identical to source (also older files). */
  mode: SyncMode;
  /** Delete files on the target side that do not exist on the source side. */
  deleteObsolete: boolean;
  compareSize: boolean;
  compareTime: boolean;
  compareChecksum: boolean;
  /** Allowed mtime difference in seconds (FAT/FTP precision). */
  timeTolerance: number;
  fileMask: string;
  excludeHidden: boolean;
  /** Compare only the given directories, not their subdirectories. */
  nonRecursive: boolean;
}

export type SyncActionKind = 'copyLeftToRight' | 'copyRightToLeft' | 'deleteLeft' | 'deleteRight' | 'conflict';
export type SyncReason = 'new' | 'newer' | 'older' | 'sizeDiffers' | 'checksumDiffers' | 'obsolete' | 'bothChanged';

export interface SyncAction {
  id: string;
  /** Path relative to leftPath/rightPath. */
  relPath: string;
  isDir: boolean;
  action: SyncActionKind;
  reason: SyncReason;
  left?: FileEntry | null;
  right?: FileEntry | null;
}

export interface SyncPlan {
  id: string;
  params: SyncParams;
  actions: SyncAction[];
  scannedLeft: number;
  scannedRight: number;
  identical: number;
}

export interface Watch {
  id: string;
  localPath: string;
  remoteSession: string;
  remotePath: string;
  deleteRemote: boolean;
  fileMask: string;
  uploads: number;
  lastEvent?: string | null;
  error?: string | null;
}

// ---------------------------------------------------------------- search

export interface SearchParams {
  session: string;
  root: string;
  /** File mask like '*.log; *.txt' (empty = all). */
  nameMask: string;
  /** Find files containing this text (slow on remote sessions). */
  contentText?: string | null;
  caseSensitive: boolean;
  minSize?: number | null;
  maxSize?: number | null;
  modifiedAfter?: number | null;
  modifiedBefore?: number | null;
  includeHidden: boolean;
  includeDirs: boolean;
  maxDepth?: number | null;
}

// ---------------------------------------------------------------- terminal & tunnels

export interface TerminalInfo { id: string; session: string; title: string }

export type TunnelKind = 'local' | 'dynamic';

export interface Tunnel {
  id: string;
  session: string;
  kind: TunnelKind;
  bindHost: string;
  bindPort: number;
  targetHost?: string | null;
  targetPort?: number | null;
  connections: number;
  bytesIn: number;
  bytesOut: number;
  error?: string | null;
}

// ---------------------------------------------------------------- misc

export interface Bookmark { id: string; name: string; /** 'local', a site id, or '*' for any */ scope: string; path: string }

export interface CustomCommand {
  id: string;
  name: string;
  /** Patterns: ! = file name, !& = all selected names (quoted), !/ = current dir,
   *  !@ = host, !U = user name, !! = literal '!'. */
  command: string;
  /** Run once per selected file, or once for the whole selection. */
  perFile: boolean;
  /** Run on the panel's session ('remote') or always on the local machine ('local'). */
  target: 'session' | 'local';
  showOutput: boolean;
  refresh: boolean;
}

export interface KnownHost { key: string; keyType: string; fingerprint: string; publicKey: string; added: number }

export interface ExternalEdit { id: string; session: string; remotePath: string; localPath: string; uploads: number; lastError?: string | null }

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export interface LogEntry { ts: number /* ms */; level: LogLevel; session?: string | null; message: string }

export interface Peer {
  /** Instance id (random UUID, stable per installation). */
  id: string;
  name: string;
  hostname: string;
  version: string;
  os: string;
  user?: string | null;
  addresses: string[];
  /** Present when the instance exposes its web UI. */
  web?: { port: number; tls: boolean; fingerprint?: string | null; url: string } | null;
  lastSeen: number;
  /** Added by address instead of discovered by broadcast. */
  manual: boolean;
  /** This very instance. */
  self: boolean;
  online: boolean;
}

export interface DiscoveryStatus { enabled: boolean; port: number; instanceId: string; instanceName: string; error?: string | null }

export interface ServerStatus {
  running: boolean;
  bind: string;
  port: number;
  tls: boolean;
  fingerprint?: string | null;
  urls: string[];
  hasPassword: boolean;
  clients: number;
  error?: string | null;
}

export interface Settings {
  language: 'auto' | 'en' | 'de';
  theme: 'system' | 'light' | 'dark';
  showHidden: boolean;
  confirmDelete: boolean;
  confirmOverwrite: boolean;
  /** Prefer native file manager style double-click behaviour for files: 'edit' | 'open' | 'download' */
  doubleClickAction: 'edit' | 'open' | 'transfer';
  sizeFormat: 'auto' | 'bytes';
  maxConcurrentJobs: number;
  transfer: TransferOptions;
  discovery: { enabled: boolean; port: number; instanceName: string; intervalSecs: number };
  server: { autoStart: boolean; bind: string; port: number; tls: boolean; allowTerminal: boolean };
  editor: { fontSize: number; wordWrap: boolean; tabSize: number };
  terminal: { fontSize: number; fontFamily: string; scrollback: number };
}

export interface AppInfo {
  version: string;
  mode: 'desktop' | 'web';
  hostname: string;
  os: string;
  arch: string;
  user: string;
  homeDir: string;
  instanceId: string;
  instanceName: string;
  features: { terminal: boolean; localExec: boolean; externalEdit: boolean; openLocal: boolean; protocols: Protocol[] };
}

export interface VaultStatus { hasMasterPassword: boolean; locked: boolean }

/** Requests the backend raises while connecting or transferring. Answer with 'prompt.respond'. */
export type PromptRequest =
  | { kind: 'host_key'; host: string; port: number; keyType: string; fingerprint: string; state: 'new' | 'changed'; previousFingerprint?: string }
  | { kind: 'certificate'; host: string; port: number; fingerprint: string; subject: string; issuer: string; reason: string; state: 'new' | 'changed' }
  | { kind: 'password'; host: string; username: string; message: string }
  | { kind: 'username'; host: string }
  | { kind: 'passphrase'; keyPath: string }
  | { kind: 'keyboard_interactive'; host: string; name: string; instructions: string; prompts: { text: string; echo: boolean }[] }
  | { kind: 'banner'; host: string; message: string }
  | { kind: 'confirm'; title: string; message: string };

export interface PromptResponse { accepted: boolean; values: string[]; remember: boolean }

export interface PendingPrompt { id: string; request: PromptRequest }

// ---------------------------------------------------------------- methods

type Empty = Record<string, never> | undefined;

/** method name -> [params, result] */
export interface RpcMethods {
  'app.info': [Empty, AppInfo];
  /** Desktop only: open a URL or local path with the system default application. */
  'app.open': [{ target: string }, null];

  'settings.get': [Empty, Settings];
  'settings.set': [{ settings: Settings }, Settings];

  'vault.status': [Empty, VaultStatus];
  'vault.unlock': [{ password: string }, VaultStatus];
  'vault.lock': [Empty, VaultStatus];
  /** `current` required when a master password is set; `newPassword: null` removes it. */
  'vault.setMasterPassword': [{ current?: string | null; newPassword?: string | null }, VaultStatus];

  'sites.list': [Empty, SiteConfig[]];
  /** Returns a site with all defaults filled in (for the "new site" form). */
  'sites.template': [{ protocol?: Protocol }, SiteConfig];
  'sites.save': [{ site: SiteConfig }, SiteConfig];
  'sites.delete': [{ id: string }, null];
  'sites.duplicate': [{ id: string }, SiteConfig];
  /** Rename a folder (moves all sites below it). */
  'sites.renameFolder': [{ from: string; to: string }, null];
  /** `content` omitted for 'openssh' = read ~/.ssh/config. */
  'sites.import': [{ format: ImportFormat; content?: string | null }, { imported: number; sites: SiteConfig[] }];
  /** JSON export without secrets. */
  'sites.export': [{ ids?: string[] | null }, { content: string }];
  'sites.fromUrl': [{ url: string }, SiteConfig];
  'sites.toUrl': [{ site: SiteConfig; path?: string | null }, string];

  'session.list': [Empty, SessionSummary[]];
  /** Connect. Exactly one of siteId / site / url. Prompts may be raised meanwhile. */
  'session.open': [{ siteId?: string; site?: SiteConfig; url?: string; password?: string | null }, SessionSummary];
  'session.close': [{ id: string }, null];
  'session.reconnect': [{ id: string }, SessionSummary];
  'session.info': [{ id: string }, SessionInfo];

  'fs.list': [{ session: string; path: string }, { path: string; entries: FileEntry[] }];
  'fs.home': [{ session: string }, string];
  'fs.realpath': [{ session: string; path: string }, string];
  'fs.stat': [{ session: string; path: string }, FileEntry];
  'fs.mkdir': [{ session: string; path: string; parents?: boolean }, null];
  'fs.createFile': [{ session: string; path: string }, null];
  'fs.rename': [{ session: string; from: string; to: string }, null];
  /** Runs in the background, returns the job. */
  'fs.delete': [{ session: string; paths: string[] }, Job];
  'fs.setAttributes': [{
    session: string; paths: string[];
    permissions?: number | null;
    /** Separate mode for directories when recursive (e.g. files 644, dirs 755). */
    dirPermissions?: number | null;
    owner?: string | null; group?: string | null;
    modified?: number | null;
    recursive?: boolean;
  }, null];
  'fs.symlink': [{ session: string; target: string; link: string }, null];
  'fs.readText': [{ session: string; path: string; maxBytes?: number }, { content: string; encoding: 'utf-8' | 'latin1'; size: number; modified?: number | null; binary: boolean }];
  'fs.writeText': [{ session: string; path: string; content: string; encoding?: 'utf-8' | 'latin1' }, null];
  /** For previews (images, PDFs). */
  'fs.readBase64': [{ session: string; path: string; maxBytes?: number }, { data: string; mime: string; size: number }];
  'fs.checksum': [{ session: string; path: string; algo: ChecksumAlgo }, string];
  'fs.dirSize': [{ session: string; path: string }, { size: number; files: number; dirs: number }];
  'fs.diskInfo': [{ session: string; path: string }, DiskInfo | null];
  'fs.exec': [{ session: string; command: string; cwd?: string | null }, ExecOutput];

  /** Local sessions only. */
  'archive.extract': [{ session: string; path: string; dstDir: string }, Job];
  'archive.create': [{ session: string; paths: string[]; dst: string; format: 'zip' | 'tar' | 'tar.gz' }, Job];

  'transfer.defaults': [Empty, TransferOptions];
  'transfer.start': [{ srcSession: string; srcPaths: string[]; dstSession: string; dstDir: string; options?: Partial<TransferOptions> }, Job];
  'jobs.list': [Empty, Job[]];
  'jobs.pause': [{ id: string }, null];
  'jobs.resume': [{ id: string }, null];
  'jobs.cancel': [{ id: string }, null];
  'jobs.retry': [{ id: string }, Job];
  'jobs.remove': [{ id: string }, null];
  'jobs.clearFinished': [Empty, null];
  'jobs.resolveConflict': [{ id: string; conflictId: string; action: ConflictAction; applyToAll: boolean; newName?: string | null }, null];

  'sync.defaults': [Empty, SyncParams];
  /** Compares both trees (emits 'sync.progress'). */
  'sync.compare': [{ params: SyncParams }, SyncPlan];
  'sync.execute': [{ planId: string; actionIds: string[]; options?: Partial<TransferOptions> }, Job];
  'sync.discard': [{ planId: string }, null];

  'watch.list': [Empty, Watch[]];
  'watch.start': [{ localPath: string; remoteSession: string; remotePath: string; deleteRemote: boolean; fileMask: string; initialSync: boolean }, Watch];
  'watch.stop': [{ id: string }, null];

  'search.start': [{ params: SearchParams }, { id: string }];
  'search.cancel': [{ id: string }, null];

  'terminal.open': [{ session: string; cols: number; rows: number; cwd?: string | null }, TerminalInfo];
  'terminal.list': [Empty, TerminalInfo[]];
  /** `data` is text typed by the user (UTF-8). */
  'terminal.write': [{ id: string; data: string }, null];
  'terminal.resize': [{ id: string; cols: number; rows: number }, null];
  'terminal.close': [{ id: string }, null];

  'tunnel.list': [Empty, Tunnel[]];
  'tunnel.start': [{ session: string; kind: TunnelKind; bindHost: string; bindPort: number; targetHost?: string | null; targetPort?: number | null }, Tunnel];
  'tunnel.stop': [{ id: string }, null];

  'bookmarks.list': [Empty, Bookmark[]];
  'bookmarks.save': [{ bookmark: Bookmark }, Bookmark];
  'bookmarks.delete': [{ id: string }, null];

  'commands.list': [Empty, CustomCommand[]];
  'commands.save': [{ command: CustomCommand }, CustomCommand];
  'commands.delete': [{ id: string }, null];
  /** Run a saved command (`id`) or an ad-hoc `command`. */
  'commands.run': [{ id?: string | null; command?: string | null; session: string; cwd: string; names: string[] }, ExecOutput[]];

  /** Desktop only: download to a temp file, open with the system editor, upload on save. */
  'edit.external': [{ session: string; path: string }, ExternalEdit];
  'edit.list': [Empty, ExternalEdit[]];
  'edit.stop': [{ id: string }, null];

  'knownHosts.list': [Empty, KnownHost[]];
  'knownHosts.remove': [{ key: string; fingerprint?: string | null }, null];

  'prompt.pending': [Empty, PendingPrompt[]];
  /** `response: null` cancels. */
  'prompt.respond': [{ id: string; response: PromptResponse | null }, null];

  'log.recent': [Empty, LogEntry[]];

  'discovery.status': [Empty, DiscoveryStatus];
  'discovery.peers': [Empty, Peer[]];
  /** Broadcast a query so that peers answer immediately. */
  'discovery.refresh': [Empty, null];
  /** Probe `host[:port]` (or a URL) and add it as a manual peer. */
  'discovery.add': [{ address: string }, Peer];
  'discovery.remove': [{ id: string }, null];

  'server.status': [Empty, ServerStatus];
  /** Desktop only: expose this instance's UI over HTTP(S). */
  'server.start': [{ bind?: string; port?: number; tls?: boolean }, ServerStatus];
  'server.stop': [Empty, ServerStatus];
  'server.setPassword': [{ password: string }, ServerStatus];
}

export type RpcMethod = keyof RpcMethods;
export type RpcParams<M extends RpcMethod> = RpcMethods[M][0];
export type RpcResult<M extends RpcMethod> = RpcMethods[M][1];

// ---------------------------------------------------------------- events

/** event name -> payload */
export interface RpcEvents {
  'session.opened': SessionSummary;
  'session.closed': { id: string; reason?: string | null };
  'job.updated': Job;
  'job.removed': { id: string };
  'prompt.request': PendingPrompt;
  /** A prompt was answered (possibly by another client) or timed out. */
  'prompt.closed': { id: string };
  /** `data` is base64 encoded terminal output. */
  'terminal.data': { id: string; data: string };
  'terminal.exit': { id: string; code?: number | null };
  'search.result': { id: string; entries: FileEntry[] };
  'search.done': { id: string; scanned: number; found: number; cancelled: boolean; error?: string | null };
  'sync.progress': { scannedLeft: number; scannedRight: number; current: string };
  'watch.updated': Watch;
  'edit.updated': ExternalEdit;
  'tunnel.updated': Tunnel;
  'discovery.peers': Peer[];
  'server.status': ServerStatus;
  /** A directory changed because of an operation; panels showing it should refresh. */
  'fs.changed': { session: string; path: string };
  'log': LogEntry;
}

export type RpcEventName = keyof RpcEvents;

// ---------------------------------------------------------------- web-mode HTTP endpoints
//
//   GET  /api/info                      -> { name, version, authRequired, authenticated }   (no auth)
//   POST /api/login   { password }      -> sets HttpOnly cookie 'rc_session'; 401 on failure
//   POST /api/logout
//   POST /api/rpc     { method, params } -> 200 { result } | 4xx/5xx { error: RpcError }
//   GET  /api/events  (WebSocket)        -> { name, payload } messages
//   GET  /api/download?session=S&path=P[&path=P2...][&inline=1]
//        one file -> raw stream (supports Range), otherwise a .zip stream
//   PUT  /api/upload?session=S&path=/full/target/file[&offset=N]   raw request body
//
// All mutating requests must send the header 'X-RC-Request: 1' (CSRF protection).
// Non-browser clients may authenticate with 'Authorization: Bearer <token>' where the token
// is returned in the JSON body of /api/login.
