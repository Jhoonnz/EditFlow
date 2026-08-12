import { FormEvent, useCallback, useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { Building2, CircleDollarSign, Eye, Laptop, LoaderCircle, Mail, MonitorCog, Moon, PackageCheck, Palette, Pencil, Plus, Power, Save, Sun, Trash2, UserPlus, Users, Video, X } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import type { BillingPricingModel, Client, ClientBillingSetting, MemberAvailability, Task, WorkspaceInvitation, WorkspaceMember, WorkspaceRole, WorkspaceSummary } from './types';

export function ClientsView({
  workspace,
  clients,
  tasks,
  onChanged,
}: {
  workspace: WorkspaceSummary;
  clients: Client[];
  tasks: Task[];
  onChanged: () => Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [billingSettings, setBillingSettings] = useState<ClientBillingSetting[]>([]);
  const [billingAvailable, setBillingAvailable] = useState(true);
  const [billingLoading, setBillingLoading] = useState(workspace.role === 'owner');
  const [billingMode, setBillingMode] = useState<'none' | BillingPricingModel>('none');
  const [amountUsd, setAmountUsd] = useState('');
  const [bundleSize, setBundleSize] = useState('5');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isOwner = workspace.role === 'owner';

  const loadBillingSettings = useCallback(async () => {
    if (!supabase || !isOwner) {
      setBillingLoading(false);
      return;
    }
    setBillingLoading(true);
    const { data, error: billingError } = await supabase
      .from('client_billing_settings')
      .select('*')
      .eq('workspace_id', workspace.id);
    if (billingError) {
      const missingSchema = isMissingFinanceSchema(billingError.message);
      setBillingAvailable(!missingSchema);
      if (!missingSchema) setError(billingError.message);
      setBillingLoading(false);
      return;
    }
    setBillingAvailable(true);
    setBillingSettings((data ?? []).map(normalizeBillingSetting));
    setBillingLoading(false);
  }, [isOwner, workspace.id]);

  useEffect(() => { void loadBillingSettings(); }, [loadBillingSettings]);

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setEmail('');
    setBillingMode('none');
    setAmountUsd('');
    setBundleSize('5');
    setError(null);
  };

  const saveClient = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase || !name.trim()) return setError('Digite o nome do cliente.');
    const parsedAmount = Number(amountUsd.replace(',', '.'));
    const parsedBundleSize = billingMode === 'bundle' ? Number(bundleSize) : 1;
    if (isOwner && billingMode !== 'none' && (!Number.isFinite(parsedAmount) || parsedAmount <= 0)) return setError('Digite um valor em dólar maior que zero.');
    if (isOwner && billingMode === 'bundle' && (!Number.isInteger(parsedBundleSize) || parsedBundleSize < 2)) return setError('O pacote precisa ter pelo menos 2 vídeos.');

    setSaving(true);
    setError(null);
    const payload = { name: name.trim(), email: email.trim() || null };
    let clientId = editingId;
    let createdClientId: string | null = null;
    if (editingId) {
      const { error: clientError } = await supabase.from('clients').update(payload).eq('id', editingId);
      if (clientError) {
        setSaving(false);
        return setError(clientError.message);
      }
    } else {
      const { data: createdClient, error: clientError } = await supabase
        .from('clients')
        .insert({ ...payload, workspace_id: workspace.id })
        .select('id')
        .single();
      if (clientError || !createdClient) {
        setSaving(false);
        return setError(clientError?.message ?? 'Não foi possível criar o cliente.');
      }
      clientId = createdClient.id as string;
      createdClientId = clientId;
    }

    if (isOwner && clientId && billingAvailable) {
      const billingResult = billingMode === 'none'
        ? await supabase.from('client_billing_settings').delete().eq('client_id', clientId)
        : await supabase.from('client_billing_settings').upsert({
          client_id: clientId,
          workspace_id: workspace.id,
          currency: 'USD',
          pricing_model: billingMode,
          amount_usd: parsedAmount,
          bundle_size: parsedBundleSize,
        }, { onConflict: 'client_id' });
      if (billingResult.error) {
        if (createdClientId) await supabase.from('clients').delete().eq('id', createdClientId);
        setSaving(false);
        return setError(isMissingFinanceSchema(billingResult.error.message)
          ? 'Ative primeiro o módulo financeiro executando a migration 012 no Supabase.'
          : billingResult.error.message);
      }
      if (billingMode !== 'none') {
        const { error: syncError } = await supabase.rpc('sync_client_earnings', { target_client: clientId });
        if (syncError) {
          setSaving(false);
          setEditingId(clientId);
          await loadBillingSettings();
          await onChanged();
          return setError(`Cliente salvo, mas não foi possível sincronizar entregas anteriores: ${syncError.message}`);
        }
      }
    }

    setSaving(false);
    resetForm();
    await loadBillingSettings();
    await onChanged();
  };

  const editClient = (client: Client) => {
    setEditingId(client.id);
    setName(client.name);
    setEmail(client.email ?? '');
    const setting = billingSettings.find((item) => item.client_id === client.id);
    setBillingMode(setting?.pricing_model ?? 'none');
    setAmountUsd(setting ? String(setting.amount_usd) : '');
    setBundleSize(setting ? String(setting.bundle_size) : '5');
    setError(null);
  };

  const deleteClient = async (client: Client) => {
    if (!supabase || !window.confirm(`Excluir o cliente “${client.name}”? As tarefas serão mantidas sem cliente.`)) return;
    const { error: deleteError } = await supabase.from('clients').delete().eq('id', client.id);
    if (deleteError) return setError(deleteError.message);
    if (editingId === client.id) resetForm();
    await onChanged();
  };

  return (
    <div className="content-view">
      <section className="content-card client-form-card">
        <div className="content-card-heading">
          <span className="content-icon"><Plus size={18} /></span>
          <div><h2>{editingId ? 'Editar cliente' : 'Novo cliente'}</h2><p>Organize os trabalhos por cliente.</p></div>
        </div>
        <form className="settings-form" onSubmit={saveClient}>
          <label><span>Nome</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nome do cliente" /></label>
          <label><span>E-mail</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="contato@cliente.com" /></label>
          {isOwner && billingAvailable ? (
            <fieldset className="client-payment-panel">
              <legend><CircleDollarSign size={15} /><span><strong>Pagamento do cliente</strong><small>O valor será contabilizado quando o trabalho for entregue.</small></span></legend>
              <div className="client-payment-models">
                <button type="button" className={billingMode === 'none' ? 'active' : ''} onClick={() => setBillingMode('none')}><X size={15} /><span><strong>Não contabilizar</strong><small>Sem ganhos automáticos</small></span></button>
                <button type="button" className={billingMode === 'per_video' ? 'active' : ''} onClick={() => setBillingMode('per_video')}><Video size={15} /><span><strong>Por vídeo</strong><small>Valor por entrega</small></span></button>
                <button type="button" className={billingMode === 'bundle' ? 'active' : ''} onClick={() => setBillingMode('bundle')}><PackageCheck size={15} /><span><strong>Por pacote</strong><small>Valor a cada lote</small></span></button>
              </div>
              {billingMode !== 'none' ? (
                <div className="client-payment-values">
                  <label><span>Valor em USD</span><div><b>US$</b><input inputMode="decimal" value={amountUsd} onChange={(event) => setAmountUsd(event.target.value)} placeholder="200.00" /></div></label>
                  {billingMode === 'bundle' ? <label><span>Vídeos no pacote</span><div><input type="number" min="2" max="1000" value={bundleSize} onChange={(event) => setBundleSize(event.target.value)} /><b>vídeos</b></div></label> : null}
                </div>
              ) : null}
            </fieldset>
          ) : isOwner ? <div className="client-payment-unavailable">Execute a migration 012 no Supabase para configurar pagamentos automáticos.</div> : null}
          {error ? <div className="panel-error">{error}</div> : null}
          <div className="form-actions">
            {editingId ? <button type="button" className="secondary-button" onClick={resetForm}>Cancelar</button> : null}
            <button className="primary-button" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spinner" size={16} /> : <Save size={16} />}{editingId ? 'Salvar' : 'Adicionar cliente'}</button>
          </div>
        </form>
      </section>

      <section className="content-card client-list-card">
        <div className="content-card-heading"><span className="content-icon"><Users size={18} /></span><div><h2>Seus clientes</h2><p>{clients.length} cadastrados</p></div></div>
        <div className="client-list">
          {clients.map((client) => {
            const taskCount = tasks.filter((task) => task.client_id === client.id).length;
            const setting = billingSettings.find((item) => item.client_id === client.id);
            return (
              <article className="client-row" key={client.id}>
                <span className="client-avatar">{client.name.slice(0, 1).toUpperCase()}</span>
                <div className="client-copy"><strong>{client.name}</strong><small>{client.email || 'Sem e-mail'} · {taskCount} {taskCount === 1 ? 'trabalho' : 'trabalhos'}{isOwner ? ` · ${setting ? billingDescription(setting) : 'sem pagamento automático'}` : ''}</small></div>
                <button disabled={isOwner && billingLoading} onClick={() => editClient(client)} aria-label={`Editar ${client.name}`}><Pencil size={15} /></button>
                <button className="danger-icon" onClick={() => void deleteClient(client)} aria-label={`Excluir ${client.name}`}><Trash2 size={15} /></button>
              </article>
            );
          })}
          {!clients.length ? <div className="empty-panel">Nenhum cliente cadastrado ainda.</div> : null}
        </div>
      </section>
    </div>
  );
}

