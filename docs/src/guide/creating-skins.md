# Creating skins

A skin is a small JSON file. You can build one without writing any JSON in the
[skin editor](skins.md#the-skin-editor), or write the file yourself in any text editor —
this page explains the format, walks through a complete skin step by step and collects
recipes for common looks. The full list of colors is in the
[token reference](../reference/skin-tokens.md).

## Your first skin in two minutes

1. Open *Preferences* (Ctrl+,) → **Appearance** and note the **skins folder** (on Linux
   `~/.config/rust-commander/skins/`; the desktop app has an **Open folder** button).
2. Create the file `sunset.json` in that folder:

   ```json
   {
     "id": "sunset",
     "name": "Sunset",
     "light": { "accent": "#e8590c" },
     "dark": { "accent": "#ff922b" }
   }
   ```

3. Switch back to Rust Commander: *Sunset* appears under **Your skins** and in
   *View* → **Skin**. Select it.

One color was enough for a consistent result: buttons, links, the frame of the active
panel, the file cursor, marked files, focus rings, progress bars, symbolic links and the
editor cursor all follow the new accent, in hover and selection shades computed from it.
Everything else comes from the standard skin.

## How a skin works

### The file

| Key | Required | Meaning |
|---|---|---|
| `id` | yes | Unique id: `a-z`, `0-9`, `-` and `_`, at most 64 characters. Use it as the file name too (`sunset.json`). The ids of the built-in skins are reserved. |
| `name` | yes | Name in the gallery and the *Skin* menu. |
| `description`, `author`, `version`, `license` | no | Shown in the gallery (as a tooltip) and kept when the skin is shared. |
| `extends` | no | Id of the skin this one builds on. Default: `default` (the standard *Rust Commander* skin). |
| `style` | no | Fonts, corner radii, row height, list font size, striped rows — for both variants. |
| `light`, `dark` | no | The colors of the light and the dark variant: `"token": "value"` pairs. |
| `$schema` | no | Lets editors such as VS Code complete and check the file (see [Tools](#tools)). |

Unknown keys and invalid values are ignored — the rest of the skin still works. They are
reported when you import the skin, and a warning icon on the skin's card in
Preferences → Appearance lists them.

### Variants: light and dark

Rust Commander shows the **light** or the **dark** variant of a skin, depending on the
*Theme* setting (*System*, *Light*, *Dark*). A skin may have both, or only one:

- `light` and `dark` → follows the *Theme* setting.
- only `dark` (or only `light`) → always that variant, whatever the *Theme* says. *Retro
  Blue* and *Dracula* work this way.
- neither (a skin that only changes `style`) → has the variants of the skin it extends.

An empty object, `"light": {}`, is enough to declare a variant that inherits all its colors.

### Inheritance: `extends`

A skin starts from the skin it extends and changes only what it sets. That chain always ends
at `default`, which defines every token, so a skin never has holes:

```json
{
  "id": "nord-rose",
  "name": "Nord Rosé",
  "extends": "nord",
  "dark": { "accent": "#d8a0b8" }
}
```

*Nord Rosé* is *Nord* in every detail — palette, fonts, radius, terminal, light/dark
behavior (*Nord* has both; this skin declares only `dark`, so it is always dark) — except
for the accent. You can extend user skins as well as built-in ones.

### Derived colors

Many tokens are computed from others when a skin does not set them itself. The main ones:

| You set | Rust Commander derives |
|---|---|
| `accent` | `accent-hover`, `accent-fg` (black or white, whichever is readable), `accent-weak`, `accent-weak-2`, `accent-border`, `sel-bg`, `sel-fg`, `cursor-bg`, `hover`, `fi-link`, `term-selection`, `editor-selection`, `editor-cursor`, `editor-active-line`, `syn-link`, `syn-heading` |
| `text` | `text-2`, `muted`, `faint` (mixed towards `surface`), `term-fg`, `editor-fg`, `syn-variable` |
| `surface`, `bg` | `surface-2`, `surface-3`, `input-bg`, `border`, `border-soft`, `border-strong`, `scroll`, `row-alt`, `term-bg`, `editor-bg`, `editor-gutter-bg` |
| the **palette** (`red`, `orange`, `yellow`, `green`, `teal`, `cyan`, `blue`, `purple`, `pink`) | the status colors (`ok`, `warn`, `err` and their backgrounds), the file icon colors, the colored terminal colors (red … cyan, normal and bright) and the syntax highlighting |

Derivation only touches tokens that depend on what you changed: a skin that sets only
`accent` keeps the default surfaces, borders and text colors.
Whatever you set explicitly always wins — set `sel-fg` and the derived value is not used.
The [token reference](../reference/skin-tokens.md) shows for every token what it is derived
from.

In practice this means a good skin needs surprisingly few values: the nine palette hues,
`bg`, `chrome`, `surface`, `text` and `accent` per variant give a complete, consistent look.
Everything after that is fine-tuning.

### Color values

Any of these notations works:

| Notation | Example |
|---|---|
| Hex | `#0af`, `#00aaff`, `#00aaff80` (with alpha) |
| RGB | `rgb(0, 170, 255)`, `rgba(0, 170, 255, 0.5)`, `rgb(0 170 255 / 50%)` |
| HSL | `hsl(200, 100%, 50%)`, `hsla(200, 100%, 50%, 0.5)` |
| Keywords | `black`, `white`, `transparent` |

Translucent colors are welcome for tints that sit on top of other colors (`sel-bg`,
`accent-weak`, `backdrop`, `editor-selection` in dark skins). Other color names (`red`,
`navy` …), `var()` and `url()` are not accepted.

The tokens `shadow` and `shadow-lg` take a CSS `box-shadow` — lengths and colors, several
separated by commas — or `none` for a flat look:

```json
"shadow": "none",
"shadow-lg": "0 0 0 1px #55ffff, 8px 8px 0 rgba(0, 0, 0, 0.65)"
```

### Style

```json
"style": {
  "fontUi": "'Inter', system-ui, sans-serif",
  "fontMono": "'JetBrains Mono', monospace",
  "radius": 4,
  "panelRadius": 6,
  "density": "compact",
  "listFontSize": 13,
  "stripes": true
}
```

| Key | Meaning | Range | Default |
|---|---|---|---|
| `fontUi` | Font of the user interface (CSS font-family list) | | system font |
| `fontMono` | Font of paths, permissions and the editor | | system monospace |
| `radius` | Corner radius of buttons, inputs, menu items | 0–16 px | 6 |
| `panelRadius` | Corner radius of panels, menus, dialogs | 0–24 px | 9 |
| `density` | Row height of the file lists | `compact`, `normal`, `comfortable` | `normal` |
| `listFontSize` | Font size of the file lists | 10–20 px | 13 |
| `stripes` | Alternating row backgrounds (color: `row-alt`) | `true` / `false` | `false` |

Fonts are not downloaded: list fonts that are installed, with a generic family
(`sans-serif`, `monospace`) last. The user's own [adjustments](skins.md#adjustments)
(accent, row height, fonts …) override what the skin says here.

## Tutorial: the *Ocean* skin

Let's build a complete skin with a light and a dark variant: deep blue water, sandy
highlights. Create `ocean.json` in the skins folder and keep Rust Commander open next to
your editor — every time you save and switch back to the window, the skin reloads.

### 1. Name and palette

Start with the metadata and the palette. The nine hues drive file icons, status colors,
the terminal and the syntax highlighting, so choose them first. Light variants need darker,
more saturated hues (they sit on light backgrounds), dark variants lighter ones:

```json
{
  "$schema": "https://raw.githubusercontent.com/bobnautic/rustcommander/main/ui/src/skins/skin.schema.json",
  "id": "ocean",
  "name": "Ocean",
  "description": "Deep blue water, sandy highlights.",
  "author": "Your Name",
  "version": "1.0.0",
  "light": {
    "red": "#c92a2a", "orange": "#d9480f", "yellow": "#b07d05", "green": "#2b8a3e", "teal": "#0c8599",
    "cyan": "#1098ad", "blue": "#1971c2", "purple": "#7048e8", "pink": "#c2255c"
  },
  "dark": {
    "red": "#ff8787", "orange": "#ffa94d", "yellow": "#ffd43b", "green": "#69db7c", "teal": "#38d9a9",
    "cyan": "#3bc9db", "blue": "#74c0fc", "purple": "#b197fc", "pink": "#f783ac"
  }
}
```

Select *Ocean* now: the folder icons are yellow-gold, scripts green, archives orange, and
the terminal (`ls`) uses the new colors — the surfaces are still the default ones.

### 2. Surfaces and text

Three surfaces define the depth of the window: `bg` (behind everything), `chrome` (menu
bar, tabs, status bar) and `surface` (panels and dialogs). In light skins the panels are the
brightest layer; in dark skins they are slightly *lighter* than the background. Add `text`:

```json
"light": {
  …palette…,
  "bg": "#e3eef5", "chrome": "#edf4f8", "surface": "#fbfdfe",
  "text": "#0b2233"
},
"dark": {
  …palette…,
  "bg": "#06141f", "chrome": "#0a1b28", "surface": "#0e2333",
  "text": "#e3f2fb"
}
```

Headers, hover backgrounds, input fields, all borders, secondary text, hints and the
editor and terminal backgrounds are derived from these — tinted blue now, like the rest.

### 3. The accent

```json
"light": { …, "accent": "#0b7285" },
"dark":  { …, "accent": "#3bc9db" }
```

The accent colors the active panel, the cursor bar, marked files and buttons. For a sandy
touch in the dark variant, give marked files their own color and make the terminal a little
deeper than the panels:

```json
"dark": { …, "sel-fg": "#ffd43b", "term-bg": "#041019" }
```

### 4. Shape

Rounder corners and striped lists fit the soft look:

```json
"style": { "radius": 8, "panelRadius": 12, "stripes": true }
```

### 5. Check it

- Switch *Theme* between *Light* and *Dark* (toolbar button) and look at both variants.
- Mark a few files (Insert), move the cursor, open a dialog (F5) and a menu.
- Open a terminal (Ctrl+J → *Terminal*) and run `ls`; open a source file in the editor (F4).
- Open the skin in the skin editor (*Your skins* → pencil icon): the **contrast check** under
  the preview lists everything that is hard to read.

The complete file:

```json
{
  "$schema": "https://raw.githubusercontent.com/bobnautic/rustcommander/main/ui/src/skins/skin.schema.json",
  "id": "ocean",
  "name": "Ocean",
  "description": "Deep blue water, sandy highlights.",
  "author": "Your Name",
  "version": "1.0.0",
  "style": { "radius": 8, "panelRadius": 12, "stripes": true },
  "light": {
    "red": "#c92a2a", "orange": "#d9480f", "yellow": "#b07d05", "green": "#2b8a3e", "teal": "#0c8599",
    "cyan": "#1098ad", "blue": "#1971c2", "purple": "#7048e8", "pink": "#c2255c",
    "bg": "#e3eef5", "chrome": "#edf4f8", "surface": "#fbfdfe",
    "text": "#0b2233",
    "accent": "#0b7285"
  },
  "dark": {
    "red": "#ff8787", "orange": "#ffa94d", "yellow": "#ffd43b", "green": "#69db7c", "teal": "#38d9a9",
    "cyan": "#3bc9db", "blue": "#74c0fc", "purple": "#b197fc", "pink": "#f783ac",
    "bg": "#06141f", "chrome": "#0a1b28", "surface": "#0e2333",
    "text": "#e3f2fb",
    "accent": "#3bc9db",
    "sel-fg": "#ffd43b",
    "term-bg": "#041019"
  }
}
```

About thirty values for a skin that colors all 117 tokens in two variants.

## Recipes

**Just another accent for a built-in skin**

```json
{ "id": "gruvbox-aqua", "name": "Gruvbox Aqua", "extends": "gruvbox",
  "light": { "accent": "#427b58" }, "dark": { "accent": "#8ec07c" } }
```

**Flat and square**

```json
"style": { "radius": 0, "panelRadius": 0 },
"light": { "shadow": "none", "shadow-lg": "0 0 0 1px #000000" }
```

**A classic cursor bar** — a solid bar with its own text color, like the DOS-era file
managers (*Retro Blue*):

```json
"dark": { "cursor-bg": "#00a8a8", "cursor-fg": "#000000" }
```

**Colored folder names** — folders in their own color (optional token, unset by default):

```json
"dark": { "dir-fg": "#ffffff" }
```

**A colored menu bar and function keys**

```json
"dark": {
  "menubar-bg": "#00a8a8", "menubar-fg": "#000000",
  "key-bg": "#00a8a8", "key-fg": "#000000", "key-num": "#ffffff"
}
```

**Your terminal color scheme** — the 16 ANSI colors plus background, text, cursor and
selection (`term-black` … `term-bright-white`, see the
[reference](../reference/skin-tokens.md#terminal)):

```json
"dark": { "term-bg": "#000000", "term-fg": "#aaaaaa", "term-red": "#aa0000", "term-bright-red": "#ff5555" }
```

**Syntax colors** — `syn-keyword`, `syn-string`, `syn-comment`, `syn-function`, `syn-type` …
(see the [reference](../reference/skin-tokens.md#syntax-highlighting)). Without them the
editor uses the palette: keywords purple, strings green, numbers orange, functions blue.

**Big lists for a presentation or a TV**

```json
"style": { "listFontSize": 17, "density": "comfortable" }
```

## Tools

- **Completion and checking in your editor.** With the `$schema` line at the top of the file,
  VS Code, JetBrains IDEs and other editors that support JSON Schema complete token names,
  show their descriptions and flag invalid values. Exported skins contain the line already.
- **Live reload.** Rust Commander re-reads the skins folder whenever its window gets the
  focus again (and with **Reload skins** in Preferences → Appearance). Save in your editor,
  switch back, look.
- **The skin editor** writes the same files: open a skin you wrote by hand, adjust colors with
  the color picker and save — or copy the result from its **JSON** tab.
- **Contrast.** Aim for at least 4.5 : 1 for text on its background (WCAG AA), 3 : 1 for
  hints, icons and button labels. The skin editor checks the important combinations. With a
  checkout of the source code (and `npm --prefix ui ci`) you can check files from the
  command line:

  ```bash
  node ui/scripts/skins.mjs check ~/.config/rust-commander/skins/ocean.json
  ```

## Sharing skins

A skin is a single file: share the file from the skins folder, or **Export** it from its card
in Preferences → Appearance. Others add it with **Import…** or by putting it into their
skins folder. If the id already exists, Rust Commander asks before replacing; a file that
uses the id of a built-in skin is imported as `<id>-custom`.

### Contributing a built-in skin

Built-in skins live in [`ui/src/skins/`](https://github.com/bobnautic/rustcommander/tree/main/ui/src/skins)
in exactly this format. To propose one:

1. Add `<id>.json` there (with `"$schema": "./skin.schema.json"`, an `author` and a
   `license`; palettes of other projects need a compatible license and a credit in
   `author`). Give it both variants if the design allows it.
2. Add the id to `ORDER` in `ui/src/skins/index.ts`.
3. Run, in `ui/`:

   ```bash
   node scripts/skins.mjs format
   node scripts/skins.mjs check
   npm test
   ```

   `check` must report *contrast ok* for every variant; the unit tests verify the same.
4. Regenerate the screenshots with `ONLY=skins,skins-overview npm run screenshots:docs` and
   add the skin to the table in [Skins and appearance](skins.md).

If you add a token to `ui/src/lib/skins/tokens.ts`, also give it a value in `default.json`
and run `node scripts/skins.mjs schema` and `node scripts/skins.mjs docs`.

## What skins can and cannot do

Skins change colors, shadows, fonts, corner radii, row height and striped rows — in the
whole app, including the terminal and the editor. They cannot change the layout, replace
icons, add CSS or load anything from the network: every value is checked to be a color, a
shadow made of lengths and colors, a number in range or a font list, before it is applied.
A skin from the internet therefore cannot hide or fake parts of the interface, track you or
run code — at worst it looks bad, and *View* → *Skin* → **Rust Commander** brings the
standard look back.

## Reference

- [Skin tokens](../reference/skin-tokens.md) — every token with its purpose, what it is
  derived from and its default values.
- [`skin.schema.json`](https://github.com/bobnautic/rustcommander/blob/main/ui/src/skins/skin.schema.json)
  — the JSON Schema of skin files.
- The [built-in skins](https://github.com/bobnautic/rustcommander/tree/main/ui/src/skins)
  as examples — *Retro Blue* uses nearly every optional token, *Ember* shows how far the
  palette and a handful of colors go.
