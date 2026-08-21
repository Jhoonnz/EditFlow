import { FormEvent, useCallback, useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { AlertTriangle, AppWindow, Bell, BriefcaseBusiness, Building2, CalendarClock, Camera, CheckCircle2, CircleDollarSign, Eye, ExternalLink, KeyRound, Laptop, ListVideo, LoaderCircle, LockKeyhole, Mail, MonitorCog, Moon, MoreHorizontal, PackageCheck, Palette, Pencil, Plus, Power, RefreshCw, Save, Search, ShieldCheck, Sun, Trash2, UserPlus, UserRound, Users, Video, X, Youtube } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAppDialog } from '../../components/AppDialog';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { estimateNetUsd, paymentFeeRule, paymentFeeRules, paymentMethodLabel } from '../finance/paymentFees';
import type { BillingCurrency, BillingPricingModel, Client, ClientBillingSetting, EditFlowAccountSearchResult, PaymentMethod, Task, WorkspaceInvitation, WorkspaceMember, WorkspaceRole, WorkspaceSummary } from './types';

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
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [youtubeChannelUrl, setYoutubeChannelUrl] = useState('');
  const [billingSettings, setBillingSettings] = useState<ClientBillingSetting[]>([]);
  const [billingAvailable, setBillingAvailable] = useState(true);
  const [billingLoading, setBillingLoading] = useState(workspace.role === 'owner');
  const [billingMode, setBillingMode] = useState<'none' | BillingPricingModel>('none');
  const [billingCurrency, setBillingCurrency] = useState<BillingCurrency>('USD');
  const [amountUsd, setAmountUsd] = useState('');
  const [bundleSize, setBundleSize] = useState('5');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('none');
  const [feePercent, setFeePercent] = useState('0');
  const [feeFixedUsd, setFeeFixedUsd] = useState('0');
  const [conversionSpreadPercent, setConversionSpreadPercent] = useState('0');
  const [saving, setSaving] = useState(false);
  const [syncingClientId, setSyncingClientId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const appDialog = useAppDialog();
  const isOwner = workspace.role === 'owner';

  const loadBillingSettings = useCallback(async () => {
    if (!supabase || !isOwner) {
      setBillingLoading(false);
      return;
    }
    setBillingLoading(true);
    const { data, error: billingError } = await supabase
      .from('client_billing_settings')
      .select('client_id, workspace_id, currency, pricing_model, amount_usd, bundle_size, payment_method, fee_percent, fee_fixed_usd, conversion_spread_percent, created_at, updated_at')
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
    setYoutubeChannelUrl('');
    setBillingMode('none');
    setBillingCurrency('USD');
    setAmountUsd('');
    setBundleSize('5');
    applyPaymentMethod('none');
    setError(null);
    setFormOpen(false);
  };

  const openCreateForm = () => {
    resetForm();
    setFormOpen(true);
  };

  const applyPaymentMethod = (method: PaymentMethod) => {
    const rule = paymentFeeRule(method);
    setPaymentMethod(method);
    setFeePercent(String(rule.feePercent));
    setFeeFixedUsd(String(rule.fixedFeeUsd));
    setConversionSpreadPercent(String(rule.conversionSpreadPercent));
  };

  const applyBillingCurrency = (currency: BillingCurrency) => {
    setBillingCurrency(currency);
    if (currency === 'BRL') applyPaymentMethod('none');
  };

  const syncYoutubeChannel = async (clientId: string) => {
    if (!supabase) return 'O Supabase não está configurado.';
    const { error: syncError } = await supabase.functions.invoke('sync-youtube-channel', {
      body: { clientId },
    });
    return syncError ? await edgeFunctionErrorMessage(syncError) : null;
  };

  const refreshYoutubeChannel = async (client: Client) => {
    if (!client.youtube_channel_url || syncingClientId) return;
    setSyncingClientId(client.id);
    setError(null);
    const syncError = await syncYoutubeChannel(client.id);
    setSyncingClientId(null);
    if (syncError) return setError(syncError);
    await onChanged();
  };

  const saveClient = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase || !name.trim()) return setError('Digite o nome do cliente.');
    if (youtubeChannelUrl.trim() && !isSupportedYoutubeChannelUrl(youtubeChannelUrl.trim())) {
      return setError('Use o link no formato youtube.com/@canal ou youtube.com/channel/UC...');
    }
    const parsedAmount = Number(amountUsd.replace(',', '.'));
    const parsedBundleSize = billingMode === 'bundle' ? Number(bundleSize) : 1;
    const parsedFeePercent = Number(feePercent.replace(',', '.'));
    const parsedFixedFee = Number(feeFixedUsd.replace(',', '.'));
    const parsedConversionSpread = Number(conversionSpreadPercent.replace(',', '.'));
    if (isOwner && billingMode !== 'none' && (!Number.isFinite(parsedAmount) || parsedAmount <= 0)) return setError(`Digite um valor em ${billingCurrency === 'BRL' ? 'real' : 'dólar'} maior que zero.`);
    if (isOwner && billingMode === 'bundle' && (!Number.isInteger(parsedBundleSize) || parsedBundleSize < 2)) return setError('O pacote precisa ter pelo menos 2 vídeos.');
    if (isOwner && billingMode !== 'none' && (!validPercent(parsedFeePercent) || !validPercent(parsedConversionSpread) || !Number.isFinite(parsedFixedFee) || parsedFixedFee < 0)) return setError('Revise as taxas de recebimento informadas.');

    setSaving(true);
    setError(null);
    const channelUrl = youtubeChannelUrl.trim() || null;
    const previousClient = editingId ? clients.find((client) => client.id === editingId) : null;
    const channelChanged = (previousClient?.youtube_channel_url ?? null) !== channelUrl;
    const payload = {
      name: name.trim(),
      email: email.trim() || null,
      youtube_channel_url: channelUrl,
      ...(channelChanged ? {
        youtube_channel_id: null,
        youtube_channel_title: null,
        youtube_thumbnail_url: null,
        youtube_subscriber_count: null,
        youtube_average_views: null,
        youtube_uploads_per_month: null,
        youtube_video_count: null,
        youtube_last_synced_at: null,
      } : {}),
    };
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
          currency: billingCurrency,
          pricing_model: billingMode,
          amount_usd: parsedAmount,
          bundle_size: parsedBundleSize,
          payment_method: paymentMethod,
          fee_percent: parsedFeePercent,
          fee_fixed_usd: parsedFixedFee,
          conversion_spread_percent: billingCurrency === 'BRL' ? 0 : parsedConversionSpread,
        }, { onConflict: 'client_id' });
      if (billingResult.error) {
        if (createdClientId) await supabase.from('clients').delete().eq('id', createdClientId);
        setSaving(false);
        return setError(isMissingFinanceSchema(billingResult.error.message)
            ? 'Atualize o módulo financeiro executando a migration 020_financial_currencies.sql no Supabase.'
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

    if (clientId && channelUrl && (!editingId || channelChanged)) {
      const youtubeError = await syncYoutubeChannel(clientId);
      if (youtubeError) {
        setSaving(false);
        setEditingId(clientId);
        setFormOpen(true);
        await onChanged();
        return setError(`Cliente salvo, mas o canal não foi atualizado: ${youtubeError}`);
      }
    }

    setSaving(false);
    resetForm();
    await loadBillingSettings();
    await onChanged();
  };

  const editClient = (client: Client) => {
    setEditingId(client.id);
    setFormOpen(true);
    setName(client.name);
    setEmail(client.email ?? '');
    setYoutubeChannelUrl(client.youtube_channel_url ?? '');
    const setting = billingSettings.find((item) => item.client_id === client.id);
    setBillingMode(setting?.pricing_model ?? 'none');
    setBillingCurrency(setting?.currency ?? 'USD');
    setAmountUsd(setting ? String(setting.amount_usd) : '');
    setBundleSize(setting ? String(setting.bundle_size) : '5');
    if (setting) {
      setPaymentMethod(setting.payment_method);
      setFeePercent(String(setting.fee_percent));
      setFeeFixedUsd(String(setting.fee_fixed_usd));
      setConversionSpreadPercent(String(setting.conversion_spread_percent));
    } else {
      applyPaymentMethod('none');
    }
    setError(null);
  };

  const deleteClient = async (client: Client) => {
    if (!supabase) return;
    const confirmed = await appDialog.confirm({
      title: `Excluir “${client.name}”?`,
      description: 'As tarefas serão mantidas, mas ficarão sem um cliente associado.',
      confirmLabel: 'Excluir cliente',
      tone: 'danger',
    });
    if (!confirmed) return;
    const { error: deleteError } = await supabase.from('clients').delete().eq('id', client.id);
    if (deleteError) return setError(deleteError.message);
    if (editingId === client.id) resetForm();
    await onChanged();
  };

  return (
    <div className={`content-view clients-view ${formOpen ? 'form-open' : ''}`}>
      {!formOpen && error ? <div className="panel-error client-page-error">{error}</div> : null}
      {formOpen ? <section className="content-card client-form-card">
        <div className="content-card-heading">
          <span className="content-icon"><Plus size={18} /></span>
          <div><h2>{editingId ? 'Editar cliente' : 'Novo cliente'}</h2><p>Organize os trabalhos por cliente.</p></div>
          <button type="button" className="client-form-close" onClick={resetForm} aria-label="Fechar formulário"><X size={16} /></button>
        </div>
        <form className="settings-form" onSubmit={saveClient}>
          <label><span>Nome</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nome do cliente" /></label>
          <label><span>E-mail</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="contato@cliente.com" /></label>
          <label className="youtube-channel-field">
            <span>Canal do YouTube</span>
            <div><Youtube size={16} /><input type="url" value={youtubeChannelUrl} onChange={(event) => setYoutubeChannelUrl(event.target.value)} placeholder="https://youtube.com/@canal" /></div>
            <small>A foto, inscritos, média de views e frequência serão atualizados pelos 12 vídeos mais recentes.</small>
          </label>
          {isOwner && billingAvailable ? (
            <fieldset className="client-payment-panel">
              <legend><CircleDollarSign size={15} /><span><strong>Pagamento do cliente</strong><small>O valor será contabilizado quando o trabalho for entregue.</small></span></legend>
              <div className="client-payment-models">
                <button type="button" className={billingMode === 'none' ? 'active' : ''} onClick={() => setBillingMode('none')}><X size={15} /><span><strong>Não contabilizar</strong><small>Sem ganhos automáticos</small></span></button>
                <button type="button" className={billingMode === 'per_video' ? 'active' : ''} onClick={() => setBillingMode('per_video')}><Video size={15} /><span><strong>Por vídeo</strong><small>Valor por entrega</small></span></button>
                <button type="button" className={billingMode === 'bundle' ? 'active' : ''} onClick={() => setBillingMode('bundle')}><PackageCheck size={15} /><span><strong>Por pacote</strong><small>Valor a cada lote</small></span></button>
              </div>
              {billingMode !== 'none' ? (
                <>
                  <div className="client-payment-values">
                      <label><span>Moeda do pagamento</span><select className="client-currency-select" value={billingCurrency} onChange={(event) => applyBillingCurrency(event.target.value as BillingCurrency)}><option value="USD">Dólar americano (USD)</option><option value="BRL">Real brasileiro (BRL)</option></select></label>
                      <label><span>Valor bruto</span><div><b>{billingCurrency === 'BRL' ? 'R$' : 'US$'}</b><input inputMode="decimal" value={amountUsd} onChange={(event) => setAmountUsd(event.target.value)} placeholder={billingCurrency === 'BRL' ? '800,00' : '200.00'} /></div></label>
                    {billingMode === 'bundle' ? <label><span>Vídeos no pacote</span><div><input type="number" min="2" max="1000" value={bundleSize} onChange={(event) => setBundleSize(event.target.value)} /><b>vídeos</b></div></label> : null}
                  </div>
                  <label className="payment-provider-select"><span>Como você recebe</span><select value={paymentMethod} onChange={(event) => applyPaymentMethod(event.target.value as PaymentMethod)}>{paymentFeeRules.filter((rule) => billingCurrency === 'USD' || rule.method === 'none' || rule.method === 'custom').map((rule) => <option value={rule.method} key={rule.method}>{rule.label}</option>)}</select></label>
                  {paymentMethod === 'custom' ? (
                    <div className="client-fee-values">
                      <label><span>Taxa percentual</span><div><input inputMode="decimal" value={feePercent} onChange={(event) => setFeePercent(event.target.value)} /><b>%</b></div></label>
                      <label><span>Taxa fixa</span><div><b>{billingCurrency === 'BRL' ? 'R$' : 'US$'}</b><input inputMode="decimal" value={feeFixedUsd} onChange={(event) => setFeeFixedUsd(event.target.value)} /></div></label>
                      {billingCurrency === 'USD' ? <label><span>Spread de conversão</span><div><input inputMode="decimal" value={conversionSpreadPercent} onChange={(event) => setConversionSpreadPercent(event.target.value)} /><b>%</b></div></label> : null}
                    </div>
                  ) : null}
                  <PaymentEstimate currency={billingCurrency} grossAmount={Number(amountUsd.replace(',', '.'))} paymentMethod={paymentMethod} feePercent={Number(feePercent.replace(',', '.'))} fixedFee={Number(feeFixedUsd.replace(',', '.'))} conversionSpreadPercent={billingCurrency === 'BRL' ? 0 : Number(conversionSpreadPercent.replace(',', '.'))} />
                </>
              ) : null}
            </fieldset>
          ) : isOwner ? <div className="client-payment-unavailable">Execute as migrations financeiras pendentes, incluindo a 020, para configurar pagamentos automáticos.</div> : null}
          {error ? <div className="panel-error">{error}</div> : null}
          <div className="form-actions">
            {editingId ? <button type="button" className="secondary-button" onClick={resetForm}>Cancelar</button> : null}
            <button className="primary-button" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spinner" size={16} /> : <Save size={16} />}{editingId ? 'Salvar' : 'Adicionar cliente'}</button>
          </div>
        </form>
      </section> : null}

      <section className="content-card client-list-card">
        <div className="content-card-heading client-list-heading">
          <span className="content-icon"><Users size={18} /></span>
          <div><h2>Seus clientes</h2><p>{clients.length} cadastrados</p></div>
          <button type="button" className="primary-button client-create-button" onClick={openCreateForm}><Plus size={16} />Novo cliente</button>
        </div>
        <div className="client-list">
          {clients.map((client) => {
            const taskCount = tasks.filter((task) => task.client_id === client.id).length;
            const setting = billingSettings.find((item) => item.client_id === client.id);
            return (
              <article className={`client-row ${client.youtube_channel_id ? 'has-youtube' : ''}`} key={client.id}>
                <span className="client-avatar">{client.youtube_thumbnail_url ? <img src={client.youtube_thumbnail_url} alt="" /> : client.name.slice(0, 1).toUpperCase()}</span>
                <div className="client-copy">
                  <strong>{client.name}</strong>
                  <small>{client.email || 'Sem e-mail'} · {taskCount} {taskCount === 1 ? 'trabalho' : 'trabalhos'}{isOwner ? ` · ${setting ? billingDescription(setting) : 'sem pagamento automático'}` : ''}</small>
                  {client.youtube_channel_url ? (
                    <div className="client-youtube-summary">
                      <button type="button" onClick={() => void window.editflow.openExternal(client.youtube_channel_url!)} title="Abrir canal no YouTube"><Youtube size={13} /><b>{client.youtube_channel_title || 'Canal conectado'}</b><ExternalLink size={10} /></button>
                      {client.youtube_last_synced_at ? (
                        <span>
                          <i>{client.youtube_subscriber_count === null ? 'Inscritos ocultos' : `${compactNumber(client.youtube_subscriber_count)} inscritos`}</i>
                          <i>{client.youtube_average_views === null ? 'Sem média' : `${compactNumber(client.youtube_average_views)} views em média`}</i>
                          <i>{postingFrequency(client.youtube_uploads_per_month)}</i>
                        </span>
                      ) : <span><i>Aguardando sincronização</i></span>}
                    </div>
                  ) : null}
                </div>
                {client.youtube_channel_url ? <button disabled={syncingClientId !== null} onClick={() => void refreshYoutubeChannel(client)} aria-label={`Atualizar canal de ${client.name}`} title="Atualizar dados do canal">{syncingClientId === client.id ? <LoaderCircle className="spinner" size={15} /> : <RefreshCw size={15} />}</button> : null}
                <button disabled={isOwner && billingLoading} onClick={() => editClient(client)} aria-label={`Editar ${client.name}`}><Pencil size={15} /></button>
                <button className="danger-icon" onClick={() => void deleteClient(client)} aria-label={`Excluir ${client.name}`}><Trash2 size={15} /></button>
              </article>
            );
          })}
          {!clients.length ? <div className="empty-panel">Nenhum cliente cadastrado ainda.</div> : null}
        </div>
      </section>
      {appDialog.host}
    </div>
  );
}

