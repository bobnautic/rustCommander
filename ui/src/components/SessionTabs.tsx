import { Info, Loader2, Plus, Repeat, Unplug, X, Copy } from 'lucide-react';
import { useT } from '../i18n';
import { useApp } from '../store/app';
import { remoteSide, switchSession, usePanels } from '../store/panels';
import { closeSession, connect, openSiteManager, reconnectSession, showSessionInfo, useConnecting } from '../actions/sessions';
import { showContextMenu } from './Menu';
import { PROTOCOL_ICON } from './panel/Panel';
import { cx } from './ui';
import { copyText } from '../actions/fileOps';
import { usePanelDrag } from './panel/panelDrag';

export function SessionTabs() {
  const t = useT();
  const sessions = useApp((s) => s.sessions);
  const left = usePanels((s) => s.left.session);
  const right = usePanels((s) => s.right.session);
  const connecting = useConnecting((s) => s.items);
  const dropSession = usePanelDrag((s) => (s.drag?.target?.kind === 'session' ? s.drag.target.session : null));
  const remotes = sessions.filter((s) => s.id !== 'local');

  return (
    <div className="session-tabs" role="tablist" aria-label={t('session.tabs')}>
      {remotes.map((s) => {
        const Icon = PROTOCOL_ICON[s.protocol];
        const shown = left === s.id || right === s.id;
        return (
          <div
            key={s.id}
            role="tab"
            aria-selected={shown}
            tabIndex={0}
            className={cx('session-tab', shown && 'on', dropSession === s.id && 'drop-target')}
            data-session-tab={s.id}
            style={s.color ? { ['--tab-color' as string]: s.color } : undefined}
            title={`${s.url}\n${s.username ? s.username + '@' : ''}${s.host}`}
            data-testid="session-tab"
            onClick={() => void switchSession(remoteSide(), s.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                void switchSession(remoteSide(), s.id);
              }
            }}
            onAuxClick={(e) => {
              if (e.button === 1) void closeSession(s.id);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              showContextMenu(e.clientX, e.clientY, [
                { label: t('session.showLeft'), onClick: () => void switchSession('left', s.id) },
                { label: t('session.showRight'), onClick: () => void switchSession('right', s.id) },
                { separator: true },
                { label: t('session.info'), icon: Info, onClick: () => showSessionInfo(s.id) },
                { label: t('session.reconnect'), icon: Repeat, onClick: () => void reconnectSession(s.id) },
                { label: t('session.duplicate'), icon: Copy, hidden: !s.siteId, onClick: () => void connect({ siteId: s.siteId! }, s.name) },
                { label: t('session.copyUrl'), onClick: () => void copyText(s.url) },
                { separator: true },
                { label: t('session.close'), icon: Unplug, danger: true, onClick: () => void closeSession(s.id) },
              ]);
            }}
          >
            <span className="session-tab-color" />
            <Icon size={14} className="session-tab-icon" />
            <span className="session-tab-name">{s.name}</span>
            <button
              type="button"
              className="session-tab-close"
              title={t('session.close')}
              aria-label={t('session.close')}
              onClick={(e) => {
                e.stopPropagation();
                void closeSession(s.id);
              }}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
      {connecting.map((c) => (
        <div key={c.id} className="session-tab connecting" title={t('session.connecting', { name: c.label })}>
          <Loader2 size={13} className="spin" />
          <span className="session-tab-name">{c.label}</span>
        </div>
      ))}
      <button type="button" className="session-tab-add" onClick={() => openSiteManager()} title={t('session.newSession')} data-testid="tab-add">
        <Plus size={14} />
        {remotes.length === 0 && connecting.length === 0 && <span>{t('session.newSession')}</span>}
      </button>
    </div>
  );
}
