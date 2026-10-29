import {
  forwardRef, useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type KeyboardEvent,
  type ReactNode, type SelectHTMLAttributes, type InputHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, Loader2, X, type LucideIcon } from 'lucide-react';
import { useT } from '../i18n';

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------- buttons

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'ghost' | 'subtle';
  size?: 'sm' | 'md';
  icon?: LucideIcon;
  busy?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', icon: Icon, busy, className, children, type = 'button', disabled, ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={cx('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', className)} disabled={disabled || busy} {...rest}>
      {busy ? <Loader2 className="spin" size={14} /> : Icon ? <Icon size={14} /> : null}
      {children !== undefined && children !== null && <span>{children}</span>}
    </button>
  );
});

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  title: string;
  active?: boolean;
  size?: number;
  badge?: number | string | null;
  shortcut?: string;
  tone?: 'default' | 'danger' | 'accent';
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, title, active, size = 16, badge, shortcut, className, tone = 'default', type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx('icon-btn', active && 'active', tone !== 'default' && `tone-${tone}`, className)}
      title={shortcut ? `${title} (${shortcut})` : title}
      aria-label={title}
      aria-pressed={active === undefined ? undefined : active}
      {...rest}
    >
      <Icon size={size} strokeWidth={1.75} />
      {badge !== undefined && badge !== null && badge !== 0 && <span className="icon-badge">{badge}</span>}
    </button>
  );
});

// ---------------------------------------------------------------- form controls

interface CheckboxProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  indeterminate?: boolean;
  disabled?: boolean;
  title?: string;
  className?: string;
  id?: string;
}

export function Checkbox({ checked, onChange, label, indeterminate, disabled, title, className, id }: CheckboxProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate;
  }, [indeterminate]);
  return (
    <label className={cx('check', disabled && 'disabled', className)} title={title}>
      <input id={id} ref={ref} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label !== undefined && <span>{label}</span>}
    </label>
  );
}

export function Radio<T extends string>({ value, current, onChange, label, disabled, name }: { value: T; current: T; onChange: (v: T) => void; label: ReactNode; disabled?: boolean; name: string }) {
  return (
    <label className={cx('check', disabled && 'disabled')}>
      <input type="radio" name={name} checked={value === current} disabled={disabled} onChange={() => onChange(value)} />
      <span>{label}</span>
    </label>
  );
}

export function Field({ label, hint, children, className, htmlFor, inline }: { label?: ReactNode; hint?: ReactNode; children: ReactNode; className?: string; htmlFor?: string; inline?: boolean }) {
  return (
    <div className={cx('field', inline && 'field-inline', className)}>
      {label !== undefined && <label className="field-label" htmlFor={htmlFor}>{label}</label>}
      <div className="field-control">{children}</div>
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className, ...rest }, ref) {
  return <input ref={ref} className={cx('input', className)} spellCheck={false} autoComplete="off" {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={cx('select', className)}>
      <select {...rest}>{children}</select>
      <ChevronDown size={14} className="select-caret" />
    </div>
  );
}

export function NumberInput({ value, onChange, min, max, step, className, disabled, placeholder, id, title }: { value: number | null | undefined; onChange: (v: number) => void; min?: number; max?: number; step?: number; className?: string; disabled?: boolean; placeholder?: string; id?: string; title?: string }) {
  const [text, setText] = useState(value === null || value === undefined ? '' : String(value));
  useEffect(() => {
    setText((t) => (Number(t) === value ? t : value === null || value === undefined ? '' : String(value)));
  }, [value]);
  return (
    <input
      id={id}
      title={title}
      className={cx('input input-num', className)}
      type="number"
      inputMode="numeric"
      value={text}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (e.target.value !== '' && Number.isFinite(n)) onChange(n);
        else if (e.target.value === '') onChange(0);
      }}
    />
  );
}

