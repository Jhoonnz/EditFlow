import { FormEvent, useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { ArrowLeft, Download, LoaderCircle, RotateCw, X } from 'lucide-react';
import { isSupabaseConfigured, supabase } from './lib/supabase';
import { watchThemePreference } from './lib/theme';
import { parseAuthRecoveryCallback } from './lib/authRecovery';
import { AuthenticatedApp } from './features/workspace/AuthenticatedApp';

type AuthMode = 'signin' | 'signup' | 'forgot' | 'recovery';
type Notice = { kind: 'error' | 'success' | 'info'; message: string } | null;

function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionLoading, setSessionLoading] = useState(isSupabaseConfigured);
  const [themePreference, setThemePreference] = useState<EditFlowDesktopPreferences['theme']>('light');
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [authCallbackNotice, setAuthCallbackNotice] = useState<Notice>(null);
  const handledAuthCallbacks = useRef(new Set<string>());

  useEffect(() => {
    void window.editflow.getDesktopPreferences().then((preferences) => setThemePreference(preferences.theme));
    return window.editflow.onDesktopPreferencesChanged((preferences) => setThemePreference(preferences.theme));
  }, []);

  useEffect(() => watchThemePreference(themePreference), [themePreference]);

  useEffect(() => {
    if (!supabase) return;

    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setSessionLoading(false);
    });

    const { data } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession);
      setSessionLoading(false);
      if (event === 'PASSWORD_RECOVERY') setRecoveryMode(true);
    });

    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!supabase || !window.editflow?.onAuthCallback) return;
    const client = supabase;
    const handleCallback = async (rawUrl: string | null) => {
      if (!rawUrl || handledAuthCallbacks.current.has(rawUrl)) return;
      handledAuthCallbacks.current.add(rawUrl);
      try {
        const { code, accessToken, refreshToken } = parseAuthRecoveryCallback(rawUrl);
        if (code) {
          const { error } = await client.auth.exchangeCodeForSession(code);
          if (error) throw error;
        } else if (accessToken && refreshToken) {
          const { error } = await client.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
          if (error) throw error;
        }
        setAuthCallbackNotice(null);
        setRecoveryMode(true);
      } catch (error) {
        setAuthCallbackNotice({ kind: 'error', message: translateAuthError(error instanceof Error ? error.message : 'Link de recuperação inválido.') });
      } finally {
        setSessionLoading(false);
      }
    };

    const unsubscribe = window.editflow.onAuthCallback((url) => void handleCallback(url));
    void window.editflow.getPendingAuthCallback().then((url) => void handleCallback(url));
    return unsubscribe;
  }, []);

  if (sessionLoading) {
    return (
      <>
        <main className="loading-screen">
          <LoaderCircle className="spinner" size={28} />
        </main>
        <UpdateNotice />
      </>
    );
  }

  if (recoveryMode) {
    return (
      <>
        <AuthScreen recoveryMode onRecoveryComplete={() => setRecoveryMode(false)} initialNotice={authCallbackNotice} />
        <UpdateNotice />
      </>
    );
  }

  if (session) {
    return (
      <>
        <AuthenticatedApp user={session.user} />
        <UpdateNotice />
      </>
    );
  }

  return (
    <>
      <AuthScreen initialNotice={authCallbackNotice} />
      <UpdateNotice />
    </>
  );
}

