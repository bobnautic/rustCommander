// Skin files: export (download / copy) and import (file picker or pasted JSON).
import { compactSkin, type Skin } from './engine';

/** Lets editors (VS Code, IntelliJ, …) complete and check skin files. */
export const SCHEMA_URL = 'https://raw.githubusercontent.com/bobnautic/rustcommander/main/ui/src/skins/skin.schema.json';
export const GUIDE_URL = 'https://github.com/bobnautic/rustcommander/blob/main/docs/src/guide/creating-skins.md';

/** The skin as a file: `$schema` first, then only what the skin sets. */
export function skinToJson(skin: Skin): string {
  return JSON.stringify({ $schema: SCHEMA_URL, ...compactSkin(skin) }, null, 2) + '\n';
}

export function downloadSkin(skin: Skin) {
  const url = URL.createObjectURL(new Blob([skinToJson(skin)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${skin.id}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Opens the file picker; resolves with the file's text (null when cancelled). */
export function pickTextFile(accept = '.json,application/json'): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      input.remove();
      resolve(v);
    };
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      finish(f ? await f.text() : null);
    });
    input.addEventListener('cancel', () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}
