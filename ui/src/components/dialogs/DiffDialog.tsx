import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Columns2, GitCompare, Rows2 } from 'lucide-react';
import { call } from '../../api/client';
import { normalizeError } from '../../api/errors';
import { useT } from '../../i18n';
import { detectEol, splitBom } from '../../lib/editor/detect';
import { load, save } from '../../lib/storage';
import { sessionById } from '../../store/app';
import type { DialogPropsMap, DiffSide } from '../../store/dialogs';
import { MAX_TEXT } from '../../store/editors';
import { DiffView, type DiffNav } from '../editor/DiffView';
import { Badge, Button, Checkbox, Dialog, EmptyState, IconButton, Segmented, Spinner } from '../ui';
import { SessionDot } from '../panel/Panel';

interface Loaded {
  text: string;
  eol: string;
}

async function loadSide(s: DiffSide): Promise<Loaded> {
  let raw = s.text;
  if (raw === undefined) {
    const r = await call('fs.readText', { session: s.session!, path: s.path!, maxBytes: MAX_TEXT });
    if (r.binary) throw new Error('binary');
    raw = r.content;
  }
  const { text } = splitBom(raw);
  const { eol, mixed } = detectEol(text);
  return { text: text.replace(/\r\n?/g, '\n'), eol: mixed ? 'mixed' : eol === '\r\n' ? 'CRLF' : 'LF' };
}

function SideLabel({ side }: { side: DiffSide }) {
  const s = side.session ? sessionById(side.session) : undefined;
  return (
    <div className="diff-side-label" title={side.path ?? side.label}>
      {s && <SessionDot color={s.color} />}
      <span className="ellipsis">{side.label}</span>
    </div>
  );
}

export default function DiffDialog({ props, close }: { props: DialogPropsMap['diff']; close: () => void }) {
  const t = useT();
  const [sides, setSides] = useState<[Loaded, Loaded] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'split' | 'unified'>(() => load('diffMode', window.innerWidth < 900 ? 'unified' : 'split'));
  const [collapse, setCollapse] = useState(true);
  const [chunks, setChunks] = useState(0);
  const nav = useRef<DiffNav | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([loadSide(props.left), loadSide(props.right)]).then(
      (r) => alive && setSides(r),
      (e) => alive && setError(e instanceof Error && e.message === 'binary' ? t('diff.binary') : normalizeError(e).message),
    );
    return () => {
      alive = false;
    };
  }, [props.left, props.right, t]);

  const identical = sides && sides[0].text === sides[1].text;
  return (
    <Dialog
      title={props.title ?? t('diff.title', { name: props.right.fileName })}
      icon={GitCompare}
      onClose={close}
      width={1400}
      className="diff-dialog"
      layer={props.top ? 'top' : 'normal'}
      bodyClassName="diff-body"
      noEnterSubmit
      headerExtra={
        sides && !identical ? (
          <span className="row gap-sm">
            <Badge tone="warn">{t('diff.changes', { n: chunks })}</Badge>
            <IconButton icon={ArrowUp} title={t('diff.prev')} onClick={() => nav.current?.prev()} />
            <IconButton icon={ArrowDown} title={t('diff.next')} onClick={() => nav.current?.next()} data-testid="diff-next" />
          </span>
        ) : undefined
      }
      footer={
        <>
          <div className="dlg-foot-extra row gap">
            <Segmented
              size="sm"
              value={mode}
              onChange={(m) => {
                setMode(m);
                save('diffMode', m);
              }}
              options={[
                { value: 'split', label: t('diff.split'), icon: Columns2 },
                { value: 'unified', label: t('diff.unified'), icon: Rows2 },
              ]}
            />
            <Checkbox label={t('diff.collapse')} checked={collapse} onChange={setCollapse} />
          </div>
          <div className="dlg-foot-buttons">
            <Button variant="primary" onClick={close}>
              {t('common.close')}
            </Button>
          </div>
        </>
      }
    >
      <div className="diff-labels">
        <SideLabel side={props.left} />
        <SideLabel side={props.right} />
      </div>
      {error ? (
        <EmptyState icon={GitCompare} title={t('diff.failed')}>
          {error}
        </EmptyState>
      ) : !sides ? (
        <div className="center-fill">
          <Spinner />
        </div>
      ) : (
        <>
          {identical && <div className="diff-note ok" data-testid="diff-identical">{t('diff.identical')}</div>}
          {sides[0].eol !== sides[1].eol && <div className="diff-note">{t('diff.eolDiffers', { a: sides[0].eol, b: sides[1].eol })}</div>}
          <DiffView a={sides[0].text} b={sides[1].text} fileName={props.right.fileName} mode={mode} collapse={collapse} onChunks={setChunks} navRef={nav} />
        </>
      )}
    </Dialog>
  );
}
