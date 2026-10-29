import type { LucideIcon } from 'lucide-react';
import {
  Database, Disc3, File, FileArchive, FileAudio, FileCode, FileImage, FileJson, FileKey, FileSpreadsheet, FileTerminal,
  FileText, FileVideo, Folder, FolderSymlink, Presentation, Type, Cpu, FileSymlink, BookOpen,
} from 'lucide-react';
import type { FileEntry } from '../api/types';
import { extname } from './paths';

export type FileCategory =
  | 'dir' | 'link' | 'linkDir' | 'image' | 'video' | 'audio' | 'archive' | 'code' | 'script' | 'config' | 'text'
  | 'document' | 'spreadsheet' | 'presentation' | 'key' | 'executable' | 'font' | 'database' | 'disk' | 'file';

const EXT: Record<string, FileCategory> = {};
function reg(cat: FileCategory, exts: string) {
  for (const e of exts.split(' ')) EXT[e] = cat;
}
reg('image', 'png jpg jpeg gif webp svg bmp ico tif tiff avif heic heif psd xcf raw cr2 nef');
reg('video', 'mp4 mkv avi mov webm m4v wmv flv mpg mpeg 3gp ts');
reg('audio', 'mp3 wav flac ogg oga m4a aac opus wma mid midi');
reg('archive', 'zip tar gz tgz bz2 tbz2 xz txz 7z rar zst lz lzma deb rpm jar war apk cab');
reg('code', 'rs tsx jsx js mjs cjs py rb go java kt kts c h cpp hpp cc cxx cs php swift scala lua pl pm sql html htm css scss sass less vue svelte dart r zig nim ex exs erl hs ml clj elm groovy gradle tf proto graphql wasm asm s');
reg('script', 'sh bash zsh fish ps1 psm1 bat cmd command');
reg('config', 'json jsonc json5 yaml yml toml ini conf cfg xml env properties lock plist service desktop editorconfig');
reg('text', 'txt md markdown log rst nfo adoc tex diff patch');
reg('document', 'pdf doc docx odt rtf epub pages');
reg('spreadsheet', 'xls xlsx ods csv tsv numbers');
reg('presentation', 'ppt pptx odp key');
reg('key', 'pem crt cer pub p12 pfx gpg asc der csr ppk');
reg('executable', 'exe msi dll so dylib bin app appimage elf o a');
reg('font', 'ttf otf woff woff2 eot');
reg('database', 'db sqlite sqlite3 mdb accdb dbf');
reg('disk', 'iso img dmg vmdk qcow2 vdi vhd vhdx');

const NAMES: Record<string, FileCategory> = {
  dockerfile: 'code', makefile: 'code', cmakelists: 'code', jenkinsfile: 'code', vagrantfile: 'code', gemfile: 'code',
  readme: 'text', license: 'text', changelog: 'text', authors: 'text', todo: 'text',
  '.bashrc': 'config', '.profile': 'config', '.zshrc': 'config', '.gitignore': 'config', '.gitconfig': 'config',
  '.bash_profile': 'config', '.env': 'config', '.npmrc': 'config', '.vimrc': 'config', '.dockerignore': 'config',
  authorized_keys: 'key', known_hosts: 'key', id_rsa: 'key', id_ed25519: 'key', id_ecdsa: 'key',
};

export function categoryOf(e: Pick<FileEntry, 'name' | 'kind' | 'targetKind'>): FileCategory {
  if (e.kind === 'dir') return 'dir';
  if (e.kind === 'symlink') return e.targetKind === 'dir' ? 'linkDir' : 'link';
  const lower = e.name.toLowerCase();
  const byName = NAMES[lower] ?? NAMES[lower.replace(/\.[^.]*$/, '')];
  if (byName) return byName;
  return EXT[extname(e.name)] ?? 'file';
}

export function categoryOfName(name: string): FileCategory {
  return categoryOf({ name, kind: 'file' });
}

export const CATEGORY_ICON: Record<FileCategory, LucideIcon> = {
  dir: Folder,
  link: FileSymlink,
  linkDir: FolderSymlink,
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  archive: FileArchive,
  code: FileCode,
  script: FileTerminal,
  config: FileJson,
  text: FileText,
  document: BookOpen,
  spreadsheet: FileSpreadsheet,
  presentation: Presentation,
  key: FileKey,
  executable: Cpu,
  font: Type,
  database: Database,
  disk: Disc3,
  file: File,
};

const IMAGE_PREVIEW = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
export function isPreviewableImage(name: string): boolean {
  return IMAGE_PREVIEW.has(extname(name));
}

export function isPdf(name: string): boolean {
  return extname(name) === 'pdf';
}

export function isArchive(name: string): boolean {
  const l = name.toLowerCase();
  return /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|7z|rar)$/.test(l);
}

/** Entries that can be entered like a directory. */
export function isDirLike(e: Pick<FileEntry, 'kind' | 'targetKind'>): boolean {
  return e.kind === 'dir' || (e.kind === 'symlink' && e.targetKind === 'dir');
}
