// Preferences → Appearance: light/dark, the skin gallery, the user's adjustments, and the
// skins folder. Changes are previewed live; the Preferences dialog saves them.
import { useEffect, useMemo, type KeyboardEvent } from 'react';
import { BookOpen, Check, Copy, Download, FileUp, FolderOpen, Moon, Pencil, Plus, RefreshCw, RotateCcw, Sun, Trash2, TriangleAlert } from 'lucide-react';
import type { AppearanceSettings, Settings } from '../../api/types';
import { call } from '../../api/client';
import { tr, useT } from '../../i18n';
import { DENSITIES, DEFAULT_SKIN_ID, normalizeSkinId, validateSkin, type Density, type Skin } from '../../lib/skins/engine';
import { downloadSkin, GUIDE_URL, pickTextFile } from '../../lib/skins/files';
import { normalizeColor, toHex6 } from '../../lib/skins/color';
import { BUILTIN_IDS, BUILTIN_SKINS } from '../../skins';
import { useApp } from '../../store/app';
import { confirmDialog, openDialog } from '../../store/dialogs';
import { deleteUserSkin, lookupSkin, reloadSkins, resolveLook, saveUserSkin, skinVariants, useSkins, type SkinEntry } from '../../store/skins';
import { toast } from '../../store/toasts';
import { Badge, Button, Field, IconButton, Segmented, Select, TextInput, cx } from '../ui';
import { SkinPreview } from '../SkinPreview';

const ACCENTS = ['#2563d9', '#0e8a8a', '#2f8f46', '#c27c0e', '#e2672f', '#d03e47', '#c2417f', '#7c4dd6'];

export function openGuide() {
  if (useApp.getState().info?.mode === 'desktop') void call('app.open', { target: GUIDE_URL }).catch((e) => toast.error(e));
  else window.open(GUIDE_URL, '_blank', 'noopener,noreferrer');
}

/** Imports a skin file chosen by the user; returns its id. */
export async function importSkin(): Promise<string | null> {
  const text = await pickTextFile();
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    toast.error(tr('skins.invalid'), String(e));
    return null;
  }
  const v = validateSkin(raw);
  if (!v.skin) {
    toast.error(tr('skins.invalid'), v.errors.join('\n'));
    return null;
  }
  const skin = v.skin;
  if (BUILTIN_IDS.has(skin.id)) skin.id = normalizeSkinId(`${skin.id}-custom`);
  if (useSkins.getState().user.some((e) => e.skin.id === skin.id)) {
    const ok = await confirmDialog({ title: tr('skins.replaceTitle'), message: tr('skins.replaceText', { id: skin.id }), okLabel: tr('common.replace') });
    if (!ok) return null;
  }
  try {
    await saveUserSkin(skin);
  } catch (e) {
    toast.error(e);
    return null;
  }
  if (v.warnings.length) toast.warning(tr('skins.imported', { name: skin.name }), tr('skins.importIgnored', { n: v.warnings.length, first: v.warnings[0] }));
  else toast.success(tr('skins.imported', { name: skin.name }));
  return skin.id;
}

/** A copy of `base` to customize: it extends the base and starts without changes. */
export function newSkinFrom(baseId: string): Skin {
  const base = lookupSkin(baseId) ?? lookupSkin(DEFAULT_SKIN_ID)!;
  const taken = (id: string) => BUILTIN_IDS.has(id) || useSkins.getState().user.some((e) => e.skin.id === id);
  let id = normalizeSkinId(`${base.id}-custom`);
  for (let i = 2; taken(id); i++) id = normalizeSkinId(`${base.id}-custom-${i}`);
  const variants = skinVariants(base);
  return {
    id,
    name: tr('skins.copyName', { name: base.name }),
    extends: base.id,
    ...(variants.includes('light') ? { light: {} } : {}),
    ...(variants.includes('dark') ? { dark: {} } : {}),
  };
}

