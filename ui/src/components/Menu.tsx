import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { Check, ChevronRight, type LucideIcon } from 'lucide-react';
import { cx } from './ui';

export interface MenuItem {
  label?: string;
  icon?: LucideIcon;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
  danger?: boolean;
  checked?: boolean;
  submenu?: MenuItem[];
  separator?: boolean;
  hidden?: boolean;
  /** Small muted header line. */
  header?: boolean;
  testId?: string;
}

interface MenuListProps {
  items: MenuItem[];
  x: number;
  y: number;
  onClose: () => void;
  /** Position relative to an anchor rect (for dropdowns) instead of a point. */
  anchor?: DOMRect;
  isSubmenu?: boolean;
  onLeft?: () => void;
  autoFocus?: boolean;
  className?: string;
  /** Called with ArrowLeft/ArrowRight when not inside a submenu (menubar navigation). */
  onNavigate?: (dir: -1 | 1) => void;
}

const actionable = (i: MenuItem) => !i.separator && !i.header && !i.disabled && !i.hidden;

export function MenuList({ items, x, y, onClose, anchor, isSubmenu, onLeft, autoFocus = true, className, onNavigate }: MenuListProps) {
  const visible = items.filter((i) => !i.hidden);
  // drop leading/trailing/double separators
  const cleaned = visible.filter((i, idx, arr) => !(i.separator && (idx === 0 || idx === arr.length - 1 || arr[idx - 1].separator)));
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });
  const [active, setActive] = useState(-1);
  const [sub, setSub] = useState<{ index: number; rect: DOMRect } | null>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    if (anchor) {
      if (isSubmenu) {
        left = anchor.right - 2;
        top = anchor.top - 4;
        if (left + r.width > vw - 4) left = Math.max(4, anchor.left - r.width + 2);
      } else {
        left = anchor.left;
        top = anchor.bottom + 2;
        if (top + r.height > vh - 4 && anchor.top - r.height > 4) top = anchor.top - r.height - 2;
      }
    }
    if (left + r.width > vw - 4) left = Math.max(4, vw - r.width - 4);
    if (top + r.height > vh - 4) top = Math.max(4, vh - r.height - 4);
    setPos({ left, top });
  }, [x, y, anchor, isSubmenu]);

  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  useEffect(() => () => {
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
  }, []);

  const move = (dir: 1 | -1) => {
    if (!cleaned.some(actionable)) return;
    let i = active;
    for (let n = 0; n < cleaned.length; n++) {
      i = (i + dir + cleaned.length) % cleaned.length;
      if (actionable(cleaned[i])) break;
    }
    setActive(i);
  };

  const openSub = (index: number) => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-idx="${index}"]`);
    if (el) setSub({ index, rect: el.getBoundingClientRect() });
  };

  const activate = (item: MenuItem, index: number) => {
    if (!actionable(item)) return;
    if (item.submenu) {
      openSub(index);
      return;
    }
    onClose();
    item.onClick?.();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        move(-1);
        break;
      case 'Home':
        e.preventDefault();
        setActive(cleaned.findIndex(actionable));
        break;
      case 'End':
        e.preventDefault();
        for (let i = cleaned.length - 1; i >= 0; i--) if (actionable(cleaned[i])) return setActive(i);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (active >= 0 && cleaned[active]?.submenu) openSub(active);
        else onNavigate?.(1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (isSubmenu) onLeft?.();
        else onNavigate?.(-1);
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (active >= 0) activate(cleaned[active], active);
        break;
      case 'Escape':
      case 'Tab':
        e.preventDefault();
        if (isSubmenu) onLeft?.();
        else onClose();
        break;
      default: {
        // accelerator: first letter
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
          const k = e.key.toLowerCase();
          const start = active + 1;
          for (let n = 0; n < cleaned.length; n++) {
            const i = (start + n) % cleaned.length;
            if (actionable(cleaned[i]) && cleaned[i].label?.toLowerCase().startsWith(k)) {
              setActive(i);
              break;
            }
          }
        }
      }
    }
  };

  return (
    <>
      <div
        ref={ref}
        className={cx('menu', className)}
        role="menu"
        tabIndex={-1}
        style={{ left: pos.left, top: pos.top }}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {cleaned.map((item, i) =>
          item.separator ? (
            <div key={i} className="menu-sep" role="separator" />
          ) : item.header ? (
            <div key={i} className="menu-header">{item.label}</div>
          ) : (
            <div
              key={i}
              data-idx={i}
              data-testid={item.testId}
              role="menuitem"
              aria-disabled={item.disabled || undefined}
              className={cx('menu-item', i === active && 'active', item.disabled && 'disabled', item.danger && 'danger', sub?.index === i && 'sub-open')}
              onMouseEnter={() => {
                setActive(i);
                if (hoverTimer.current) clearTimeout(hoverTimer.current);
                if (item.submenu && !item.disabled) hoverTimer.current = setTimeout(() => openSub(i), 120);
                else hoverTimer.current = setTimeout(() => setSub(null), 200);
              }}
              onClick={() => activate(item, i)}
            >
              <span className="menu-check">{item.checked ? <Check size={14} /> : item.icon ? <item.icon size={15} strokeWidth={1.75} /> : null}</span>
              <span className="menu-label">{item.label}</span>
              {item.shortcut && <span className="menu-shortcut">{item.shortcut}</span>}
              {item.submenu && <ChevronRight size={14} className="menu-sub-caret" />}
            </div>
          ),
        )}
      </div>
      {sub && cleaned[sub.index]?.submenu && (
        <MenuList
          items={cleaned[sub.index].submenu!}
          x={0}
          y={0}
          anchor={sub.rect}
          isSubmenu
          onClose={onClose}
          onLeft={() => {
            setSub(null);
            ref.current?.focus();
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------- context menu host

interface CtxStore {
  menu: { x: number; y: number; items: MenuItem[] } | null;
}

export const useContextMenu = create<CtxStore>(() => ({ menu: null }));

let prevFocus: HTMLElement | null = null;

export function showContextMenu(x: number, y: number, items: MenuItem[]) {
  if (!useContextMenu.getState().menu) prevFocus = document.activeElement as HTMLElement | null;
  useContextMenu.setState({ menu: { x, y, items } });
}

export function closeContextMenu() {
  if (!useContextMenu.getState().menu) return;
  useContextMenu.setState({ menu: null });
  const el = prevFocus;
  prevFocus = null;
  if (el && document.contains(el)) el.focus({ preventScroll: true });
}

export function ContextMenuHost() {
  const menu = useContextMenu((s) => s.menu);
  useEffect(() => {
    if (!menu) return;
    const close = () => closeContextMenu();
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
      window.removeEventListener('resize', close);
    };
  }, [menu]);
  if (!menu) return null;
  return createPortal(<MenuList items={menu.items} x={menu.x} y={menu.y} onClose={closeContextMenu} />, document.body);
}
