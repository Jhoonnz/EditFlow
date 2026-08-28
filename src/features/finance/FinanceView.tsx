import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  BadgeDollarSign,
  Banknote,
  CalendarRange,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  Clock3,
  FileDown,
  FilePlus2,
  LoaderCircle,
  Pencil,
  Plus,
  ReceiptText,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
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
import { fetchAllRows } from '../../lib/paginatedQuery';
import {
  currentFinancialCycle,
  financialCycleRange,
  formatFinancialCycle,
  isDateInRange,
  normalizeCycleStartDay,
  shiftMonthKey,
} from '../../lib/financialCycle';
import { estimateNetUsd, paymentFeeRule, paymentMethodLabel } from './paymentFees';
import type {
  Client,
  ClientBillingSetting,
  BillingCurrency,
  Earning,
  EarningEvent,
  EarningPayment,
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
  currency: BillingCurrency;
  amountUsd: string;
  earnedDate: string;
  paymentMethod: PaymentMethod;
  feePercent: string;
  feeFixedUsd: string;
  conversionSpreadPercent: string;
  status: 'pending' | 'received';
  actualAmountBrl: string;
};

type BatchReceiveDraft = {
  clientId: string | null;
  currency: BillingCurrency;
  selectedIds: string[];
  periodStart: string;
  periodEnd: string;
  receivedDate: string;
  paymentMethod: PaymentMethod;
  feePercent: string;
  feeFixed: string;
  conversionSpreadPercent: string;
  actualAmountBrl: string;
};

