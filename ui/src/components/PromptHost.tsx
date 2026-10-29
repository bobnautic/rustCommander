import { useState } from 'react';
import { FileWarning, KeyRound, LockKeyhole, MessageSquare, ShieldAlert, ShieldCheck, ShieldQuestion, UserRound } from 'lucide-react';
import type { PendingPrompt, PromptResponse } from '../api/types';
import { call } from '../api/client';
import { useT } from '../i18n';
import { removePrompt, usePrompts } from '../store/misc';
import { toast } from '../store/toasts';
import { copyText } from '../actions/fileOps';
import { Button, Checkbox, Dialog, Field, TextInput } from './ui';

async function respond(id: string, response: PromptResponse | null) {
  removePrompt(id);
  try {
    await call('prompt.respond', { id, response });
  } catch (e) {
    toast.error(e);
  }
}

function Fingerprint({ value, label }: { value: string; label: string }) {
  const t = useT();
  return (
    <div className="fp">
      <span className="fp-label">{label}</span>
      <code className="fp-value" title={t('common.clickToCopy')} onClick={() => void copyText(value)}>
        {value}
      </code>
    </div>
  );
}

function PromptDialog({ p, queued }: { p: PendingPrompt; queued: number }) {
  const t = useT();
  const r = p.request;
  const [values, setValues] = useState<string[]>(() => (r.kind === 'keyboard_interactive' ? r.prompts.map(() => '') : ['']));
  const [remember, setRemember] = useState(false);
  const setVal = (i: number, v: string) => setValues((arr) => arr.map((x, j) => (j === i ? v : x)));
  const ok = (extra: Partial<PromptResponse> = {}) => void respond(p.id, { accepted: true, values, remember, ...extra });
  const cancel = () => void respond(p.id, null);
  const queueNote = queued > 1 ? <span className="muted prompt-queue">{t('prompt.queued', { n: queued - 1 })}</span> : undefined;

  switch (r.kind) {
    case 'host_key':
    case 'certificate': {
      const changed = r.state === 'changed';
      const isCert = r.kind === 'certificate';
      return (
        <Dialog
          layer="top"
          tone={changed ? 'danger' : undefined}
          width={560}
          icon={changed ? ShieldAlert : ShieldQuestion}
          title={changed ? (isCert ? t('prompt.certChangedTitle') : t('prompt.hostKeyChangedTitle')) : isCert ? t('prompt.certTitle') : t('prompt.hostKeyTitle')}
          onClose={cancel}
          onSubmit={() => (changed ? undefined : ok({ remember: true }))}
          headerExtra={queueNote}
          footer={
            <div className="dlg-foot-buttons">
              {changed ? (
                <>
                  <Button variant="primary" onClick={cancel} data-autofocus>
                    {t('prompt.disconnect')}
                  </Button>
                  <Button variant="danger" onClick={() => ok({ remember: true })}>
                    {t('prompt.updateKey')}
                  </Button>
                  <Button onClick={() => ok({ remember: false })}>{t('prompt.acceptOnce')}</Button>
                </>
              ) : (
                <>
                  <Button variant="primary" onClick={() => ok({ remember: true })} data-testid="prompt-accept-save">
                    {t('prompt.acceptSave')}
                  </Button>
                  <Button onClick={() => ok({ remember: false })} data-testid="prompt-accept-once">
                    {t('prompt.acceptOnce')}
                  </Button>
                  <Button onClick={cancel}>{t('common.cancel')}</Button>
                </>
              )}
            </div>
          }
        >
          {changed ? (
            <div className="mitm">
              <ShieldAlert size={28} />
              <div>
                <strong>{t('prompt.mitmHeadline')}</strong>
                <p>{isCert ? t('prompt.certChangedText', { host: r.host }) : t('prompt.hostKeyChangedText', { host: r.host })}</p>
              </div>
            </div>
          ) : (
            <p className="prompt-text">{isCert ? t('prompt.certText', { host: r.host }) : t('prompt.hostKeyText', { host: r.host })}</p>
          )}
          <div className="kv">
            <span>{t('prompt.server')}</span>
            <span className="mono">
              {r.host}:{r.port}
            </span>
            {r.kind === 'host_key' && (
              <>
                <span>{t('prompt.keyType')}</span>
                <span className="mono">{r.keyType}</span>
              </>
            )}
            {r.kind === 'certificate' && (
              <>
                <span>{t('prompt.subject')}</span>
                <span className="mono">{r.subject}</span>
                <span>{t('prompt.issuer')}</span>
                <span className="mono">{r.issuer}</span>
                <span>{t('prompt.reason')}</span>
                <span>{r.reason}</span>
              </>
            )}
          </div>
          <Fingerprint label={changed ? t('prompt.newFingerprint') : t('prompt.fingerprint')} value={r.fingerprint} />
          {r.kind === 'host_key' && changed && r.previousFingerprint && <Fingerprint label={t('prompt.oldFingerprint')} value={r.previousFingerprint} />}
          {!changed && (
            <p className="muted small">
              <ShieldCheck size={12} /> {t('prompt.verifyHint')}
            </p>
          )}
        </Dialog>
      );
    }
    case 'password':
    case 'passphrase':
    case 'username': {
      const isUser = r.kind === 'username';
      return (
        <Dialog
          layer="top"
          width={420}
          icon={isUser ? UserRound : r.kind === 'passphrase' ? KeyRound : LockKeyhole}
          title={isUser ? t('prompt.usernameTitle') : r.kind === 'passphrase' ? t('prompt.passphraseTitle') : t('prompt.passwordTitle')}
          onClose={cancel}
          onSubmit={() => ok()}
          headerExtra={queueNote}
          footer={
            <div className="dlg-foot-buttons">
              <Button type="submit" variant="primary" data-testid="prompt-ok">
                {t('common.ok')}
              </Button>
              <Button onClick={cancel}>{t('common.cancel')}</Button>
            </div>
          }
        >
          <p className="prompt-text">
            {r.kind === 'password' ? r.message || t('prompt.passwordFor', { user: r.username, host: r.host }) : r.kind === 'passphrase' ? t('prompt.passphraseFor', { path: r.keyPath }) : t('prompt.usernameFor', { host: r.host })}
          </p>
          <Field label={isUser ? t('site.username') : r.kind === 'passphrase' ? t('site.passphrase') : t('site.password')}>
            <TextInput type={isUser ? 'text' : 'password'} value={values[0]} onChange={(e) => setVal(0, e.target.value)} data-autofocus autoComplete={isUser ? 'username' : 'current-password'} data-testid="prompt-input" />
          </Field>
          {!isUser && <Checkbox label={r.kind === 'passphrase' ? t('prompt.rememberPassphrase') : t('prompt.rememberPassword')} checked={remember} onChange={setRemember} />}
        </Dialog>
      );
    }
    case 'keyboard_interactive':
      return (
        <Dialog
          layer="top"
          width={440}
          icon={KeyRound}
          title={r.name || t('prompt.kbdTitle')}
          onClose={cancel}
          onSubmit={() => ok()}
          headerExtra={queueNote}
          footer={
            <div className="dlg-foot-buttons">
              <Button type="submit" variant="primary">
                {t('common.ok')}
              </Button>
              <Button onClick={cancel}>{t('common.cancel')}</Button>
            </div>
          }
        >
          <p className="prompt-text">{r.instructions || t('prompt.kbdText', { host: r.host })}</p>
          {r.prompts.map((q, i) => (
            <Field key={i} label={q.text}>
              <TextInput type={q.echo ? 'text' : 'password'} value={values[i] ?? ''} onChange={(e) => setVal(i, e.target.value)} data-autofocus={i === 0 ? true : undefined} />
            </Field>
          ))}
        </Dialog>
      );
    case 'banner':
      return (
        <Dialog
          layer="top"
          width={520}
          icon={MessageSquare}
          title={t('prompt.bannerTitle', { host: r.host })}
          onClose={() => void respond(p.id, { accepted: false, values: [], remember: false })}
          onSubmit={() => ok()}
          footer={
            <div className="dlg-foot-buttons">
              <Button type="submit" variant="primary">
                {t('prompt.continue')}
              </Button>
              <Button onClick={() => void respond(p.id, { accepted: false, values: [], remember: false })}>{t('prompt.disconnect')}</Button>
            </div>
          }
        >
          <pre className="banner-text">{r.message}</pre>
        </Dialog>
      );
    case 'confirm':
      return (
        <Dialog
          layer="top"
          width={440}
          icon={FileWarning}
          title={r.title}
          onClose={() => void respond(p.id, { accepted: false, values: [], remember: false })}
          onSubmit={() => ok()}
          footer={
            <div className="dlg-foot-buttons">
              <Button type="submit" variant="primary">
                {t('common.yes')}
              </Button>
              <Button onClick={() => void respond(p.id, { accepted: false, values: [], remember: false })}>{t('common.no')}</Button>
            </div>
          }
        >
          <p className="prompt-text pre-wrap">{r.message}</p>
        </Dialog>
      );
    default:
      return null;
  }
}

export function PromptHost() {
  const queue = usePrompts((s) => s.queue);
  if (!queue.length) return null;
  const p = queue[0];
  return <PromptDialog key={p.id} p={p} queued={queue.length} />;
}
