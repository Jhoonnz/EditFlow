import { FormEvent, useCallback, useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { Building2, LoaderCircle, Mail, Pencil, Plus, Save, Trash2, UserPlus, Users } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import type { Client, Task, WorkspaceMember, WorkspaceRole, WorkspaceSummary } from './types';

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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setEmail('');
    setError(null);
  };

  const saveClient = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase || !name.trim()) return setError('Digite o nome do cliente.');
    setSaving(true);
    setError(null);
    const payload = { name: name.trim(), email: email.trim() || null };
    const result = editingId
      ? await supabase.from('clients').update(payload).eq('id', editingId)
      : await supabase.from('clients').insert({ ...payload, workspace_id: workspace.id });
    setSaving(false);
    if (result.error) return setError(result.error.message);
    resetForm();
    await onChanged();
  };

  const editClient = (client: Client) => {
    setEditingId(client.id);
    setName(client.name);
    setEmail(client.email ?? '');
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
            return (
              <article className="client-row" key={client.id}>
                <span className="client-avatar">{client.name.slice(0, 1).toUpperCase()}</span>
                <div className="client-copy"><strong>{client.name}</strong><small>{client.email || 'Sem e-mail'} · {taskCount} {taskCount === 1 ? 'trabalho' : 'trabalhos'}</small></div>
                <button onClick={() => editClient(client)} aria-label={`Editar ${client.name}`}><Pencil size={15} /></button>
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
}: {
  user: User;
  workspace: WorkspaceSummary;
  onWorkspacesChanged: () => Promise<void>;
}) {
  const [workspaceName, setWorkspaceName] = useState(workspace.name);
  const [displayName, setDisplayName] = useState(String(user.user_metadata.full_name ?? ''));
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Exclude<WorkspaceRole, 'owner'>>('editor');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canManage = workspace.role === 'owner' || workspace.role === 'admin';

  useEffect(() => setWorkspaceName(workspace.name), [workspace.id, workspace.name]);

  const loadMembers = useCallback(async () => {
    if (!supabase) return;
    const { data: memberships, error: membershipError } = await supabase
      .from('workspace_members')
      .select('user_id, role')
      .eq('workspace_id', workspace.id);
    if (membershipError) return setError(membershipError.message);
    const ids = (memberships ?? []).map((item) => item.user_id as string);
    const profiles = ids.length
      ? await supabase.from('profiles').select('id, display_name').in('id', ids)
      : { data: [], error: null };
    if (profiles.error) return setError(profiles.error.message);
    const names = new Map((profiles.data ?? []).map((profile) => [profile.id as string, profile.display_name as string]));
    setMembers((memberships ?? []).map((item) => ({
      user_id: item.user_id as string,
      role: item.role as WorkspaceRole,
      display_name: names.get(item.user_id as string) || (item.user_id === user.id ? user.email || 'Você' : 'Membro'),
    })));
  }, [user.email, user.id, workspace.id]);

  useEffect(() => { void loadMembers(); }, [loadMembers]);

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
    const { error: inviteError } = await supabase.rpc('add_workspace_member', {
      target_workspace: workspace.id,
      member_email: inviteEmail.trim(),
      member_role: inviteRole,
    });
    setSaving(false);
    if (inviteError) return setError(translateMemberError(inviteError.message));
    setInviteEmail('');
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
        <div className="content-card-heading"><span className="content-icon"><UserPlus size={18} /></span><div><h2>Membros</h2><p>Convide pessoas que já possuem uma conta no EditFlow.</p></div></div>
        {canManage ? (
          <form className="invite-form" onSubmit={addMember}>
            <label><Mail size={16} /><input type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} placeholder="email@exemplo.com" /></label>
            <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as Exclude<WorkspaceRole, 'owner'>)}><option value="editor">Editor</option><option value="admin">Administrador</option></select>
            <button className="primary-button" type="submit" disabled={saving}><Plus size={16} />Adicionar</button>
          </form>
        ) : null}
        <div className="member-list">
          {members.map((member) => (
            <article className="member-row" key={member.user_id}>
              <span className="client-avatar">{member.display_name.slice(0, 1).toUpperCase()}</span>
              <div className="client-copy"><strong>{member.display_name}{member.user_id === user.id ? ' (você)' : ''}</strong><small>{roleLabel(member.role)}</small></div>
              {canManage && member.role !== 'owner' ? <button className="danger-icon" onClick={() => void removeMember(member)} aria-label="Remover membro"><Trash2 size={15} /></button> : null}
            </article>
          ))}
        </div>
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

function roleLabel(role: WorkspaceRole) {
  if (role === 'owner') return 'Proprietário';
  if (role === 'admin') return 'Administrador';
  return 'Editor';
}

function translateMemberError(message: string) {
  if (message.toLowerCase().includes('no editflow account')) return 'Essa pessoa precisa criar uma conta no EditFlow antes de ser adicionada.';
  return message;
}
