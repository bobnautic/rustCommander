// Lazy-loaded: pulls in xterm.js only when a terminal is shown.
import { useEffect, useLayoutEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { Plus, SquareTerminal, X } from 'lucide-react';
import { call } from '../../api/client';
import { useT } from '../../i18n';
import { useApp } from '../../store/app';
import { useSkins } from '../../store/skins';
import { terminalTheme } from '../../lib/skins/apply';
import { closeTerminal, registerTerminal, setActiveTerminal, useTerms } from '../../store/terminals';
import { getPanel } from '../../store/panels';
import { openTerminalHere } from '../../actions/fileOps';
import { Button, EmptyState, IconButton, cx } from '../ui';
import { PROTOCOL_ICON } from '../panel/Panel';

/** Terminal colors of the current skin. */
const skinTheme = () => terminalTheme(useSkins.getState().current.tokens);

interface Instance {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
  opened: boolean;
  lastSize: string;
}

const instances = new Map<string, Instance>();
let parking: HTMLDivElement | null = null;
function park(el: HTMLElement) {
  if (!parking) {
    parking = document.createElement('div');
    parking.className = 'term-parking';
    document.body.appendChild(parking);
  }
  parking.appendChild(el);
}

function getInstance(id: string): Instance {
  let inst = instances.get(id);
  if (inst) return inst;
  const ts = useApp.getState().settings?.terminal;
  const term = new Terminal({
    fontFamily: ts?.fontFamily || 'ui-monospace, Menlo, Consolas, monospace',
    fontSize: ts?.fontSize || 13,
    scrollback: ts?.scrollback || 5000,
    cursorBlink: true,
    allowProposedApi: false,
    theme: skinTheme(),
    convertEol: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const el = document.createElement('div');
  el.className = 'term-host';
  inst = { term, fit, el, opened: false, lastSize: '' };
  instances.set(id, inst);
  term.onData((data) => {
    const tab = useTerms.getState().tabs.find((t) => t.id === id);
    if (!tab || tab.exited) return;
    void call('terminal.write', { id, data }).catch(() => undefined);
  });
  term.onResize(({ cols, rows }) => {
    const key = `${cols}x${rows}`;
    if (inst!.lastSize === key) return;
    inst!.lastSize = key;
    void call('terminal.resize', { id, cols, rows }).catch(() => undefined);
  });
  registerTerminal(
    id,
    (bytes) => term.write(bytes),
    () => {
      term.dispose();
      el.remove();
      instances.delete(id);
    },
  );
  return inst;
}

// keep terminal colors and fonts in sync with the skin and the settings
useSkins.subscribe((s, prev) => {
  if (s.current.tokens === prev.current.tokens) return;
  const theme = terminalTheme(s.current.tokens);
  for (const inst of instances.values()) inst.term.options.theme = theme;
});
useApp.subscribe((s, prev) => {
  if (s.settings?.terminal === prev.settings?.terminal) return;
  for (const inst of instances.values()) {
    if (s.settings?.terminal) {
      inst.term.options.fontSize = s.settings.terminal.fontSize;
      inst.term.options.fontFamily = s.settings.terminal.fontFamily;
    }
  }
});

function XtermPane({ id, visible }: { id: string; visible: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const inst = getInstance(id);
    const container = host.current!;
    container.appendChild(inst.el);
    if (!inst.opened) {
      inst.term.open(inst.el);
      inst.opened = true;
    }
    const ro = new ResizeObserver(() => {
      if (container.clientWidth > 20 && container.clientHeight > 20) {
        try {
          inst.fit.fit();
        } catch {
          /* not measurable yet */
        }
      }
    });
    ro.observe(container);
    return () => {
      ro.disconnect();
      if (instances.has(id)) park(inst.el);
    };
  }, [id]);
  useEffect(() => {
    if (!visible) return;
    const inst = instances.get(id);
    if (!inst) return;
    requestAnimationFrame(() => {
      try {
        inst.fit.fit();
      } catch {
        /* ignore */
      }
      inst.term.focus();
    });
  }, [visible, id]);
  return <div ref={host} className={cx('term-pane', !visible && 'hidden')} data-testid={`terminal-${id}`} />;
}

export default function TerminalView() {
  const t = useT();
  const tabs = useTerms((s) => s.tabs);
  const active = useTerms((s) => s.active);
  const sessions = useApp((s) => s.sessions);

  if (!tabs.length) {
    return (
      <EmptyState
        icon={SquareTerminal}
        title={t('terminal.none')}
        action={
          <Button size="sm" icon={Plus} onClick={() => openTerminalHere(useApp.getState().activeSide)} data-testid="terminal-new">
            {t('terminal.open')}
          </Button>
        }
      >
        {t('terminal.noneHint')}
      </EmptyState>
    );
  }
  return (
    <div className="terminals">
      <div className="term-tabs">
        {tabs.map((tab) => {
          const s = sessions.find((x) => x.id === tab.session);
          const Icon = PROTOCOL_ICON[s?.protocol ?? 'local'];
          return (
            <div key={tab.id} className={cx('term-tab', tab.id === active && 'on', tab.exited && 'exited')} onClick={() => setActiveTerminal(tab.id)} title={tab.title}>
              <Icon size={12} />
              <span>{tab.title}</span>
              <button type="button" className="term-tab-close" onClick={(e) => { e.stopPropagation(); void closeTerminal(tab.id); }} aria-label={t('common.close')}>
                <X size={11} />
              </button>
            </div>
          );
        })}
        <IconButton icon={Plus} size={14} title={t('terminal.new')} onClick={() => openTerminalHere(useApp.getState().activeSide)} />
        <div className="flex1" />
        <span className="muted term-hint">{getPanel(useApp.getState().activeSide).path}</span>
      </div>
      <div className="term-panes">
        {tabs.map((tab) => (
          <XtermPane key={tab.id} id={tab.id} visible={tab.id === active} />
        ))}
      </div>
    </div>
  );
}
