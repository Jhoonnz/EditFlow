import { useCallback, useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { ArrowLeft, ArrowRight, Building2, LoaderCircle, LogOut, RefreshCw, Sparkles, UserPlus } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { Dashboard } from '../board/Dashboard';
import type { WorkspaceRole, WorkspaceSummary } from './types';

type Props = { user: User };

export function AuthenticatedApp({ user }: Props) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadWorkspaces = useCallback(async () => {
    if (!supabase) return;
    setError(null);

    const { data: memberships, error: membershipError } = await supabase
      .from('workspace_members')
      .select('workspace_id, role')
      .eq('user_id', user.id);

    if (membershipError) {
      setError(membershipError.message);
      setLoading(false);
      return;
    }

    if (!memberships?.length) {
      setWorkspaces([]);
      setLoading(false);
      return;
    }

    const { data: workspaceRows, error: workspaceError } = await supabase
      .from('workspaces')
      .select('id, name')
      .in('id', memberships.map((membership) => membership.workspace_id));

    if (workspaceError) {
      setError(workspaceError.message);
      setLoading(false);
      return;
    }

    const roleByWorkspace = new Map(
      memberships.map((membership) => [membership.workspace_id, membership.role as WorkspaceRole]),
    );
    const nextWorkspaces = (workspaceRows ?? []).map((workspace) => ({
      id: workspace.id as string,
      name: workspace.name as string,
      role: roleByWorkspace.get(workspace.id as string) ?? 'editor',
    }));

    setWorkspaces(nextWorkspaces);
    setActiveWorkspaceId((current) =>
      current && nextWorkspaces.some((workspace) => workspace.id === current)
        ? current
        : (nextWorkspaces[0]?.id ?? null),
    );
    setLoading(false);
  }, [user.id]);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  if (loading) {
    return (
      <main className="app-loading">
        <div className="app-logo"><Sparkles size={19} /></div>
        <LoaderCircle className="spinner" size={25} />
      </main>
    );
  }

  if (!workspaces.length) {
    return <WorkspaceOnboarding user={user} onCreated={loadWorkspaces} initialError={error} />;
  }

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0];

  return (
    <Dashboard
      user={user}
      workspace={activeWorkspace}
      workspaces={workspaces}
      onWorkspaceChange={setActiveWorkspaceId}
      onWorkspacesChanged={loadWorkspaces}
    />
  );
}

function WorkspaceOnboarding({
  user,
  onCreated,
  initialError,
}: {
  user: User;
  onCreated: () => Promise<void>;
  initialError: string | null;
}) {
  const [mode, setMode] = useState<'choose' | 'create' | 'join'>('choose');
  const suggestedName = user.user_metadata.full_name
    ? `Estúdio de ${String(user.user_metadata.full_name).split(' ')[0]}`
    : 'Meu estúdio';
  const [name, setName] = useState(suggestedName);
  const [submitting, setSubmitting] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(initialError);

  const checkMembership = useCallback(async () => {
    setChecking(true);
    setError(null);
    await onCreated();
    setChecking(false);
  }, [onCreated]);

  useEffect(() => {
    if (mode !== 'join') return;
    const timer = window.setInterval(() => void onCreated(), 5000);
    return () => window.clearInterval(timer);
  }, [mode, onCreated]);

  const createWorkspace = async () => {
    if (!supabase || name.trim().length < 2) {
      setError('Digite um nome com pelo menos 2 caracteres.');
      return;
    }

    setSubmitting(true);
    setError(null);
    const { error: createError } = await supabase.rpc('create_workspace', {
      workspace_name: name.trim(),
    });

    if (createError) {
      setError(translateWorkspaceError(createError.message));
      setSubmitting(false);
      return;
    }

    await onCreated();
    setSubmitting(false);
  };

  return (
    <main className="onboarding-page">
      <div className="onboarding-orb onboarding-orb-blue" />
      <div className="onboarding-orb onboarding-orb-pink" />
      <section className="onboarding-card">
        {mode !== 'choose' ? <button className="onboarding-back" onClick={() => { setMode('choose'); setError(null); }}><ArrowLeft size={16} />Voltar</button> : null}
        <div className="onboarding-icon">{mode === 'join' ? <UserPlus size={24} /> : <Building2 size={24} />}</div>
        <p className="onboarding-kicker">PRIMEIRO ACESSO</p>
        <h1>{mode === 'choose' ? 'Como você usará o EditFlow?' : mode === 'create' ? 'Crie seu espaço de produção.' : 'Entre na equipe que te convidou.'}</h1>
        <p className="onboarding-copy">{mode === 'choose' ? 'Você pode criar uma nova equipe ou entrar em um espaço existente.' : mode === 'create' ? 'Ele reunirá clientes, trabalhos, prazos e links da sua equipe.' : 'Peça ao responsável pela equipe para adicionar o e-mail abaixo nas configurações.'}</p>

        {mode === 'choose' ? (
          <div className="onboarding-choices">
            <button onClick={() => setMode('join')}><span><UserPlus size={20} /></span><div><strong>Entrar em uma equipe</strong><small>Fui convidado por outra pessoa</small></div><ArrowRight size={17} /></button>
            <button onClick={() => setMode('create')}><span><Building2 size={20} /></span><div><strong>Criar uma equipe</strong><small>Quero configurar um espaço novo</small></div><ArrowRight size={17} /></button>
          </div>
        ) : null}

        {mode === 'create' ? (
          <>
            <label className="workspace-field">
              <span>Nome da equipe ou empresa</span>
              <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus />
            </label>
            {error ? <div className="workspace-error" role="alert">{error}</div> : null}
            <button className="onboarding-submit" onClick={() => void createWorkspace()} disabled={submitting}>
              {submitting ? <LoaderCircle className="spinner" size={19} /> : <><span>Criar meu espaço</span><ArrowRight size={18} /></>}
            </button>
          </>
        ) : null}

        {mode === 'join' ? (
          <div className="join-workspace-panel">
            <div><small>SEU E-MAIL DE CONVITE</small><strong>{user.email}</strong></div>
            <ol><li>O administrador abre <b>Configurações → Membros</b>.</li><li>Ele adiciona este e-mail como Editor ou Administrador.</li><li>Esta tela entrará automaticamente na equipe.</li></ol>
            {error ? <div className="workspace-error" role="alert">{error}</div> : null}
            <button className="onboarding-submit" onClick={() => void checkMembership()} disabled={checking}>{checking ? <LoaderCircle className="spinner" size={19} /> : <><RefreshCw size={17} />Verificar convite agora</>}</button>
            <p>Aguardando convite… verificando automaticamente.</p>
          </div>
        ) : null}

        <button className="onboarding-logout" onClick={() => void supabase?.auth.signOut()}>
          <LogOut size={15} /> Sair desta conta
        </button>
      </section>
    </main>
  );
}

function translateWorkspaceError(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes('profiles') || normalized.includes('foreign key')) {
    return 'Seu perfil ainda não foi preparado no banco. Aplique a migration 002 e tente novamente.';
  }
  if (normalized.includes('create_workspace') || normalized.includes('schema cache')) {
    return 'A função de criação da equipe não está instalada no Supabase. Aplique as migrations do projeto.';
  }
  if (normalized.includes('permission denied')) {
    return 'O banco ainda não concedeu acesso ao aplicativo. Aplique a migration 003 no Supabase.';
  }
  if (normalized.includes('workspace_members') || normalized.includes('relation')) {
    return 'As tabelas do EditFlow ainda não estão instaladas no Supabase. Aplique a migration inicial.';
  }
  return message;
}
