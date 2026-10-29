import { useRef } from 'react';
import {
  Apple, BookmarkPlus, Cpu, ExternalLink, Globe, Lock, LockOpen, Monitor, MoreHorizontal, Plug, Plus, Radar, RefreshCw,
  Server, Settings, Share2, Smartphone, Trash2, WifiOff, Laptop, Copy,
} from 'lucide-react';
import type { Peer } from '../api/types';
import { call } from '../api/client';
import { useT } from '../i18n';
import { formatRelative } from '../lib/format';
import { useApp } from '../store/app';
import { openDialog, openSingleton } from '../store/dialogs';
import { useNearby } from '../store/misc';
import { attempt } from '../store/toasts';
import { askConnectPeer, openPeerWebUi, savePeerAsSite } from '../actions/sessions';
import { copyText } from '../actions/fileOps';
import { showContextMenu, type MenuItem } from './Menu';
import { SidebarClose, SidebarSwitch } from './SidebarSwitch';
import { Badge, Button, IconButton, cx } from './ui';

function osIcon(os: string) {
  const o = os.toLowerCase();
  if (o.includes('mac') || o.includes('darwin') || o.includes('ios')) return Apple;
  if (o.includes('win')) return Monitor;
  if (o.includes('android')) return Smartphone;
  if (o.includes('bsd')) return Server;
  if (o.includes('linux')) return Cpu;
  return Laptop;
}

function osLabel(os: string): string {
  const map: Record<string, string> = { linux: 'Linux', macos: 'macOS', darwin: 'macOS', windows: 'Windows', freebsd: 'FreeBSD', android: 'Android', ios: 'iOS' };
  return map[os.toLowerCase()] ?? os;
}

function peerMenu(peer: Peer, t: ReturnType<typeof useT>): MenuItem[] {
  return [
    { label: t('nearby.openWeb'), icon: ExternalLink, disabled: !peer.web || !peer.online, onClick: () => void openPeerWebUi(peer) },
    { label: t('nearby.connectPanel'), icon: Plug, disabled: !peer.web || !peer.online, onClick: () => askConnectPeer(peer) },
    { label: t('nearby.saveSite'), icon: BookmarkPlus, disabled: !peer.web, onClick: () => void savePeerAsSite(peer) },
    { separator: true },
    { label: t('nearby.copyAddress'), icon: Copy, onClick: () => void copyText(peer.web?.url ?? peer.addresses[0] ?? peer.hostname) },
    { label: t('nearby.copyFingerprint'), icon: Lock, hidden: !peer.web?.fingerprint, onClick: () => void copyText(peer.web!.fingerprint!) },
    { separator: true },
    { label: t('nearby.remove'), icon: Trash2, danger: true, hidden: !peer.manual, onClick: () => void attempt(() => call('discovery.remove', { id: peer.id })) },
  ];
}

function PeerCard({ peer }: { peer: Peer }) {
  const t = useT();
  const Icon = osIcon(peer.os);
  const web = peer.web;
  const more = useRef<HTMLButtonElement>(null);
  return (
    <div
      className={cx('peer', !peer.online && 'offline')}
      data-testid="peer"
      onContextMenu={(e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, peerMenu(peer, t));
      }}
      onDoubleClick={() => web && peer.online && askConnectPeer(peer)}
    >
      <div className="peer-head">
        <span className="peer-os" title={osLabel(peer.os)}>
          <Icon size={18} strokeWidth={1.6} />
          <span className={cx('peer-dot', peer.online ? 'on' : 'off')} />
        </span>
        <div className="peer-title">
          <div className="peer-name">
            <span>{peer.name}</span>
            {peer.manual && <Badge tone="muted">{t('nearby.manual')}</Badge>}
          </div>
          <div className="peer-sub" title={peer.addresses.join('\n')}>
            {peer.hostname}
            {peer.user ? ` · ${peer.user}` : ''}
          </div>
        </div>
        <IconButton
          ref={more}
          icon={MoreHorizontal}
          size={15}
          title={t('common.more')}
          onClick={() => {
            const r = more.current!.getBoundingClientRect();
            showContextMenu(r.left, r.bottom + 2, peerMenu(peer, t));
          }}
        />
      </div>
      <div className="peer-meta">
        <span title={peer.addresses.join('\n')} className="mono-soft">
          {peer.addresses[0] ?? '—'}
          {peer.addresses.length > 1 && <span className="muted"> +{peer.addresses.length - 1}</span>}
        </span>
        <span className="muted">
          {osLabel(peer.os)} · v{peer.version}
        </span>
      </div>
      <div className="peer-foot">
        {web ? (
          <Badge tone={web.tls ? 'ok' : 'warn'} title={web.tls ? `${t('nearby.tlsFingerprint')}\n${web.fingerprint ?? '—'}` : t('nearby.noTls')}>
            {web.tls ? <Lock size={10} /> : <LockOpen size={10} />} {t('nearby.webUi')} :{web.port}
          </Badge>
        ) : (
          <Badge tone="muted">{t('nearby.noWeb')}</Badge>
        )}
        {!peer.online && (
          <span className="muted peer-seen">
            <WifiOff size={11} /> {formatRelative(peer.lastSeen)}
          </span>
        )}
        <div className="flex1" />
        {web && peer.online && (
          <>
            <IconButton icon={Globe} size={14} title={t('nearby.openWeb')} onClick={() => void openPeerWebUi(peer)} data-testid="peer-open-web" />
            <IconButton icon={Plug} size={14} title={t('nearby.connectPanel')} onClick={() => askConnectPeer(peer)} data-testid="peer-connect" />
          </>
        )}
      </div>
    </div>
  );
}

