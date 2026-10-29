// Web-mode helpers: browser downloads via /api/download and uploads via PUT /api/upload.
import { apiUrl, call, mockBackend, mode } from './client';
import { normalizeError, RpcCallError } from './errors';
import * as P from '../lib/paths';
import { addClientJob, patchClientJob } from '../store/jobs';
import { refreshWhere } from '../store/panels';
import { toast } from '../store/toasts';
import { tr } from '../i18n';
import { showDock } from '../store/app';

export function downloadUrl(session: string, paths: string[], inline = false): string {
  const q = new URLSearchParams();
  q.set('session', session);
  for (const p of paths) q.append('path', p);
  if (inline) q.set('inline', '1');
  return apiUrl(`api/download?${q.toString()}`);
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Download files to this computer: one file directly, several items / directories as a .zip. */
export async function downloadToComputer(session: string, entries: { name: string; path: string; kind: string; size: number }[]) {
  if (!entries.length) return;
  const paths = entries.map((e) => e.path);
  const single = entries.length === 1 && entries[0].kind !== 'dir';
  const title = single ? tr('web.downloadOne', { name: entries[0].name }) : tr('web.downloadZip', { n: entries.length });
  const total = entries.reduce((s, e) => s + (e.kind === 'dir' ? 0 : e.size), 0);
  const id = addClientJob({ kind: 'download', title, state: 'running', session, bytesTotal: total, bytesDone: 0, filesTotal: entries.length, filesDone: 0 });
  try {
    if (mode === 'mock' && mockBackend) {
      const { blob, name } = await mockBackend.download(session, paths);
      saveBlob(blob, name);
    } else {
      const a = document.createElement('a');
      a.href = downloadUrl(session, paths);
      a.download = single ? entries[0].name : '';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    patchClientJob(id, { state: 'completed', bytesDone: total, filesDone: entries.length, finishedAt: Math.floor(Date.now() / 1000), currentFile: tr('web.handedToBrowser') });
  } catch (e) {
    patchClientJob(id, { state: 'failed', errors: [{ path: paths[0], message: normalizeError(e).message }], finishedAt: Math.floor(Date.now() / 1000) });
    toast.error(e);
  }
}

export interface UploadItem {
  file: File;
  /** Path relative to the target directory, '/'-separated (e.g. 'photos/2024/a.jpg'). */
  relPath: string;
}

export interface UploadSet {
  items: UploadItem[];
  /** Relative directories to create (including empty ones). */
  dirs: string[];
}

/** Synchronously grab the entries of a drop event (must run inside the event handler). */
export function entriesFromDataTransfer(dt: DataTransfer): FileSystemEntry[] | null {
  if (!dt.items || !dt.items.length || typeof dt.items[0].webkitGetAsEntry !== 'function') return null;
  const out: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== 'file') continue;
    const e = item.webkitGetAsEntry();
    if (e) out.push(e);
  }
  return out;
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const next = () =>
      reader.readEntries((batch) => {
        if (!batch.length) resolve(all);
        else {
          all.push(...batch);
          next();
        }
      }, reject);
    next();
  });
}

function entryFile(e: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => e.file(resolve, reject));
}

/** Walks dropped files and folders. */
export async function collectEntries(entries: FileSystemEntry[]): Promise<UploadSet> {
  const items: UploadItem[] = [];
  const dirs: string[] = [];
  const walk = async (e: FileSystemEntry, prefix: string) => {
    if (e.isFile) {
      items.push({ file: await entryFile(e as FileSystemFileEntry), relPath: prefix + e.name });
    } else if (e.isDirectory) {
      const rel = prefix + e.name;
      dirs.push(rel);
      const children = await readAllEntries((e as FileSystemDirectoryEntry).createReader());
      for (const c of children) await walk(c, rel + '/');
    }
  };
  for (const e of entries) await walk(e, '');
  return { items, dirs };
}

/** Files from an <input type=file> (with or without webkitdirectory). */
export function collectFileList(files: FileList | File[]): UploadSet {
  const items: UploadItem[] = [];
  const dirs = new Set<string>();
  for (const f of Array.from(files)) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    items.push({ file: f, relPath: rel });
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return { items, dirs: [...dirs] };
}

function putFile(url: string, file: File, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-RC-Request', '1');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        let err: unknown = `HTTP ${xhr.status}`;
        try {
          err = JSON.parse(xhr.responseText)?.error ?? err;
        } catch {
          /* ignore */
        }
        reject(normalizeError(err));
      }
    };
    xhr.onerror = () => reject(new RpcCallError('connection_lost', 'Upload failed (network error)'));
    xhr.onabort = () => reject(new RpcCallError('cancelled', 'Upload cancelled'));
    signal.addEventListener('abort', () => xhr.abort());
    xhr.send(file);
  });
}

