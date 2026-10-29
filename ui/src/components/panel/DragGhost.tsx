import { Copy, MoveRight } from 'lucide-react';
import { useT } from '../../i18n';
import { useApp } from '../../store/app';
import { usePanels } from '../../store/panels';
import { usePanelDrag } from './panelDrag';
import { cx } from '../ui';

/** Small label that follows the pointer during a panel-to-panel drag. */
export function DragGhost() {
  const t = useT();
  const drag = usePanelDrag((s) => s.drag);
  const sessions = useApp((s) => s.sessions);
  if (!drag) return null;
  const panels = usePanels.getState();
  const what = drag.names.length === 1 ? drag.names[0] : t('dnd.items', { n: drag.names.length });
  let where = '';
  const target = drag.target;
  if (target?.kind === 'panel') {
    const p = panels[target.side];
    const name = sessions.find((s) => s.id === p.session);
    const dir = target.dir ? `${p.path.replace(/\/$/, '')}/${target.dir}` : p.path;
    where = `${p.session === 'local' ? t('session.local') : name?.name ?? p.session}: ${dir}`;
  } else if (target?.kind === 'session') {
    where = sessions.find((s) => s.id === target.session)?.name ?? target.session;
  }
  const Icon = drag.move ? MoveRight : Copy;
  return (
    <div className={cx('drag-ghost', !target && 'no-target', drag.move && 'is-move')} style={{ transform: `translate(${drag.x + 14}px, ${drag.y + 14}px)` }} data-testid="drag-ghost">
      <div className="drag-ghost-main">
        {target && <Icon size={13} />}
        <span className="drag-ghost-what">{what}</span>
      </div>
      {target ? (
        <div className="drag-ghost-where">
          {drag.move ? t('dnd.move') : t('dnd.copy')} → {where}
        </div>
      ) : (
        <div className="drag-ghost-where">{t('dnd.hint')}</div>
      )}
    </div>
  );
}
