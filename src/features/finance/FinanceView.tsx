import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  BadgeDollarSign,
  Banknote,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  FilePlus2,
  LoaderCircle,
  Pencil,
  Plus,
  ReceiptText,
  RefreshCw,
  Save,
  TrendingUp,
  Trash2,
  Video,
  WalletCards,
  X,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { useAppDialog } from '../../components/AppDialog';
import { useLatestRequest } from '../../lib/asyncRequest';
import { useDialogFocus } from '../../lib/useDialogFocus';
import { paymentFeeRule, paymentMethodLabel } from './paymentFees';
import type {
  Client,
  ClientBillingSetting,
  Earning,
  EarningEvent,
  PaymentMethod,
  Task,
  WorkspaceSummary,
} from '../workspace/types';

type Props = {
  workspace: WorkspaceSummary;
  clients: Client[];
  tasks: Task[];
};

type ManualEarningDraft = {
  clientId: string;
  description: string;
  amountUsd: string;
  earnedDate: string;
  paymentMethod: PaymentMethod;
  feePercent: string;
  feeFixedUsd: string;
  conversionSpreadPercent: string;
  status: 'pending' | 'received';
  actualAmountBrl: string;
};

export function FinanceView({ workspace, clients, tasks }: Props) {
  const [settings, setSettings] = useState<ClientBillingSetting[]>([]);
  const [earnings, setEarnings] = useState<Earning[]>([]);
  const [events, setEvents] = useState<EarningEvent[]>([]);
  const [rate, setRate] = useState<EditFlowUsdBrlRate | null>(null);
  const [month, setMonth] = useState(currentMonth());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rateLoading, setRateLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [migrationMissing, setMigrationMissing] = useState(false);
  const [receivingEarning, setReceivingEarning] = useState<Earning | null>(null);
  const [actualReceivedBrl, setActualReceivedBrl] = useState('');
  const [manualEditor, setManualEditorState] = useState<Earning | 'new' | null>(null);
  const [manualDraft, setManualDraft] = useState<ManualEarningDraft>(() => emptyManualDraft());
  const [syncing, setSyncing] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const setManualEditor = (value: Earning | 'new' | null) => {
    if (saving && value === null) return;
    setManualEditorState(value);
  };
  const appDialog = useAppDialog();
  const { begin: beginFinanceRequest, isLatest: isLatestFinanceRequest, cancel: cancelFinanceRequests } = useLatestRequest();
  useDialogFocus<HTMLElement>(Boolean(manualEditor) && !appDialog.open, () => setManualEditor(null), !saving, '.manual-earning-dialog');
  useDialogFocus<HTMLElement>(Boolean(receivingEarning) && !appDialog.open, () => setReceivingEarning(null), !saving, '.receive-dialog');

  const loadRate = useCallback(async () => {
    setRateLoading(true);
    try {
      setRate(await window.editflow.getUsdBrlRate());
    } catch {
      setError((current) => current ?? 'Não foi possível consultar a cotação USD/BRL e ainda não existe uma cotação salva.');
    } finally {
      setRateLoading(false);
    }
  }, []);

  const loadFinance = useCallback(async (quiet = false) => {
    if (!supabase) return;
    const requestId = beginFinanceRequest();
    if (!quiet) setLoading(true);
    setError(null);
    const [settingsResult, earningsResult, eventsResult] = await Promise.all([
      supabase.from('client_billing_settings').select('client_id, workspace_id, currency, pricing_model, amount_usd, bundle_size, payment_method, fee_percent, fee_fixed_usd, conversion_spread_percent, created_at, updated_at').eq('workspace_id', workspace.id).order('created_at'),
      supabase.from('earnings').select('id, workspace_id, client_id, source_type, description, item_count, amount_usd, net_amount_usd, payment_method, fee_percent, fee_fixed_usd, conversion_spread_percent, status, earned_at, received_at, exchange_rate_brl, amount_brl, created_at, updated_at').eq('workspace_id', workspace.id).order('earned_at', { ascending: false }),
      supabase.from('earning_events').select('id, workspace_id, client_id, task_id, task_title, completed_at, pricing_model, amount_usd, bundle_size, payment_method, fee_percent, fee_fixed_usd, conversion_spread_percent, earning_id, created_at').eq('workspace_id', workspace.id).order('completed_at', { ascending: false }),
    ]);
    const loadError = settingsResult.error ?? earningsResult.error ?? eventsResult.error;
    if (!isLatestFinanceRequest(requestId)) return;
    if (loadError) {
      setMigrationMissing(isMissingFinanceSchema(loadError.message));
      if (!isMissingFinanceSchema(loadError.message)) setError(loadError.message);
      setLoading(false);
      return;
    }

    setMigrationMissing(false);
    setSettings((settingsResult.data ?? []).map(normalizeBillingSetting));
    setEarnings((earningsResult.data ?? []).map(normalizeEarning));
    setEvents((eventsResult.data ?? []).map(normalizeEarningEvent));
    setLoading(false);
  }, [beginFinanceRequest, isLatestFinanceRequest, workspace.id]);

  useEffect(() => {
    void Promise.all([loadFinance(), loadRate()]);
    return cancelFinanceRequests;
  }, [cancelFinanceRequests, loadFinance, loadRate]);

  useEffect(() => {
    if (!supabase || migrationMissing) return;
    const realtimeClient = supabase;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const scheduleReload = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void loadFinance(true), 180);
    };
    const channel: RealtimeChannel = realtimeClient
      .channel(`editflow-finance:${workspace.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'client_billing_settings', filter: `workspace_id=eq.${workspace.id}` }, scheduleReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'earnings', filter: `workspace_id=eq.${workspace.id}` }, scheduleReload)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'earning_events', filter: `workspace_id=eq.${workspace.id}` }, scheduleReload)
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void realtimeClient.removeChannel(channel);
    };
  }, [loadFinance, migrationMissing, workspace.id]);

  const monthlyEarnings = useMemo(() => earnings.filter((earning) => monthKey(earning.earned_at) === month), [earnings, month]);
  const grossUsd = sum(monthlyEarnings.map((earning) => earning.amount_usd));
  const netUsd = sum(monthlyEarnings.map((earning) => earning.net_amount_usd));
  const feeUsd = grossUsd - netUsd;
  const pendingEarnings = monthlyEarnings.filter((earning) => earning.status === 'pending');
  const receivedEarnings = monthlyEarnings.filter((earning) => earning.status === 'received');
  const receivedBrl = sum(receivedEarnings.map((earning) => earning.amount_brl ?? 0));
  const pendingNetUsd = sum(pendingEarnings.map((earning) => earning.net_amount_usd));
  const grossBrl = rate ? grossUsd * rate.rate : null;
  const feeBrl = rate ? feeUsd * rate.rate : null;
  const expectedNetBrl = rate ? receivedBrl + pendingNetUsd * rate.rate : null;
  const clientSummaries = useMemo(() => clients.map((client) => {
    const clientEarnings = monthlyEarnings.filter((earning) => earning.client_id === client.id);
    const setting = settings.find((item) => item.client_id === client.id);
    const unallocated = events.filter((event) => event.client_id === client.id && !event.earning_id);
    return {
      client,
      setting,
      grossUsd: sum(clientEarnings.map((earning) => earning.amount_usd)),
      netUsd: sum(clientEarnings.map((earning) => earning.net_amount_usd)),
      itemCount: sum(clientEarnings.map((earning) => earning.item_count)),
      pendingItems: unallocated.length,
    };
  }).filter((summary) => summary.setting || summary.grossUsd), [clients, events, monthlyEarnings, settings]);
  const completedMonthTasks = useMemo(() => tasks.filter((task) => task.completed_at && monthKey(task.completed_at) === month), [month, tasks]);
  const deliveryIssues = useMemo(() => completedMonthTasks.flatMap((task) => {
    const event = events.find((item) => item.task_id === task.id);
    if (event?.earning_id) return [];
    if (event?.pricing_model === 'per_video') return [{ task, clientName: clients.find((item) => item.id === task.client_id)?.name ?? 'Cliente', reason: 'O evento está pronto para ser sincronizado.' }];
    if (event) return [];
    const client = clients.find((item) => item.id === task.client_id);
    if (!task.client_id || !client) return [{ task, clientName: 'Sem cliente', reason: 'Vincule um cliente para contabilizar esta entrega.' }];
    if (!settings.some((item) => item.client_id === task.client_id)) return [{ task, clientName: client.name, reason: 'Configure o pagamento deste cliente.' }];
    return [{ task, clientName: client.name, reason: 'A entrega está pronta para ser sincronizada.' }];
  }), [clients, completedMonthTasks, events, settings]);
  const bundleProgress = useMemo(() => clients.flatMap((client) => {
    const setting = settings.find((item) => item.client_id === client.id);
    if (!setting || setting.pricing_model !== 'bundle') return [];
    const pendingEvents = events.filter((event) => event.client_id === client.id && !event.earning_id);
    return pendingEvents.length ? [{ client, setting, pendingEvents }] : [];
  }), [clients, events, settings]);

  const openManualEditor = (earning?: Earning) => {
    setError(null);
    setSuccess(null);
    if (!earning) {
      setManualEditor('new');
      setManualDraft(emptyManualDraft(month));
      return;
    }
    setManualEditor(earning);
    setManualDraft({
      clientId: earning.client_id ?? '',
      description: earning.description,
      amountUsd: String(earning.amount_usd),
      earnedDate: earning.earned_at.slice(0, 10),
      paymentMethod: earning.payment_method,
      feePercent: String(earning.fee_percent),
      feeFixedUsd: String(earning.fee_fixed_usd),
      conversionSpreadPercent: String(earning.conversion_spread_percent),
      status: earning.status,
      actualAmountBrl: earning.amount_brl === null ? '' : String(earning.amount_brl).replace('.', ','),
    });
  };

  const applyManualClient = (clientId: string) => {
    const setting = settings.find((item) => item.client_id === clientId);
    setManualDraft((current) => setting ? {
      ...current,
      clientId,
      paymentMethod: setting.payment_method,
      feePercent: String(setting.fee_percent),
      feeFixedUsd: String(setting.fee_fixed_usd),
      conversionSpreadPercent: String(setting.conversion_spread_percent),
    } : { ...current, clientId });
  };

  const applyManualPaymentMethod = (paymentMethod: PaymentMethod) => {
    const rule = paymentFeeRule(paymentMethod);
    setManualDraft((current) => ({
      ...current,
      paymentMethod,
      feePercent: String(rule.feePercent),
      feeFixedUsd: String(rule.fixedFeeUsd),
      conversionSpreadPercent: String(rule.conversionSpreadPercent),
    }));
  };

  const saveManualEarning = async () => {
    if (!supabase || !manualEditor) return;
    const amountUsd = Number(manualDraft.amountUsd.replace(',', '.'));
    const feePercent = Number(manualDraft.feePercent.replace(',', '.'));
    const feeFixedUsd = Number(manualDraft.feeFixedUsd.replace(',', '.'));
    const conversionSpreadPercent = Number(manualDraft.conversionSpreadPercent.replace(',', '.'));
    const actualAmountBrl = manualDraft.actualAmountBrl ? Number(manualDraft.actualAmountBrl.replace(',', '.')) : null;
    if (!manualDraft.description.trim()) return setError('Digite uma descrição para o lançamento.');
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) return setError('Informe um valor bruto em dólar maior que zero.');
    if (![feePercent, feeFixedUsd, conversionSpreadPercent].every(Number.isFinite)) return setError('Revise os valores das taxas.');
    if (manualDraft.status === 'received' && (!actualAmountBrl || actualAmountBrl <= 0)) return setError('Informe quanto realmente caiu em reais.');
    setSaving(true);
    setError(null);
    setSuccess(null);
    const commonValues = {
      client_target: manualDraft.clientId || null,
      earning_description: manualDraft.description.trim(),
      gross_amount_usd: amountUsd,
      earning_date: new Date(`${manualDraft.earnedDate}T12:00:00`).toISOString(),
      earning_payment_method: manualDraft.paymentMethod,
      earning_fee_percent: feePercent,
      earning_fee_fixed_usd: feeFixedUsd,
      earning_conversion_spread_percent: conversionSpreadPercent,
      mark_as_received: manualDraft.status === 'received',
      actual_amount_brl: actualAmountBrl,
    };
    const { error: saveError } = manualEditor === 'new'
      ? await supabase.rpc('create_manual_earning', { workspace_target: workspace.id, ...commonValues })
      : await supabase.rpc('update_manual_earning', { earning_target: manualEditor.id, ...commonValues });
    setSaving(false);
    if (saveError) return setError(financeErrorMessage(saveError.message));
    setManualEditor(null);
    await loadFinance(true);
    setSuccess(manualEditor === 'new' ? 'Lançamento manual criado.' : 'Lançamento manual atualizado.');
  };

  const deleteManualEarning = async (earning: Earning) => {
    if (!supabase || earning.source_type !== 'manual' || saving) return;
    const confirmed = await appDialog.confirm({
      title: `Excluir “${earning.description}”?`,
      description: 'O lançamento manual será removido definitivamente do resumo financeiro.',
      confirmLabel: 'Excluir lançamento',
      tone: 'danger',
    });
    if (!confirmed) return;
    setSaving(true);
    setSuccess(null);
    const { error: deleteError } = await supabase.rpc('delete_manual_earning', { earning_target: earning.id });
    setSaving(false);
    if (deleteError) return setError(financeErrorMessage(deleteError.message));
    await loadFinance(true);
    setSuccess('Lançamento manual excluído.');
  };

  const synchronizeEarnings = async () => {
    if (!supabase) return;
    setSyncing(true);
    setError(null);
    setSuccess(null);
    const { data, error: syncError } = await supabase.rpc('sync_workspace_earnings', { target_workspace: workspace.id });
    setSyncing(false);
    if (syncError) return setError(financeErrorMessage(syncError.message));
    await loadFinance(true);
    setSuccess(Number(data) > 0 ? `${data} novo(s) lançamento(s) gerado(s).` : 'Tudo certo. Nenhum lançamento novo foi necessário.');
  };

  const openReceiveDialog = (earning: Earning) => {
    setReceivingEarning(earning);
    setActualReceivedBrl(rate ? String(roundCurrency(earning.net_amount_usd * rate.rate)).replace('.', ',') : '');
    setError(null);
  };

  const markReceived = async () => {
    if (!supabase || !receivingEarning) return;
    const amountBrl = Number(actualReceivedBrl.replace(',', '.'));
    if (!Number.isFinite(amountBrl) || amountBrl <= 0) return setError('Informe o valor em reais que realmente caiu na conta.');
    setSaving(true);
    setError(null);
    const { error: updateError } = await supabase.from('earnings').update({
      status: 'received',
      received_at: new Date().toISOString(),
      exchange_rate_brl: receivingEarning.net_amount_usd > 0
        ? roundRate(amountBrl / receivingEarning.net_amount_usd)
        : (rate?.rate ?? 1),
      amount_brl: roundCurrency(amountBrl),
    }).eq('id', receivingEarning.id);
    setSaving(false);
    if (updateError) return setError(updateError.message);
    setReceivingEarning(null);
    setActualReceivedBrl('');
    await loadFinance(true);
  };

  const reopenEarning = async (earning: Earning) => {
    if (!supabase) return;
    setSaving(true);
    const { error: updateError } = await supabase.from('earnings').update({
      status: 'pending',
      received_at: null,
      exchange_rate_brl: null,
      amount_brl: null,
    }).eq('id', earning.id);
    setSaving(false);
    if (updateError) return setError(updateError.message);
    await loadFinance(true);
  };

  if (loading) return <div className="finance-loading"><LoaderCircle className="spinner" size={24} />Carregando ganhos…</div>;

  if (migrationMissing) {
    return (
      <div className="finance-view finance-empty-state">
        <span><WalletCards size={25} /></span>
        <h2>Ative o módulo financeiro</h2>
        <p>Execute as migrations <strong>012_financial_tracking.sql</strong> e <strong>013_payment_fees.sql</strong> no SQL Editor do Supabase. Depois, volte aqui e tente novamente.</p>
        <button className="secondary-button" onClick={() => void loadFinance()}><RefreshCw size={15} />Tentar novamente</button>
      </div>
    );
  }

  return (
    <div className="finance-view">
      <section className="finance-hero">
        <div className="finance-hero-copy">
          <p>VISÃO FINANCEIRA</p>
          <h2>{expectedNetBrl === null ? 'Cotação indisponível' : formatBrl(expectedNetBrl)}</h2>
          <span>Líquido estimado em {formatMonth(month)} · {formatUsd(netUsd)} após taxas</span>
        </div>
        <div className="finance-rate-card">
          <span><TrendingUp size={17} /></span>
          <div><small>USD → BRL</small><strong>{rate ? formatRate(rate.rate) : '—'}</strong><em>{rate ? `${rate.stale ? 'Última cotação salva' : 'Cotação atual'} · ${formatCompactDate(rate.sourceUpdatedAt)}` : 'Sem cotação salva'}</em></div>
          <button aria-label="Atualizar cotação" onClick={() => void loadRate()} disabled={rateLoading}><RefreshCw className={rateLoading ? 'spinner' : ''} size={15} /></button>
        </div>
        <label className="finance-month"><span>Mês</span><input type="month" value={month} onChange={(event) => setMonth(event.target.value)} /></label>
        <div className="finance-hero-actions"><button className="secondary-button" disabled={syncing} onClick={() => void synchronizeEarnings()}>{syncing ? <LoaderCircle className="spinner" size={14} /> : <RefreshCw size={14} />}Sincronizar</button><button className="primary-button" onClick={() => openManualEditor()}><Plus size={14} />Novo lançamento</button></div>
      </section>

      {error ? <div className="panel-error finance-error">{error}</div> : null}
      {success ? <div className="panel-success finance-success"><CheckCircle2 size={15} />{success}</div> : null}

      <section className="finance-metrics">
        <article><span className="purple"><BadgeDollarSign size={18} /></span><div><small>Faturamento bruto</small><strong>{grossBrl === null ? '—' : formatBrl(grossBrl)}</strong><em>{formatUsd(grossUsd)}</em></div></article>
        <article><span className="orange"><ReceiptText size={18} /></span><div><small>Taxas estimadas</small><strong>{feeBrl === null ? '—' : `-${formatBrl(feeBrl)}`}</strong><em>-{formatUsd(feeUsd)}</em></div></article>
        <article><span className="blue"><CircleDollarSign size={18} /></span><div><small>Líquido estimado</small><strong>{expectedNetBrl === null ? '—' : formatBrl(expectedNetBrl)}</strong><em>{formatUsd(netUsd)}</em></div></article>
        <article><span className="green"><Banknote size={18} /></span><div><small>Recebido</small><strong>{formatBrl(receivedBrl)}</strong><em>{receivedEarnings.length} pagamentos</em></div></article>
      </section>

      <section className="finance-card client-earnings-card finance-client-summary">
          <header><span><WalletCards size={18} /></span><div><h3>Resumo por cliente</h3><p>Valores gerados no mês selecionado. Configure o pagamento ao criar ou editar um cliente.</p></div></header>
          <div className="client-earning-list">
            {clientSummaries.map(({ client, setting, grossUsd: clientGrossUsd, netUsd: clientNetUsd, itemCount, pendingItems }) => (
              <article key={client.id}>
                <span className="finance-client-avatar">{client.youtube_thumbnail_url ? <img src={client.youtube_thumbnail_url} alt={`Canal de ${client.name}`} /> : client.name.slice(0,1).toUpperCase()}</span>
                <div><strong>{client.name}</strong><small>{setting ? billingDescription(setting) : 'Sem configuração atual'}{setting?.pricing_model === 'bundle' && pendingItems ? ` · ${pendingItems}/${setting.bundle_size} no próximo pacote` : ''}</small></div>
                <em>{rate ? formatBrl(clientNetUsd * rate.rate) : formatUsd(clientNetUsd)}<small>líquido · bruto {formatUsd(clientGrossUsd)} · {itemCount} vídeos</small></em>
              </article>
            ))}
            {!clientSummaries.length ? <div className="finance-list-empty">Configure o primeiro cliente para começar a contabilizar as entregas.</div> : null}
          </div>
      </section>

      {(deliveryIssues.length || bundleProgress.length) ? <section className="finance-card finance-pending-card">
        <header><span><Clock3 size={18} /></span><div><h3>Entregas em acompanhamento</h3><p>Veja o que ainda não virou um lançamento completo.</p></div></header>
        <div className="finance-pending-list">
          {bundleProgress.map(({ client, setting, pendingEvents }) => <article key={client.id}><span className="pending-progress"><b style={{ width: `${Math.min(100, pendingEvents.length / setting.bundle_size * 100)}%` }} /></span><div><strong>{client.name}</strong><small>{pendingEvents.map((event) => event.task_title).join(', ')}</small></div><em>{pendingEvents.length}/{setting.bundle_size}<small>próximo pacote</small></em></article>)}
          {deliveryIssues.map(({ task, clientName, reason }) => <article className="issue" key={task.id}><span className="pending-warning"><FilePlus2 size={15} /></span><div><strong>{task.title}</strong><small>{clientName} · {reason}</small></div><em>Não lançado</em></article>)}
        </div>
      </section> : null}

      <section className="finance-card earnings-history-card">
        <header><span><CheckCircle2 size={18} /></span><div><h3>Lançamentos do mês</h3><p>Automáticos vêm da última coluna; manuais podem ser corrigidos ou removidos.</p></div><button className="finance-add-entry" onClick={() => openManualEditor()}><Plus size={14} />Adicionar</button></header>
        <div className="earnings-table">
          <div className="earnings-table-head"><span>Cliente / lançamento</span><span>Data</span><span>Valor</span><span>Status / ações</span></div>
          {monthlyEarnings.map((earning) => {
            const client = clients.find((item) => item.id === earning.client_id);
            const displayBrl = earning.status === 'received' ? earning.amount_brl : (rate ? earning.net_amount_usd * rate.rate : null);
            const earningFeeUsd = earning.amount_usd - earning.net_amount_usd;
            return (
              <article key={earning.id}>
                <div><strong>{client?.name || (earning.source_type === 'manual' ? 'Lançamento avulso' : 'Cliente removido')}<i className={`earning-source ${earning.source_type}`}>{earningSourceLabel(earning.source_type)}</i></strong><small>{earning.description} · {paymentMethodLabel(earning.payment_method)}{earning.source_type !== 'manual' ? ` · ${earning.item_count} ${earning.item_count === 1 ? 'vídeo' : 'vídeos'}` : ''}</small></div>
                <span>{formatCompactDate(earning.earned_at)}</span>
                <div className="earning-value"><strong>{displayBrl === null ? '—' : formatBrl(displayBrl)}</strong><small>líquido {formatUsd(earning.net_amount_usd)} · bruto {formatUsd(earning.amount_usd)} · taxas {formatUsd(earningFeeUsd)}{earning.exchange_rate_brl ? ` · câmbio efetivo ${formatRate(earning.exchange_rate_brl)}` : ''}</small></div>
                <div className="earning-row-actions">{earning.status === 'received'
                  ? <button className="earning-status received" disabled={saving} onClick={() => void reopenEarning(earning)}><CheckCircle2 size={13} />Recebido</button>
                  : <button className="earning-status pending" disabled={saving} onClick={() => openReceiveDialog(earning)}><Clock3 size={13} />Marcar recebido</button>}{earning.source_type === 'manual' ? <><button className="earning-icon-action" onClick={() => openManualEditor(earning)} aria-label="Editar lançamento"><Pencil size={13} /></button><button className="earning-icon-action danger" onClick={() => void deleteManualEarning(earning)} aria-label="Excluir lançamento"><Trash2 size={13} /></button></> : null}</div>
              </article>
            );
          })}
          {!monthlyEarnings.length ? <div className="finance-list-empty">Nenhum ganho foi gerado neste mês.</div> : null}
        </div>
      </section>

      {manualEditor ? <div className="manual-earning-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setManualEditor(null); }}><section className="manual-earning-dialog" role="dialog" aria-modal="true" aria-labelledby="manual-earning-title"><header><span><FilePlus2 size={18} /></span><div><h3 id="manual-earning-title">{manualEditor === 'new' ? 'Novo lançamento' : 'Editar lançamento'}</h3><p>Registre bônus, extras ou trabalhos que não vieram de uma tarefa.</p></div><button onClick={() => setManualEditor(null)} aria-label="Fechar"><X size={17} /></button></header><div className="manual-earning-grid"><label><span>Cliente</span><select value={manualDraft.clientId} onChange={(event) => applyManualClient(event.target.value)}><option value="">Sem cliente específico</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label><label><span>Data do lançamento</span><input type="date" value={manualDraft.earnedDate} onChange={(event) => setManualDraft({ ...manualDraft, earnedDate: event.target.value })} /></label><label className="wide"><span>Descrição</span><input maxLength={300} value={manualDraft.description} onChange={(event) => setManualDraft({ ...manualDraft, description: event.target.value })} placeholder="Ex.: Bônus do projeto especial" /></label><label><span>Valor bruto</span><div className="manual-money-input"><b>US$</b><input inputMode="decimal" value={manualDraft.amountUsd} onChange={(event) => setManualDraft({ ...manualDraft, amountUsd: event.target.value })} placeholder="0.00" /></div></label><label><span>Meio de pagamento</span><select value={manualDraft.paymentMethod} onChange={(event) => applyManualPaymentMethod(event.target.value as PaymentMethod)}><option value="none">Sem taxas</option><option value="paypal_international">PayPal internacional</option><option value="wise_ach">Wise ACH</option><option value="wise_wire">Wise Wire</option><option value="custom">Taxa personalizada</option></select></label><label><span>Taxa percentual</span><div className="manual-money-input"><input inputMode="decimal" value={manualDraft.feePercent} onChange={(event) => setManualDraft({ ...manualDraft, feePercent: event.target.value })} /><b>%</b></div></label><label><span>Taxa fixa</span><div className="manual-money-input"><b>US$</b><input inputMode="decimal" value={manualDraft.feeFixedUsd} onChange={(event) => setManualDraft({ ...manualDraft, feeFixedUsd: event.target.value })} /></div></label><label><span>Spread de conversão</span><div className="manual-money-input"><input inputMode="decimal" value={manualDraft.conversionSpreadPercent} onChange={(event) => setManualDraft({ ...manualDraft, conversionSpreadPercent: event.target.value })} /><b>%</b></div></label><label><span>Status</span><select value={manualDraft.status} onChange={(event) => setManualDraft({ ...manualDraft, status: event.target.value as 'pending' | 'received' })}><option value="pending">Pendente</option><option value="received">Recebido</option></select></label>{manualDraft.status === 'received' ? <label className="wide"><span>Valor real recebido</span><div className="manual-money-input received"><b>R$</b><input inputMode="decimal" value={manualDraft.actualAmountBrl} onChange={(event) => setManualDraft({ ...manualDraft, actualAmountBrl: event.target.value })} placeholder="0,00" /></div></label> : null}</div>{error ? <div className="panel-error manual-earning-error">{error}</div> : null}<footer><button className="secondary-button" disabled={saving} onClick={() => setManualEditor(null)}>Cancelar</button><button className="primary-button" disabled={saving} onClick={() => void saveManualEarning()}>{saving ? <LoaderCircle className="spinner" size={15} /> : <Save size={15} />}{manualEditor === 'new' ? 'Criar lançamento' : 'Salvar alterações'}</button></footer></section></div> : null}

      {receivingEarning ? (
        <div className="receive-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setReceivingEarning(null); }}>
          <section className="receive-dialog" role="dialog" aria-modal="true" aria-labelledby="receive-dialog-title">
            <header><span><Banknote size={18} /></span><div><h3 id="receive-dialog-title">Confirmar recebimento</h3><p>Registre o valor real após todas as taxas e conversões.</p></div><button disabled={saving} onClick={() => setReceivingEarning(null)} aria-label="Fechar"><X size={17} /></button></header>
            <div className="receive-dialog-summary"><div><span>Bruto</span><strong>{formatUsd(receivingEarning.amount_usd)}</strong></div><div><span>Líquido estimado</span><strong>{formatUsd(receivingEarning.net_amount_usd)}</strong></div><div><span>Meio</span><strong>{paymentMethodLabel(receivingEarning.payment_method)}</strong></div></div>
            <label><span>Quanto realmente caiu na conta?</span><div><b>R$</b><input autoFocus inputMode="decimal" value={actualReceivedBrl} onChange={(event) => setActualReceivedBrl(event.target.value)} placeholder="0,00" /></div></label>
            <small>Esse valor substituirá a estimativa e ficará registrado no histórico.</small>
            {error ? <div className="panel-error receive-dialog-error">{error}</div> : null}
            <button className="primary-button" disabled={saving} onClick={() => void markReceived()}>{saving ? <LoaderCircle className="spinner" size={15} /> : <CheckCircle2 size={15} />}Confirmar recebimento</button>
          </section>
        </div>
      ) : null}
      {appDialog.host}
    </div>
  );
}

function normalizeBillingSetting(row: Record<string, unknown>) {
  return {
    ...row,
    amount_usd: Number(row.amount_usd),
    bundle_size: Number(row.bundle_size),
    payment_method: (row.payment_method ?? 'none') as PaymentMethod,
    fee_percent: Number(row.fee_percent ?? 0),
    fee_fixed_usd: Number(row.fee_fixed_usd ?? 0),
    conversion_spread_percent: Number(row.conversion_spread_percent ?? 0),
  } as ClientBillingSetting;
}

function normalizeEarning(row: Record<string, unknown>) {
  return {
    ...row,
    amount_usd: Number(row.amount_usd),
    net_amount_usd: Number(row.net_amount_usd ?? row.amount_usd),
    item_count: Number(row.item_count),
    payment_method: (row.payment_method ?? 'none') as PaymentMethod,
    fee_percent: Number(row.fee_percent ?? 0),
    fee_fixed_usd: Number(row.fee_fixed_usd ?? 0),
    conversion_spread_percent: Number(row.conversion_spread_percent ?? 0),
    exchange_rate_brl: row.exchange_rate_brl === null ? null : Number(row.exchange_rate_brl),
    amount_brl: row.amount_brl === null ? null : Number(row.amount_brl),
  } as Earning;
}

function normalizeEarningEvent(row: Record<string, unknown>) {
  return {
    ...row,
    amount_usd: Number(row.amount_usd),
    bundle_size: Number(row.bundle_size),
    payment_method: (row.payment_method ?? 'none') as PaymentMethod,
    fee_percent: Number(row.fee_percent ?? 0),
    fee_fixed_usd: Number(row.fee_fixed_usd ?? 0),
    conversion_spread_percent: Number(row.conversion_spread_percent ?? 0),
  } as EarningEvent;
}

function emptyManualDraft(selectedMonth = currentMonth()): ManualEarningDraft {
  const today = new Date();
  const todayMonth = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  const date = `${selectedMonth}-${selectedMonth === todayMonth ? String(today.getDate()).padStart(2, '0') : '01'}`;
  return {
    clientId: '',
    description: '',
    amountUsd: '',
    earnedDate: date,
    paymentMethod: 'none',
    feePercent: '0',
    feeFixedUsd: '0',
    conversionSpreadPercent: '0',
    status: 'pending',
    actualAmountBrl: '',
  };
}

function earningSourceLabel(source: Earning['source_type']) {
  if (source === 'manual') return 'Manual';
  if (source === 'bundle') return 'Pacote';
  return 'Automático';
}

function financeErrorMessage(message: string) {
  const normalized = message.toLowerCase();
  if (normalized.includes('create_manual_earning') || normalized.includes('update_manual_earning') || normalized.includes('sync_workspace_earnings') || normalized.includes('schema cache')) {
    return 'Execute a migration 016_financial_entries.sql no Supabase para ativar esta função.';
  }
  if (normalized.includes('description')) return 'Revise a descrição do lançamento.';
  if (normalized.includes('gross amount')) return 'Informe um valor bruto maior que zero.';
  if (normalized.includes('actual brl')) return 'Informe quanto realmente caiu em reais.';
  return message;
}

function isMissingFinanceSchema(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes('client_billing_settings') || normalized.includes('earning_events') || normalized.includes('net_amount_usd') || normalized.includes('payment_method') || normalized.includes('schema cache');
}

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2,'0')}`;
}

function monthKey(date: string) {
  const parsed = new Date(date);
  return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2,'0')}`;
}

function formatMonth(month: string) {
  const [year, value] = month.split('-').map(Number);
  return new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(new Date(year, value - 1, 1));
}

function formatUsd(value: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function formatBrl(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

function formatRate(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(value);
}

function formatCompactDate(date: string) {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(date));
}

function billingDescription(setting: ClientBillingSetting) {
  return setting.pricing_model === 'per_video'
    ? `${formatUsd(setting.amount_usd)} por vídeo · ${paymentMethodLabel(setting.payment_method)}`
    : `${formatUsd(setting.amount_usd)} a cada ${setting.bundle_size} vídeos · ${paymentMethodLabel(setting.payment_method)}`;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function roundCurrency(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function roundRate(value: number) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}