function UpdateNotice() {
  const [status, setStatus] = useState<EditFlowUpdateStatus | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    if (!window.editflow?.onUpdateStatus) return;
    return window.editflow.onUpdateStatus((nextStatus) => {
      setStatus(nextStatus);
      setShowDetails(false);
    });
  }, []);

  useEffect(() => {
    if (status?.state !== 'up-to-date') return;
    const timeout = window.setTimeout(() => setStatus(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [status]);

  if (!status) return null;

  const isBusy = status.state === 'checking' || status.state === 'available' || status.state === 'downloading';
  const title = status.state === 'checking'
    ? 'Procurando atualizações'
    : status.state === 'available'
      ? `Versão ${status.version} encontrada`
      : status.state === 'downloading'
        ? `Baixando versão ${status.version ?? 'nova'}`
        : status.state === 'downloaded'
          ? `Versão ${status.version} pronta`
          : status.state === 'up-to-date'
            ? 'EditFlow está atualizado'
            : 'Não foi possível atualizar';

  return (
    <aside className={`update-notice ${status.state}`} role="status" aria-live="polite">
      <div className="update-icon">
        {isBusy ? <LoaderCircle className="spinner" size={18} /> : status.state === 'downloaded' ? <Download size={18} /> : <RotateCw size={18} />}
      </div>
      <div className="update-copy">
        <strong>{title}</strong>
        {status.state === 'checking' ? <span>Isso leva apenas alguns segundos.</span> : null}
        {status.state === 'available' ? <span>O download começará automaticamente.</span> : null}
        {status.state === 'downloading' ? (
          <>
            <span>{status.percent}% concluído</span>
            <div className="update-progress"><i style={{ width: `${status.percent}%` }} /></div>
          </>
        ) : null}
        {status.state === 'downloaded' ? <span>A atualização será aplicada automaticamente e o EditFlow abrirá novamente.</span> : null}
        {status.state === 'up-to-date' ? <span>Você está usando a versão {status.version}.</span> : null}
        {status.state === 'error' ? (
          <>
            <span>Abra os detalhes para identificar a causa.</span>
            <div className="update-error-actions">
              <button type="button" onClick={() => setShowDetails((show) => !show)}>{showDetails ? 'Ocultar detalhes' : 'Ver detalhes'}</button>
              <button type="button" onClick={() => void window.editflow.checkForUpdates()}>Tentar novamente</button>
              <button type="button" onClick={() => void window.editflow.showUpdateLog()}>Abrir log</button>
            </div>
            {showDetails ? <code className="update-error-detail">{status.message}</code> : null}
          </>
        ) : null}
      </div>
      {status.state === 'downloaded' ? (
        <button className="update-install" type="button" onClick={() => void window.editflow.installUpdate()}>
          Atualizar agora
        </button>
      ) : null}
      {!isBusy && status.state !== 'downloaded' ? (
        <button className="update-close" type="button" aria-label="Fechar aviso" onClick={() => setStatus(null)}>
          <X size={15} />
        </button>
      ) : null}
    </aside>
  );
}

function AuthScreen({ recoveryMode = false, onRecoveryComplete, initialNotice = null }: {
  recoveryMode?: boolean;
  onRecoveryComplete?: () => void;
  initialNotice?: Notice;
}) {
  const [mode, setMode] = useState<AuthMode>(recoveryMode ? 'recovery' : 'signin');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<Notice>(initialNotice);

  useEffect(() => setNotice(initialNotice), [initialNotice]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setNotice(null);

    if (!supabase) {
      setNotice({ kind: 'info', message: 'Configure as credenciais do Supabase no arquivo .env.' });
      return;
    }

    if (mode !== 'recovery' && !email.trim()) {
      setNotice({ kind: 'error', message: 'Digite seu e-mail para continuar.' });
      return;
    }

    setSubmitting(true);
    try {
      if (mode === 'forgot') {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: 'editflow://auth/recovery',
        });
        if (error) throw error;
        setNotice({ kind: 'success', message: 'Enviamos as instruções. Abra o link neste computador para voltar ao EditFlow.' });
        return;
      }

      if (!password) {
        setNotice({ kind: 'error', message: 'Digite sua senha para continuar.' });
        return;
      }

      if (mode === 'recovery') {
        if (password.length < 6) {
          setNotice({ kind: 'error', message: 'A nova senha precisa ter pelo menos 6 caracteres.' });
          return;
        }
        if (password !== confirmPassword) {
          setNotice({ kind: 'error', message: 'As senhas não são iguais.' });
          return;
        }
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
        setNotice({ kind: 'success', message: 'Senha atualizada com sucesso.' });
        window.setTimeout(() => onRecoveryComplete?.(), 700);
        return;
      }

      if (mode === 'signup') {
        if (fullName.trim().length < 2) {
          setNotice({ kind: 'error', message: 'Digite seu nome para criar a conta.' });
          return;
        }
        if (password.length < 6) {
          setNotice({ kind: 'error', message: 'A senha precisa ter pelo menos 6 caracteres.' });
          return;
        }
        if (password !== confirmPassword) {
          setNotice({ kind: 'error', message: 'As senhas não são iguais.' });
          return;
        }

        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { full_name: fullName.trim() } },
        });
        if (error) throw error;
        if (!data.session) {
          setMode('signin');
          setPassword('');
          setConfirmPassword('');
          setNotice({ kind: 'success', message: 'Conta criada. Confirme seu e-mail e depois entre no EditFlow.' });
        }
        return;
      }

      const { error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (error) throw error;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Não foi possível concluir o acesso.';
      setNotice({ kind: 'error', message: translateAuthError(message) });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="liquid-page">
      <div className="color-cloud cloud-blue" />
      <div className="color-cloud cloud-pink" />
      <div className="color-cloud cloud-violet" />
      <div className="page-noise" />

      <section className="liquid-card" aria-label="Login do EditFlow">
        <div className="liquid-shine" />

        {mode === 'forgot' ? (
          <button className="back-button" type="button" onClick={() => { setMode('signin'); setNotice(null); }}>
            <ArrowLeft size={17} /> Voltar
          </button>
        ) : null}

        <header className="login-heading">
          <h1>{mode === 'signin' ? 'Welcome Back' : mode === 'signup' ? 'Create Account' : mode === 'recovery' ? 'Create New Password' : 'Reset Password'}</h1>
          <p>
            {mode === 'signin'
              ? 'Sign in to your account to continue'
              : mode === 'signup'
                ? 'Create your account to start editing'
                : mode === 'recovery'
                  ? 'Choose a secure password for your account'
                  : 'Enter your email to receive instructions'}
          </p>
        </header>

        <form className="login-form" onSubmit={handleSubmit} noValidate>
          {mode === 'signup' ? (
            <label className="plain-field">
              <span>Full Name</span>
              <input type="text" autoComplete="name" value={fullName} onChange={(event) => setFullName(event.target.value)} placeholder="Enter your name" />
            </label>
          ) : null}

          {mode !== 'recovery' ? <label className="plain-field">
            <span>Email Address</span>
            <input
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="Enter your email"
            />
          </label> : null}

          {mode !== 'forgot' ? (
            <label className="plain-field">
              <span>Password</span>
              <input
                type="password"
                autoComplete={mode === 'signup' || mode === 'recovery' ? 'new-password' : 'current-password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter your password"
              />
            </label>
          ) : null}

          {mode === 'signup' || mode === 'recovery' ? (
            <label className="plain-field">
              <span>Confirm Password</span>
              <input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Enter your password again" />
            </label>
          ) : null}

          {notice ? <div className={`notice ${notice.kind}`} role="status">{notice.message}</div> : null}

          <button className="sign-in-button" type="submit" disabled={submitting}>
            {submitting ? <LoaderCircle className="spinner" size={20} /> : mode === 'signin' ? 'Sign In' : mode === 'signup' ? 'Create Account' : mode === 'recovery' ? 'Save New Password' : 'Send Instructions'}
          </button>
        </form>

        {mode !== 'forgot' && mode !== 'recovery' ? (
          <p className="auth-switch">
            {mode === 'signin' ? 'Ainda não possui uma conta?' : 'Já possui uma conta?'}
            <button type="button" onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setNotice(null); setPassword(''); setConfirmPassword(''); }}>
              {mode === 'signin' ? 'Criar conta' : 'Entrar'}
            </button>
          </p>
        ) : null}

        {mode === 'signin' ? (
          <>
            <div className="continue-label">OR CONTINUE WITH</div>

            <div className="social-stack">
              <button type="button" className="social-button" disabled title="Login com Google em breve">
                <GoogleIcon />
                <span>Google · em breve</span>
              </button>
              <button type="button" className="social-button" disabled title="Login com Apple em breve">
                <AppleIcon />
                <span>Apple · em breve</span>
              </button>
              <button type="button" className="social-button" disabled title="Login com Meta em breve">
                <MetaIcon />
                <span>Meta · em breve</span>
              </button>
            </div>

            <button className="forgot-button" type="button" onClick={() => { setMode('forgot'); setNotice(null); }}>
              Forgot your password?
            </button>
          </>
        ) : null}
      </section>
    </main>
  );
}