/** Uploads browser files into `dstDir` of `session`, shown as a client-side queue entry. */
export async function uploadToSession(session: string, dstDir: string, set: UploadSet) {
  if (!set.items.length && !set.dirs.length) return;
  const total = set.items.reduce((s, i) => s + i.file.size, 0);
  const ctrl = new AbortController();
  const title =
    set.items.length === 1 && !set.dirs.length ? tr('web.uploadOne', { name: set.items[0].file.name }) : tr('web.uploadMany', { n: set.items.length });
  const id = addClientJob({
    kind: 'upload', title, state: 'running', session, dstDir, bytesTotal: total, bytesDone: 0, filesTotal: set.items.length, filesDone: 0,
    cancel: () => ctrl.abort(),
  });
  showDock('queue');
  const errors: { path: string; message: string }[] = [];
  let doneBytes = 0;
  let filesDone = 0;
  const started = performance.now();
  try {
    const dirs = [...new Set(set.dirs)].sort((a, b) => a.split('/').length - b.split('/').length);
    for (const d of dirs) {
      if (ctrl.signal.aborted) throw new RpcCallError('cancelled', 'cancelled');
      try {
        await call('fs.mkdir', { session, path: P.join(dstDir, d), parents: true });
      } catch (e) {
        const err = normalizeError(e);
        if (err.code !== 'already_exists') throw err;
      }
    }
    for (const item of set.items) {
      if (ctrl.signal.aborted) throw new RpcCallError('cancelled', 'cancelled');
      const target = P.join(dstDir, item.relPath);
      patchClientJob(id, { currentFile: item.relPath });
      const onProgress = (loaded: number) => {
        const done = doneBytes + loaded;
        const secs = (performance.now() - started) / 1000;
        const speed = secs > 0.2 ? done / secs : 0;
        patchClientJob(id, { bytesDone: done, speed, eta: speed > 0 ? (total - done) / speed : null });
      };
      try {
        if (mode === 'mock' && mockBackend) await mockBackend.upload(session, target, item.file, onProgress, ctrl.signal);
        else {
          const url = apiUrl(`api/upload?${new URLSearchParams({ session, path: target }).toString()}`);
          await putFile(url, item.file, onProgress, ctrl.signal);
        }
      } catch (e) {
        const err = normalizeError(e);
        if (err.code === 'cancelled' || ctrl.signal.aborted) throw err;
        errors.push({ path: target, message: err.message });
      }
      doneBytes += item.file.size;
      filesDone++;
      patchClientJob(id, { bytesDone: doneBytes, filesDone, errors: [...errors] });
    }
    patchClientJob(id, { state: errors.length ? 'failed' : 'completed', speed: 0, eta: null, currentFile: null, finishedAt: Math.floor(Date.now() / 1000) });
    if (errors.length) toast.warning(tr('web.uploadErrors', { n: errors.length }), errors[0].message);
    else toast.success(tr('web.uploadDone', { n: set.items.length }));
  } catch (e) {
    const err = normalizeError(e);
    patchClientJob(id, {
      state: err.code === 'cancelled' ? 'cancelled' : 'failed', speed: 0, eta: null, currentFile: null,
      errors: err.code === 'cancelled' ? errors : [...errors, { path: dstDir, message: err.message }], finishedAt: Math.floor(Date.now() / 1000),
    });
    if (err.code !== 'cancelled') toast.error(err);
  } finally {
    refreshWhere(session, dstDir);
  }
}

/** Opens the browser's file (or folder) chooser and resolves with the chosen files. */
export function pickBrowserFiles(opts: { directory?: boolean; multiple?: boolean; accept?: string } = {}): Promise<FileList | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = opts.multiple ?? true;
    if (opts.accept) input.accept = opts.accept;
    if (opts.directory) {
      input.setAttribute('webkitdirectory', '');
      input.setAttribute('directory', '');
    }
    input.style.display = 'none';
    input.addEventListener('change', () => {
      resolve(input.files && input.files.length ? input.files : null);
      input.remove();
    });
    input.addEventListener('cancel', () => {
      resolve(null);
      input.remove();
    });
    document.body.appendChild(input);
    input.click();
  });
}

export async function readFileAsText(f: File): Promise<string> {
  return f.text();
}
