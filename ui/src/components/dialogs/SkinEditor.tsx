// Skin editor: change the tokens of a user skin with a live preview, then save it to the
// skins folder. Values left empty are inherited from the base skin (or derived from other
// tokens, see lib/skins/tokens.ts).
import { useEffect, useMemo, useState } from 'react';
import { ClipboardCopy, Download, Moon, Palette, RotateCcw, Search, ShieldCheck, Sun, TriangleAlert } from 'lucide-react';
import { useT, type TKey } from '../../i18n';
import { DENSITIES, DEFAULT_SKIN_ID, ID_RE, STYLE_LIMITS, compactSkin, contrastReport, normalizeSkinId, sanitizeValue, slugify, validateSkin, type Density, type Scheme, type Skin, type SkinStyle } from '../../lib/skins/engine';
import { GROUPS, TOKENS, type TokenDef, type TokenGroup } from '../../lib/skins/tokens';
import { formatColor, parseColor, toHex6 } from '../../lib/skins/color';
import { downloadSkin, skinToJson } from '../../lib/skins/files';
import { BUILTIN_IDS } from '../../skins';
import { setSkin as applySkinSetting } from '../../store/app';
import { confirmDialog, type DialogPropsMap } from '../../store/dialogs';
import { allSkins, endPreview, previewLook, requestedScheme, resolveLook, saveUserSkin, skinVariants, useSkins } from '../../store/skins';
import { useApp } from '../../store/app';
import { toast } from '../../store/toasts';
import { copyText } from '../../actions/fileOps';
import { Button, Checkbox, Collapsible, Dialog, Field, IconButton, Segmented, Select, Tabs, TextInput, cx, type TabDef } from '../ui';
import { SkinPreview } from '../SkinPreview';

type View = 'colors' | 'style' | 'json';

/** A picked #rrggbb that keeps the alpha of the value it replaces. */
function withPreviousAlpha(hex: string, previous: string | undefined): string {
  const prev = previous ? parseColor(previous) : null;
  const c = parseColor(hex);
  if (!c || !prev || prev.a >= 1) return hex;
  return formatColor({ ...c, a: prev.a });
}

function TokenRow({ def, value, effective, onChange }: { def: TokenDef; value: string | undefined; effective: string | undefined; onChange: (v: string | null) => void }) {
  const t = useT();
  const [text, setText] = useState(value ?? '');
  useEffect(() => setText(value ?? ''), [value]);
  const invalid = text.trim() !== '' && sanitizeValue(def, text) === null;
  const isColor = def.kind === 'color';
  return (
    <div className={cx('tok-row', value !== undefined && 'set')} data-token={def.name}>
      {isColor ? (
        <label className="tok-swatch" title={effective ?? t('skinEditor.optionalUnset')}>
          <span className="tok-swatch-fill" style={{ background: effective ?? 'transparent' }} />
          <input type="color" value={toHex6(effective ?? '#808080')} onChange={(e) => onChange(withPreviousAlpha(e.target.value, effective))} aria-label={def.name} />
        </label>
      ) : (
        <span className="tok-swatch tok-swatch-shadow" style={{ boxShadow: effective && effective !== 'none' ? effective : undefined }} />
      )}
      <div className="tok-name">
        <span className="mono">{def.name}</span>
        <span className="tok-doc">{def.doc}</span>
      </div>
      <input
        className={cx('input input-sm mono tok-input', invalid && 'invalid')}
        value={text}
        placeholder={effective ?? t('skinEditor.optionalUnset')}
        spellCheck={false}
        onChange={(e) => {
          const v = e.target.value;
          setText(v);
          if (!v.trim()) onChange(null);
          else if (sanitizeValue(def, v) !== null) onChange(v.trim());
        }}
        onBlur={() => !invalid && setText(value ?? '')}
        aria-label={`${def.name} value`}
        data-no-enter
      />
      <IconButton icon={RotateCcw} size={13} title={t('skinEditor.reset')} onClick={() => onChange(null)} disabled={value === undefined} className="tok-reset" />
    </div>
  );
}

function StyleSelect<T extends string | number | boolean>({ value, options, onChange, format }: { value: T | undefined; options: T[]; onChange: (v: T | undefined) => void; format?: (v: T) => string }) {
  const t = useT();
  return (
    <Select value={value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? undefined : options.find((o) => String(o) === e.target.value))}>
      <option value="">{t('skinEditor.style.default')}</option>
      {options.map((o) => (
        <option key={String(o)} value={String(o)}>
          {format ? format(o) : String(o)}
        </option>
      ))}
    </Select>
  );
}