function SkinCard({ entry, selected, theme, onSelect, onUse }: { entry: SkinEntry; selected: boolean; theme: Settings['theme']; onSelect: () => void; onUse: (id: string) => void }) {
  const t = useT();
  const { skin, builtin } = entry;
  const user = useSkins((s) => s.user);
  const resolved = useMemo(() => resolveLook({ theme, appearance: { skin: skin.id } }), [skin, theme, user]); // eslint-disable-line react-hooks/exhaustive-deps
  const variants = skinVariants(skin);
  const onKey = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect();
    }
  };
  const edit = () => openDialog('skinEditor', builtin ? { skin: newSkinFrom(skin.id), onSaved: (id, use) => use && onUse(id) } : { skin, onSaved: (id, use) => use && onUse(id) });
  const remove = async () => {
    if (!(await confirmDialog({ title: t('skins.deleteTitle'), message: t('skins.deleteText', { name: skin.name }), okLabel: t('skins.delete'), danger: true }))) return;
    try {
      await deleteUserSkin(skin.id);
      if (selected) onUse(DEFAULT_SKIN_ID);
      toast.success(t('skins.deleted'), skin.name);
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div
      className={cx('skin-card', selected && 'on')}
      role="radio"
      aria-checked={selected}
      aria-label={skin.name}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={onKey}
      data-testid={`skin-${skin.id}`}
      title={skin.description}
    >
      <div className="skin-thumb">
        <SkinPreview resolved={resolved} size="card" />
      </div>
      {selected && (
        <span className="skin-card-check" title={t('skins.active')}>
          <Check size={13} strokeWidth={3} />
        </span>
      )}
      <div className="skin-card-actions" onClick={(e) => e.stopPropagation()}>
        <IconButton icon={builtin ? Copy : Pencil} size={13} title={builtin ? t('skins.customize') : t('skins.edit')} onClick={edit} data-testid={`skin-edit-${skin.id}`} />
        <IconButton icon={Download} size={13} title={t('skins.export')} onClick={() => downloadSkin(skin)} />
        {!builtin && <IconButton icon={Trash2} size={13} tone="danger" title={t('skins.delete')} onClick={() => void remove()} />}
      </div>
      <div className="skin-card-body">
        <div className="skin-card-text">
          <div className="skin-card-title">{skin.name}</div>
          <div className="skin-card-sub">{skin.author && !builtin ? t('skins.by', { author: skin.author }) : (skin.description ?? '')}</div>
        </div>
        {variants.length === 1 && (
          <span className="skin-card-variant" title={variants[0] === 'dark' ? t('skins.darkOnly') : t('skins.lightOnly')}>
            {variants[0] === 'dark' ? <Moon size={12} /> : <Sun size={12} />}
          </span>
        )}
        {entry.warnings.length > 0 && (
          <span className="skin-card-variant warn" title={entry.warnings.join('\n')}>
            <TriangleAlert size={12} />
          </span>
        )}
      </div>
    </div>
  );
}

function AccentPicker({ value, onChange }: { value: string | null | undefined; onChange: (v: string | null) => void }) {
  const t = useT();
  const cur = value ? normalizeColor(value) : null;
  return (
    <div className="swatches" role="radiogroup" aria-label={t('skins.accent')}>
      <button type="button" className={cx('swatch none', !cur && 'on')} onClick={() => onChange(null)} title={t('skins.fromSkin')} aria-checked={!cur} role="radio" />
      {ACCENTS.map((c) => (
        <button key={c} type="button" className={cx('swatch', cur === c && 'on')} style={{ background: c }} onClick={() => onChange(c)} aria-checked={cur === c} role="radio" title={c} />
      ))}
      <label className={cx('swatch swatch-custom', cur && !ACCENTS.includes(cur) && 'on')} title={cur ?? t('skins.accent')} style={cur && !ACCENTS.includes(cur) ? { background: cur } : undefined}>
        <input type="color" value={toHex6(cur ?? '#2563d9')} onChange={(e) => onChange(e.target.value)} aria-label={t('skins.accent')} data-testid="skin-accent-custom" />
      </label>
    </div>
  );
}

