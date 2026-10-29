import { useState } from 'react';
import { LogIn, ShieldCheck } from 'lucide-react';
import { mode, webLogin, type WebInfo } from '../api/client';
import { useT } from '../i18n';
import { Button, TextInput } from './ui';

export function LoginScreen({ info, onLoggedIn }: { info: WebInfo | null; onLoggedIn: () => void }) {
  const t = useT();
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!pw || busy) return;
    setBusy(true);
    setError('');
    try {
      if (await webLogin(pw)) onLoggedIn();
      else setError(t('login.wrong'));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-screen">
      <form
        className="login-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <svg viewBox="0 0 64 64" width="52" height="52" aria-hidden>
          <rect x="4" y="4" width="56" height="56" rx="13" fill="var(--brand)" />
          <rect x="13" y="16" width="17" height="32" rx="3" fill="#fff" opacity=".95" />
          <rect x="34" y="16" width="17" height="32" rx="3" fill="#fff" opacity=".7" />
        </svg>
        <h1>Rust Commander</h1>
        <p className="muted">{t('login.subtitle', { name: info?.name ?? '…' })}</p>
        <label className="field-label" htmlFor="login-pw">
          {t('login.password')}
        </label>
        <TextInput id="login-pw" type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" data-testid="login-password" />
        {error && <div className="err small">{error}</div>}
        <Button type="submit" variant="primary" icon={LogIn} busy={busy} disabled={!pw}>
          {t('login.submit')}
        </Button>
        <p className="muted small login-foot">
          <ShieldCheck size={12} /> {window.location.protocol === 'https:' ? t('login.secure') : t('login.insecure')}
          {info?.version ? ` · v${info.version}` : ''}
          {mode === 'mock' ? ` · ${t('vault.demoHint')}` : ''}
        </p>
      </form>
    </div>
  );
}