const range = (lo: number, hi: number, step = 1) => Array.from({ length: Math.floor((hi - lo) / step) + 1 }, (_, i) => lo + i * step);

export default function SkinEditor({ props, close }: { props: DialogPropsMap['skinEditor']; close: () => void }) {
  const t = useT();
  const user = useSkins((s) => s.user);
  const theme = useApp((s) => s.settings?.theme ?? 'system');
  const [initial] = useState<Skin>(() => structuredClone(props.skin ?? { id: 'my-skin', name: 'My skin', light: {}, dark: {} }));
  const [isNew] = useState(() => !user.some((e) => e.skin.id === initial.id));
  const [skin, setSkin] = useState<Skin>(initial);
  const [idTouched, setIdTouched] = useState(!isNew);
  const [view, setView] = useState<View>('colors');
  const [filter, setFilter] = useState('');
  const [onlySet, setOnlySet] = useState(false);
  const [live, setLive] = useState(false);
  const [json, setJson] = useState('');
  const [busy, setBusy] = useState(false);
  const [openGroups, setOpenGroups] = useState<Set<TokenGroup>>(() => new Set(['base', 'text', 'accent']));

  // the draft as it would be saved: values checked and normalized
  const clean = useMemo(() => validateSkin(skin).skin ?? { ...skin, id: normalizeSkinId(skin.id || 'skin'), name: skin.name || '?' }, [skin]);
  const variants = useMemo(() => skinVariants(clean), [clean, user]); // eslint-disable-line react-hooks/exhaustive-deps
  const [scheme, setScheme] = useState<Scheme>(() => {
    const v = skinVariants(initial);
    const want = requestedScheme(theme);
    return v.includes(want) ? want : v[0];
  });
  useEffect(() => {
    if (!variants.includes(scheme)) setScheme(variants[0]);
  }, [variants, scheme]);

  const resolved = useMemo(() => resolveLook({ theme: scheme, appearance: { skin: clean.id } }, scheme, clean), [clean, scheme, user]); // eslint-disable-line react-hooks/exhaustive-deps
  const contrast = useMemo(() => contrastReport(resolved).filter((c) => !c.ok), [resolved]);

  useEffect(() => {
    if (live) previewLook('skin-editor', { theme: scheme, appearance: { skin: clean.id } }, clean);
    else endPreview('skin-editor');
  }, [live, clean, scheme]);
  useEffect(() => () => endPreview('skin-editor'), []);

  const own = (scheme === 'light' ? skin.light : skin.dark) ?? {};
  const effectiveOwn = (scheme === 'light' ? clean.light : clean.dark) ?? {};
  const setToken = (name: string, value: string | null) =>
    setSkin((s) => {
      const v = { ...(s[scheme] ?? {}) };
      if (value === null) delete v[name];
      else v[name] = value;
      return { ...s, [scheme]: v };
    });
  const setStyle = <K extends keyof SkinStyle>(k: K, v: SkinStyle[K] | undefined) =>
    setSkin((s) => {
      const style = { ...(s.style ?? {}) };
      if (v === undefined || v === '') delete style[k];
      else style[k] = v;
      return { ...s, style };
    });
  const toggleVariant = (v: Scheme, on: boolean) =>
    setSkin((s) => {
      const next = { ...s };
      if (on) next[v] = s[v] ?? {};
      else delete next[v];
      return next;
    });

  const bases = allSkins().filter((e) => e.skin.id !== skin.id);
  const idError = !ID_RE.test(skin.id) ? t('skinEditor.idHint') : BUILTIN_IDS.has(skin.id) ? t('skins.reservedId', { id: skin.id }) : null;
  const dirty = JSON.stringify(compactSkin(clean)) !== JSON.stringify(compactSkin(validateSkin(initial).skin ?? initial));

  const q = filter.trim().toLowerCase();
  const visible = (d: TokenDef) => (!q || d.name.includes(q) || d.doc.toLowerCase().includes(q)) && (!onlySet || own[d.name] !== undefined);

  const tryClose = async () => {
    if (dirty && !(await confirmDialog({ title: t('skinEditor.title'), message: t('skinEditor.unsaved'), okLabel: t('common.ok') }))) return;
    close();
  };

  const save = async (use: boolean) => {
    if (idError) return toast.warning(idError);
    if (!skin.name.trim()) return toast.warning(t('skins.invalid'), '"name"');
    const exists = user.some((e) => e.skin.id === clean.id);
    if (exists && (isNew || clean.id !== initial.id)) {
      if (!(await confirmDialog({ title: t('skins.replaceTitle'), message: t('skins.replaceText', { id: clean.id }), okLabel: t('common.replace') }))) return;
    }
    setBusy(true);
    try {
      await saveUserSkin(compactSkin(clean));
      toast.success(t('skins.saved', { name: clean.name }));
      if (props.onSaved) props.onSaved(clean.id, use);
      else if (use) applySkinSetting(clean.id);
      endPreview('skin-editor', false);
      close();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const applyJson = () => {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch (e) {
      return toast.error(t('skins.invalid'), String(e));
    }
    const v = validateSkin(raw);
    if (!v.skin) return toast.error(t('skins.invalid'), v.errors.join('\n'));
    if (v.warnings.length) toast.warning(t('skins.importIgnored', { n: v.warnings.length, first: v.warnings[0] }));
    setSkin(v.skin);
    setIdTouched(true);
  };

  const tabs: TabDef<View>[] = [
    { id: 'colors', label: t('skinEditor.colors') },
    { id: 'style', label: t('skinEditor.style') },
    { id: 'json', label: t('skinEditor.json') },
  ];

  return (
    <Dialog
      title={t('skinEditor.title')}
      icon={Palette}
      onClose={() => void tryClose()}
      onSubmit={() => void save(false)}
      width={1120}
      height={720}
      className="skin-editor-dlg"
      bodyClassName="skin-editor"
      footer={
        <>
          <div className="dlg-foot-extra">
            <Button icon={Download} onClick={() => downloadSkin(clean)}>
              {t('skins.export')}
            </Button>
            <Checkbox label={t('skinEditor.liveApp')} checked={live} onChange={setLive} />
          </div>
          <div className="dlg-foot-buttons">
            <Button variant="primary" onClick={() => void save(true)} busy={busy} disabled={!!idError} data-testid="skin-save-use">
              {t('skinEditor.saveUse')}
            </Button>
            <Button type="submit" disabled={!!idError || busy}>
              {t('common.save')}
            </Button>
            <Button onClick={() => void tryClose()}>{t('common.cancel')}</Button>
          </div>
        </>
      }
    >
      <div className="se-form">
        <div className="form-grid se-meta">
          <Field label={t('skinEditor.name')}>
            <TextInput
              value={skin.name}
              onChange={(e) => {
                const name = e.target.value;
                setSkin((s) => ({ ...s, name, ...(idTouched ? {} : { id: normalizeSkinId(slugify(name)) }) }));
              }}
              data-testid="skin-name"
              data-autofocus
            />
          </Field>
          <Field label={t('skinEditor.id')} hint={idError ? <span className="err">{idError}</span> : undefined}>
            <TextInput
              className="mono"
              value={skin.id}
              disabled={!isNew}
              onChange={(e) => {
                setIdTouched(true);
                setSkin((s) => ({ ...s, id: e.target.value.toLowerCase() }));
              }}
              data-testid="skin-id"
            />
          </Field>
          <Field label={t('skinEditor.extends')}>
            <Select value={skin.extends ?? DEFAULT_SKIN_ID} onChange={(e) => setSkin((s) => ({ ...s, extends: e.target.value }))}>
              {bases.map((e) => (
                <option key={e.skin.id} value={e.skin.id}>
                  {e.skin.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('skinEditor.author')}>
            <TextInput value={skin.author ?? ''} onChange={(e) => setSkin((s) => ({ ...s, author: e.target.value || undefined }))} />
          </Field>
          <Field label={t('skinEditor.description')} className="span2">
            <TextInput value={skin.description ?? ''} onChange={(e) => setSkin((s) => ({ ...s, description: e.target.value || undefined }))} />
          </Field>
        </div>
        <div className="se-variants">
          <span className="field-label">{t('skinEditor.variants')}</span>
          <Checkbox label={t('skinEditor.hasLight')} checked={!!skin.light} onChange={(v) => toggleVariant('light', v)} />
          <Checkbox label={t('skinEditor.hasDark')} checked={!!skin.dark} onChange={(v) => toggleVariant('dark', v)} />
          <div className="flex1" />
          <span className="field-label">{t('skinEditor.editing')}</span>
          <Segmented
            size="sm"
            value={scheme}
            onChange={setScheme}
            options={variants.map((v) => ({ value: v, label: v === 'light' ? t('skinEditor.hasLight') : t('skinEditor.hasDark'), icon: v === 'light' ? Sun : Moon }))}
          />
        </div>
        <Tabs
          tabs={tabs}
          value={view}
          onChange={(v) => {
            if (v === 'json') setJson(skinToJson(clean));
            setView(v);
          }}
          className="se-tabs"
        />
        <div className="se-scroll">
          {view === 'colors' && (
            <div className="form-stack se-colors">
              <div className="row gap">
                <div className="sm-search grow">
                  <Search size={13} className="muted" />
                  <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t('skinEditor.filter')} data-no-enter />
                </div>
                <Checkbox label={t('skinEditor.onlySet')} checked={onlySet} onChange={setOnlySet} />
              </div>
              {GROUPS.map((g) => {
                const defs = TOKENS.filter((d) => d.group === g && visible(d));
                if (!defs.length) return null;
                const count = TOKENS.filter((d) => d.group === g && own[d.name] !== undefined).length;
                const hint = g === 'palette' || g === 'accent' ? t(`skinEditor.hint.${g}` as TKey) : null;
                return (
                  <Collapsible
                    key={g}
                    title={t(`skinEditor.group.${g}` as TKey)}
                    open={!!q || onlySet || openGroups.has(g)}
                    onToggle={() =>
                      setOpenGroups((s) => {
                        const n = new Set(s);
                        if (n.has(g)) n.delete(g);
                        else n.add(g);
                        return n;
                      })
                    }
                    extra={count ? `${count} ${t('skinEditor.set')}` : undefined}
                  >
                    {hint && <p className="muted small">{hint}</p>}
                    <div className="tok-list">
                      {defs.map((d) => (
                        <TokenRow key={d.name} def={d} value={own[d.name]} effective={effectiveOwn[d.name] ?? resolved.tokens[d.name]} onChange={(v) => setToken(d.name, v)} />
                      ))}
                    </div>
                  </Collapsible>
                );
              })}
            </div>
          )}
          {view === 'style' && (
            <div className="form-grid">
              <Field label={t('skins.fontUi')} className="span2" hint={t('skins.fontHint')}>
                <TextInput value={skin.style?.fontUi ?? ''} onChange={(e) => setStyle('fontUi', e.target.value)} placeholder={resolved.style.fontUi} />
              </Field>
              <Field label={t('skins.fontMono')} className="span2">
                <TextInput className="mono" value={skin.style?.fontMono ?? ''} onChange={(e) => setStyle('fontMono', e.target.value)} placeholder={resolved.style.fontMono} />
              </Field>
              <Field label={t('skins.radius')}>
                <StyleSelect value={skin.style?.radius} options={range(...STYLE_LIMITS.radius)} onChange={(v) => setStyle('radius', v)} format={(n) => `${n} px`} />
              </Field>
              <Field label={t('skinEditor.panelRadius')}>
                <StyleSelect value={skin.style?.panelRadius} options={range(...STYLE_LIMITS.panelRadius)} onChange={(v) => setStyle('panelRadius', v)} format={(n) => `${n} px`} />
              </Field>
              <Field label={t('skins.density')}>
                <StyleSelect<Density> value={skin.style?.density} options={DENSITIES} onChange={(v) => setStyle('density', v)} format={(d) => t(`skins.density.${d}`)} />
              </Field>
              <Field label={t('skins.listFontSize')}>
                <StyleSelect value={skin.style?.listFontSize} options={range(...STYLE_LIMITS.listFontSize)} onChange={(v) => setStyle('listFontSize', v)} format={(n) => `${n} px`} />
              </Field>
              <Field label={t('skins.stripes')}>
                <StyleSelect value={skin.style?.stripes} options={[true, false]} onChange={(v) => setStyle('stripes', v)} format={(b) => (b ? t('common.on') : t('common.off'))} />
              </Field>
            </div>
          )}
          {view === 'json' && (
            <div className="form-stack se-json">
              <p className="muted small">{t('skinEditor.jsonHint')}</p>
              <textarea className="input textarea mono small" rows={22} value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} data-testid="skin-json" />
              <div className="row gap">
                <Button size="sm" onClick={applyJson}>
                  {t('skinEditor.jsonApply')}
                </Button>
                <Button size="sm" icon={ClipboardCopy} onClick={() => void copyText(json, `${clean.id}.json`)}>
                  {t('common.copy')}
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
      <div className="se-side">
        <div className="se-preview">
          <SkinPreview resolved={resolved} size="full" />
        </div>
        <div className={cx('se-contrast', contrast.length ? 'warn' : 'ok')}>
          {contrast.length === 0 ? (
            <div className="row gap">
              <ShieldCheck size={14} /> {t('skinEditor.contrastOk')}
            </div>
          ) : (
            contrast.map((c) => (
              <div key={c.what} className="row gap">
                <TriangleAlert size={14} />
                {t('skinEditor.contrastLow', { what: t(`contrast.${c.what}` as TKey), ratio: c.ratio.toFixed(1), min: c.min })}
              </div>
            ))
          )}
        </div>
      </div>
    </Dialog>
  );
}