function GoogleIcon() {
  return (
    <svg className="provider-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.23-.2-1.78H12v3.4h5.52a4.7 4.7 0 0 1-2.05 3.08l-.02.11 2.98 2.31.21.02c1.94-1.79 2.96-4.43 2.96-7.14Z" />
      <path fill="#34A853" d="M12 22c2.7 0 4.96-.89 6.64-2.63l-3.17-2.44c-.85.57-1.99.97-3.47.97a6.02 6.02 0 0 1-5.69-4.17l-.1.01-3.1 2.4-.03.1A10.02 10.02 0 0 0 12 22Z" />
      <path fill="#FBBC05" d="M6.31 13.73A6.15 6.15 0 0 1 6 11.99c0-.6.11-1.19.3-1.74v-.12L3.17 7.69l-.1.05A10 10 0 0 0 2 12c0 1.54.36 3 .99 4.3l3.32-2.57Z" />
      <path fill="#EA4335" d="M12 6.1c1.88 0 3.15.81 3.88 1.48l2.82-2.75A9.56 9.56 0 0 0 12 2a10.02 10.02 0 0 0-8.92 5.74l3.22 2.51A6.04 6.04 0 0 1 12 6.1Z" />
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg className="provider-icon apple-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M17.05 12.54c-.03-2.72 2.22-4.04 2.32-4.1a4.96 4.96 0 0 0-3.9-2.12c-1.64-.17-3.23.98-4.07.98-.86 0-2.15-.96-3.54-.93a5.16 5.16 0 0 0-4.34 2.64c-1.89 3.27-.48 8.08 1.33 10.72.91 1.3 1.97 2.75 3.36 2.7 1.36-.06 1.87-.87 3.51-.87 1.63 0 2.1.87 3.52.84 1.46-.02 2.38-1.3 3.25-2.61a10.7 10.7 0 0 0 1.49-3.03 4.7 4.7 0 0 1-2.93-4.22ZM14.4 4.58A4.77 4.77 0 0 0 15.5 1.2a4.86 4.86 0 0 0-3.14 1.6 4.54 4.54 0 0 0-1.13 3.24 4 4 0 0 0 3.17-1.46Z" />
    </svg>
  );
}

function MetaIcon() {
  return <span className="meta-icon" aria-hidden="true">f</span>;
}

function translateAuthError(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes('invalid login credentials')) return 'E-mail ou senha incorretos.';
  if (normalized.includes('email not confirmed')) return 'Confirme seu e-mail antes de entrar.';
  if (normalized.includes('user already registered')) return 'Já existe uma conta com este e-mail.';
  if (normalized.includes('password should be')) return 'A senha não atende aos requisitos de segurança.';
  if (normalized.includes('rate limit')) return 'Muitas tentativas. Aguarde um instante e tente novamente.';
  if (normalized.includes('redirect') && normalized.includes('allow')) return 'O endereço de recuperação do EditFlow ainda não está autorizado no Supabase.';
  if (normalized.includes('code verifier') || normalized.includes('expired')) return 'Este link expirou ou já foi utilizado. Solicite uma nova recuperação de senha.';
  return message;
}

export default App;