export function SettingsView({
  user,
  workspace,
  onWorkspacesChanged,
  onMemberProfile,
}: {
  user: User;
  workspace: WorkspaceSummary;
  onWorkspacesChanged: () => Promise<void>;
  onMemberProfile: (memberId: string) => void;
}) {
  const [workspaceName, setWorkspaceName] = useState(workspace.name);
  const [displayName, setDisplayName] = useState(String(user.user_metadata.full_name ?? ''));
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [pendingInvitations, setPendingInvitations] = useState<WorkspaceInvitation[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Exclude<WorkspaceRole, 'owner'>>('editor');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState('...');
  const [desktopPreferences, setDesktopPreferences] = useState<EditFlowDesktopPreferences | null>(null);
  const [desktopSaving, setDesktopSaving] = useState<keyof EditFlowDesktopPreferences | null>(null);
  const canManage = workspace.role === 'owner' || workspace.role === 'admin';

  useEffect(() => setWorkspaceName(workspace.name), [workspace.id, workspace.name]);
  useEffect(() => { void window.editflow.getVersion().then(setAppVersion); }, []);
  useEffect(() => { void window.editflow.getDesktopPreferences().then(setDesktopPreferences); }, []);

  const loadMembers = useCallback(async () => {
    if (!supabase) return;
    const [membershipResult, invitationResult] = await Promise.all([
      supabase.from('workspace_members').select('user_id, role').eq('workspace_id', workspace.id),
      canManage
        ? supabase.from('workspace_invitations').select('id, workspace_id, email, role, status, expires_at, created_at').eq('workspace_id', workspace.id).eq('status', 'pending').order('created_at', { ascending: false })
        : Promise.resolve({ data: [], error: null }),
    ]);
    const membershipError = membershipResult.error ?? invitationResult.error;
    if (membershipError) return setError(membershipError.message);
    const memberships = membershipResult.data ?? [];
    const ids = memberships.map((item) => item.user_id as string);
    const profileResult = ids.length
      ? await supabase.rpc('get_workspace_member_profiles', { target_workspace: workspace.id })
      : { data: [], error: null };
    let profileRows = (profileResult.data ?? []) as Array<{
      user_id: string;
      display_name: string;
      email: string | null;
      avatar_url: string | null;
      availability: MemberAvailability;
    }>;
    if (profileResult.error && ids.length) {
      const fallbackProfiles = await supabase.from('profiles').select('id, display_name, avatar_url').in('id', ids);
      if (fallbackProfiles.error) return setError(fallbackProfiles.error.message);
      profileRows = (fallbackProfiles.data ?? []).map((profile) => ({
        user_id: profile.id as string,
        display_name: profile.display_name as string,
        email: null,
        avatar_url: profile.avatar_url as string | null,
        availability: 'available',
      }));
    }
    const profilesById = new Map(profileRows.map((profile) => [profile.user_id, profile]));
    setMembers(memberships.map((item) => ({
      user_id: item.user_id as string,
      role: item.role as WorkspaceRole,
      display_name: profilesById.get(item.user_id as string)?.display_name || (item.user_id === user.id ? user.email || 'Você' : 'Membro'),
      email: profilesById.get(item.user_id as string)?.email ?? undefined,
      avatar_url: profilesById.get(item.user_id as string)?.avatar_url ?? null,
      availability: profilesById.get(item.user_id as string)?.availability ?? 'available',
    })));
    setPendingInvitations((invitationResult.data ?? []).map((invitation) => ({
      id: invitation.id as string,
      workspace_id: invitation.workspace_id as string,
      workspace_name: workspace.name,
      email: invitation.email as string,
      role: invitation.role as WorkspaceInvitation['role'],
      status: invitation.status as WorkspaceInvitation['status'],
      expires_at: invitation.expires_at as string,
      created_at: invitation.created_at as string,
    })));
  }, [canManage, user.email, user.id, workspace.id, workspace.name]);

  useEffect(() => { void loadMembers(); }, [loadMembers]);

  useEffect(() => {
    if (!supabase) return;
    const realtimeClient = supabase;
    const channel = realtimeClient
      .channel(`editflow-team-settings:${workspace.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'workspace_invitations', filter: `workspace_id=eq.${workspace.id}` }, () => void loadMembers())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'workspace_members', filter: `workspace_id=eq.${workspace.id}` }, () => void loadMembers())
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles' }, () => void loadMembers())
      .subscribe();
    return () => { void realtimeClient.removeChannel(channel); };
  }, [loadMembers, workspace.id]);

  const saveGeneral = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase || workspaceName.trim().length < 2) return setError('O nome da equipe precisa ter pelo menos 2 caracteres.');
    setSaving(true);
    setError(null);
    const [workspaceResult, profileResult] = await Promise.all([
      canManage ? supabase.from('workspaces').update({ name: workspaceName.trim() }).eq('id', workspace.id) : Promise.resolve({ error: null }),
      supabase.from('profiles').update({ display_name: displayName.trim() }).eq('id', user.id),
    ]);
    setSaving(false);
    const saveError = workspaceResult.error ?? profileResult.error;
    if (saveError) return setError(saveError.message);
    await supabase.auth.updateUser({ data: { full_name: displayName.trim() } });
    await onWorkspacesChanged();
  };

  const addMember = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase || !inviteEmail.trim()) return;
    setSaving(true);
    setError(null);
    const { error: inviteError } = await supabase.rpc('invite_workspace_member', {
      target_workspace: workspace.id,
      member_email: inviteEmail.trim(),
      member_role: inviteRole,
    });
    setSaving(false);
    if (inviteError) return setError(translateMemberError(inviteError.message));
    setInviteEmail('');
    await loadMembers();
  };

  const cancelInvitation = async (invitation: WorkspaceInvitation) => {
    if (!supabase || !window.confirm(`Cancelar o convite enviado para ${invitation.email}?`)) return;
    const { error: cancelError } = await supabase.rpc('cancel_workspace_invitation', { target_invitation: invitation.id });
    if (cancelError) return setError(cancelError.message);
    await loadMembers();
  };

  const changeMemberRole = async (member: WorkspaceMember, role: Exclude<WorkspaceRole, 'owner'>) => {
    if (!supabase) return;
    setError(null);
    const { error: roleError } = await supabase.rpc('change_workspace_member_role', {
      target_workspace: workspace.id,
      target_user: member.user_id,
      member_role: role,
    });
    if (roleError) return setError(roleError.message);
    await loadMembers();
  };

  const removeMember = async (member: WorkspaceMember) => {
    if (!supabase || !window.confirm(`Remover ${member.display_name} desta equipe?`)) return;
    const { error: removeError } = await supabase.rpc('remove_workspace_member', {
      target_workspace: workspace.id,
      target_user: member.user_id,
    });
    if (removeError) return setError(removeError.message);
    await loadMembers();
  };

  const deleteWorkspace = async () => {
    if (!supabase || workspace.role !== 'owner') return;
    const confirmation = window.prompt(`Digite ${workspace.name} para excluir esta equipe e todos os trabalhos.`);
    if (confirmation !== workspace.name) return;
    setSaving(true);
    const { error: deleteError } = await supabase.rpc('delete_workspace', { target_workspace: workspace.id });
    setSaving(false);
    if (deleteError) return setError(deleteError.message);
    await onWorkspacesChanged();
  };

  const checkForUpdates = async () => {
    setError(null);
    try {
      await window.editflow.checkForUpdates();
    } catch {
      setError('Não foi possível verificar atualizações agora. Tente novamente em alguns instantes.');
    }
  };

  const updateDesktopPreference = async (
    key: keyof EditFlowDesktopPreferences,
    value: boolean | EditFlowDesktopPreferences['theme'],
  ) => {
    if (!desktopPreferences) return;
    const nextPreferences = { ...desktopPreferences, [key]: value };
    setDesktopPreferences(nextPreferences);
    setDesktopSaving(key);
    setError(null);
    try {
      setDesktopPreferences(await window.editflow.updateDesktopPreferences(nextPreferences));
    } catch {
      setDesktopPreferences(desktopPreferences);
      setError('Não foi possível salvar essa preferência do Windows.');
    } finally {
      setDesktopSaving(null);
    }
  };

  return (
    <div className="settings-view">
      {error ? <div className="panel-error">{error}</div> : null}
      <section className="content-card">
        <div className="content-card-heading"><span className="content-icon"><Building2 size={18} /></span><div><h2>Geral</h2><p>Dados da equipe e do seu perfil.</p></div></div>
        <form className="settings-form settings-grid" onSubmit={saveGeneral}>
          <label><span>Nome da equipe</span><input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} disabled={!canManage} /></label>
          <label><span>Seu nome</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Como você quer aparecer" /></label>
          <div className="form-actions full-row"><button className="primary-button" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spinner" size={16} /> : <Save size={16} />}Salvar alterações</button></div>
        </form>
      </section>

      <section className="content-card">
        <div className="content-card-heading"><span className="content-icon"><UserPlus size={18} /></span><div><h2>Membros</h2><p>Envie um convite para a pessoa aceitar ou recusar.</p></div></div>
        {canManage ? (
          <form className="invite-form" onSubmit={addMember}>
            <label><Mail size={16} /><input type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="email@exemplo.com" /></label>
            <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as Exclude<WorkspaceRole, 'owner'>)}><option value="editor">Editor</option><option value="admin">Administrador</option></select>
            <button className="primary-button" type="submit" disabled={saving}><Plus size={16} />Enviar convite</button>
          </form>
        ) : null}
        {canManage && pendingInvitations.length ? (
          <div className="pending-invitations">
            <strong>CONVITES PENDENTES</strong>
            {pendingInvitations.map((invitation) => (
              <article key={invitation.id}>
                <span className="client-avatar">{invitation.email.slice(0, 1).toUpperCase()}</span>
                <div className="client-copy"><strong>{invitation.email}</strong><small>{roleLabel(invitation.role)} · aguardando resposta</small></div>
                <button className="danger-icon" onClick={() => void cancelInvitation(invitation)} aria-label="Cancelar convite"><Trash2 size={15} /></button>
              </article>
            ))}
          </div>
        ) : null}
        <div className="member-list">
          {members.map((member) => (
            <article className="member-row" key={member.user_id}>
              <button type="button" className="client-avatar member-avatar-button" onClick={() => onMemberProfile(member.user_id)} aria-label={`Abrir perfil de ${member.display_name}`}>
                {member.avatar_url ? <img src={member.avatar_url} alt="" /> : member.display_name.slice(0, 1).toUpperCase()}
              </button>
              <div className="client-copy"><strong>{member.display_name}{member.user_id === user.id ? ' (você)' : ''}</strong><small>{roleLabel(member.role)} · {availabilityLabel(member.availability)}</small></div>
              {canManage && member.role !== 'owner' && member.user_id !== user.id ? <select className="member-role-select" value={member.role} onChange={(event) => void changeMemberRole(member, event.target.value as Exclude<WorkspaceRole, 'owner'>)}><option value="editor">Editor</option><option value="admin">Administrador</option></select> : null}
              {canManage && member.role !== 'owner' && member.user_id !== user.id ? <button className="danger-icon" onClick={() => void removeMember(member)} aria-label="Remover membro"><Trash2 size={15} /></button> : null}
            </article>
          ))}
        </div>
      </section>

      <section className="content-card appearance-settings-card">
        <div className="content-card-heading"><span className="content-icon"><Palette size={18} /></span><div><h2>Aparência</h2><p>Escolha como o EditFlow deve aparecer neste computador.</p></div></div>
        {desktopPreferences ? (
          <div className="theme-options" role="radiogroup" aria-label="Tema do aplicativo">
            <ThemeOption
              icon={Sun}
              title="Claro"
              description="Visual limpo e iluminado."
              active={desktopPreferences.theme === 'light'}
              saving={desktopSaving === 'theme'}
              onClick={() => void updateDesktopPreference('theme', 'light')}
            />
            <ThemeOption
              icon={Moon}
              title="Escuro"
              description="Grafite com cores vibrantes."
              active={desktopPreferences.theme === 'dark'}
              saving={desktopSaving === 'theme'}
              onClick={() => void updateDesktopPreference('theme', 'dark')}
            />
            <ThemeOption
              icon={Laptop}
              title="Automático"
              description="Acompanha o tema do Windows."
              active={desktopPreferences.theme === 'system'}
              saving={desktopSaving === 'theme'}
              onClick={() => void updateDesktopPreference('theme', 'system')}
            />
          </div>
        ) : <div className="desktop-settings-loading"><LoaderCircle className="spinner" size={18} />Carregando preferências…</div>}
      </section>

      <section className="content-card desktop-settings-card">
        <div className="content-card-heading"><span className="content-icon"><MonitorCog size={18} /></span><div><h2>Aplicativo no Windows</h2><p>Escolha como o EditFlow se comporta ao iniciar e fechar.</p></div></div>
        {desktopPreferences ? (
          <div className="desktop-preference-list">
            <DesktopPreference
              icon={Power}
              title="Iniciar com o Windows"
              description="Abre o EditFlow automaticamente quando você entrar no computador."
              checked={desktopPreferences.launchAtLogin}
              saving={desktopSaving === 'launchAtLogin'}
              onChange={(checked) => void updateDesktopPreference('launchAtLogin', checked)}
            />
            <DesktopPreference
              icon={X}
              title="Manter ativo ao clicar no X"
              description="Esconde a janela nos ícones ocultos para continuar recebendo notificações."
              checked={desktopPreferences.closeToTray}
              saving={desktopSaving === 'closeToTray'}
              onChange={(checked) => void updateDesktopPreference('closeToTray', checked)}
            />
            <DesktopPreference
              icon={Eye}
              title="Mostrar resumo ao abrir"
              description="Exibe a tela de boas-vindas com tarefas, mensagens e prazos."
              checked={desktopPreferences.showWelcome}
              saving={desktopSaving === 'showWelcome'}
              onChange={(checked) => void updateDesktopPreference('showWelcome', checked)}
            />
          </div>
        ) : <div className="desktop-settings-loading"><LoaderCircle className="spinner" size={18} />Carregando preferências…</div>}
      </section>

      <section className="content-card update-settings-row">
        <div><h2>Atualizações</h2><p>Versão instalada: {appVersion}. O EditFlow também verifica automaticamente ao abrir.</p></div>
        <button className="secondary-button" onClick={() => void checkForUpdates()}>Verificar atualizações</button>
      </section>

      {workspace.role === 'owner' ? (
        <section className="content-card danger-zone">
          <div><h2>Excluir equipe</h2><p>Remove permanentemente clientes, quadros, tarefas e links desta equipe.</p></div>
          <button className="danger-button" onClick={() => void deleteWorkspace()} disabled={saving}><Trash2 size={16} />Excluir equipe</button>
        </section>
      ) : null}
    </div>
  );
}

function ThemeOption({
  icon: Icon,
  title,
  description,
  active,
  saving,
  onClick,
}: {
  icon: typeof Sun;
  title: string;
  description: string;
  active: boolean;
  saving: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`theme-option ${active ? 'active' : ''}`}
      role="radio"
      aria-checked={active}
      disabled={saving}
      onClick={onClick}
    >
      <span className="theme-option-preview"><Icon size={21} /></span>
      <span><strong>{title}</strong><small>{description}</small></span>
      <i aria-hidden="true" />
    </button>
  );
}

function DesktopPreference({
  icon: Icon,
  title,
  description,
  checked,
  saving,
  onChange,
}: {
  icon: typeof Power;
  title: string;
  description: string;
  checked: boolean;
  saving: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="desktop-preference-row">
      <span className="desktop-preference-icon"><Icon size={17} /></span>
      <span className="desktop-preference-copy"><strong>{title}</strong><small>{description}</small></span>
      <input type="checkbox" checked={checked} disabled={saving} onChange={(event) => onChange(event.target.checked)} />
      <span className="settings-switch" aria-hidden="true"><i /></span>
    </label>
  );
}

function roleLabel(role: WorkspaceRole) {
  if (role === 'owner') return 'Proprietário';
  if (role === 'admin') return 'Administrador';
  return 'Editor';
}

function availabilityLabel(availability: MemberAvailability) {
  if (availability === 'busy') return 'Ocupado';
  if (availability === 'away') return 'Ausente';
  return 'Disponível';
}

function normalizeBillingSetting(row: Record<string, unknown>) {
  return { ...row, amount_usd: Number(row.amount_usd), bundle_size: Number(row.bundle_size) } as ClientBillingSetting;
}

function billingDescription(setting: ClientBillingSetting) {
  const amount = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(setting.amount_usd);
  return setting.pricing_model === 'per_video'
    ? `${amount} por vídeo`
    : `${amount} a cada ${setting.bundle_size} vídeos`;
}

function isMissingFinanceSchema(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes('client_billing_settings') || normalized.includes('schema cache');
}

function translateMemberError(message: string) {
  if (message.toLowerCase().includes('already a workspace member')) return 'Essa pessoa já faz parte da equipe.';
  if (message.toLowerCase().includes('valid email')) return 'Digite um e-mail válido.';
  return message;
}
