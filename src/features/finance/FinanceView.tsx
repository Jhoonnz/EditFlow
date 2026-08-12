import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  BadgeDollarSign,
  Banknote,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  LoaderCircle,
  ReceiptText,
  RefreshCw,
  TrendingUp,
  Video,
  WalletCards,
  X,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { paymentMethodLabel } from './paymentFees';
import type {
  Client,
  ClientBillingSetting,
  Earning,
  EarningEvent,
  PaymentMethod,
  WorkspaceSummary,
} from '../workspace/types';

type Props = {
  workspace: WorkspaceSummary;
  clients: Client[];
};

export function FinanceView({ workspace, clients }: Props) {
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
    if (!quiet) setLoading(true);
    setError(null);
    const [settingsResult, earningsResult, eventsResult] = await Promise.all([
      supabase.from('client_billing_settings').select('client_id, workspace_id, currency, pricing_model, amount_usd, bundle_size, payment_method, fee_percent, fee_fixed_usd, conversion_spread_percent, created_at, updated_at').eq('workspace_id', workspace.id).order('created_at'),
      supabase.from('earnings').select('id, workspace_id, client_id, source_type, description, item_count, amount_usd, net_amount_usd, payment_method, fee_percent, fee_fixed_usd, conversion_spread_percent, status, earned_at, received_at, exchange_rate_brl, amount_brl, created_at, updated_at').eq('workspace_id', workspace.id).order('earned_at', { ascending: false }),
      supabase.from('earning_events').select('id, workspace_id, client_id, task_id, task_title, completed_at, pricing_model, amount_usd, bundle_size, payment_method, fee_percent, fee_fixed_usd, conversion_spread_percent, earning_id, created_at').eq('workspace_id', workspace.id).order('completed_at', { ascending: false }),
    ]);
    const loadError = settingsResult.error ?? earningsResult.error ?? eventsResult.error;
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
  }, [workspace.id]);

  useEffect(() => {
    void Promise.all([loadFinance(), loadRate()]);
  }, [loadFinance, loadRate]);

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
      </section>

      {error ? <div className="panel-error finance-error">{error}</div> : null}

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
                <span className="finance-client-avatar">{client.name.slice(0,1).toUpperCase()}</span>
                <div><strong>{client.name}</strong><small>{setting ? billingDescription(setting) : 'Sem configuração atual'}{setting?.pricing_model === 'bundle' && pendingItems ? ` · ${pendingItems}/${setting.bundle_size} no próximo pacote` : ''}</small></div>
                <em>{rate ? formatBrl(clientNetUsd * rate.rate) : formatUsd(clientNetUsd)}<small>líquido · bruto {formatUsd(clientGrossUsd)} · {itemCount} vídeos</small></em>
              </article>
            ))}
            {!clientSummaries.length ? <div className="finance-list-empty">Configure o primeiro cliente para começar a contabilizar as entregas.</div> : null}
          </div>
      </section>

      <section className="finance-card earnings-history-card">
        <header><span><CheckCircle2 size={18} /></span><div><h3>Lançamentos do mês</h3><p>O valor em reais é estimado até você confirmar o recebimento.</p></div></header>
        <div className="earnings-table">
          <div className="earnings-table-head"><span>Cliente / lançamento</span><span>Conclusão</span><span>Valor</span><span>Status</span></div>
          {monthlyEarnings.map((earning) => {
            const client = clients.find((item) => item.id === earning.client_id);
            const displayBrl = earning.status === 'received' ? earning.amount_brl : (rate ? earning.net_amount_usd * rate.rate : null);
            const earningFeeUsd = earning.amount_usd - earning.net_amount_usd;
            return (
              <article key={earning.id}>
                <div><strong>{client?.name || 'Cliente removido'}</strong><small>{earning.description} · {paymentMethodLabel(earning.payment_method)} · {earning.item_count} {earning.item_count === 1 ? 'vídeo' : 'vídeos'}</small></div>
                <span>{formatCompactDate(earning.earned_at)}</span>
                <div className="earning-value"><strong>{displayBrl === null ? '—' : formatBrl(displayBrl)}</strong><small>líquido {formatUsd(earning.net_amount_usd)} · bruto {formatUsd(earning.amount_usd)} · taxas {formatUsd(earningFeeUsd)}{earning.exchange_rate_brl ? ` · câmbio efetivo ${formatRate(earning.exchange_rate_brl)}` : ''}</small></div>
                {earning.status === 'received'
                  ? <button className="earning-status received" disabled={saving} onClick={() => void reopenEarning(earning)}><CheckCircle2 size={13} />Recebido</button>
                  : <button className="earning-status pending" disabled={saving} onClick={() => openReceiveDialog(earning)}><Clock3 size={13} />Marcar recebido</button>}
              </article>
            );
          })}
          {!monthlyEarnings.length ? <div className="finance-list-empty">Nenhum ganho foi gerado neste mês.</div> : null}
        </div>
      </section>

      {receivingEarning ? (
        <div className="receive-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setReceivingEarning(null); }}>
          <section className="receive-dialog" role="dialog" aria-modal="true" aria-labelledby="receive-dialog-title">
            <header><span><Banknote size={18} /></span><div><h3 id="receive-dialog-title">Confirmar recebimento</h3><p>Registre o valor real após todas as taxas e conversões.</p></div><button onClick={() => setReceivingEarning(null)} aria-label="Fechar"><X size={17} /></button></header>
            <div className="receive-dialog-summary"><div><span>Bruto</span><strong>{formatUsd(receivingEarning.amount_usd)}</strong></div><div><span>Líquido estimado</span><strong>{formatUsd(receivingEarning.net_amount_usd)}</strong></div><div><span>Meio</span><strong>{paymentMethodLabel(receivingEarning.payment_method)}</strong></div></div>
            <label><span>Quanto realmente caiu na conta?</span><div><b>R$</b><input autoFocus inputMode="decimal" value={actualReceivedBrl} onChange={(event) => setActualReceivedBrl(event.target.value)} placeholder="0,00" /></div></label>
            <small>Esse valor substituirá a estimativa e ficará registrado no histórico.</small>
            {error ? <div className="panel-error receive-dialog-error">{error}</div> : null}
            <button className="primary-button" disabled={saving} onClick={() => void markReceived()}>{saving ? <LoaderCircle className="spinner" size={15} /> : <CheckCircle2 size={15} />}Confirmar recebimento</button>
          </section>
        </div>
      ) : null}
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