export function Segmented<T extends string>({ options, value, onChange, size }: { options: { value: T; label: ReactNode; icon?: LucideIcon; title?: string }[]; value: T; onChange: (v: T) => void; size?: 'sm' }) {
  return (
    <div className={cx('segmented', size === 'sm' && 'segmented-sm')} role="radiogroup">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={o.value === value} className={cx(o.value === value && 'on')} onClick={() => onChange(o.value)} title={o.title}>
          {o.icon && <o.icon size={14} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- misc

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return <Loader2 size={size} className={cx('spin', className)} />;
}

export function ProgressBar({ value, indeterminate, tone, thin }: { value: number; indeterminate?: boolean; tone?: 'ok' | 'warn' | 'err' | 'muted'; thin?: boolean }) {
  return (
    <div className={cx('progress', indeterminate && 'indeterminate', tone && `progress-${tone}`, thin && 'progress-thin')} role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress-fill" style={{ width: indeterminate ? undefined : `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function Badge({ children, tone = 'muted', title }: { children: ReactNode; tone?: 'muted' | 'accent' | 'ok' | 'warn' | 'err'; title?: string }) {
  return <span className={cx('badge', `badge-${tone}`)} title={title}>{children}</span>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function EmptyState({ icon: Icon, title, children, action }: { icon?: LucideIcon; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      {Icon && <Icon size={30} strokeWidth={1.4} className="empty-icon" />}
      <div className="empty-title">{title}</div>
      {children && <div className="empty-text">{children}</div>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function Collapsible({ title, open, onToggle, children, extra }: { title: ReactNode; open: boolean; onToggle: () => void; children: ReactNode; extra?: ReactNode }) {
  return (
    <div className={cx('collapsible', open && 'open')}>
      <button type="button" className="collapsible-head" onClick={onToggle} aria-expanded={open}>
        <ChevronRight size={14} className="collapsible-caret" />
        <span>{title}</span>
        {extra && <span className="collapsible-extra">{extra}</span>}
      </button>
      {open && <div className="collapsible-body">{children}</div>}
    </div>
  );
}

export interface TabDef<T extends string> {
  id: T;
  label: ReactNode;
  icon?: LucideIcon;
  hidden?: boolean;
  badge?: ReactNode;
}

export function Tabs<T extends string>({ tabs, value, onChange, className, vertical }: { tabs: TabDef<T>[]; value: T; onChange: (v: T) => void; className?: string; vertical?: boolean }) {
  const onKey = (e: KeyboardEvent) => {
    const vis = tabs.filter((t) => !t.hidden);
    const i = vis.findIndex((t) => t.id === value);
    const next = vertical ? ['ArrowDown', 'ArrowUp'] : ['ArrowRight', 'ArrowLeft'];
    if (e.key === next[0]) onChange(vis[(i + 1) % vis.length].id);
    else if (e.key === next[1]) onChange(vis[(i - 1 + vis.length) % vis.length].id);
    else return;
    e.preventDefault();
  };
  return (
    <div className={cx('tabs', vertical && 'tabs-vertical', className)} role="tablist" onKeyDown={onKey}>
      {tabs
        .filter((t) => !t.hidden)
        .map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={t.id === value} tabIndex={t.id === value ? 0 : -1} className={cx('tab', t.id === value && 'on')} onClick={() => onChange(t.id)}>
            {t.icon && <t.icon size={14} />}
            <span>{t.label}</span>
            {t.badge}
          </button>
        ))}
    </div>
  );
}

// ---------------------------------------------------------------- dialog

const FOCUSABLE = 'input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

interface DialogProps {
  title: ReactNode;
  icon?: LucideIcon;
  onClose: () => void;
  onSubmit?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  height?: number | string;
  className?: string;
  bodyClassName?: string;
  /** Extra content in the title bar (right side). */
  headerExtra?: ReactNode;
  tone?: 'danger' | 'warn';
  layer?: 'normal' | 'top';
  /** Disable Enter-to-submit (e.g. dialogs with multiline inputs only). */
  noEnterSubmit?: boolean;
}

export function Dialog({ title, icon: Icon, onClose, onSubmit, children, footer, width = 460, height, className, bodyClassName, headerExtra, tone, layer = 'normal', noEnterSubmit }: DialogProps) {
  const ref = useRef<HTMLFormElement>(null);
  const titleId = useId();
  const t = useT();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el) {
      const inBody = FOCUSABLE.split(',').map((s) => `.dlg-body ${s.trim()}`).join(', ');
      const target =
        el.querySelector<HTMLElement>('[data-autofocus]') ??
        el.querySelector<HTMLElement>(inBody) ??
        el.querySelector<HTMLElement>('.dlg-foot .btn-primary, .dlg-foot .btn-danger') ??
        el;
      target.focus({ preventScroll: true });
      if (target instanceof HTMLInputElement && target.dataset.select !== 'none' && (target.type === 'text' || target.type === 'password')) {
        if (target.dataset.selectStem) {
          const v = target.value;
          const dot = v.lastIndexOf('.');
          target.setSelectionRange(0, dot > 0 ? dot : v.length);
        } else target.select();
      }
    }
    return () => {
      if (prev && document.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, []);

  // Focus can fall out of the dialog (e.g. a clicked button becomes disabled while busy).
  // Then Escape / Tab still have to reach the topmost dialog.
  useEffect(() => {
    const onWindowKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || (e.key !== 'Escape' && e.key !== 'Tab')) return;
      const ae = document.activeElement as HTMLElement | null;
      if (ae && ae !== document.body && ae.closest('.dlg, .menu, .editor-overlay')) return;
      const all = document.querySelectorAll('.dlg');
      if (all[all.length - 1] !== ref.current) return;
      e.preventDefault();
      if (e.key === 'Escape') closeRef.current();
      else (ref.current?.querySelector<HTMLElement>(FOCUSABLE) ?? ref.current)?.focus();
    };
    window.addEventListener('keydown', onWindowKey);
    return () => window.removeEventListener('keydown', onWindowKey);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    const target = e.target as HTMLElement;
    if (e.key === 'Escape') {
      if (target.closest('.cm-editor') && target.closest('.cm-panels')) return;
      e.preventDefault();
      e.stopPropagation();
      closeRef.current();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.nativeEvent.isComposing) {
      const tag = target.tagName;
      if (tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A' || target.closest('.cm-editor') || target.dataset.noEnter !== undefined) {
        e.stopPropagation();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (!noEnterSubmit && onSubmit) onSubmit();
      return;
    }
    if (e.key === 'Tab') {
      const el = ref.current;
      if (!el) return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    // keep app-level shortcuts from firing behind the dialog
    e.stopPropagation();
  };

  const style: CSSProperties = { width, height };
  return createPortal(
    <div className={cx('dlg-backdrop', layer === 'top' && 'dlg-top')} onMouseDown={(e) => e.stopPropagation()}>
      <form
        ref={ref}
        className={cx('dlg', tone && `dlg-${tone}`, className)}
        style={style}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit?.();
        }}
      >
        <div className="dlg-head">
          {Icon && <Icon size={16} className="dlg-icon" />}
          <h2 id={titleId}>{title}</h2>
          {headerExtra}
          <button type="button" className="dlg-close" onClick={onClose} title={t('common.close')} aria-label={t('common.close')}>
            <X size={16} />
          </button>
        </div>
        <div className={cx('dlg-body', bodyClassName)}>{children}</div>
        {footer && <div className="dlg-foot">{footer}</div>}
      </form>
    </div>,
    document.body,
  );
}

/** Standard OK/Cancel footer. */
export function DialogButtons({ onCancel, okLabel, cancelLabel, okDisabled, busy, danger, extra, onOk }: { onCancel: () => void; okLabel?: string; cancelLabel?: string; okDisabled?: boolean; busy?: boolean; danger?: boolean; extra?: ReactNode; onOk?: () => void }) {
  const t = useT();
  return (
    <>
      {extra && <div className="dlg-foot-extra">{extra}</div>}
      <div className="dlg-foot-buttons">
        <Button type={onOk ? 'button' : 'submit'} onClick={onOk} variant={danger ? 'danger' : 'primary'} disabled={okDisabled} busy={busy}>
          {okLabel ?? t('common.ok')}
        </Button>
        <Button onClick={onCancel}>{cancelLabel ?? t('common.cancel')}</Button>
      </div>
    </>
  );
}
