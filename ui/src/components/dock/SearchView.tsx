import { ClipboardCopy, Edit3, Eye, FolderOpen, Search, Square } from 'lucide-react';
import type { FileEntry } from '../../api/types';
import { call } from '../../api/client';
import { useT } from '../../i18n';
import { CATEGORY_ICON, categoryOf, isDirLike } from '../../lib/fileTypes';
import { formatDate, formatNumber, formatSize } from '../../lib/format';
import * as P from '../../lib/paths';
import { useApp } from '../../store/app';
import { openDialog } from '../../store/dialogs';
import { openFile } from '../../store/editors';
import { useSearch } from '../../store/misc';
import { navigate, getPanel, type Side } from '../../store/panels';
import { attempt } from '../../store/toasts';
import { copyText } from '../../actions/fileOps';
import { showContextMenu } from '../Menu';
import { Button, EmptyState, Spinner, cx } from '../ui';

async function reveal(session: string, e: FileEntry) {
  const st = useApp.getState();
  let side: Side = st.activeSide;
  if (getPanel(side).session !== session) side = getPanel(side === 'left' ? 'right' : 'left').session === session ? (side === 'left' ? 'right' : 'left') : side;
  await navigate(side, session, P.dirname(e.path), { select: e.name });
  document.querySelector<HTMLElement>(`[data-panel="${side}"] .ft-body`)?.focus();
}

export function SearchView() {
  const t = useT();
  const run = useSearch((s) => s.run);
  const sizeFormat = useApp((s) => s.settings?.sizeFormat ?? 'auto');
  const sessions = useApp((s) => s.sessions);
  if (!run) {
    return (
      <EmptyState icon={Search} title={t('find.noSearch')} action={<Button size="sm" icon={Search} onClick={() => openDialog('find', { session: getPanel(useApp.getState().activeSide).session, root: getPanel(useApp.getState().activeSide).path })}>{t('find.title')}</Button>} />
    );
  }
  const session = run.params.session;
  const sname = sessions.find((s) => s.id === session)?.name ?? session;
  const menu = (x: number, y: number, e: FileEntry) =>
    showContextMenu(x, y, [
      { label: t('find.reveal'), icon: FolderOpen, onClick: () => void reveal(session, e) },
      { label: t('ops.edit'), icon: Edit3, hidden: isDirLike(e), onClick: () => void openFile(session, e, 'edit') },
      { label: t('ops.view'), icon: Eye, hidden: isDirLike(e), onClick: () => void openFile(session, e, 'view') },
      { separator: true },
      { label: t('ops.copyPath'), icon: ClipboardCopy, onClick: () => void copyText(e.path) },
    ]);
  return (
    <div className="searchview">
      <div className="dock-toolbar">
        {run.running && <Spinner size={14} />}
        <span className="search-summary">
          {t('find.summary', { mask: run.params.nameMask || '*', root: `${sname}:${run.params.root}`, n: formatNumber(run.results.length) })}
          {run.scanned != null && <span className="muted"> · {t('find.scanned', { n: formatNumber(run.scanned) })}</span>}
          {run.cancelled && <span className="warn"> · {t('find.cancelled')}</span>}
          {run.error && <span className="err"> · {run.error}</span>}
        </span>
        <div className="flex1" />
        {run.running ? (
          <Button size="sm" variant="ghost" icon={Square} onClick={() => void attempt(() => call('search.cancel', { id: run.id }))}>
            {t('common.cancel')}
          </Button>
        ) : (
          <Button size="sm" variant="ghost" icon={Search} onClick={() => openDialog('find', { session, root: run.params.root })}>
            {t('find.newSearch')}
          </Button>
        )}
      </div>
      <div className="search-list" role="grid">
        <div className="search-row search-head" role="row">
          <span>{t('col.name')}</span>
          <span>{t('find.folder')}</span>
          <span className="num">{t('col.size')}</span>
          <span>{t('col.modified')}</span>
        </div>
        {run.results.length === 0 && !run.running && <EmptyState icon={Search} title={t('find.none')} />}
        {run.results.map((e) => {
          const cat = categoryOf(e);
          const Icon = CATEGORY_ICON[cat];
          return (
            <div
              key={e.path}
              className="search-row"
              role="row"
              tabIndex={0}
              data-testid="search-result"
              onDoubleClick={() => void reveal(session, e)}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') void reveal(session, e);
              }}
              onContextMenu={(ev) => {
                ev.preventDefault();
                menu(ev.clientX, ev.clientY, e);
              }}
            >
              <span className="search-name">
                <span className={cx('fi', `fi-${cat}`)}>
                  <Icon size={15} strokeWidth={1.6} />
                </span>
                {e.name}
              </span>
              <span className="muted search-dir" title={P.dirname(e.path)}>{P.dirname(e.path)}</span>
              <span className="num">{isDirLike(e) ? '' : formatSize(e.size, sizeFormat)}</span>
              <span className="muted">{formatDate(e.modified)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
