import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ClipboardCopy, Eraser, ScrollText } from 'lucide-react';
import type { LogLevel } from '../../api/types';
import { useT } from '../../i18n';
import { formatTime } from '../../lib/format';
import { useApp } from '../../store/app';
import { clearLog, useLog } from '../../store/misc';
import { copyText } from '../../actions/fileOps';
import { Button, EmptyState, IconButton, Select, cx } from '../ui';

const LEVELS: LogLevel[] = ['error', 'warn', 'info', 'debug'];

export function LogView() {
  const t = useT();
  const entries = useLog((s) => s.entries);
  const sessions = useApp((s) => s.sessions);
  const [minLevel, setMinLevel] = useState<LogLevel>('info');
  const [session, setSession] = useState<string>('');
  const [follow, setFollow] = useState(true);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    useLog.setState({ unseenErrors: 0 });
  }, [entries.length]);

  const filtered = useMemo(() => {
    const maxIdx = LEVELS.indexOf(minLevel);
    return entries.filter((e) => LEVELS.indexOf(e.level) <= maxIdx && (!session || e.session === session || (session === '-' && !e.session))).slice(-1500);
  }, [entries, minLevel, session]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [filtered, follow]);

  const name = (id?: string | null) => (id ? (sessions.find((s) => s.id === id)?.name ?? id) : '');

  return (
    <div className="logview">
      <div className="dock-toolbar">
        <Select value={minLevel} onChange={(e) => setMinLevel(e.target.value as LogLevel)} aria-label={t('log.level')} className="select-sm">
          {LEVELS.map((l) => (
            <option key={l} value={l}>
              {t(`log.min.${l}`)}
            </option>
          ))}
        </Select>
        <Select value={session} onChange={(e) => setSession(e.target.value)} aria-label={t('log.session')} className="select-sm">
          <option value="">{t('log.allSessions')}</option>
          <option value="-">{t('log.general')}</option>
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id === 'local' ? t('session.local') : s.name}
            </option>
          ))}
        </Select>
        <div className="flex1" />
        <IconButton icon={ArrowDownToLine} title={t('log.autoScroll')} active={follow} onClick={() => setFollow(!follow)} />
        <IconButton icon={ClipboardCopy} title={t('log.copy')} onClick={() => void copyText(filtered.map((e) => `${formatTime(e.ts)} ${e.level.toUpperCase()} ${name(e.session)} ${e.message}`).join('\n'), t('log.copied', { n: filtered.length }))} />
        <Button size="sm" variant="ghost" icon={Eraser} onClick={clearLog}>
          {t('common.clear')}
        </Button>
      </div>
      <div
        className="log-list"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
          if (atBottom !== follow) setFollow(atBottom);
        }}
      >
        {filtered.length === 0 ? (
          <EmptyState icon={ScrollText} title={t('log.empty')} />
        ) : (
          filtered.map((e, i) => (
            <div key={i} className={cx('log-row', `log-${e.level}`)}>
              <span className="log-time">{formatTime(e.ts)}</span>
              <span className={cx('log-level', `lv-${e.level}`)}>{e.level}</span>
              {e.session && <span className="log-session">{name(e.session)}</span>}
              <span className="log-msg">{e.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