export function FinanceView({ workspace, clients, tasks }: Props) {
  const [settings, setSettings] = useState<ClientBillingSetting[]>([]);
  const [earnings, setEarnings] = useState<Earning[]>([]);
  const [events, setEvents] = useState<EarningEvent[]>([]);
  const [payments, setPayments] = useState<EarningPayment[]>([]);
  const [rate, setRate] = useState<EditFlowUsdBrlRate | null>(null);
  const [cycleMonth, setCycleMonth] = useState(currentMonth());
  const [cycleStartDay, setCycleStartDay] = useState(1);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [rateLoading, setRateLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [migrationMissing, setMigrationMissing] = useState(false);
  const [receivingBatch, setReceivingBatch] = useState<BatchReceiveDraft | null>(null);
  const [expandedPayments, setExpandedPayments] = useState<string[]>([]);
  const [manualEditor, setManualEditorState] = useState<Earning | 'new' | null>(null);
  const [manualDraft, setManualDraft] = useState<ManualEarningDraft>(() => emptyManualDraft());
  const [syncing, setSyncing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const cycleWorkspaceRef = useRef<string | null>(null);
  const setManualEditor = (value: Earning | 'new' | null) => {
    if (saving && value === null) return;
    setManualEditorState(value);
  };
  const appDialog = useAppDialog();
  const { begin: beginFinanceRequest, isLatest: isLatestFinanceRequest, cancel: cancelFinanceRequests } = useLatestRequest();
  useDialogFocus<HTMLElement>(Boolean(manualEditor) && !appDialog.open, () => setManualEditor(null), !saving, '.manual-earning-dialog');
  useDialogFocus<HTMLElement>(Boolean(receivingBatch) && !appDialog.open, () => setReceivingBatch(null), !saving, '.receive-dialog');

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
    const client = supabase;
    const requestId = beginFinanceRequest();
    if (!quiet) setLoading(true);
    setError(null);
    const [settingsResult, earningsResult, eventsResult, paymentsResult, workspaceCycleResult] = await Promise.all([
      fetchAllRows<ClientBillingSetting>(async (from, to) => await client.from('client_billing_settings').select('client_id, workspace_id, currency, pricing_model, amount_usd, bundle_size, payment_method, fee_percent, fee_fixed_usd, conversion_spread_percent, created_at, updated_at').eq('workspace_id', workspace.id).order('created_at').range(from, to)),
      fetchAllRows<Earning>(async (from, to) => await client.from('earnings').select('id, workspace_id, client_id, source_type, description, item_count, currency, amount_usd, net_amount_usd, payment_method, fee_percent, fee_fixed_usd, conversion_spread_percent, status, earned_at, received_at, exchange_rate_brl, amount_brl, payment_id, created_at, updated_at').eq('workspace_id', workspace.id).order('earned_at', { ascending: false }).range(from, to)),
      fetchAllRows<EarningEvent>(async (from, to) => await client.from('earning_events').select('id, workspace_id, client_id, task_id, task_title, completed_at, pricing_model, currency, amount_usd, bundle_size, payment_method, fee_percent, fee_fixed_usd, conversion_spread_percent, earning_id, created_at').eq('workspace_id', workspace.id).order('completed_at', { ascending: false }).range(from, to)),
      fetchAllRows<EarningPayment>(async (from, to) => await client.from('earning_payments').select('id, workspace_id, client_id, currency, payment_method, entry_count, item_count, gross_amount, estimated_net_amount, fee_percent, fee_fixed, conversion_spread_percent, received_amount_brl, effective_exchange_rate, period_start, period_end, received_at, created_by, created_at').eq('workspace_id', workspace.id).order('received_at', { ascending: false }).range(from, to)),
      client.from('workspaces').select('financial_cycle_start_day').eq('id', workspace.id).single(),
    ]);
    const loadError = settingsResult.error ?? earningsResult.error ?? eventsResult.error ?? paymentsResult.error ?? workspaceCycleResult.error;
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
    setPayments((paymentsResult.data ?? []).map(normalizeEarningPayment));
    const loadedCycleDay = normalizeCycleStartDay(workspaceCycleResult.data?.financial_cycle_start_day);
    setCycleStartDay(loadedCycleDay);
    if (cycleWorkspaceRef.current !== workspace.id) {
      cycleWorkspaceRef.current = workspace.id;
      setCycleMonth(currentFinancialCycle(loadedCycleDay));
    }
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'earning_payments', filter: `workspace_id=eq.${workspace.id}` }, scheduleReload)
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      void realtimeClient.removeChannel(channel);
    };
  }, [loadFinance, migrationMissing, workspace.id]);

  const cycleRange = useMemo(() => financialCycleRange(cycleMonth, cycleStartDay), [cycleMonth, cycleStartDay]);
  const cycleLabel = formatFinancialCycle(cycleRange);
  const cycleEarnings = useMemo(() => earnings.filter((earning) => isDateInRange(earning.earned_at, cycleRange)), [cycleRange, earnings]);
  const usdEarnings = cycleEarnings.filter((earning) => earning.currency === 'USD');
  const brlEarnings = cycleEarnings.filter((earning) => earning.currency === 'BRL');
  const grossUsd = sum(usdEarnings.map((earning) => earning.amount_usd));
  const pendingEarnings = cycleEarnings.filter((earning) => earning.status === 'pending');
  const receivedEarnings = cycleEarnings.filter((earning) => earning.status === 'received');
  const pendingPaymentGroups = buildPendingPaymentGroups(pendingEarnings);
  const netUsd = sum(receivedEarnings.filter((earning) => earning.currency === 'USD').map((earning) => earning.net_amount_usd))
    + sum(pendingPaymentGroups.filter((group) => group.currency === 'USD').map((group) => group.net));
  const netNativeBrl = sum(receivedEarnings.filter((earning) => earning.currency === 'BRL').map((earning) => earning.net_amount_usd))
    + sum(pendingPaymentGroups.filter((group) => group.currency === 'BRL').map((group) => group.net));
  const cyclePayments = payments.filter((payment) => isDateInRange(payment.received_at, cycleRange));
  const receivedPaymentCount = new Set(receivedEarnings.flatMap((earning) => earning.payment_id ? [earning.payment_id] : [earning.id])).size;
  const receivedBrl = sum(receivedEarnings.map((earning) => earning.amount_brl ?? 0));
  const pendingNetBrl = totalPendingGroupsBrl(pendingPaymentGroups, (group) => group.net, rate);
  const grossBrl = totalEarningsBrl(cycleEarnings, (earning) => earning.amount_usd, rate);
  const receivedFeeBrl = totalEarningsBrl(receivedEarnings, (earning) => earning.amount_usd - earning.net_amount_usd, rate);
  const pendingFeeBrl = totalPendingGroupsBrl(pendingPaymentGroups, (group) => group.gross - group.net, rate);
  const feeBrl = receivedFeeBrl === null || pendingFeeBrl === null ? null : receivedFeeBrl + pendingFeeBrl;
  const expectedNetBrl = pendingNetBrl === null ? null : receivedBrl + pendingNetBrl;
  const nativeNetSummary = [grossUsd ? formatUsd(netUsd) : '', netNativeBrl ? formatBrl(netNativeBrl) : ''].filter(Boolean).join(' + ');
  const clientSummaries = useMemo(() => clients.map((client) => {
    const clientEarnings = cycleEarnings.filter((earning) => earning.client_id === client.id);
    const setting = settings.find((item) => item.client_id === client.id);
    const unallocated = events.filter((event) => event.client_id === client.id && !event.earning_id);
    const pendingCurrencies = Array.from(new Set(
      earnings
        .filter((earning) => earning.client_id === client.id && earning.status === 'pending')
        .map((earning) => earning.currency),
    ));
    return {
      client,
      setting,
      grossBrl: totalEarningsBrl(clientEarnings, (earning) => earning.amount_usd, rate),
      netBrl: totalNetEarningsBrl(clientEarnings, rate),
      itemCount: sum(clientEarnings.map((earning) => earning.item_count)),
      pendingItems: unallocated.length,
      pendingCurrencies,
    };
  }).filter((summary) => summary.setting || summary.grossBrl || summary.pendingCurrencies.length), [clients, cycleEarnings, earnings, events, rate, settings]);
  const completedCycleTasks = useMemo(() => tasks.filter((task) => task.completed_at && isDateInRange(task.completed_at, cycleRange)), [cycleRange, tasks]);
  const deliveryIssues = useMemo(() => completedCycleTasks.flatMap((task) => {
    const event = events.find((item) => item.task_id === task.id);
    if (event?.earning_id) return [];
    if (event?.pricing_model === 'per_video') return [{ task, clientName: clients.find((item) => item.id === task.client_id)?.name ?? 'Cliente', reason: 'O evento está pronto para ser sincronizado.' }];
    if (event) return [];
    const client = clients.find((item) => item.id === task.client_id);
    if (!task.client_id || !client) return [{ task, clientName: 'Sem cliente', reason: 'Vincule um cliente para contabilizar esta entrega.' }];
    if (!settings.some((item) => item.client_id === task.client_id)) return [{ task, clientName: client.name, reason: 'Configure o pagamento deste cliente.' }];
    return [{ task, clientName: client.name, reason: 'A entrega está pronta para ser sincronizada.' }];
  }), [clients, completedCycleTasks, events, settings]);
  const bundleProgress = useMemo(() => clients.flatMap((client) => {
    const setting = settings.find((item) => item.client_id === client.id);
    if (!setting || setting.pricing_model !== 'bundle') return [];
    const pendingEvents = events.filter((event) => event.client_id === client.id && !event.earning_id);
    return pendingEvents.length ? [{ client, setting, pendingEvents }] : [];
  }), [clients, events, settings]);
  const receivingBatchEligible = useMemo(() => receivingBatch ? earnings.filter((earning) => (
    earning.client_id === receivingBatch.clientId
    && earning.currency === receivingBatch.currency
    && earning.status === 'pending'
    && earningInputDate(earning.earned_at) >= receivingBatch.periodStart
    && earningInputDate(earning.earned_at) <= receivingBatch.periodEnd
  )) : [], [earnings, receivingBatch]);
  const receivingBatchSelected = useMemo(() => receivingBatch
    ? receivingBatchEligible.filter((earning) => receivingBatch.selectedIds.includes(earning.id))
    : [], [receivingBatch, receivingBatchEligible]);
  const receivingBatchGross = sum(receivingBatchSelected.map((earning) => earning.amount_usd));
  const receivingBatchFeePercent = parseDraftNumber(receivingBatch?.feePercent);
  const receivingBatchFeeFixed = parseDraftNumber(receivingBatch?.feeFixed);
  const receivingBatchSpread = parseDraftNumber(receivingBatch?.conversionSpreadPercent);
  const receivingBatchNet = receivingBatch?.currency === 'BRL'
    ? receivingBatchGross
    : estimateNetUsd(receivingBatchGross, receivingBatchFeePercent, receivingBatchFeeFixed, receivingBatchSpread);
  const receivingBatchClient = clients.find((client) => client.id === receivingBatch?.clientId);

  const configureFinancialCycle = async () => {
    if (!supabase) return;
    const value = await appDialog.prompt({
      title: 'Início do ciclo financeiro',
      description: 'Escolha o dia em que um novo período de ganhos começa. Nos meses mais curtos, será usado o último dia disponível.',
      inputLabel: 'Dia do início (1 a 31)',
      initialValue: String(cycleStartDay),
      confirmLabel: 'Salvar ciclo',
    });
    if (value === null) return;
    const parsedDay = Number(value);
    if (!Number.isInteger(parsedDay) || parsedDay < 1 || parsedDay > 31) {
      setError('Informe um dia inteiro entre 1 e 31.');
      return;
    }

    setSaving(true);
    setError(null);
    setSuccess(null);
    const { error: cycleError } = await supabase.rpc('update_workspace_financial_cycle', {
      target_workspace: workspace.id,
      cycle_start_day: parsedDay,
    });
    setSaving(false);
    if (cycleError) return setError(financeErrorMessage(cycleError.message));
    setCycleStartDay(parsedDay);
    setCycleMonth(currentFinancialCycle(parsedDay));
    setSuccess(parsedDay === 1
      ? 'O financeiro voltou a acompanhar os meses do calendário.'
      : `O ciclo financeiro agora começa no dia ${parsedDay}.`);
  };

  const openManualEditor = (earning?: Earning) => {
    setError(null);
    setSuccess(null);
    if (!earning) {
      setManualEditor('new');
      setManualDraft(emptyManualDraft(cycleMonth, cycleStartDay));
      return;
    }
    setManualEditor(earning);
    setManualDraft({
      clientId: earning.client_id ?? '',
      description: earning.description,
      currency: earning.currency,
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
      currency: setting.currency,
      paymentMethod: setting.payment_method,
      feePercent: String(setting.fee_percent),
      feeFixedUsd: String(setting.fee_fixed_usd),
      conversionSpreadPercent: String(setting.currency === 'BRL' ? 0 : setting.conversion_spread_percent),
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

  const applyManualCurrency = (currency: BillingCurrency) => {
    setManualDraft((current) => ({
      ...current,
      currency,
      paymentMethod: currency === 'BRL' ? 'none' : current.paymentMethod,
      feePercent: currency === 'BRL' ? '0' : current.feePercent,
      feeFixedUsd: currency === 'BRL' ? '0' : current.feeFixedUsd,
      conversionSpreadPercent: currency === 'BRL' ? '0' : current.conversionSpreadPercent,
      actualAmountBrl: current.status === 'received' && currency === 'BRL' ? current.amountUsd : current.actualAmountBrl,
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
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) return setError(`Informe um valor bruto em ${manualDraft.currency === 'BRL' ? 'real' : 'dólar'} maior que zero.`);
    if (![feePercent, feeFixedUsd, conversionSpreadPercent].every(Number.isFinite)) return setError('Revise os valores das taxas.');
    if (manualDraft.status === 'received' && (!actualAmountBrl || actualAmountBrl <= 0)) return setError('Informe quanto realmente caiu em reais.');
    setSaving(true);
    setError(null);
    setSuccess(null);
    const commonValues = {
      client_target: manualDraft.clientId || null,
      earning_description: manualDraft.description.trim(),
      earning_currency: manualDraft.currency,
      gross_amount_usd: amountUsd,
      earning_date: new Date(`${manualDraft.earnedDate}T12:00:00`).toISOString(),
      earning_payment_method: manualDraft.paymentMethod,
      earning_fee_percent: feePercent,
      earning_fee_fixed_usd: feeFixedUsd,
      earning_conversion_spread_percent: manualDraft.currency === 'BRL' ? 0 : conversionSpreadPercent,
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

  const openBatchReceive = (clientId: string | null, currency: BillingCurrency, singleEarning?: Earning) => {
    const pending = earnings
      .filter((earning) => earning.client_id === clientId && earning.currency === currency && earning.status === 'pending')
      .sort((left, right) => left.earned_at.localeCompare(right.earned_at));
    const selected = singleEarning ? pending.filter((earning) => earning.id === singleEarning.id) : pending;
    if (!selected.length) return;
    const setting = settings.find((item) => item.client_id === clientId);
    const paymentMethod = currency === 'BRL' ? 'none' : (setting?.payment_method ?? selected[0].payment_method);
    const rule = currency === 'BRL' ? paymentFeeRule('none') : paymentFeeRule(paymentMethod);
    const feePercent = currency === 'BRL' ? 0 : (setting?.fee_percent ?? rule.feePercent);
    const feeFixed = currency === 'BRL' ? 0 : (setting?.fee_fixed_usd ?? rule.fixedFeeUsd);
    const spread = currency === 'BRL' ? 0 : (setting?.conversion_spread_percent ?? rule.conversionSpreadPercent);
    const gross = sum(selected.map((earning) => earning.amount_usd));
    const estimatedNet = currency === 'BRL' ? gross : estimateNetUsd(gross, feePercent, feeFixed, spread);
    const estimatedBrl = currency === 'BRL' ? gross : (rate ? estimatedNet * rate.rate : null);
    setReceivingBatch({
      clientId,
      currency,
      selectedIds: selected.map((earning) => earning.id),
      periodStart: earningInputDate(selected[0].earned_at),
      periodEnd: earningInputDate(selected[selected.length - 1].earned_at),
      receivedDate: localDateInputValue(new Date()),
      paymentMethod,
      feePercent: String(feePercent),
      feeFixed: String(feeFixed),
      conversionSpreadPercent: String(spread),
      actualAmountBrl: estimatedBrl === null ? '' : String(roundCurrency(estimatedBrl)).replace('.', ','),
    });
    setError(null);
    setSuccess(null);
  };

  const updateBatchPeriod = (field: 'periodStart' | 'periodEnd', value: string) => {
    setReceivingBatch((current) => {
      if (!current) return current;
      const next = { ...current, [field]: value };
      const selectedIds = earnings
        .filter((earning) => earning.client_id === current.clientId
          && earning.currency === current.currency
          && earning.status === 'pending'
          && earningInputDate(earning.earned_at) >= next.periodStart
          && earningInputDate(earning.earned_at) <= next.periodEnd)
        .map((earning) => earning.id);
      return { ...next, selectedIds };
    });
  };

  const updateBatchPaymentMethod = (paymentMethod: PaymentMethod) => {
    const rule = paymentFeeRule(paymentMethod);
    setReceivingBatch((current) => current ? {
      ...current,
      paymentMethod,
      feePercent: String(rule.feePercent),
      feeFixed: String(rule.fixedFeeUsd),
      conversionSpreadPercent: String(rule.conversionSpreadPercent),
    } : current);
  };

  const toggleBatchEarning = (earningId: string) => {
    setReceivingBatch((current) => current ? {
      ...current,
      selectedIds: current.selectedIds.includes(earningId)
        ? current.selectedIds.filter((id) => id !== earningId)
        : [...current.selectedIds, earningId],
    } : current);
  };

  const markBatchReceived = async () => {
    if (!supabase || !receivingBatch) return;
    const selected = earnings.filter((earning) => receivingBatch.selectedIds.includes(earning.id));
    if (!selected.length) return setError('Selecione pelo menos um lançamento para receber.');
    if (!receivingBatch.periodStart || !receivingBatch.periodEnd || !receivingBatch.receivedDate) return setError('Preencha o período e a data do recebimento.');
    if (receivingBatch.periodEnd < receivingBatch.periodStart) return setError('A data final deve ser igual ou posterior à data inicial.');
    const feePercent = Number(receivingBatch.feePercent.replace(',', '.'));
    const feeFixed = Number(receivingBatch.feeFixed.replace(',', '.'));
    const spread = Number(receivingBatch.conversionSpreadPercent.replace(',', '.'));
    const gross = sum(selected.map((earning) => earning.amount_usd));
    const actualBrl = receivingBatch.currency === 'BRL'
      ? gross
      : Number(receivingBatch.actualAmountBrl.replace(',', '.'));
    if (![feePercent, feeFixed, spread].every(Number.isFinite)) return setError('Revise os valores das taxas do pagamento.');
    if (!Number.isFinite(actualBrl) || actualBrl <= 0) return setError('Informe o valor em reais que realmente caiu na conta.');

    setSaving(true);
    setError(null);
    const { error: paymentError } = await supabase.rpc('register_earning_payment_batch', {
      target_workspace: workspace.id,
      target_client: receivingBatch.clientId,
      target_earning_ids: receivingBatch.selectedIds,
      target_payment_method: receivingBatch.currency === 'BRL' ? 'none' : receivingBatch.paymentMethod,
      target_fee_percent: receivingBatch.currency === 'BRL' ? 0 : feePercent,
      target_fee_fixed: receivingBatch.currency === 'BRL' ? 0 : feeFixed,
      target_conversion_spread_percent: receivingBatch.currency === 'BRL' ? 0 : spread,
      target_received_amount_brl: roundCurrency(actualBrl),
      target_period_start: receivingBatch.periodStart,
      target_period_end: receivingBatch.periodEnd,
      target_received_at: new Date(`${receivingBatch.receivedDate}T12:00:00`).toISOString(),
    });
    setSaving(false);
    if (paymentError) return setError(financeErrorMessage(paymentError.message));
    setReceivingBatch(null);
    await loadFinance(true);
    setSuccess(`Pagamento de ${selected.length} ${selected.length === 1 ? 'lançamento' : 'lançamentos'} registrado.`);
  };

  const reopenPayment = async (payment: EarningPayment) => {
    if (!supabase || saving) return;
    const confirmed = await appDialog.confirm({
      title: 'Reabrir este pagamento?',
      description: `Os ${payment.entry_count} lançamentos voltarão para pendentes. O registro do pagamento será removido.`,
      confirmLabel: 'Reabrir pagamento',
      tone: 'danger',
    });
    if (!confirmed) return;
    setSaving(true);
    setError(null);
    const { error: reopenError } = await supabase.rpc('reopen_earning_payment', { target_payment: payment.id });
    setSaving(false);
    if (reopenError) return setError(financeErrorMessage(reopenError.message));
    await loadFinance(true);
    setSuccess('O pagamento foi reaberto e os lançamentos voltaram para pendentes.');
  };

  const reopenEarning = async (earning: Earning) => {
    if (!supabase) return;
    if (earning.payment_id) {
      const payment = payments.find((item) => item.id === earning.payment_id);
      if (payment) return reopenPayment(payment);
    }
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

  const exportMonthlyReport = async () => {
    if (exporting) return;
    setExporting(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await window.editflow.exportFinancialReport({
        workspaceName: workspace.name,
        month: cycleMonth,
        monthLabel: cycleLabel,
        generatedAt: new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeStyle: 'short' }).format(new Date()),
        usdBrlRate: rate?.rate ?? null,
        totals: {
          grossBrl,
          feesBrl: feeBrl,
          netBrl: expectedNetBrl,
          receivedBrl,
          pendingBrl: pendingNetBrl,
          entries: cycleEarnings.length,
        },
        rows: cycleEarnings.map((earning) => {
          const client = clients.find((item) => item.id === earning.client_id);
          return {
            client: client?.name || (earning.source_type === 'manual' ? 'Lançamento avulso' : 'Cliente removido'),
            description: earning.description,
            date: new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(earning.earned_at)),
            source: earningSourceLabel(earning.source_type),
            currency: earning.currency,
            gross: earning.amount_usd,
            fees: earning.amount_usd - earning.net_amount_usd,
            net: earning.net_amount_usd,
            netBrl: earningNetBrl(earning, rate),
            status: earning.status,
          };
        }),
      });
      if (!result.cancelled) setSuccess(`Relatório do ciclo ${cycleLabel} exportado em PDF.`);
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : 'Não foi possível exportar o relatório em PDF.');
    } finally {
      setExporting(false);
    }
  };

  if (loading) return <div className="finance-loading"><LoaderCircle className="spinner" size={24} />Carregando ganhos…</div>;

  if (migrationMissing) {
    return (
      <div className="finance-view finance-empty-state">
        <span><WalletCards size={25} /></span>
        <h2>Ative o módulo financeiro</h2>
        <p>Execute as migrations financeiras pendentes, incluindo <strong>027_batch_earning_payments.sql</strong>, no SQL Editor do Supabase. Depois, volte aqui e tente novamente.</p>
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
          <span>Líquido estimado no ciclo de {cycleLabel}{nativeNetSummary ? ` · ${nativeNetSummary} nas moedas originais` : ''}</span>
        </div>
        <div
          className="finance-rate-card"
          title={rate ? `${rate.stale ? 'Última cotação salva' : 'Cotação atual'} · ${formatCompactDate(rate.sourceUpdatedAt)}` : 'Sem cotação salva'}
        >
          <span><TrendingUp size={14} /></span>
          <div><small>USD → BRL</small><strong>{rate ? formatRate(rate.rate) : '—'}</strong><em>{rate ? `${rate.stale ? 'Última cotação salva' : 'Cotação atual'} · ${formatCompactDate(rate.sourceUpdatedAt)}` : 'Sem cotação salva'}</em></div>
          <button aria-label="Atualizar cotação" onClick={() => void loadRate()} disabled={rateLoading}><RefreshCw className={rateLoading ? 'spinner' : ''} size={15} /></button>
        </div>
        <div className="finance-cycle">
          <span>Ciclo financeiro</span>
          <div>
            <button type="button" aria-label="Ciclo anterior" onClick={() => setCycleMonth((current) => shiftMonthKey(current, -1))}><ChevronLeft size={15} /></button>
            <strong><CalendarRange size={14} /><span>{cycleLabel}</span></strong>
            <button type="button" aria-label="Próximo ciclo" onClick={() => setCycleMonth((current) => shiftMonthKey(current, 1))}><ChevronRight size={15} /></button>
          </div>
          <button className="finance-cycle-setting" type="button" disabled={saving} onClick={() => void configureFinancialCycle()}><Settings2 size={12} />Inicia no dia {cycleStartDay}</button>
        </div>
        <div className="finance-hero-actions"><button className="secondary-button" disabled={exporting} onClick={() => void exportMonthlyReport()}>{exporting ? <LoaderCircle className="spinner" size={14} /> : <FileDown size={14} />}Exportar PDF</button><button className="secondary-button" disabled={syncing} onClick={() => void synchronizeEarnings()}>{syncing ? <LoaderCircle className="spinner" size={14} /> : <RefreshCw size={14} />}Sincronizar</button><button className="primary-button" onClick={() => openManualEditor()}><Plus size={14} />Novo lançamento</button></div>
      </section>

      {error ? <div className="panel-error finance-error">{error}</div> : null}
      {success ? <div className="panel-success finance-success"><CheckCircle2 size={15} />{success}</div> : null}

      <section className="finance-metrics">
        <article><span className="purple"><BadgeDollarSign size={18} /></span><div><small>Faturamento bruto</small><strong>{grossBrl === null ? '—' : formatBrl(grossBrl)}</strong><em>{cycleEarnings.length} lançamentos</em></div></article>
        <article><span className="orange"><ReceiptText size={18} /></span><div><small>Taxas estimadas</small><strong>{feeBrl === null ? '—' : `-${formatBrl(feeBrl)}`}</strong><em>USD e BRL consolidados</em></div></article>
        <article><span className="blue"><CircleDollarSign size={18} /></span><div><small>Líquido estimado</small><strong>{expectedNetBrl === null ? '—' : formatBrl(expectedNetBrl)}</strong><em>{nativeNetSummary || 'Sem lançamentos'}</em></div></article>
        <article><span className="green"><Banknote size={18} /></span><div><small>Recebido</small><strong>{formatBrl(receivedBrl)}</strong><em>{receivedPaymentCount} pagamentos</em></div></article>
      </section>

      <section className="finance-card client-earnings-card finance-client-summary">
          <header><span><WalletCards size={18} /></span><div><h3>Resumo por cliente</h3><p>Valores gerados no ciclo selecionado. Configure o pagamento ao criar ou editar um cliente.</p></div></header>
          <div className="client-earning-list">
            {clientSummaries.map(({ client, setting, grossBrl: clientGrossBrl, netBrl: clientNetBrl, itemCount, pendingItems, pendingCurrencies }) => (
              <article key={client.id}>
                <span className="finance-client-avatar">{client.youtube_thumbnail_url ? <img src={client.youtube_thumbnail_url} alt={`Canal de ${client.name}`} /> : client.name.slice(0,1).toUpperCase()}</span>
                <div><strong>{client.name}</strong><small>{setting ? billingDescription(setting) : 'Sem configuração atual'}{setting?.pricing_model === 'bundle' && pendingItems ? ` · ${pendingItems}/${setting.bundle_size} no próximo pacote` : ''}</small></div>
                <em>{clientNetBrl === null ? '—' : formatBrl(clientNetBrl)}<small>líquido · bruto {clientGrossBrl === null ? '—' : formatBrl(clientGrossBrl)} · {itemCount} vídeos</small></em>
                {pendingCurrencies.length ? <div className="client-earning-actions">{pendingCurrencies.map((currency) => {
                  const pendingCount = earnings.filter((earning) => earning.client_id === client.id && earning.currency === currency && earning.status === 'pending').length;
                  return <button key={currency} onClick={() => openBatchReceive(client.id, currency)}><Banknote size={12} />Receber {pendingCount}{pendingCurrencies.length > 1 ? ` ${currency}` : ''}</button>;
                })}</div> : null}
              </article>
            ))}
            {!clientSummaries.length ? <div className="finance-list-empty">Configure o primeiro cliente para começar a contabilizar as entregas.</div> : null}
          </div>
      </section>

      {cyclePayments.length ? <section className="finance-card payment-history-card">
        <header><span><ReceiptText size={18} /></span><div><h3>Pagamentos recebidos</h3><p>Cada transferência reúne os lançamentos pagos pelo cliente naquele período.</p></div></header>
        <div className="payment-history-list">
          {cyclePayments.map((payment) => {
            const paymentEarnings = earnings.filter((earning) => earning.payment_id === payment.id);
            const client = clients.find((item) => item.id === payment.client_id);
            const paymentClientName = client?.name ?? (paymentEarnings.every((earning) => earning.source_type === 'manual') ? 'Lançamento avulso' : 'Cliente removido');
            const expanded = expandedPayments.includes(payment.id);
            return <article key={payment.id} className={expanded ? 'expanded' : ''}>
              <button className="payment-history-main" onClick={() => setExpandedPayments((current) => current.includes(payment.id) ? current.filter((id) => id !== payment.id) : [...current, payment.id])}>
                <span className="payment-history-icon"><Banknote size={15} /></span>
                <span><strong>{paymentClientName}</strong><small>{formatDateOnly(payment.period_start)} a {formatDateOnly(payment.period_end)} · {payment.entry_count} lançamentos · {payment.item_count} vídeos</small></span>
                <span><strong>{formatBrl(payment.received_amount_brl)}</strong><small>{payment.currency === 'BRL' ? 'PIX · sem taxas' : `${formatMoney(payment.gross_amount, payment.currency)} bruto · ${paymentMethodLabel(payment.payment_method)}`}</small></span>
                <ChevronDown size={15} />
              </button>
              {expanded ? <div className="payment-history-details">
                <div className="payment-history-meta"><span>Recebido em <strong>{formatCompactDate(payment.received_at)}</strong></span><span>Líquido estimado <strong>{formatMoney(payment.estimated_net_amount, payment.currency)}</strong></span>{payment.currency === 'USD' ? <span>Câmbio efetivo <strong>{formatRate(payment.effective_exchange_rate)}</strong></span> : null}</div>
                <div className="payment-history-items">{paymentEarnings.map((earning) => <span key={earning.id}><i />{earning.description}<strong>{formatMoney(earning.amount_usd, earning.currency)}</strong></span>)}</div>
                <button className="payment-reopen-button" disabled={saving} onClick={() => void reopenPayment(payment)}><RotateCcw size={12} />Reabrir pagamento</button>
              </div> : null}
            </article>;
          })}
        </div>
      </section> : null}

      {(deliveryIssues.length || bundleProgress.length) ? <section className="finance-card finance-pending-card">
        <header><span><Clock3 size={18} /></span><div><h3>Entregas em acompanhamento</h3><p>Veja o que ainda não virou um lançamento completo.</p></div></header>
        <div className="finance-pending-list">
          {bundleProgress.map(({ client, setting, pendingEvents }) => <article key={client.id}><span className="pending-progress"><b style={{ width: `${Math.min(100, pendingEvents.length / setting.bundle_size * 100)}%` }} /></span><div><strong>{client.name}</strong><small>{pendingEvents.map((event) => event.task_title).join(', ')}</small></div><em>{pendingEvents.length}/{setting.bundle_size}<small>próximo pacote</small></em></article>)}
          {deliveryIssues.map(({ task, clientName, reason }) => <article className="issue" key={task.id}><span className="pending-warning"><FilePlus2 size={15} /></span><div><strong>{task.title}</strong><small>{clientName} · {reason}</small></div><em>Não lançado</em></article>)}
        </div>
      </section> : null}

      <section className="finance-card earnings-history-card">
        <header><span><CheckCircle2 size={18} /></span><div><h3>Lançamentos do ciclo</h3><p>Automáticos vêm da última coluna; manuais podem ser corrigidos ou removidos.</p></div><button className="finance-add-entry" onClick={() => openManualEditor()}><Plus size={14} />Adicionar</button></header>
        <div className="earnings-table">
          <div className="earnings-table-head"><span>Cliente / lançamento</span><span>Data</span><span>Valor</span><span>Status / ações</span></div>
          {cycleEarnings.map((earning) => {
            const client = clients.find((item) => item.id === earning.client_id);
            const displayBrl = earningNetBrl(earning, rate);
            const earningFee = earning.amount_usd - earning.net_amount_usd;
            return (
              <article key={earning.id}>
                <div><strong>{client?.name || (earning.source_type === 'manual' ? 'Lançamento avulso' : 'Cliente removido')}<i className={`earning-source ${earning.source_type}`}>{earningSourceLabel(earning.source_type)}</i></strong><small>{earning.description} · {paymentMethodLabel(earning.payment_method)}{earning.source_type !== 'manual' ? ` · ${earning.item_count} ${earning.item_count === 1 ? 'vídeo' : 'vídeos'}` : ''}</small></div>
                <span>{formatCompactDate(earning.earned_at)}</span>
                <div className="earning-value"><strong>{displayBrl === null ? '—' : formatBrl(displayBrl)}</strong><small>{earning.currency} · líquido {formatMoney(earning.net_amount_usd, earning.currency)} · bruto {formatMoney(earning.amount_usd, earning.currency)} · taxas {formatMoney(earningFee, earning.currency)}{earning.currency === 'USD' && earning.exchange_rate_brl ? ` · câmbio efetivo ${formatRate(earning.exchange_rate_brl)}` : ''}</small></div>
                <div className="earning-row-actions">{earning.status === 'received'
                  ? <button className="earning-status received" disabled={saving} onClick={() => void reopenEarning(earning)}><CheckCircle2 size={13} />{earning.payment_id ? 'Recebido em lote' : 'Recebido'}</button>
                  : <button className="earning-status pending" disabled={saving} onClick={() => openBatchReceive(earning.client_id, earning.currency, earning)}><Clock3 size={13} />Marcar recebido</button>}{earning.source_type === 'manual' && !earning.payment_id ? <><button className="earning-icon-action" onClick={() => openManualEditor(earning)} aria-label="Editar lançamento"><Pencil size={13} /></button><button className="earning-icon-action danger" onClick={() => void deleteManualEarning(earning)} aria-label="Excluir lançamento"><Trash2 size={13} /></button></> : null}</div>
              </article>
            );
          })}
          {!cycleEarnings.length ? <div className="finance-list-empty">Nenhum ganho foi gerado neste ciclo.</div> : null}
        </div>
      </section>

      {manualEditor ? (
        <div className="manual-earning-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setManualEditor(null); }}>
          <section className="manual-earning-dialog" role="dialog" aria-modal="true" aria-labelledby="manual-earning-title">
            <header><span><FilePlus2 size={18} /></span><div><h3 id="manual-earning-title">{manualEditor === 'new' ? 'Novo lançamento' : 'Editar lançamento'}</h3><p>Registre bônus, extras ou trabalhos que não vieram de uma tarefa.</p></div><button onClick={() => setManualEditor(null)} aria-label="Fechar"><X size={17} /></button></header>
            <div className="manual-earning-grid">
              <label><span>Cliente</span><select value={manualDraft.clientId} onChange={(event) => applyManualClient(event.target.value)}><option value="">Sem cliente específico</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
              <label className="manual-date-field"><span>Data do lançamento</span><input type="date" value={manualDraft.earnedDate} onChange={(event) => setManualDraft({ ...manualDraft, earnedDate: event.target.value })} /></label>
              <label className="wide"><span>Descrição</span><input maxLength={300} value={manualDraft.description} onChange={(event) => setManualDraft({ ...manualDraft, description: event.target.value })} placeholder="Ex.: Bônus do projeto especial" /></label>
              <label><span>Moeda</span><select value={manualDraft.currency} onChange={(event) => applyManualCurrency(event.target.value as BillingCurrency)}><option value="USD">Dólar americano (USD)</option><option value="BRL">Real brasileiro (BRL)</option></select></label>
              <label><span>Valor bruto</span><div className="manual-money-input"><b>{manualDraft.currency === 'BRL' ? 'R$' : 'US$'}</b><input inputMode="decimal" value={manualDraft.amountUsd} onChange={(event) => setManualDraft({ ...manualDraft, amountUsd: event.target.value })} placeholder={manualDraft.currency === 'BRL' ? '0,00' : '0.00'} /></div></label>
              <label><span>Meio de pagamento</span><select value={manualDraft.paymentMethod} onChange={(event) => applyManualPaymentMethod(event.target.value as PaymentMethod)}><option value="none">Sem taxas</option>{manualDraft.currency === 'USD' ? <><option value="paypal_international">PayPal internacional</option><option value="wise_ach">Wise ACH</option><option value="wise_wire">Wise Wire</option></> : null}<option value="custom">Taxa personalizada</option></select></label>
              <label><span>Taxa percentual</span><div className="manual-money-input"><input inputMode="decimal" value={manualDraft.feePercent} onChange={(event) => setManualDraft({ ...manualDraft, feePercent: event.target.value })} /><b>%</b></div></label>
              <label><span>Taxa fixa</span><div className="manual-money-input"><b>{manualDraft.currency === 'BRL' ? 'R$' : 'US$'}</b><input inputMode="decimal" value={manualDraft.feeFixedUsd} onChange={(event) => setManualDraft({ ...manualDraft, feeFixedUsd: event.target.value })} /></div></label>
              {manualDraft.currency === 'USD' ? <label><span>Spread de conversão</span><div className="manual-money-input"><input inputMode="decimal" value={manualDraft.conversionSpreadPercent} onChange={(event) => setManualDraft({ ...manualDraft, conversionSpreadPercent: event.target.value })} /><b>%</b></div></label> : null}
              <label><span>Status</span><select value={manualDraft.status} onChange={(event) => setManualDraft({ ...manualDraft, status: event.target.value as 'pending' | 'received', actualAmountBrl: event.target.value === 'received' && manualDraft.currency === 'BRL' ? manualDraft.amountUsd : manualDraft.actualAmountBrl })}><option value="pending">Pendente</option><option value="received">Recebido</option></select></label>
              {manualDraft.status === 'received' ? <label className="wide"><span>Valor real recebido</span><div className="manual-money-input received"><b>R$</b><input inputMode="decimal" value={manualDraft.actualAmountBrl} onChange={(event) => setManualDraft({ ...manualDraft, actualAmountBrl: event.target.value })} placeholder="0,00" /></div></label> : null}
            </div>
            {error ? <div className="panel-error manual-earning-error">{error}</div> : null}
            <footer><button className="secondary-button" disabled={saving} onClick={() => setManualEditor(null)}>Cancelar</button><button className="primary-button" disabled={saving} onClick={() => void saveManualEarning()}>{saving ? <LoaderCircle className="spinner" size={15} /> : <Save size={15} />}{manualEditor === 'new' ? 'Criar lançamento' : 'Salvar alterações'}</button></footer>
          </section>
        </div>
      ) : null}

      {receivingBatch ? (
        <div className="receive-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) setReceivingBatch(null); }}>
          <section className="receive-dialog batch-receive-dialog" role="dialog" aria-modal="true" aria-labelledby="receive-dialog-title">
            <header><span><Banknote size={18} /></span><div><h3 id="receive-dialog-title">Registrar pagamento</h3><p>{receivingBatchClient?.name ?? 'Lançamento avulso'} · escolha os lançamentos incluídos na transferência.</p></div><button disabled={saving} onClick={() => setReceivingBatch(null)} aria-label="Fechar"><X size={17} /></button></header>
            <div className="receive-dialog-summary"><div><span>Lançamentos</span><strong>{receivingBatchSelected.length} · {sum(receivingBatchSelected.map((earning) => earning.item_count))} vídeos</strong></div><div><span>Bruto</span><strong>{formatMoney(receivingBatchGross, receivingBatch.currency)}</strong></div><div><span>Líquido estimado</span><strong>{formatMoney(receivingBatchNet, receivingBatch.currency)}</strong></div></div>

            <div className="batch-receive-grid">
              <label><span>Início do período</span><input type="date" value={receivingBatch.periodStart} onChange={(event) => updateBatchPeriod('periodStart', event.target.value)} /></label>
              <label><span>Fim do período</span><input type="date" value={receivingBatch.periodEnd} onChange={(event) => updateBatchPeriod('periodEnd', event.target.value)} /></label>
              <label><span>Data do recebimento</span><input type="date" value={receivingBatch.receivedDate} onChange={(event) => setReceivingBatch({ ...receivingBatch, receivedDate: event.target.value })} /></label>
            </div>

            <div className="batch-receive-selection">
              <header><div><strong>Lançamentos do período</strong><small>{receivingBatchEligible.length} disponíveis</small></div><button type="button" onClick={() => setReceivingBatch({ ...receivingBatch, selectedIds: receivingBatchSelected.length === receivingBatchEligible.length ? [] : receivingBatchEligible.map((earning) => earning.id) })}>{receivingBatchSelected.length === receivingBatchEligible.length ? 'Desmarcar todos' : 'Selecionar todos'}</button></header>
              <div>{receivingBatchEligible.map((earning) => <label key={earning.id}>
                <input type="checkbox" checked={receivingBatch.selectedIds.includes(earning.id)} onChange={() => toggleBatchEarning(earning.id)} />
                <span><strong>{earning.description}</strong><small>{formatCompactDate(earning.earned_at)} · {earning.item_count} {earning.item_count === 1 ? 'vídeo' : 'vídeos'}</small></span>
                <b>{formatMoney(earning.amount_usd, earning.currency)}</b>
              </label>)}</div>
            </div>

            {receivingBatch.currency === 'BRL' ? <div className="batch-pix-note"><span><CheckCircle2 size={15} /></span><div><strong>Recebimento por PIX</strong><small>Sem taxas ou conversão. O valor recebido será {formatBrl(receivingBatchGross)}.</small></div></div> : <div className="batch-payment-fields">
              <label className="wide"><span>Meio de pagamento</span><select value={receivingBatch.paymentMethod} onChange={(event) => updateBatchPaymentMethod(event.target.value as PaymentMethod)}><option value="none">Sem taxas</option><option value="paypal_international">PayPal internacional</option><option value="wise_ach">Wise ACH</option><option value="wise_wire">Wise Wire</option><option value="custom">Taxa personalizada</option></select></label>
              <label><span>Taxa percentual</span><div><input inputMode="decimal" value={receivingBatch.feePercent} onChange={(event) => setReceivingBatch({ ...receivingBatch, feePercent: event.target.value })} /><b>%</b></div></label>
              <label><span>Taxa fixa</span><div><b>US$</b><input inputMode="decimal" value={receivingBatch.feeFixed} onChange={(event) => setReceivingBatch({ ...receivingBatch, feeFixed: event.target.value })} /></div></label>
              <label><span>Spread de conversão</span><div><input inputMode="decimal" value={receivingBatch.conversionSpreadPercent} onChange={(event) => setReceivingBatch({ ...receivingBatch, conversionSpreadPercent: event.target.value })} /><b>%</b></div></label>
              <label><span>Quanto caiu em reais?</span><div><b>R$</b><input autoFocus inputMode="decimal" value={receivingBatch.actualAmountBrl} onChange={(event) => setReceivingBatch({ ...receivingBatch, actualAmountBrl: event.target.value })} placeholder="0,00" /></div></label>
            </div>}

            <small>A taxa fixa é aplicada uma única vez sobre todo o pagamento.</small>
            {error ? <div className="panel-error receive-dialog-error">{error}</div> : null}
            <button className="primary-button" disabled={saving || !receivingBatchSelected.length} onClick={() => void markBatchReceived()}>{saving ? <LoaderCircle className="spinner" size={15} /> : <CheckCircle2 size={15} />}Confirmar {receivingBatchSelected.length} {receivingBatchSelected.length === 1 ? 'lançamento' : 'lançamentos'}</button>
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
    currency: (row.currency === 'BRL' ? 'BRL' : 'USD') as BillingCurrency,
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
    currency: (row.currency === 'BRL' ? 'BRL' : 'USD') as BillingCurrency,
    amount_usd: Number(row.amount_usd),
    net_amount_usd: Number(row.net_amount_usd ?? row.amount_usd),
    item_count: Number(row.item_count),
    payment_method: (row.payment_method ?? 'none') as PaymentMethod,
    fee_percent: Number(row.fee_percent ?? 0),
    fee_fixed_usd: Number(row.fee_fixed_usd ?? 0),
    conversion_spread_percent: Number(row.conversion_spread_percent ?? 0),
    exchange_rate_brl: row.exchange_rate_brl === null ? null : Number(row.exchange_rate_brl),
    amount_brl: row.amount_brl === null ? null : Number(row.amount_brl),
    payment_id: typeof row.payment_id === 'string' ? row.payment_id : null,
  } as Earning;
}

function normalizeEarningPayment(row: Record<string, unknown>) {
  return {
    ...row,
    currency: (row.currency === 'BRL' ? 'BRL' : 'USD') as BillingCurrency,
    payment_method: (row.payment_method ?? 'none') as PaymentMethod,
    entry_count: Number(row.entry_count),
    item_count: Number(row.item_count),
    gross_amount: Number(row.gross_amount),
    estimated_net_amount: Number(row.estimated_net_amount),
    fee_percent: Number(row.fee_percent ?? 0),
    fee_fixed: Number(row.fee_fixed ?? 0),
    conversion_spread_percent: Number(row.conversion_spread_percent ?? 0),
    received_amount_brl: Number(row.received_amount_brl),
    effective_exchange_rate: Number(row.effective_exchange_rate),
  } as EarningPayment;
}

function normalizeEarningEvent(row: Record<string, unknown>) {
  return {
    ...row,
    currency: (row.currency === 'BRL' ? 'BRL' : 'USD') as BillingCurrency,
    amount_usd: Number(row.amount_usd),
    bundle_size: Number(row.bundle_size),
    payment_method: (row.payment_method ?? 'none') as PaymentMethod,
    fee_percent: Number(row.fee_percent ?? 0),
    fee_fixed_usd: Number(row.fee_fixed_usd ?? 0),
    conversion_spread_percent: Number(row.conversion_spread_percent ?? 0),
  } as EarningEvent;
}

function emptyManualDraft(selectedCycle = currentMonth(), cycleStartDay = 1): ManualEarningDraft {
  const today = new Date();
  const range = financialCycleRange(selectedCycle, cycleStartDay);
  const selectedDate = isDateInRange(today, range) ? today : range.start;
  const date = localDateInputValue(selectedDate);
  return {
    clientId: '',
    description: '',
    currency: 'USD',
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
  if (normalized.includes('update_workspace_financial_cycle') || normalized.includes('financial_cycle_start_day')) {
    return 'Execute a migration 026_financial_cycles.sql no Supabase para configurar ciclos financeiros.';
  }
  if (normalized.includes('register_earning_payment_batch') || normalized.includes('reopen_earning_payment') || normalized.includes('earning_payments') || normalized.includes('payment_id')) {
    return 'Execute a migration 027_batch_earning_payments.sql no Supabase para ativar recebimentos em lote.';
  }
  if (normalized.includes('create_manual_earning') || normalized.includes('update_manual_earning') || normalized.includes('sync_workspace_earnings') || normalized.includes('schema cache')) {
    return 'Execute as migrations financeiras pendentes, incluindo 027_batch_earning_payments.sql, no Supabase.';
  }
  if (normalized.includes('description')) return 'Revise a descrição do lançamento.';
  if (normalized.includes('gross amount')) return 'Informe um valor bruto maior que zero.';
  if (normalized.includes('actual brl')) return 'Informe quanto realmente caiu em reais.';
  return message;
}

function isMissingFinanceSchema(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes('client_billing_settings') || normalized.includes('earning_events') || normalized.includes('earning_payments') || normalized.includes('payment_id') || normalized.includes('net_amount_usd') || normalized.includes('currency') || normalized.includes('payment_method') || normalized.includes('financial_cycle_start_day') || normalized.includes('schema cache');
}

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2,'0')}`;
}

function localDateInputValue(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function earningInputDate(date: string) {
  return localDateInputValue(new Date(date));
}

function formatDateOnly(date: string) {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(`${date}T12:00:00`));
}

function parseDraftNumber(value?: string) {
  const parsed = Number((value ?? '0').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatUsd(value: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
}

function formatBrl(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

function formatMoney(value: number, currency: BillingCurrency) {
  return currency === 'BRL' ? formatBrl(value) : formatUsd(value);
}

function earningRateToBrl(earning: Earning, rate: EditFlowUsdBrlRate | null) {
  if (earning.currency === 'BRL') return 1;
  if (earning.status === 'received' && earning.exchange_rate_brl) return earning.exchange_rate_brl;
  return rate?.rate ?? null;
}

function earningNetBrl(earning: Earning, rate: EditFlowUsdBrlRate | null) {
  if (earning.status === 'received' && earning.amount_brl !== null) return earning.amount_brl;
  const conversionRate = earningRateToBrl(earning, rate);
  return conversionRate === null ? null : earning.net_amount_usd * conversionRate;
}

function totalEarningsBrl(earnings: Earning[], amount: (earning: Earning) => number, rate: EditFlowUsdBrlRate | null) {
  let total = 0;
  for (const earning of earnings) {
    const nativeAmount = amount(earning);
    if (!nativeAmount) continue;
    const conversionRate = earningRateToBrl(earning, rate);
    if (conversionRate === null) return null;
    total += nativeAmount * conversionRate;
  }
  return total;
}

function totalNetEarningsBrl(earnings: Earning[], rate: EditFlowUsdBrlRate | null) {
  let total = 0;
  for (const earning of earnings) {
    const converted = earningNetBrl(earning, rate);
    if (converted === null) return null;
    total += converted;
  }
  return total;
}

type PendingPaymentGroup = {
  currency: BillingCurrency;
  gross: number;
  net: number;
  feePercent: number;
  feeFixed: number;
  spread: number;
};

function buildPendingPaymentGroups(earnings: Earning[]) {
  const groups = new Map<string, PendingPaymentGroup>();
  for (const earning of earnings) {
    const key = [
      earning.client_id ?? earning.id,
      earning.currency,
      earning.payment_method,
      earning.fee_percent,
      earning.fee_fixed_usd,
      earning.conversion_spread_percent,
    ].join(':');
    const current = groups.get(key) ?? {
      currency: earning.currency,
      gross: 0,
      net: 0,
      feePercent: earning.currency === 'BRL' ? 0 : earning.fee_percent,
      feeFixed: earning.currency === 'BRL' ? 0 : earning.fee_fixed_usd,
      spread: earning.currency === 'BRL' ? 0 : earning.conversion_spread_percent,
    };
    current.gross += earning.amount_usd;
    groups.set(key, current);
  }

  return Array.from(groups.values()).map((group) => ({
    ...group,
    net: group.currency === 'BRL'
      ? roundCurrency(group.gross)
      : estimateNetUsd(group.gross, group.feePercent, group.feeFixed, group.spread),
  }));
}

function totalPendingGroupsBrl(
  groups: PendingPaymentGroup[],
  amount: (group: PendingPaymentGroup) => number,
  rate: EditFlowUsdBrlRate | null,
) {
  let total = 0;
  for (const group of groups) {
    const nativeAmount = amount(group);
    if (!nativeAmount) continue;
    if (group.currency === 'BRL') total += nativeAmount;
    else if (rate) total += nativeAmount * rate.rate;
    else return null;
  }
  return total;
}

function formatRate(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(value);
}

function formatCompactDate(date: string) {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(date));
}

function billingDescription(setting: ClientBillingSetting) {
  const method = setting.currency === 'BRL' ? 'PIX · sem taxas' : paymentMethodLabel(setting.payment_method);
  return setting.pricing_model === 'per_video'
    ? `${formatMoney(setting.amount_usd, setting.currency)} por vídeo · ${method}`
    : `${formatMoney(setting.amount_usd, setting.currency)} a cada ${setting.bundle_size} vídeos · ${method}`;
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
