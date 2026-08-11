import { useCallback, useEffect, useRef, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { ArrowLeft, ArrowRight, Building2, LoaderCircle, LogOut, RefreshCw, Sparkles, UserPlus } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { Dashboard } from '../board/Dashboard';
import { WelcomeScreen } from './WelcomeScreen';
import type { WelcomeStartupAction, WorkspaceInvitation, WorkspaceRole, WorkspaceSummary } from './types';

type Props = { user: User };

export function AuthenticatedApp({ user }: Props) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [invitations, setInvitations] = useState<WorkspaceInvitation[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [desktopPreferences, setDesktopPreferences] = useState<EditFlowDesktopPreferences | null>(null);
  const [welcomeAccess, setWelcomeAccess] = useState<{ isFirstAccess: boolean; previousOpenedAt: string | null } | null>(null);
  const [welcomeDismissed, setWelcomeDismissed] = useState(false);
  const [startupAction, setStartupAction] = useState<WelcomeStartupAction | null>(null);
  const accessRecorded = useRef(false);

  const loadWorkspaces = useCallback(async () => {
    if (!supabase) return;
    setError(null);

    const [membershipResult, invitationResult] = await Promise.all([
      supabase.from('workspace_members').select('workspace_id, role').eq('user_id', user.id),
      supabase
        .from('workspace_invitations')
        .select('id, workspace_id, email, role, status, expires_at, created_at')
        .eq('email', (user.email ?? '').toLowerCase())
        .eq('status', 'pending')
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false }),
    ]);

    const loadError = membershipResult.error ?? invitationResult.error;
    if (loadError) {
      setError(loadError.message);
      setLoading(false);
      return;
    }

    const memberships = membershipResult.data ?? [];
    const invitationRows = invitationResult.data ?? [];
    const workspaceIds = Array.from(new Set([
      ...memberships.map((membership) => membership.workspace_id as string),
      ...invitationRows.map((invitation) => invitation.workspace_id as string),
    ]));

    const workspaceResult = workspaceIds.length
      ? await supabase.from('workspaces').select('id, name').in('id', workspaceIds)
      : { data: [], error: null };

    if (workspaceResult.error) {
      setError(workspaceResult.error.message);
      setLoading(false);
      return;
    }

    const workspaceNames = new Map((workspaceResult.data ?? []).map((workspace) => [workspace.id as string, workspace.name as string]));

    const roleByWorkspace = new Map(
      memberships.map((membership) => [membership.workspace_id, membership.role as WorkspaceRole]),
    );
    const nextWorkspaces = memberships.map((membership) => ({
      id: membership.workspace_id as string,
      name: workspaceNames.get(membership.workspace_id as string) ?? 'Equipe',
      role: roleByWorkspace.get(membership.workspace_id as string) ?? 'editor',
    }));

    setInvitations(invitationRows.map((invitation) => ({
      id: invitation.id as string,
      workspace_id: invitation.workspace_id as string,
      workspace_name: workspaceNames.get(invitation.workspace_id as string) ?? 'Equipe EditFlow',
      email: invitation.email as string,
      role: invitation.role as WorkspaceInvitation['role'],
      status: invitation.status as WorkspaceInvitation['status'],
      expires_at: invitation.expires_at as string,
      created_at: invitation.created_at as string,
    })));

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

  useEffect(() => {
    void window.editflow.getDesktopPreferences().then(setDesktopPreferences);
  }, []);

  useEffect(() => {
    if (loading || !workspaces.length || accessRecorded.current) return;
    accessRecorded.current = true;

    const recordAccess = async () => {
      const localKey = `editflow:last-open:${user.id}`;
      const localPrevious = window.localStorage.getItem(localKey);
      const openedAt = new Date().toISOString();
      window.localStorage.setItem(localKey, openedAt);

      let access = {
        // A temporary server/cache failure must never turn a returning user
        // into a first-time user. The server can positively confirm it below.
        isFirstAccess: false,
        previousOpenedAt: localPrevious,
      };

      if (supabase) {
        const { data, error: accessError } = await supabase.rpc('record_app_open');
        const row = Array.isArray(data) ? data[0] : null;
        if (!accessError && row) {
          const serverPrevious = row.previous_opened_at as string | null;
          access = {
            isFirstAccess: Boolean(row.is_first_access) && localPrevious === null,
            previousOpenedAt: serverPrevious ?? localPrevious,
          };
        }
      }

      setWelcomeAccess(access);
    };

    void recordAccess();
  }, [loading, user.id, workspaces.length]);

  useEffect(() => {
    if (!supabase || !user.email) return;
    const realtimeClient = supabase;
    const channel = realtimeClient
      .channel(`editflow-invitations:${user.id}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'workspace_invitations',
        filter: `email=eq.${user.email.toLowerCase()}`,
      }, () => void loadWorkspaces())
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'workspace_members',
        filter: `user_id=eq.${user.id}`,
      }, () => void loadWorkspaces())
      .subscribe();
    return () => { void realtimeClient.removeChannel(channel); };
  }, [loadWorkspaces, user.email, user.id]);

  if (loading) {
    return (
      <main className="app-loading">
        <div className="app-logo"><Sparkles size={19} /></div>
        <LoaderCircle className="spinner" size={25} />
      </main>
    );
  }

  if (!workspaces.length && invitations.length) {
    return <InvitationPrompt invitations={invitations} onChanged={loadWorkspaces} fullscreen />;
  }

  if (!workspaces.length) {
    return <WorkspaceOnboarding user={user} onCreated={loadWorkspaces} initialError={error} />;
  }

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0];

  const disableWelcome = async () => {
    if (!desktopPreferences) return;
    const updated = await window.editflow.updateDesktopPreferences({ ...desktopPreferences, showWelcome: false });
    setDesktopPreferences(updated);
  };

  if (!desktopPreferences || !welcomeAccess) {
    return <main className="app-loading"><LoaderCircle className="spinner" size={25} /></main>;
  }

  if (desktopPreferences.showWelcome && !welcomeDismissed) {
    return (
      <WelcomeScreen
        user={user}
        workspaces={workspaces}
        invitationCount={invitations.length}
        isFirstAccess={welcomeAccess.isFirstAccess}
        previousOpenedAt={welcomeAccess.previousOpenedAt}
        onDisableWelcome={disableWelcome}
        onContinue={(action) => {
          if (action.kind !== 'board' && action.workspaceId) setActiveWorkspaceId(action.workspaceId);
          setStartupAction(action);
          setWelcomeDismissed(true);
        }}
      />
    );
  }

  return <>
    <Dashboard
      user={user}
      workspace={activeWorkspace}
      workspaces={workspaces}
      onWorkspaceChange={setActiveWorkspaceId}
      onWorkspacesChanged={loadWorkspaces}
      startupAction={startupAction}
      onStartupActionHandled={() => setStartupAction(null)}
    />
    {invitations.length ? <InvitationPrompt invitations={invitations} onChanged={loadWorkspaces} /> : null}
  </>;
}

function InvitationPrompt({ invitations, onChanged, fullscreen = false }: {
  invitations: WorkspaceInvitation[];
  onChanged: () => Promise<void>;
  fullscreen?: boolean;
}) {
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const respond = async (invitation: WorkspaceInvitation, accept: boolean) => {
    if (!supabase) return;
    setSubmittingId(invitation.id);
    setError(null);
    const { error: responseError } = accept
      ? await supabase.rpc('accept_workspace_invitation', { target_invitation: invitation.id })
      : await supabase.rpc('decline_workspace_invitation', { target_invitation: invitation.id });
    setSubmittingId(null);
    if (responseError) { setError(responseError.message); return; }
    await onChanged();
  };

  return (
    <div className={fullscreen ? 'invitation-page' : 'invitation-backdrop'}>
      <section className="invitation-dialog" role="dialog" aria-modal={!fullscreen} aria-label="Convites de equipe">
        <div className="onboarding-icon"><UserPlus size={24} /></div>
        <p className="onboarding-kicker">CONVITE DE EQUIPE</p>
        <h1>Você recebeu {invitations.length === 1 ? 'um convite.' : 'novos convites.'}</h1>
        <p className="onboarding-copy">Aceite somente equipes que você reconhece.</p>
        <div className="invitation-list">
          {invitations.map((invitation) => (
            <article key={invitation.id}>
              <span>{invitation.workspace_name.slice(0, 1).toUpperCase()}</span>
              <div><strong>{invitation.workspace_name}</strong><small>Cargo: {invitation.role === 'admin' ? 'Administrador' : 'Editor'} · expira em {formatInviteDate(invitation.expires_at)}</small></div>
              <div className="invitation-actions">
                <button className="secondary-button" disabled={submittingId === invitation.id} onClick={() => void respond(invitation, false)}>Recusar</button>
                <button className="primary-button" disabled={submittingId === invitation.id} onClick={() => void respond(invitation, true)}>{submittingId === invitation.id ? <LoaderCircle className="spinner" size={15} /> : null}Aceitar</button>
              </div>
            </article>
          ))}
        </div>
        {error ? <div className="workspace-error" role="alert">{error}</div> : null}
        {fullscreen ? <button className="onboarding-logout" onClick={() => void supabase?.auth.signOut()}><LogOut size={15} />Sair desta conta</button> : null}
      </section>
    </div>
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
        <p className="onboarding-copy">{mode === 'choose' ? 'Você pode criar uma nova equipe ou entrar em um espaço existente.' : mode === 'create' ? 'Ele reunirá clientes, trabalhos, prazos e links da sua equipe.' : 'Peça ao responsável pela equipe para enviar um convite ao e-mail abaixo.'}</p>

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
            <ol><li>O administrador abre <b>Configurações → Membros</b>.</li><li>Ele envia o convite para este e-mail.</li><li>O convite aparecerá aqui para você aceitar ou recusar.</li></ol>
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

function formatInviteDate(date: string) {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(new Date(date));
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
