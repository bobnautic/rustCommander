// The skins that ship with Rust Commander. Each one is a plain skin file — the same format
// users write (docs/src/guide/creating-skins.md) — so they double as examples.
import { validateSkin, type Skin } from '../lib/skins/engine';

const files = import.meta.glob<{ default: unknown }>(['./*.json', '!./skin.schema.json'], { eager: true });

/** Gallery order; skins not listed here follow alphabetically. */
const ORDER = ['default', 'ember', 'graphite', 'retro-blue', 'high-contrast', 'nord', 'solarized', 'catppuccin', 'gruvbox', 'dracula'];

export const BUILTIN_SKINS: Skin[] = Object.entries(files)
  .map(([path, mod]) => {
    const v = validateSkin(mod.default);
    if (!v.skin) throw new Error(`built-in skin ${path}: ${v.errors.join('; ')}`);
    return v.skin;
  })
  .sort((a, b) => {
    const ia = ORDER.indexOf(a.id);
    const ib = ORDER.indexOf(b.id);
    if (ia !== ib) return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    return a.name.localeCompare(b.name);
  });

export const BUILTIN_IDS = new Set(BUILTIN_SKINS.map((s) => s.id));
