import { useRef, type PointerEvent } from 'react';
import { cx } from './ui';

/**
 * Drag handle. `onDrag` receives the pointer delta (px) since drag start along the axis,
 * `onStart` lets the caller capture the size at drag start.
 */
export function Splitter({ axis, onStart, onDrag, onDoubleClick, className, label }: { axis: 'x' | 'y'; onStart?: () => void; onDrag: (delta: number) => void; onDoubleClick?: () => void; className?: string; label?: string }) {
  const start = useRef(0);
  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    start.current = axis === 'x' ? e.clientX : e.clientY;
    onStart?.();
    document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!(e.target as HTMLElement).hasPointerCapture(e.pointerId)) return;
    onDrag((axis === 'x' ? e.clientX : e.clientY) - start.current);
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    document.body.classList.remove('resizing-x', 'resizing-y');
  };
  return (
    <div
      className={cx('splitter', `splitter-${axis}`, className)}
      role="separator"
      aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
      aria-label={label}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={onDoubleClick}
    />
  );
}