export function AppearancePane({ draft, onChange }: { draft: Settings; onChange: (patch: Partial<Settings>) => void }) {
  const t = useT();
  const user = useSkins((s) => s.user);
  const problems = useSkins((s) => s.problems);
  const dir = useSkins((s) => s.dir);
  const desktop = useApp((s) => s.info?.mode === 'desktop');
  const app: AppearanceSettings = draft.appearance ?? { skin: DEFAULT_SKIN_ID };
  const setApp = (patch: Partial<AppearanceSettings>) => onChange({ appearance: { ...app, ...patch } });
  const current = app.skin || DEFAULT_SKIN_ID;

  useEffect(() => {
    void reloadSkins();
  }, []);

  const card = (entry: SkinEntry) => (
    <SkinCard key={entry.skin.id} entry={entry} selected={current === entry.skin.id} theme={draft.theme} onSelect={() => setApp({ skin: entry.skin.id })} onUse={(id) => setApp({ skin: id })} />
  );
  const adjusted = !!(app.accent || app.density || app.listFontSize || app.radius !== null && app.radius !== undefined || app.stripes !== null && app.stripes !== undefined || app.fontUi || app.fontMono);
  const opt = <T,>(v: string, parse: (s: string) => T): T | null => (v === '' ? null : parse(v));

  return (
    <div className="form-stack appearance" data-testid="appearance">
      <Field label={t('view.theme')}>
        <Segmented
          value={draft.theme}
          onChange={(v) => onChange({ theme: v })}
          options={[
            { value: 'system', label: t('theme.system') },
            { value: 'light', label: t('theme.light'), icon: Sun },
            { value: 'dark', label: t('theme.dark'), icon: Moon },
          ]}
        />
      </Field>

      <div className="section-title">{t('skins.builtin')}</div>
      <div className="skin-grid" role="radiogroup" aria-label={t('skins.gallery')}>
        {BUILTIN_SKINS.map((skin) => card({ skin, builtin: true, warnings: [] }))}
      </div>

      <div className="section-title skins-user-head">
        {t('skins.user')}
        <div className="flex1" />
        <Button size="sm" icon={Plus} onClick={() => openDialog('skinEditor', { skin: newSkinFrom(current), onSaved: (id, use) => use && setApp({ skin: id }) })} data-testid="skin-new">
          {t('skins.new')}
        </Button>
        <Button size="sm" icon={FileUp} onClick={() => void importSkin().then((id) => id && setApp({ skin: id }))}>
          {t('skins.import')}
        </Button>
      </div>
      {user.length ? <div className="skin-grid">{user.map(card)}</div> : <p className="muted small">{t('skins.userEmpty')}</p>}
      {problems.length > 0 && (
        <div className="skin-problems">
          <div className="row gap warn small strong">
            <TriangleAlert size={14} /> {t('skins.problems')}
          </div>
          {problems.map((p) => (
            <div key={p.file} className="small">
              <span className="mono">{p.file}</span> <span className="muted">– {p.message}</span>
            </div>
          ))}
        </div>
      )}
      <div className="skin-folder">
        <div className="skin-folder-text">
          <div className="field-label">{t('skins.folder')}</div>
          {dir && <div className="mono small break">{dir}</div>}
          <div className="muted small">{t('skins.folderHint')}</div>
        </div>
        <div className="skin-folder-buttons">
          {desktop && dir && (
            <Button size="sm" icon={FolderOpen} onClick={() => void call('app.open', { target: dir }).catch((e) => toast.error(e))}>
              {t('skins.openFolder')}
            </Button>
          )}
          <Button size="sm" icon={RefreshCw} onClick={() => void reloadSkins()}>
            {t('skins.reload')}
          </Button>
          <Button size="sm" variant="ghost" icon={BookOpen} onClick={openGuide}>
            {t('skins.guide')}
          </Button>
        </div>
      </div>

      <div className="section-title">
        {t('skins.adjust')}
        {adjusted && <Badge tone="accent">{lookupSkin(current)?.name}</Badge>}
      </div>
      <p className="muted small">{t('skins.adjustHint')}</p>
      <div className="form-grid">
        <Field label={t('skins.accent')} className="span2">
          <AccentPicker value={app.accent} onChange={(v) => setApp({ accent: v })} />
        </Field>
        <Field label={t('skins.density')}>
          <Select value={app.density ?? ''} onChange={(e) => setApp({ density: opt(e.target.value, (s) => s as Density) })} data-testid="skin-density">
            <option value="">{t('skins.fromSkin')}</option>
            {DENSITIES.map((d) => (
              <option key={d} value={d}>
                {t(`skins.density.${d}`)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('skins.listFontSize')}>
          <Select value={app.listFontSize ?? ''} onChange={(e) => setApp({ listFontSize: opt(e.target.value, Number) })}>
            <option value="">{t('skins.fromSkin')}</option>
            {[11, 12, 13, 14, 15, 16, 18].map((n) => (
              <option key={n} value={n}>
                {n} px
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('skins.radius')}>
          <Select value={app.radius ?? ''} onChange={(e) => setApp({ radius: opt(e.target.value, Number) })}>
            <option value="">{t('skins.fromSkin')}</option>
            {[0, 2, 4, 6, 8, 10, 12].map((n) => (
              <option key={n} value={n}>
                {n} px
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('skins.stripes')}>
          <Select value={app.stripes === null || app.stripes === undefined ? '' : String(app.stripes)} onChange={(e) => setApp({ stripes: opt(e.target.value, (s) => s === 'true') })} data-testid="skin-stripes">
            <option value="">{t('skins.fromSkin')}</option>
            <option value="true">{t('common.on')}</option>
            <option value="false">{t('common.off')}</option>
          </Select>
        </Field>
        <Field label={t('skins.fontUi')} hint={t('skins.fontHint')}>
          <TextInput value={app.fontUi ?? ''} onChange={(e) => setApp({ fontUi: e.target.value || null })} placeholder={t('skins.fromSkin')} />
        </Field>
        <Field label={t('skins.fontMono')}>
          <TextInput value={app.fontMono ?? ''} onChange={(e) => setApp({ fontMono: e.target.value || null })} placeholder={t('skins.fromSkin')} className="mono" />
        </Field>
      </div>
      <div>
        <Button size="sm" icon={RotateCcw} disabled={!adjusted} onClick={() => setApp({ accent: null, density: null, listFontSize: null, radius: null, stripes: null, fontUi: null, fontMono: null })}>
          {t('skins.resetAdjust')}
        </Button>
      </div>
    </div>
  );
}