function SelfCard({ peer }: { peer: Peer | undefined }) {
  const t = useT();
  const info = useApp((s) => s.info);
  const server = useNearby((s) => s.server);
  const webUi = info?.mode === 'web';
  const Icon = osIcon(info?.os ?? peer?.os ?? '');
  return (
    <div className="peer self" data-testid="self-peer">
      <div className="peer-head">
        <span className="peer-os">
          <Icon size={18} strokeWidth={1.6} />
          <span className="peer-dot on" />
        </span>
        <div className="peer-title">
          <div className="peer-name">
            <span>{info?.instanceName ?? peer?.name}</span>
            <Badge tone="accent">{t('nearby.thisInstance')}</Badge>
          </div>
          <div className="peer-sub">
            {info?.hostname} · {info?.user}
          </div>
        </div>
      </div>
      <div className="peer-share">
        {webUi ? (
          <span className="muted">{t('nearby.viaWeb')}</span>
        ) : server?.running ? (
          <>
            <span className="share-on">
              <Share2 size={12} /> {t('nearby.sharing')}
            </span>
            <span className="mono-soft share-url" title={server.urls.join('\n')}>{server.urls[0]}</span>
            <span className="muted">{t('nearby.clients', { n: server.clients })}</span>
          </>
        ) : (
          <span className="muted">{t('nearby.notSharing')}</span>
        )}
        {!webUi && (
          <Button size="sm" icon={Share2} onClick={() => openSingleton('share', {})} data-testid="share-open">
            {server?.running ? t('share.manage') : t('share.start')}
          </Button>
        )}
      </div>
    </div>
  );
}

export function NearbyView() {
  const t = useT();
  const peers = useNearby((s) => s.peers);
  const discovery = useNearby((s) => s.discovery);
  const refreshing = useNearby((s) => s.refreshing);
  const self = peers.find((p) => p.self);
  const others = peers.filter((p) => !p.self).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));

  const refresh = async () => {
    useNearby.setState({ refreshing: true });
    await attempt(() => call('discovery.refresh'));
    try {
      useNearby.setState({ peers: await call('discovery.peers') });
    } catch {
      /* event will update */
    }
    setTimeout(() => useNearby.setState({ refreshing: false }), 700);
  };

  return (
    <div className="sidebar-view" data-testid="nearby">
      <div className="sidebar-head">
        <SidebarSwitch />
        <div className="flex1" />
        <IconButton icon={RefreshCw} size={14} title={t('nearby.refresh')} className={refreshing ? 'spinning' : undefined} onClick={() => void refresh()} />
        <IconButton icon={Plus} size={15} title={t('nearby.addByAddress')} onClick={() => openDialog('addPeer', {})} />
        <SidebarClose />
      </div>
      <div className="sidebar-status">
        {discovery?.enabled ? (
          <span>
            <span className="peer-dot on inline" /> {t('nearby.discoveryOn', { port: discovery.port })}
          </span>
        ) : (
          <span className="warn">{t('nearby.discoveryOff')}</span>
        )}
        {discovery?.error && <span className="err">{discovery.error}</span>}
        <button type="button" className="link-btn" onClick={() => openSingleton('preferences', { tab: 'discovery' })}>
          <Settings size={11} /> {t('prefs.title')}
        </button>
      </div>
      <div className="sidebar-body">
        <SelfCard peer={self} />
        <div className="sidebar-section">{t('nearby.onNetwork', { n: others.filter((p) => p.online).length })}</div>
        {others.length === 0 ? (
          <div className="sidebar-empty">
            <Radar size={26} strokeWidth={1.3} />
            <p>{t('nearby.none')}</p>
            <Button size="sm" icon={Plus} onClick={() => openDialog('addPeer', {})}>
              {t('nearby.addByAddress')}
            </Button>
          </div>
        ) : (
          others.map((p) => <PeerCard key={p.id} peer={p} />)
        )}
      </div>
    </div>
  );
}