type TeamFilter = 'all' | 'available' | 'admins';

export function TeamView({
  userId,
  workspace,
  members,
  tasks,
  onChanged,
  onMemberProfile,
  onMemberTasks,
}: {
  userId: string;
  workspace: WorkspaceSummary;
  members: WorkspaceMember[];
  tasks: Task[];
  onChanged: () => Promise<void>;
  onMemberProfile: (memberId: string) => void;
  onMemberTasks: (member: WorkspaceMember) => void;
}) {
  const [filter, setFilter] = useState<TeamFilter>('all');
  const [search, setSearch] = useState('');
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Exclude<WorkspaceRole, 'owner'>>('editor');
  const [accountResults, setAccountResults] = useState<EditFlowAccountSearchResult[]>([]);
  const [selectedAccount, setSelectedAccount] = useState<EditFlowAccountSearchResult | null>(null);
  const [searchingAccounts, setSearchingAccounts] = useState(false);
  const [accountSearchError, setAccountSearchError] = useState<string | null>(null);
  const [pendingInvitations, setPendingInvitations] = useState<WorkspaceInvitation[]>([]);
  const [memberMenuId, setMemberMenuId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canManage = workspace.role === 'owner' || workspace.role === 'admin';
  const appDialog = useAppDialog();

  useEffect(() => {
    if (!memberMenuId) return;
    const dismiss = (event: PointerEvent) => {
      if (!(event.target as Element).closest('.team-card-menu-wrap')) setMemberMenuId(null);
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMemberMenuId(null);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', dismissOnEscape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', dismissOnEscape);
    };
  }, [memberMenuId]);

  const loadInvitations = useCallback(async () => {
    if (!supabase || !canManage) return setPendingInvitations([]);
    const { data, error: invitationError } = await supabase
      .from('workspace_invitations')
      .select('id, workspace_id, email, role, status, expires_at, created_at')
      .eq('workspace_id', workspace.id)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });
    if (invitationError) return setError(invitationError.message);
    setPendingInvitations((data ?? []).map((invitation) => ({
      ...invitation,
      workspace_name: workspace.name,
    })) as WorkspaceInvitation[]);
  }, [canManage, workspace.id, workspace.name]);

  useEffect(() => { void loadInvitations(); }, [loadInvitations]);

  useEffect(() => {
    const query = inviteEmail.trim();
    if (!supabase || !canManage || !inviteOpen || selectedAccount || query.length < 2) {
      setAccountResults([]);
      setSearchingAccounts(false);
      setAccountSearchError(null);
      return;
    }

    const accountSearchClient = supabase;
    let active = true;
    setSearchingAccounts(true);
    setAccountSearchError(null);
    const timeout = window.setTimeout(() => {
      void accountSearchClient.rpc('search_editflow_accounts', {
        target_workspace: workspace.id,
        search_query: query,
        result_limit: 8,
      }).then(({ data, error: searchError }) => {
        if (!active) return;
        setSearchingAccounts(false);
        if (searchError) {
          setAccountResults([]);
          setAccountSearchError(/search_editflow_accounts|schema cache|could not find/i.test(searchError.message)
            ? 'Execute a migração 021 para ativar a busca de contas.'
            : 'Não foi possível buscar contas agora.');
          return;
        }
        setAccountResults((data ?? []) as EditFlowAccountSearchResult[]);
      });
    }, 280);

    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [canManage, inviteEmail, inviteOpen, selectedAccount, workspace.id]);

  useEffect(() => {
    if (!supabase || !canManage) return;
    const realtimeClient = supabase;
    const channel = realtimeClient
      .channel(`editflow-team-page:${workspace.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'workspace_invitations', filter: `workspace_id=eq.${workspace.id}` }, () => void loadInvitations())
      .subscribe();
    return () => { void realtimeClient.removeChannel(channel); };
  }, [canManage, loadInvitations, workspace.id]);

  const visibleMembers = members.filter((member) => {
    const matchesFilter = filter === 'all'
      || (filter === 'available' && member.availability === 'available')
      || (filter === 'admins' && (member.role === 'owner' || member.role === 'admin'));
    const term = search.trim().toLocaleLowerCase('pt-BR');
    return matchesFilter && (!term || `${member.display_name} ${member.email ?? ''} ${member.specialty ?? ''} ${teamRoleLabel(member.role)}`.toLocaleLowerCase('pt-BR').includes(term));
  });

  const inviteMember = async (event: FormEvent) => {
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
    if (inviteError) return setError(translateTeamError(inviteError.message));
    setInviteEmail('');
    setSelectedAccount(null);
    setAccountResults([]);
    setInviteOpen(false);
    await loadInvitations();
  };

  const cancelInvitation = async (invitation: WorkspaceInvitation) => {
    if (!supabase) return;
    const confirmed = await appDialog.confirm({
      title: 'Cancelar convite?',
      description: `O convite enviado para ${invitation.email} deixará de ser válido.`,
      confirmLabel: 'Cancelar convite',
      tone: 'danger',
    });
    if (!confirmed) return;
    const { error: cancelError } = await supabase.rpc('cancel_workspace_invitation', { target_invitation: invitation.id });
    if (cancelError) return setError(cancelError.message);
    await loadInvitations();
  };

  const changeMemberRole = async (member: WorkspaceMember, role: Exclude<WorkspaceRole, 'owner'>) => {
    if (!supabase) return;
    setSaving(true);
    setError(null);
    const { error: roleError } = await supabase.rpc('change_workspace_member_role', {
      target_workspace: workspace.id,
      target_user: member.user_id,
      member_role: role,
    });
    setSaving(false);
    if (roleError) return setError(roleError.message);
    setMemberMenuId(null);
    await onChanged();
  };

  const removeMember = async (member: WorkspaceMember) => {
    if (!supabase) return;
    const confirmed = await appDialog.confirm({
      title: `Remover ${member.display_name}?`,
      description: 'A pessoa perderá o acesso à equipe e suas tarefas ficarão sem responsável.',
      confirmLabel: 'Remover membro',
      tone: 'danger',
    });
    if (!confirmed) return;
    setSaving(true);
    const { error: removeError } = await supabase.rpc('remove_workspace_member', {
      target_workspace: workspace.id,
      target_user: member.user_id,
    });
    setSaving(false);
    if (removeError) return setError(removeError.message);
    setMemberMenuId(null);
    await onChanged();
  };

  return (
    <div className="team-view">
      <section className="team-hero">
        <div><span>EQUIPE</span><h2>Pessoas que fazem acontecer.</h2><p>Veja a disponibilidade e a carga de trabalho de cada colaborador.</p></div>
        <label className="team-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar membro..." /></label>
      </section>

      <div className="team-toolbar">
        <div className="team-filters" role="group" aria-label="Filtrar membros">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>Todos <small>{members.length}</small></button>
          <button className={filter === 'available' ? 'active' : ''} onClick={() => setFilter('available')}>Disponíveis</button>
          <button className={filter === 'admins' ? 'active' : ''} onClick={() => setFilter('admins')}>Gestores</button>
        </div>
        {canManage ? <button className="team-invite-button" onClick={() => setInviteOpen((open) => { if (open) { setInviteEmail(''); setSelectedAccount(null); setAccountResults([]); } return !open; })}>{inviteOpen ? <X size={16} /> : <UserPlus size={16} />}{inviteOpen ? 'Fechar' : 'Convidar membro'}</button> : null}
      </div>

      {error ? <div className="panel-error">{error}</div> : null}
      {inviteOpen && canManage ? (
        <form className="team-invite-panel" onSubmit={inviteMember}>
          <div className="team-invite-intro"><Mail size={18} /><span><strong>Novo convite</strong><small>Busque uma conta EditFlow ou digite um e-mail.</small></span></div>
          <section className="team-account-search">
            <span className="sr-only">Nome ou e-mail</span>
            {selectedAccount?.avatar_url ? <img src={selectedAccount.avatar_url} alt="" /> : <Search size={15} />}
            <input
              type="text"
              value={inviteEmail}
              onChange={(event) => { setInviteEmail(event.target.value); setSelectedAccount(null); }}
              placeholder="Nome ou email@exemplo.com"
              aria-label="Nome ou e-mail da pessoa"
              autoComplete="off"
              autoFocus
            />
            {searchingAccounts ? <LoaderCircle className="spinner team-account-search-spinner" size={14} /> : null}
            {!selectedAccount && inviteEmail.trim().length >= 2 && !searchingAccounts ? (
              <div className="team-account-results" aria-label="Contas EditFlow encontradas">
                {accountResults.map((account) => (
                  <button
                    key={account.user_id}
                    type="button"
                    onClick={() => { setSelectedAccount(account); setInviteEmail(account.email); setAccountResults([]); setAccountSearchError(null); }}
                  >
                    <span className="team-account-avatar">{account.avatar_url ? <img src={account.avatar_url} alt="" /> : account.display_name.slice(0, 1).toUpperCase()}</span>
                    <span><strong>{account.display_name}</strong><small>{account.email}</small></span>
                    <em>Convidar</em>
                  </button>
                ))}
                {!accountResults.length && !accountSearchError ? <p>Nenhuma conta encontrada. Você ainda pode convidar pelo e-mail completo.</p> : null}
                {accountSearchError ? <p className="error">{accountSearchError}</p> : null}
              </div>
            ) : null}
          </section>
          <select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as Exclude<WorkspaceRole, 'owner'>)} aria-label="Cargo do convite"><option value="editor">Editor</option><option value="admin">Administrador</option></select>
          <button className="primary-button" type="submit" disabled={saving || !isValidInviteEmail(inviteEmail)}>{saving ? <LoaderCircle className="spinner" size={15} /> : <Plus size={15} />}Enviar convite</button>
        </form>
      ) : null}

      {pendingInvitations.length ? <section className="team-pending"><header><strong>Convites pendentes</strong><small>{pendingInvitations.length}</small></header><div>{pendingInvitations.map((invitation) => <article key={invitation.id}><span>{invitation.email.slice(0,1).toUpperCase()}</span><div><strong>{invitation.email}</strong><small>{teamRoleLabel(invitation.role)} · expira em {new Date(invitation.expires_at).toLocaleDateString('pt-BR')}</small></div><button onClick={() => void cancelInvitation(invitation)} aria-label="Cancelar convite"><X size={14} /></button></article>)}</div></section> : null}

      <section className="team-grid">
        {visibleMembers.map((member) => {
          const memberTasks = tasks.filter((task) => task.assignee_id === member.user_id);
          const activeTasks = memberTasks.filter((task) => !task.completed_at).length;
          const deliveredTasks = memberTasks.filter((task) => Boolean(task.completed_at)).length;
          const canManageMember = canManage && member.role !== 'owner' && member.user_id !== userId;
          return <article className="team-profile-card" key={member.user_id}>
            <span className={`team-presence ${member.availability}`} title={teamAvailabilityLabel(member.availability)} />
            {canManageMember ? <div className="team-card-menu-wrap"><button className="team-card-menu-button" onClick={() => setMemberMenuId((current) => current === member.user_id ? null : member.user_id)} aria-label={`Gerenciar ${member.display_name}`}><MoreHorizontal size={17} /></button>{memberMenuId === member.user_id ? <div className="team-card-menu"><label><span>Cargo</span><select value={member.role} disabled={saving} onChange={(event) => void changeMemberRole(member, event.target.value as Exclude<WorkspaceRole, 'owner'>)}><option value="editor">Editor</option><option value="admin">Administrador</option></select></label><button onClick={() => void removeMember(member)}><Trash2 size={13} />Remover da equipe</button></div> : null}</div> : null}
            <button className="team-card-avatar" onClick={() => onMemberProfile(member.user_id)} aria-label={`Abrir perfil de ${member.display_name}`}>{member.avatar_url ? <img src={member.avatar_url} alt="" /> : <span>{member.display_name.slice(0,1).toUpperCase()}</span>}</button>
            <div className="team-card-copy"><h3>{member.display_name}{member.user_id === userId ? <small>você</small> : null}</h3><p>{member.specialty || teamRoleLabel(member.role)}</p><span>{activeTasks} {activeTasks === 1 ? 'trabalho ativo' : 'trabalhos ativos'} · {deliveredTasks} entregues</span><em className={member.availability}>{teamAvailabilityLabel(member.availability)}</em></div>
            <footer><button onClick={() => onMemberProfile(member.user_id)}><UserRound size={15} />Perfil</button><button onClick={() => onMemberTasks(member)}><ListVideo size={15} />Trabalhos</button></footer>
          </article>;
        })}
        {canManage && filter === 'all' && !search.trim() ? <button className="team-add-card" onClick={() => { setInviteOpen(true); window.setTimeout(() => document.querySelector<HTMLInputElement>('.team-invite-panel input')?.focus(), 0); }}><span><UserPlus size={25} /></span><strong>Adicionar membro</strong><small>Convide alguém para colaborar com sua equipe.</small></button> : null}
      </section>
      {!visibleMembers.length ? <div className="team-empty"><Users size={24} /><strong>Nenhum membro encontrado</strong><span>Tente mudar o filtro ou o termo de busca.</span></div> : null}
      {appDialog.host}
    </div>
  );
}

export type SettingsTab = 'general' | 'profile' | 'security' | 'application';

const settingsTabs: Array<{ id: SettingsTab; label: string; icon: typeof Building2 }> = [
  { id: 'general', label: 'Geral', icon: Building2 },
  { id: 'profile', label: 'Meu perfil', icon: UserRound },
  { id: 'security', label: 'Segurança', icon: ShieldCheck },
  { id: 'application', label: 'Aplicativo', icon: AppWindow },
];

export function SettingsView({
  user,
  workspace,
  tasks,
  currentAvailability,
  requestedTab,
  requestedTabToken,
  onDirtyChange,
  onWorkspacesChanged,
  onProfileChanged,
}: {
  user: User;
  workspace: WorkspaceSummary;
  tasks: Task[];
  currentAvailability: WorkspaceMember['availability'];
  requestedTab?: SettingsTab;
  requestedTabToken?: number;
  onDirtyChange?: (dirty: boolean) => void;
  onWorkspacesChanged: () => Promise<void>;
  onProfileChanged: (profile?: { displayName?: string; avatarUrl?: string | null }) => Promise<void>;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [workspaceName, setWorkspaceName] = useState(workspace.name);
  const [displayName, setDisplayName] = useState(String(user.user_metadata.full_name ?? ''));
  const [specialty, setSpecialty] = useState('');
  const [bio, setBio] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileSnapshot, setProfileSnapshot] = useState({ displayName: '', specialty: '', bio: '' });
  const [avatarSaving, setAvatarSaving] = useState(false);
  const [cropSource, setCropSource] = useState<string | null>(null);
  const [cropZoom, setCropZoom] = useState(1);
  const [cropX, setCropX] = useState(0);
  const [cropY, setCropY] = useState(0);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState('...');
  const [desktopPreferences, setDesktopPreferences] = useState<EditFlowDesktopPreferences | null>(null);
  const [desktopSaving, setDesktopSaving] = useState<keyof EditFlowDesktopPreferences | null>(null);
  const canManage = workspace.role === 'owner' || workspace.role === 'admin';
  const appDialog = useAppDialog();
  useDialogFocus<HTMLElement>(Boolean(cropSource) && !appDialog.open, () => setCropSource(null), !avatarSaving, '.profile-crop-modal');

  useEffect(() => setWorkspaceName(workspace.name), [workspace.id, workspace.name]);
  useEffect(() => { void window.editflow.getVersion().then(setAppVersion); }, []);
  useEffect(() => { void window.editflow.getDesktopPreferences().then(setDesktopPreferences); }, []);
  useEffect(() => {
    if (!supabase) return setProfileLoading(false);
    let active = true;
    void (async () => {
      setProfileLoading(true);
      let result = await supabase
        .from('profiles')
        .select('display_name, avatar_url, availability, specialty, bio')
        .eq('id', user.id)
        .single();
      if (result.error && /specialty|bio/i.test(result.error.message)) {
        result = await supabase
          .from('profiles')
          .select('display_name, avatar_url, availability')
          .eq('id', user.id)
          .single();
      }
      if (!active) return;
      if (result.error) {
        setError(result.error.message);
        setProfileLoading(false);
        return;
      }
      const profile = result.data as {
        display_name?: string;
        avatar_url?: string | null;
        specialty?: string;
        bio?: string;
      };
      const nextProfile = {
        displayName: profile.display_name || String(user.user_metadata.full_name ?? ''),
        specialty: profile.specialty ?? '',
        bio: profile.bio ?? '',
      };
      setDisplayName(nextProfile.displayName);
      setSpecialty(nextProfile.specialty);
      setBio(nextProfile.bio);
      setAvatarUrl(profile.avatar_url ?? null);
      setProfileSnapshot(nextProfile);
      setProfileLoading(false);
    })();
    return () => { active = false; };
  }, [user.id, user.user_metadata.full_name]);

  const profileDirty = !profileLoading && (
    displayName.trim() !== profileSnapshot.displayName
    || specialty.trim() !== profileSnapshot.specialty
    || bio.trim() !== profileSnapshot.bio
  );
  const workspaceDirty = canManage && workspaceName.trim() !== workspace.name;
  useEffect(() => {
    onDirtyChange?.(profileDirty || workspaceDirty);
    return () => onDirtyChange?.(false);
  }, [onDirtyChange, profileDirty, workspaceDirty]);
  useEffect(() => {
    if (!profileDirty) return;
    const warnBeforeClose = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warnBeforeClose);
    return () => window.removeEventListener('beforeunload', warnBeforeClose);
  }, [profileDirty]);
  const userTasks = tasks.filter((task) => task.assignee_id === user.id);
  const activeUserTasks = userTasks.filter((task) => !task.completed_at);
  const completedUserTasks = userTasks.filter((task) => Boolean(task.completed_at));
  const overdueUserTasks = activeUserTasks.filter((task) => task.due_at && new Date(task.due_at).getTime() < Date.now());
  const nextDeadline = activeUserTasks
    .filter((task) => Boolean(task.due_at))
    .sort((left, right) => new Date(left.due_at!).getTime() - new Date(right.due_at!).getTime())[0];

  const saveWorkspace = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase || workspaceName.trim().length < 2) return setError('O nome da equipe precisa ter pelo menos 2 caracteres.');
    setSaving(true);
    setError(null);
    setSuccess(null);
    const workspaceResult = canManage
      ? await supabase.from('workspaces').update({ name: workspaceName.trim() }).eq('id', workspace.id)
      : { error: null };
    setSaving(false);
    if (workspaceResult.error) return setError(workspaceResult.error.message);
    await onWorkspacesChanged();
    setSuccess('Configurações gerais salvas.');
  };

  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase || !displayName.trim()) return setError('Digite seu nome de exibição.');
    if (displayName.trim().length > 80) return setError('O nome de exibição deve ter no máximo 80 caracteres.');
    if (specialty.trim().length > 80) return setError('A especialidade deve ter no máximo 80 caracteres.');
    if (bio.trim().length > 500) return setError('A apresentação deve ter no máximo 500 caracteres.');
    setSaving(true);
    setError(null);
    setSuccess(null);
    const profileValues = {
      display_name: displayName.trim(),
      specialty: specialty.trim(),
      bio: bio.trim(),
    };
    const { error: profileError } = await supabase.from('profiles').update(profileValues).eq('id', user.id);
    const authResult = profileError ? null : await supabase.auth.updateUser({ data: { full_name: displayName.trim() } });
    setSaving(false);
    if (profileError) return setError(profileError.message);
    setProfileSnapshot({ displayName: profileValues.display_name, specialty: profileValues.specialty, bio: profileValues.bio });
    await onProfileChanged({ displayName: profileValues.display_name });
    if (authResult?.error) setError(`O perfil foi salvo, mas os dados da conta não foram sincronizados: ${authResult.error.message}`);
    else setSuccess('Seu perfil foi atualizado.');
  };

  const chooseAvatar = (file: File | undefined) => {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return setError('Escolha uma imagem JPG, PNG ou WebP.');
    if (file.size > 5 * 1024 * 1024) return setError('A foto deve ter no máximo 5 MB.');
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      setCropSource(String(reader.result));
      setCropZoom(1);
      setCropX(0);
      setCropY(0);
    };
    reader.readAsDataURL(file);
  };

  const saveCroppedAvatar = async () => {
    if (!supabase || !cropSource) return;
    setAvatarSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const avatarBlob = await cropProfileImage(cropSource, cropZoom, cropX, cropY);
      const avatarPath = `${user.id}/avatar-${Date.now()}.webp`;
      const uploadResult = await supabase.storage.from('profile-avatars').upload(avatarPath, avatarBlob, { contentType: 'image/webp', upsert: false });
      if (uploadResult.error) throw uploadResult.error;
      const publicUrl = supabase.storage.from('profile-avatars').getPublicUrl(avatarPath).data.publicUrl;
      const oldAvatarPath = profileAvatarPath(avatarUrl);
      const updateResult = await supabase.from('profiles').update({ avatar_url: publicUrl }).eq('id', user.id);
      if (updateResult.error) {
        await supabase.storage.from('profile-avatars').remove([avatarPath]);
        throw updateResult.error;
      }
      setAvatarUrl(publicUrl);
      setCropSource(null);
      if (oldAvatarPath) await supabase.storage.from('profile-avatars').remove([oldAvatarPath]);
      await onProfileChanged({ avatarUrl: publicUrl });
      setSuccess('Foto de perfil atualizada.');
    } catch (avatarError) {
      setError(avatarError instanceof Error ? avatarError.message : 'Não foi possível salvar a foto.');
    } finally {
      setAvatarSaving(false);
    }
  };

  const removeAvatar = async () => {
    if (!supabase || !avatarUrl) return;
    const confirmed = await appDialog.confirm({
      title: 'Remover foto de perfil?',
      description: 'Sua foto será removida para todos os membros da equipe.',
      confirmLabel: 'Remover foto',
      tone: 'danger',
    });
    if (!confirmed) return;
    setAvatarSaving(true);
    setError(null);
    setSuccess(null);
    const oldAvatarPath = profileAvatarPath(avatarUrl);
    const { error: profileError } = await supabase.from('profiles').update({ avatar_url: null }).eq('id', user.id);
    if (!profileError && oldAvatarPath) await supabase.storage.from('profile-avatars').remove([oldAvatarPath]);
    setAvatarSaving(false);
    if (profileError) return setError(profileError.message);
    setAvatarUrl(null);
    await onProfileChanged({ avatarUrl: null });
    setSuccess('Foto de perfil removida.');
  };

  const changeSettingsTab = async (nextTab: SettingsTab) => {
    const leavingDirtyProfile = activeTab === 'profile' && nextTab !== 'profile' && profileDirty;
    const leavingDirtyWorkspace = activeTab === 'general' && nextTab !== 'general' && workspaceDirty;
    if (leavingDirtyProfile || leavingDirtyWorkspace) {
      const discard = await appDialog.confirm({
        title: 'Descartar alterações?',
        description: leavingDirtyProfile
          ? 'As alterações não salvas do seu perfil serão perdidas.'
          : 'O novo nome da equipe ainda não foi salvo.',
        confirmLabel: 'Descartar',
        tone: 'danger',
      });
      if (!discard) return;
      if (leavingDirtyProfile) {
        setDisplayName(profileSnapshot.displayName);
        setSpecialty(profileSnapshot.specialty);
        setBio(profileSnapshot.bio);
      }
      if (leavingDirtyWorkspace) setWorkspaceName(workspace.name);
    }
    setActiveTab(nextTab);
    setError(null);
    setSuccess(null);
  };

  useEffect(() => {
    if (!requestedTab) return;
    void changeSettingsTab(requestedTab);
    // requestedTabToken intentionally represents a navigation action.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedTab, requestedTabToken]);

  const changePassword = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase) return;
    if (newPassword.length < 8) return setError('A nova senha precisa ter pelo menos 8 caracteres.');
    if (newPassword !== confirmPassword) return setError('As duas senhas não coincidem.');
    setSaving(true);
    setError(null);
    setSuccess(null);
    const { error: passwordError } = await supabase.auth.updateUser({ password: newPassword });
    setSaving(false);
    if (passwordError) return setError(passwordError.message);
    setNewPassword('');
    setConfirmPassword('');
    setSuccess('Sua senha foi alterada com segurança.');
  };

  const deleteWorkspace = async () => {
    if (!supabase || workspace.role !== 'owner') return;
    const confirmation = await appDialog.prompt({
      title: `Excluir ${workspace.name}?`,
      description: 'Clientes, tarefas, links, mensagens e lançamentos desta equipe serão removidos permanentemente.',
      inputLabel: `Digite “${workspace.name}” para confirmar`,
      placeholder: workspace.name,
      requiredValue: workspace.name,
      confirmLabel: 'Excluir equipe',
      tone: 'danger',
    });
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
    value: EditFlowDesktopPreferences[keyof EditFlowDesktopPreferences],
  ) => {
    if (!desktopPreferences || desktopSaving) return;
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
    <div className="settings-view settings-center-view">
      <nav className="settings-tabs" role="tablist" aria-label="Seções das configurações">
        {settingsTabs.map(({ id, label, icon: Icon }) => (
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            className={activeTab === id ? 'active' : ''}
            key={id}
            onClick={() => void changeSettingsTab(id)}
          ><Icon size={15} /><span>{label}</span></button>
        ))}
      </nav>

      <main className="settings-tab-content" key={activeTab} role="tabpanel">
        {error ? <div className="panel-error">{error}</div> : null}
        {success ? <div className="panel-success"><ShieldCheck size={15} />{success}</div> : null}

        {activeTab === 'general' ? <>
          <section className="content-card settings-page-card">
            <div className="content-card-heading"><span className="content-icon"><Building2 size={18} /></span><div><h2>Configurações gerais</h2><p>Identidade e informações principais deste espaço de trabalho.</p></div></div>
            <form className="settings-form" onSubmit={saveWorkspace}>
              <label><span>Nome da equipe ou empresa</span><input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} disabled={!canManage} /></label>
              <div className="settings-info-row"><Building2 size={16} /><span><strong>Seu acesso neste espaço</strong><small>{workspace.role === 'owner' ? 'Proprietário' : workspace.role === 'admin' ? 'Administrador' : 'Editor'}</small></span></div>
              {canManage ? <div className="form-actions"><button className="primary-button" type="submit" disabled={saving}>{saving ? <LoaderCircle className="spinner" size={16} /> : <Save size={16} />}Salvar alterações</button></div> : null}
            </form>
          </section>
          {workspace.role === 'owner' ? <section className="content-card danger-zone"><div><h2>Excluir equipe</h2><p>Remove permanentemente clientes, quadros, tarefas e links desta equipe.</p></div><button className="danger-button" onClick={() => void deleteWorkspace()} disabled={saving}><Trash2 size={16} />Excluir equipe</button></section> : null}
        </> : null}

        {activeTab === 'profile' ? <section className="profile-settings-layout">
          <div className="content-card settings-page-card profile-editor-card">
            <div className="content-card-heading"><span className="content-icon"><UserRound size={18} /></span><div><h2>Editar meu perfil</h2><p>Estas informações aparecem para as pessoas da sua equipe.</p></div>{profileDirty ? <span className="profile-unsaved">Alterações não salvas</span> : null}</div>
            {profileLoading ? <div className="desktop-settings-loading"><LoaderCircle className="spinner" size={18} />Carregando seu perfil…</div> : <>
              <div className="profile-avatar-editor">
                <div className="profile-avatar-large">{avatarUrl ? <img src={avatarUrl} alt="Sua foto de perfil" /> : <span>{displayName.trim().slice(0, 1).toUpperCase() || user.email?.slice(0, 1).toUpperCase() || 'U'}</span>}<i className={currentAvailability} /></div>
                <div><strong>Foto de perfil</strong><p>JPG, PNG ou WebP. Tamanho máximo de 5 MB.</p><div><label className="profile-photo-button"><Camera size={14} />{avatarUrl ? 'Trocar foto' : 'Adicionar foto'}<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => { chooseAvatar(event.target.files?.[0]); event.currentTarget.value = ''; }} /></label>{avatarUrl ? <button type="button" className="profile-photo-remove" disabled={avatarSaving} onClick={() => void removeAvatar()}><Trash2 size={13} />Remover</button> : null}</div></div>
              </div>

              <form className="settings-form profile-details-form" onSubmit={saveProfile}>
                <div className="profile-form-grid">
                  <label><span>Nome de exibição</span><input maxLength={80} value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="Como você quer aparecer" /></label>
                  <label><span>Especialidade</span><div className="profile-icon-input"><BriefcaseBusiness size={15} /><input maxLength={80} value={specialty} onChange={(event) => setSpecialty(event.target.value)} placeholder="Ex.: Editor de vídeo" /></div></label>
                  <label><span>Presença automática</span><div className="profile-presence-readonly"><i className={currentAvailability} /><span><strong>{teamAvailabilityLabel(currentAvailability)}</strong><small>{profilePresenceDescription(currentAvailability, activeUserTasks.length)}</small></span></div></label>
                  <label><span>E-mail da conta</span><input value={user.email ?? ''} disabled /></label>
                </div>
                <label className="profile-bio-field"><span>Apresentação</span><textarea maxLength={500} value={bio} onChange={(event) => setBio(event.target.value)} placeholder="Conte brevemente à equipe sobre você e seu trabalho…" /><small>{bio.length}/500</small></label>
                <div className="form-actions profile-form-actions"><span>{profileDirty ? 'Revise a prévia antes de salvar.' : 'Seu perfil está atualizado.'}</span><button className="primary-button" type="submit" disabled={saving || !profileDirty}>{saving ? <LoaderCircle className="spinner" size={16} /> : <Save size={16} />}Salvar perfil</button></div>
              </form>
            </>}
          </div>

          <aside className="profile-preview-column">
            <span className="profile-preview-label">PRÉVIA PARA A EQUIPE</span>
            <article className="profile-preview-card">
              <div className="profile-preview-glow" />
              <div className="profile-preview-avatar">{avatarUrl ? <img src={avatarUrl} alt="" /> : <span>{displayName.trim().slice(0, 1).toUpperCase() || 'U'}</span>}<i className={currentAvailability} /></div>
              <span className={`member-availability-pill ${currentAvailability}`}>{teamAvailabilityLabel(currentAvailability)}</span>
              <h3>{displayName.trim() || 'Seu nome'}</h3>
              <p className="profile-preview-specialty">{specialty.trim() || teamRoleLabel(workspace.role)}</p>
              <p className={`profile-preview-bio ${bio.trim() ? '' : 'empty'}`}>{bio.trim() || 'Sua apresentação aparecerá aqui para os outros membros.'}</p>
              <div className="profile-preview-stats"><article><CheckCircle2 size={15} /><strong>{activeUserTasks.length}</strong><small>Ativos</small></article><article className={overdueUserTasks.length ? 'warning' : ''}><AlertTriangle size={15} /><strong>{overdueUserTasks.length}</strong><small>Atrasados</small></article><article><CalendarClock size={15} /><strong>{nextDeadline?.due_at ? new Date(nextDeadline.due_at).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }) : '—'}</strong><small>Próximo prazo</small></article></div>
              <footer><span><CheckCircle2 size={14} />{completedUserTasks.length} {completedUserTasks.length === 1 ? 'trabalho concluído' : 'trabalhos concluídos'}</span></footer>
            </article>
          </aside>

          {cropSource ? <div className="profile-crop-backdrop" role="dialog" aria-modal="true" aria-label="Recortar foto de perfil" onMouseDown={(event) => { if (event.target === event.currentTarget && !avatarSaving) setCropSource(null); }}><section className="profile-crop-modal"><header><div><strong>Ajustar foto</strong><small>Centralize seu rosto dentro do quadro.</small></div><button type="button" disabled={avatarSaving} onClick={() => setCropSource(null)} aria-label="Fechar"><X size={17} /></button></header><div className="profile-crop-preview"><img src={cropSource} alt="Prévia do recorte" style={{ transform: `translate(${cropX * .45}px, ${cropY * .45}px) scale(${cropZoom})` }} /></div><div className="profile-crop-controls"><label><span>Zoom</span><input type="range" min="1" max="3" step="0.05" value={cropZoom} onChange={(event) => setCropZoom(Number(event.target.value))} /></label><label><span>Horizontal</span><input type="range" min="-100" max="100" value={cropX} onChange={(event) => setCropX(Number(event.target.value))} /></label><label><span>Vertical</span><input type="range" min="-100" max="100" value={cropY} onChange={(event) => setCropY(Number(event.target.value))} /></label></div><footer><button type="button" className="secondary-button" disabled={avatarSaving} onClick={() => setCropSource(null)}>Cancelar</button><button type="button" className="primary-button" disabled={avatarSaving} onClick={() => void saveCroppedAvatar()}>{avatarSaving ? <LoaderCircle className="spinner" size={15} /> : <Camera size={15} />}Usar esta foto</button></footer></section></div> : null}
        </section> : null}

        {activeTab === 'security' ? <section className="content-card settings-page-card">
          <div className="content-card-heading"><span className="content-icon"><LockKeyhole size={18} /></span><div><h2>Segurança</h2><p>Atualize a senha usada para acessar sua conta.</p></div></div>
          <div className="security-account-row"><ShieldCheck size={18} /><span><strong>Conta protegida pelo Supabase</strong><small>{user.email}</small></span></div>
          <form className="settings-form security-form" onSubmit={changePassword}>
            <label><span>Nova senha</span><div className="password-setting-field"><KeyRound size={15} /><input type="password" minLength={8} autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="Mínimo de 8 caracteres" /></div></label>
            <label><span>Confirmar nova senha</span><div className="password-setting-field"><KeyRound size={15} /><input type="password" minLength={8} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="Digite novamente" /></div></label>
            <div className="form-actions"><button className="primary-button" type="submit" disabled={saving || !newPassword || !confirmPassword}>{saving ? <LoaderCircle className="spinner" size={16} /> : <ShieldCheck size={16} />}Alterar senha</button></div>
          </form>
        </section> : null}

        {activeTab === 'application' ? <>
          <section className="content-card settings-page-card desktop-settings-card">
            <div className="content-card-heading"><span className="content-icon"><MonitorCog size={18} /></span><div><h2>Aplicativo no Windows</h2><p>Escolha como o EditFlow se comporta ao iniciar e fechar.</p></div></div>
            {desktopPreferences ? <div className="desktop-preference-list">
              <DesktopPreference icon={Power} title="Iniciar com o Windows" description="Abre o EditFlow automaticamente quando você entrar no computador." checked={desktopPreferences.launchAtLogin} saving={desktopSaving !== null} onChange={(checked) => void updateDesktopPreference('launchAtLogin', checked)} />
              <DesktopPreference icon={X} title="Manter ativo ao clicar no X" description="Esconde a janela nos ícones ocultos para continuar funcionando." checked={desktopPreferences.closeToTray} saving={desktopSaving !== null} onChange={(checked) => void updateDesktopPreference('closeToTray', checked)} />
              <DesktopPreference icon={Eye} title="Mostrar resumo ao abrir" description="Exibe a tela de boas-vindas com tarefas, mensagens e prazos." checked={desktopPreferences.showWelcome} saving={desktopSaving !== null} onChange={(checked) => void updateDesktopPreference('showWelcome', checked)} />
            </div> : <div className="desktop-settings-loading"><LoaderCircle className="spinner" size={18} />Carregando preferências…</div>}
          </section>
          <section className="content-card settings-page-card startup-page-settings-card">
            <div className="content-card-heading"><span className="content-icon"><BriefcaseBusiness size={18} /></span><div><h2>Página inicial</h2><p>Escolha o primeiro espaço exibido depois das boas-vindas.</p></div></div>
            {desktopPreferences ? <div className="theme-options startup-page-options" role="radiogroup" aria-label="Página inicial do aplicativo">
              <ThemeOption icon={BriefcaseBusiness} title="Meu trabalho" description="Prioridades, prazos e novidades do seu dia." active={desktopPreferences.startupPage === 'my-work'} saving={desktopSaving !== null} onClick={() => void updateDesktopPreference('startupPage', 'my-work')} />
              <ThemeOption icon={AppWindow} title="Produção" description="Abre diretamente o quadro Kanban da equipe." active={desktopPreferences.startupPage === 'board'} saving={desktopSaving !== null} onClick={() => void updateDesktopPreference('startupPage', 'board')} />
            </div> : <div className="desktop-settings-loading"><LoaderCircle className="spinner" size={18} />Carregando preferências…</div>}
          </section>
          <section className="content-card settings-page-card appearance-settings-card">
            <div className="content-card-heading"><span className="content-icon"><Palette size={18} /></span><div><h2>Aparência</h2><p>Escolha como o EditFlow deve aparecer neste computador.</p></div></div>
            {desktopPreferences ? <div className="theme-options" role="radiogroup" aria-label="Tema do aplicativo">
              <ThemeOption icon={Sun} title="Claro" description="Visual limpo e iluminado." active={desktopPreferences.theme === 'light'} saving={desktopSaving !== null} onClick={() => void updateDesktopPreference('theme', 'light')} />
              <ThemeOption icon={Moon} title="Escuro" description="Grafite com cores vibrantes." active={desktopPreferences.theme === 'dark'} saving={desktopSaving !== null} onClick={() => void updateDesktopPreference('theme', 'dark')} />
              <ThemeOption icon={Laptop} title="Automático" description="Acompanha o tema do Windows." active={desktopPreferences.theme === 'system'} saving={desktopSaving !== null} onClick={() => void updateDesktopPreference('theme', 'system')} />
            </div> : <div className="desktop-settings-loading"><LoaderCircle className="spinner" size={18} />Carregando preferências…</div>}
          </section>
          <section className="content-card settings-page-card">
            <div className="content-card-heading"><span className="content-icon"><Bell size={18} /></span><div><h2>Notificações</h2><p>Controle os alertas exibidos pelo Windows.</p></div></div>
            {desktopPreferences ? <div className="desktop-preference-list">
              <DesktopPreference icon={Bell} title="Notificações do Windows" description="Mostra alertas de mensagens, novas tarefas, comentários, ajustes e movimentações." checked={desktopPreferences.nativeNotifications} saving={desktopSaving !== null} onChange={(checked) => void updateDesktopPreference('nativeNotifications', checked)} />
              <div className="notification-events-card"><strong>Eventos acompanhados</strong><div><span>Mensagens da equipe</span><span>Tarefas atribuídas</span><span>Comentários e ajustes</span><span>Mudanças no fluxo</span><span>Convites aceitos</span></div><small>Os avisos continuam disponíveis dentro do EditFlow mesmo quando os alertas do Windows estiverem desativados.</small></div>
            </div> : <div className="desktop-settings-loading"><LoaderCircle className="spinner" size={18} />Carregando preferências…</div>}
          </section>
          <section className="content-card update-settings-row"><div><h2>Atualizações</h2><p>Versão instalada: {appVersion}. O EditFlow também verifica automaticamente ao abrir.</p></div><button className="secondary-button" onClick={() => void checkForUpdates()}>Verificar atualizações</button></section>
        </> : null}
      </main>
      {appDialog.host}
    </div>
  );
}

async function cropProfileImage(source: string, zoom: number, offsetX: number, offsetY: number) {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error('Não foi possível ler esta imagem.'));
    element.src = source;
  });
  const baseSide = Math.min(image.naturalWidth, image.naturalHeight);
  const visibleSide = baseSide / Math.max(1, zoom);
  const maxX = Math.max(0, (image.naturalWidth - visibleSide) / 2);
  const maxY = Math.max(0, (image.naturalHeight - visibleSide) / 2);
  const sourceX = Math.max(0, Math.min(image.naturalWidth - visibleSide, maxX - (offsetX / 100) * maxX));
  const sourceY = Math.max(0, Math.min(image.naturalHeight - visibleSide, maxY - (offsetY / 100) * maxY));
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Não foi possível preparar o recorte da foto.');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, sourceX, sourceY, visibleSide, visibleSide, 0, 0, 512, 512);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Não foi possível gerar a foto.')), 'image/webp', .88);
  });
}

function profileAvatarPath(avatarUrl: string | null) {
  if (!avatarUrl) return null;
  const marker = '/storage/v1/object/public/profile-avatars/';
  const markerIndex = avatarUrl.indexOf(marker);
  if (markerIndex < 0) return null;
  return decodeURIComponent(avatarUrl.slice(markerIndex + marker.length).split('?')[0]);
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

function isSupportedYoutubeChannelUrl(value: string) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/^(www|m|music)[.]/, '');
    const segments = url.pathname.split('/').filter(Boolean);
    return url.protocol === 'https:'
      && hostname === 'youtube.com'
      && (segments[0]?.startsWith('@') || (['channel', 'user'].includes(segments[0]) && Boolean(segments[1])));
  } catch {
    return false;
  }
}

function teamRoleLabel(role: WorkspaceRole) {
  if (role === 'owner') return 'Proprietário';
  if (role === 'admin') return 'Administrador';
  return 'Editor';
}

function teamAvailabilityLabel(availability: WorkspaceMember['availability']) {
  if (availability === 'busy') return 'Ocupado';
  if (availability === 'away') return 'Ausente';
  if (availability === 'offline') return 'Offline';
  return 'Disponível';
}

function profilePresenceDescription(availability: WorkspaceMember['availability'], activeTasks: number) {
  if (availability === 'offline') return 'O EditFlow não está conectado.';
  if (availability === 'away') return 'Computador inativo ou bloqueado.';
  if (availability === 'busy') return `${activeTasks} ${activeTasks === 1 ? 'trabalho ativo' : 'trabalhos ativos'}.`;
  return 'Online e sem trabalhos ativos.';
}

function translateTeamError(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes('already a workspace member')) return 'Essa pessoa já faz parte da equipe.';
  if (normalized.includes('valid email')) return 'Digite um e-mail válido.';
  return message;
}

function isValidInviteEmail(value: string) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());
}

async function edgeFunctionErrorMessage(error: unknown) {
  const functionError = error as { message?: string; context?: Response };
  try {
    if (functionError.context) {
      const payload = await functionError.context.clone().json() as { error?: string };
      if (payload.error) return payload.error;
    }
  } catch {
    // Fall back to the SDK error below when the response is not JSON.
  }
  return functionError.message || 'Não foi possível consultar o canal do YouTube.';
}

function compactNumber(value: number) {
  return new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function postingFrequency(uploadsPerMonth: number | null) {
  if (!uploadsPerMonth || uploadsPerMonth <= 0) return 'Frequência indisponível';
  if (uploadsPerMonth >= 3.5) {
    const weekly = uploadsPerMonth / 4.345;
    return `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(weekly)} por semana`;
  }
  if (uploadsPerMonth < 1) return `a cada ${Math.max(1, Math.round(30.4375 / uploadsPerMonth))} dias`;
  return `${new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(uploadsPerMonth)} por mês`;
}

function normalizeBillingSetting(row: Record<string, unknown>) {
  return {
    ...row,
    currency: (row.currency === 'BRL' ? 'BRL' : 'USD') as BillingCurrency,
    amount_usd: Number(row.amount_usd),
    bundle_size: Number(row.bundle_size),
    payment_method: (row.payment_method ?? 'none') as PaymentMethod,
    fee_percent: Number(row.fee_percent ?? 0),
    fee_fixed_usd: Number(row.fee_fixed_usd ?? 0),
    conversion_spread_percent: Number(row.conversion_spread_percent ?? 0),
  } as ClientBillingSetting;
}

function billingDescription(setting: ClientBillingSetting) {
  const amount = formatBillingCurrency(setting.amount_usd, setting.currency);
  return setting.pricing_model === 'per_video'
    ? `${amount} por vídeo · ${paymentMethodLabel(setting.payment_method)}`
    : `${amount} a cada ${setting.bundle_size} vídeos · ${paymentMethodLabel(setting.payment_method)}`;
}

function PaymentEstimate({ currency, grossAmount, paymentMethod, feePercent, fixedFee, conversionSpreadPercent }: {
  currency: BillingCurrency;
  grossAmount: number;
  paymentMethod: PaymentMethod;
  feePercent: number;
  fixedFee: number;
  conversionSpreadPercent: number;
}) {
  const netAmount = estimateNetUsd(grossAmount, feePercent, fixedFee, conversionSpreadPercent);
  const feeAmount = Number.isFinite(grossAmount) ? Math.max(0, grossAmount - netAmount) : 0;
  return (
    <div className="payment-estimate">
      <div><span>Bruto</span><strong>{formatBillingCurrency(grossAmount, currency)}</strong></div>
      <div><span>Taxas estimadas</span><strong>-{formatBillingCurrency(feeAmount, currency)}</strong></div>
      <div className="net"><span>Líquido estimado</span><strong>{formatBillingCurrency(netAmount, currency)}</strong></div>
      <small>{paymentFeeRule(paymentMethod).note}</small>
    </div>
  );
}

function formatBillingCurrency(value: number, currency: BillingCurrency) {
  return new Intl.NumberFormat(currency === 'BRL' ? 'pt-BR' : 'en-US', { style: 'currency', currency }).format(Number.isFinite(value) ? value : 0);
}

function validPercent(value: number) {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

function isMissingFinanceSchema(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes('client_billing_settings') || normalized.includes('currency') || normalized.includes('payment_method') || normalized.includes('schema cache');
}
