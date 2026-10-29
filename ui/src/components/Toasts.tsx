import { CircleAlert, CircleCheck, Info, TriangleAlert, X } from 'lucide-react';
import { dismissToast, pauseToast, resumeToast, useToasts, type ToastKind } from '../store/toasts';
import { useT } from '../i18n';
import { cx } from './ui';

const ICONS: Record<ToastKind, typeof Info> = { info: Info, success: CircleCheck, warning: TriangleAlert, error: CircleAlert };

export function Toasts() {
  const t = useT();
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite" aria-relevant="additions">
      {toasts.map((x) => {
        const Icon = ICONS[x.kind];
        return (
          <div key={x.id} className={cx('toast', `toast-${x.kind}`)} role={x.kind === 'error' ? 'alert' : 'status'} onMouseEnter={() => pauseToast(x.id)} onMouseLeave={() => resumeToast(x.id)}>
            <Icon size={16} className="toast-icon" />
            <div className="toast-body">
              <div className="toast-title">{x.title}</div>
              {x.message && <div className="toast-msg">{x.message}</div>}
              {x.action && (
                <button
                  type="button"
                  className="toast-action"
                  onClick={() => {
                    x.action!.run();
                    dismissToast(x.id);
                  }}
                >
                  {x.action.label}
                </button>
              )}
            </div>
            <button type="button" className="toast-close" onClick={() => dismissToast(x.id)} aria-label={t('common.close')}>
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
