import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import {
  BadgeDollarSign,
  Banknote,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  RefreshCw,
  TrendingUp,
  Video,
  WalletCards,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import type {
  Client,
  ClientBillingSetting,
  Earning,
  EarningEvent,
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
      supabase.from('client_billing_settings').select('*').eq('workspace_id', workspace.id).order('created_at'),
      supabase.from('earnings').select('*').eq('workspace_id', workspace.id).order('earned_at', { ascending: false }),
      supabase.from('earning_events').select('*').eq('workspace_id', workspace.id).order('completed_at', { ascending: false }),
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
  const monthUsd = sum(monthlyEarnings.map((earning) => earning.amount_usd));
  const pendingEarnings = monthlyEarnings.filter((earning) => earning.status === 'pending');
  const receivedEarnings = monthlyEarnings.filter((earning) => earning.status === 'received');
  const pendingUsd = sum(pendingEarnings.map((earning) => earning.amount_usd));
  const receivedBrl = sum(receivedEarnings.map((earning) => earning.amount_brl ?? 0));
  const estimatedBrl = rate ? monthUsd * rate.rate : null;
  const pendingBrl = rate ? pendingUsd * rate.rate : null;
  const producedVideos = sum(monthlyEarnings.map((earning) => earning.item_count));

  const clientSummaries = useMemo(() => clients.map((client) => {
    const clientEarnings = monthlyEarnings.filter((earning) => earning.client_id === client.id);
    const setting = settings.find((item) => item.client_id === client.id);
    const unallocated = events.filter((event) => event.client_id === client.id && !event.earning_id);
    return {
      client,
      setting,
      amountUsd: sum(clientEarnings.map((earning) => earning.amount_usd)),
      itemCount: sum(clientEarnings.map((earning) => earning.item_count)),
      pendingItems: unallocated.length,
    };
  }).filter((summary) => summary.setting || summary.amountUsd), [clients, events, monthlyEarnings, settings]);

  const markReceived = async (earning: Earning) => {
    if (!supabase || !rate) return setError('A cotação precisa estar disponível para registrar o recebimento.');
    setSaving(true);
    setError(null);
    const { error: updateError } = await supabase.from('earnings').update({
      status: 'received',
      received_at: new Date().toISOString(),
      exchange_rate_brl: rate.rate,
      amount_brl: roundCurrency(earning.amount_usd * rate.rate),
    }).eq('id', earning.id);
    setSaving(false);
    if (updateError) return setError(updateError.message);
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
        <p>Execute a migration <strong>012_financial_tracking.sql</strong> no SQL Editor do Supabase. Depois, volte aqui e tente novamente.</p>
        <button className="secondary-button" onClick={() => void loadFinance()}><RefreshCw size={15} />Tentar novamente</button>
      </div>
    );
  }

  return (
    <div className="finance-view">
      <section className="finance-hero">
        <div className="finance-hero-copy">
          <p>VISÃO FINANCEIRA</p>
          <h2>{estimatedBrl === null ? 'Cotação indisponível' : formatBrl(estimatedBrl)}</h2>
          <span>Estimativa produzida em {formatMonth(month)} · {formatUsd(monthUsd)}</span>
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
        <article><span className="purple"><BadgeDollarSign size={18} /></span><div><small>Produzido</small><strong>{estimatedBrl === null ? '—' : formatBrl(estimatedBrl)}</strong><em>{formatUsd(monthUsd)}</em></div></article>
        <article><span className="green"><Banknote size={18} /></span><div><small>Recebido</small><strong>{formatBrl(receivedBrl)}</strong><em>{receivedEarnings.length} pagamentos</em></div></article>
        <article><span className="orange"><Clock3 size={18} /></span><div><small>A receber</small><strong>{pendingBrl === null ? '—' : formatBrl(pendingBrl)}</strong><em>{formatUsd(pendingUsd)}</em></div></article>
        <article><span className="blue"><Video size={18} /></span><div><small>Vídeos contabilizados</small><strong>{producedVideos}</strong><em>{monthlyEarnings.length} lançamentos</em></div></article>
      </section>

      <section className="finance-card client-earnings-card finance-client-summary">
          <header><span><WalletCards size={18} /></span><div><h3>Resumo por cliente</h3><p>Valores gerados no mês selecionado. Configure o pagamento ao criar ou editar um cliente.</p></div></header>
          <div className="client-earning-list">
            {clientSummaries.map(({ client, setting, amountUsd, itemCount, pendingItems }) => (
              <article key={client.id}>
                <span className="finance-client-avatar">{client.name.slice(0,1).toUpperCase()}</span>
                <div><strong>{client.name}</strong><small>{setting ? billingDescription(setting) : 'Sem configuração atual'}{setting?.pricing_model === 'bundle' && pendingItems ? ` · ${pendingItems}/${setting.bundle_size} no próximo pacote` : ''}</small></div>
                <em>{rate ? formatBrl(amountUsd * rate.rate) : formatUsd(amountUsd)}<small>{itemCount} vídeos</small></em>
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
            const displayBrl = earning.status === 'received' ? earning.amount_brl : (rate ? earning.amount_usd * rate.rate : null);
            return (
              <article key={earning.id}>
                <div><strong>{client?.name || 'Cliente removido'}</strong><small>{earning.description} · {earning.item_count} {earning.item_count === 1 ? 'vídeo' : 'vídeos'}</small></div>
                <span>{formatCompactDate(earning.earned_at)}</span>
                <div className="earning-value"><strong>{displayBrl === null ? '—' : formatBrl(displayBrl)}</strong><small>{formatUsd(earning.amount_usd)}{earning.exchange_rate_brl ? ` · câmbio ${formatRate(earning.exchange_rate_brl)}` : ''}</small></div>
                {earning.status === 'received'
                  ? <button className="earning-status received" disabled={saving} onClick={() => void reopenEarning(earning)}><CheckCircle2 size={13} />Recebido</button>
                  : <button className="earning-status pending" disabled={saving || !rate} onClick={() => void markReceived(earning)}><Clock3 size={13} />Marcar recebido</button>}
              </article>
            );
          })}
          {!monthlyEarnings.length ? <div className="finance-list-empty">Nenhum ganho foi gerado neste mês.</div> : null}
        </div>
      </section>
    </div>
  );
}

function normalizeBillingSetting(row: Record<string, unknown>) {
  return { ...row, amount_usd: Number(row.amount_usd), bundle_size: Number(row.bundle_size) } as ClientBillingSetting;
}

function normalizeEarning(row: Record<string, unknown>) {
  return {
    ...row,
    amount_usd: Number(row.amount_usd),
    item_count: Number(row.item_count),
    exchange_rate_brl: row.exchange_rate_brl === null ? null : Number(row.exchange_rate_brl),
    amount_brl: row.amount_brl === null ? null : Number(row.amount_brl),
  } as Earning;
}

function normalizeEarningEvent(row: Record<string, unknown>) {
  return { ...row, amount_usd: Number(row.amount_usd), bundle_size: Number(row.bundle_size) } as EarningEvent;
}

function isMissingFinanceSchema(message: string) {
  const normalized = message.toLowerCase();
  return normalized.includes('client_billing_settings') || normalized.includes('earning_events') || normalized.includes('schema cache');
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
    ? `${formatUsd(setting.amount_usd)} por vídeo`
    : `${formatUsd(setting.amount_usd)} a cada ${setting.bundle_size} vídeos`;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function roundCurrency(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
