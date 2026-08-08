import { useCallback, useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { ArrowRight, Building2, LoaderCircle, LogOut, Sparkles } from 'lucide-react';
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
  const suggestedName = user.user_metadata.full_name
    ? `Estúdio de ${String(user.user_metadata.full_name).split(' ')[0]}`
    : 'Meu estúdio';
  const [name, setName] = useState(suggestedName);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(initialError);

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
        <div className="onboarding-icon"><Building2 size={24} /></div>
        <p className="onboarding-kicker">PRIMEIRO ACESSO</p>
        <h1>Vamos criar seu espaço de produção.</h1>
        <p className="onboarding-copy">
          Ele reunirá clientes, trabalhos, prazos e links da sua equipe.
        </p>

        <label className="workspace-field">
          <span>Nome da equipe ou empresa</span>
          <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} autoFocus />
        </label>

        {error ? <div className="workspace-error" role="alert">{error}</div> : null}

        <button className="onboarding-submit" onClick={() => void createWorkspace()} disabled={submitting}>
          {submitting ? <LoaderCircle className="spinner" size={19} /> : <><span>Criar meu espaço</span><ArrowRight size={18} /></>}
        </button>

        <button className="onboarding-logout" onClick={() => void supabase?.auth.signOut()}>
          <LogOut size={15} /> Sair desta conta
        </button>
      </section>
    </main>
  );
}

function translateWorkspaceError(message: string) {
  if (message.toLowerCase().includes('profiles')) {
    return 'Seu perfil ainda não foi preparado no banco. Execute a migration e entre novamente.';
  }
  return message;
}
