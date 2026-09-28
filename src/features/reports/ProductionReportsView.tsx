import { useEffect, useMemo, useState } from 'react';
import { Archive, CalendarDays, ChevronLeft, ChevronRight, FileDown, LoaderCircle, Search, UsersRound, Video } from 'lucide-react';
import { supabase } from '../../lib/supabase';
import { fetchAllRows } from '../../lib/paginatedQuery';
import { currentFinancialCycle, financialCycleRange, formatFinancialCycle, normalizeCycleStartDay, shiftMonthKey } from '../../lib/financialCycle';
import { buildProductionReport, latestCompletionMoves, type TaskMoveForReport } from '../../lib/productionReport';
import { formatShortProductionPeriod, shiftShortProductionPeriod, shortProductionPeriodRange, toLocalDateKey } from '../../lib/productionPeriod';
import type { Client, Task, WorkspaceMember, WorkspaceSummary } from '../workspace/types';

type Props = {
  workspace: WorkspaceSummary;
  currentUserId: string;
  tasks: Task[];
  clients: Client[];
  members: WorkspaceMember[];
  completionColumnId: string | null;
  onOpenTask: (task: Task) => void;
};

export function ProductionReportsView({ workspace, currentUserId, tasks, clients, members, completionColumnId, onOpenTask }: Props) {
  const canSeeTeam = workspace.role !== 'editor';
  const [cycleStartDay, setCycleStartDay] = useState(1);
  const [cycleUnavailable, setCycleUnavailable] = useState(false);
  const [periodKind, setPeriodKind] = useState<EditFlowProductionReport['periodKind']>('month');
  const [monthKey, setMonthKey] = useState(() => currentFinancialCycle(1));
  const [dateKey, setDateKey] = useState(() => toLocalDateKey(new Date()));
  const [clientId, setClientId] = useState('all');
  const [editorId, setEditorId] = useState('all');
  const [search, setSearch] = useState('');
  const [visibleLimit, setVisibleLimit] = useState(60);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportSuccess, setExportSuccess] = useState<string | null>(null);
  const [completionHistory, setCompletionHistory] = useState<{ key: string; dates: Map<string, string>; error: string | null } | null>(null);
  const [historyRetry, setHistoryRetry] = useState(0);

  const completionCandidates = useMemo(() => tasks.filter((task) => task.completed_at && (canSeeTeam || task.assignee_id === currentUserId)), [tasks, canSeeTeam, currentUserId]);
  const historyKey = `${workspace.id}:${completionColumnId ?? ''}:${completionCandidates.map((task) => `${task.id}@${task.completed_at}`).sort().join('|')}`;

  useEffect(() => {
    const client = supabase;
    if (!client || !completionColumnId || !completionCandidates.length) {
      setCompletionHistory({ key: historyKey, dates: new Map(), error: null });
      return;
    }

    let cancelled = false;
    const loadCompletionHistory = async () => {
      const moves: TaskMoveForReport[] = [];
      const ids = completionCandidates.map((task) => task.id);
      for (let start = 0; start < ids.length; start += 80) {
        const batch = ids.slice(start, start + 80);
        const result = await fetchAllRows<TaskMoveForReport>(async (from, to) => await client
          .from('task_activities')
          .select('id, task_id, created_at, details')
          .eq('workspace_id', workspace.id)
          .eq('action', 'moved')
          .in('task_id', batch)
          .order('created_at')
          .order('id')
          .range(from, to));
        if (cancelled) return;
        if (result.error) throw new Error(result.error.message);
        moves.push(...(result.data ?? []));
      }
      if (!cancelled) setCompletionHistory({ key: historyKey, dates: latestCompletionMoves(moves, completionColumnId), error: null });
    };
    void loadCompletionHistory().catch((error: unknown) => {
      if (!cancelled) setCompletionHistory({ key: historyKey, dates: new Map(), error: error instanceof Error ? error.message : 'Não foi possível carregar o histórico das tarefas.' });
    });
    return () => { cancelled = true; };
  }, [historyKey, historyRetry]);

  useEffect(() => {
    if (!supabase) return;
    const client = supabase;
    let cancelled = false;
    void client.from('workspaces').select('financial_cycle_start_day').eq('id', workspace.id).single()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setCycleUnavailable(true);
          return;
        }
        const day = normalizeCycleStartDay(data.financial_cycle_start_day);
        setCycleStartDay(day);
        setCycleUnavailable(false);
      });
    return () => { cancelled = true; };
  }, [workspace.id]);

  useEffect(() => { setVisibleLimit(60); }, [monthKey, dateKey, periodKind, clientId, editorId, search]);

  const shortPeriod = periodKind === 'week' || periodKind === 'fortnight';
  const range = useMemo(() => shortPeriod
    ? shortProductionPeriodRange(dateKey, periodKind === 'week' ? 'week' : 'fortnight')
    : financialCycleRange(monthKey, periodKind === 'cycle' ? cycleStartDay : 1),
  [monthKey, dateKey, periodKind, cycleStartDay, shortPeriod]);
  const completionDates = completionHistory?.key === historyKey ? completionHistory.dates : null;
  const report = useMemo(() => buildProductionReport(tasks, clients, members, range, { clientId, editorId, currentUserId, canSeeTeam, search }, completionDates ?? undefined),
    [tasks, clients, members, range, clientId, editorId, currentUserId, canSeeTeam, search, completionDates]);
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);
  const periodLabel = shortPeriod ? formatShortProductionPeriod(range) : periodKind === 'cycle'
    ? formatFinancialCycle(range)
    : new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' }).format(range.start);
  const changePeriod = (kind: EditFlowProductionReport['periodKind']) => {
    if (periodKind === kind) return;
    setPeriodKind(kind);
    if (kind === 'week' || kind === 'fortnight') setDateKey(toLocalDateKey(new Date()));
    else setMonthKey(currentFinancialCycle(kind === 'cycle' ? cycleStartDay : 1));
  };
  const shiftPeriod = (offset: -1 | 1) => {
    if (periodKind === 'week' || periodKind === 'fortnight') {
      setDateKey((current) => shiftShortProductionPeriod(current, periodKind, offset));
    } else setMonthKey((current) => shiftMonthKey(current, offset));
  };
  const selectedClient = clientId === 'all' ? 'Todos os clientes' : clientId === 'none' ? 'Sem cliente' : clients.find((client) => client.id === clientId)?.name ?? 'Cliente removido';
  const selectedEditor = editorId === 'all' ? 'Todos os responsáveis' : editorId === 'none' ? 'Sem responsável' : members.find((member) => member.user_id === editorId)?.display_name ?? 'Membro removido';

  const exportPdf = async () => {
    if (exporting) return;
    setExporting(true);
    setExportError(null);
    setExportSuccess(null);
    try {
      const result = await window.editflow.exportProductionReport({
        workspaceName: workspace.name,
        periodKey: shortPeriod ? toLocalDateKey(range.start) : monthKey,
        periodLabel,
        periodKind,
        generatedAt: new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeStyle: 'short' }).format(new Date()),
        clientFilter: selectedClient,
        editorFilter: canSeeTeam ? selectedEditor : 'Meus vídeos',
        searchFilter: search.trim(),
        total: report.total,
        clientCount: report.clientCount,
        editorCount: report.editorCount,
        byClient: report.byClient.map((group) => ({ name: group.clientName, count: group.count })),
        rows: report.rows.map((row) => ({ title: row.title, client: row.clientName, editor: row.editorName,
          completedAt: formatCompletedDate(row.completedAt), archived: row.archived })),
      });
      if (!result.cancelled) setExportSuccess('Relatório de produção exportado em PDF.');
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Não foi possível exportar o relatório.');
    } finally {
      setExporting(false);
    }
  };

  if (completionHistory?.key === historyKey && completionHistory.error) {
    return <div className="board-error" role="alert"><span>Não foi possível conferir as datas pelo histórico: {completionHistory.error}</span><button type="button" onClick={() => { setCompletionHistory(null); setHistoryRetry((current) => current + 1); }}>Tentar novamente</button></div>;
  }
  if (!completionDates) return <p className="production-report-loading" role="status">Conferindo as datas de conclusão no histórico…</p>;

  return (
    <div className="production-report-view">
      <section className="production-report-hero">
        <div><span className="report-eyebrow">{canSeeTeam ? 'PRODUÇÃO DA EQUIPE' : 'MINHA PRODUÇÃO'}</span><h2>Relatório de vídeos</h2><p>Vídeos contabilizados pela última entrada registrada na etapa final. Arquivados continuam no histórico.</p></div>
        <button className="secondary-button" type="button" disabled={exporting} onClick={() => void exportPdf()}>{exporting ? <LoaderCircle size={16} className="spinner" /> : <FileDown size={16} />}Exportar PDF</button>
      </section>

      <section className="production-report-toolbar" aria-label="Período e filtros do relatório">
        <div className="production-report-period">
          <button type="button" aria-label="Período anterior" onClick={() => shiftPeriod(-1)}><ChevronLeft size={17} /></button>
          {shortPeriod
            ? <input type="date" aria-label="Escolher data da semana ou quinzena" value={dateKey} onChange={(event) => { if (/^\d{4}-\d{2}-\d{2}$/.test(event.target.value)) setDateKey(event.target.value); }} />
            : <input type="month" aria-label="Escolher mês" value={monthKey} onChange={(event) => { if (/^\d{4}-(0[1-9]|1[0-2])$/.test(event.target.value)) setMonthKey(event.target.value); }} />}
          <button type="button" aria-label="Próximo período" onClick={() => shiftPeriod(1)}><ChevronRight size={17} /></button>
        </div>
        <div className="production-report-period-kind" role="group" aria-label="Tipo de período">
          <button type="button" aria-pressed={periodKind === 'week'} className={periodKind === 'week' ? 'active' : ''} onClick={() => changePeriod('week')}>Semana</button>
          <button type="button" aria-pressed={periodKind === 'fortnight'} className={periodKind === 'fortnight' ? 'active' : ''} onClick={() => changePeriod('fortnight')} title="Dias 1–15 ou 16 até o fim do mês">15 dias</button>
          <button type="button" aria-pressed={periodKind === 'month'} className={periodKind === 'month' ? 'active' : ''} onClick={() => changePeriod('month')}>Mês</button>
          <button type="button" aria-pressed={periodKind === 'cycle'} className={periodKind === 'cycle' ? 'active' : ''} disabled={cycleUnavailable} onClick={() => changePeriod('cycle')}>Ciclo da equipe</button>
        </div>
        <span className="production-report-period-label"><CalendarDays size={15} />{periodLabel}</span>
      </section>

      <section className="production-report-summary" aria-label="Resumo dos vídeos concluídos">
        <article><span><Video size={18} /></span><strong>{report.total}</strong><small>{report.total === 1 ? 'Vídeo concluído' : 'Vídeos concluídos'}</small></article>
        <article><span><UsersRound size={18} /></span><strong>{report.clientCount}</strong><small>{report.clientCount === 1 ? 'Cliente atendido' : 'Clientes atendidos'}</small></article>
        <article><span><UsersRound size={18} /></span><strong>{report.editorCount}</strong><small>{report.editorCount === 1 ? 'Responsável atual' : 'Responsáveis atuais'}</small></article>
      </section>

      <section className="production-report-clients">
        <header><h3>Por cliente</h3><small>{periodLabel}</small></header>
        {report.byClient.length ? <div className="production-report-client-grid">{report.byClient.map((group) => <article key={group.clientId ?? 'none'}><span className="report-client-avatar">{group.clientName.charAt(0).toUpperCase()}</span><strong>{group.clientName}</strong><em>{group.count} {group.count === 1 ? 'vídeo' : 'vídeos'}</em></article>)}</div> : <p className="production-report-empty">Nenhum vídeo concluído neste período.</p>}
      </section>

      <section className="production-report-details">
        <header><div><h3>Vídeos concluídos</h3><small>Responsável exibido conforme a atribuição atual da tarefa.</small></div><span>{report.total} no período</span></header>
        <div className="production-report-filters">
          <label><span>Cliente</span><select value={clientId} onChange={(event) => setClientId(event.target.value)}><option value="all">Todos os clientes</option><option value="none">Sem cliente</option>{clients.map((client) => <option key={client.id} value={client.id}>{client.name}</option>)}</select></label>
          {canSeeTeam ? <label><span>Responsável</span><select value={editorId} onChange={(event) => setEditorId(event.target.value)}><option value="all">Todos</option><option value="none">Sem responsável</option>{members.map((member) => <option key={member.user_id} value={member.user_id}>{member.display_name}</option>)}</select></label> : null}
          <label className="production-report-search"><span>Buscar vídeo</span><div><Search size={15} /><input value={search} maxLength={120} onChange={(event) => setSearch(event.target.value)} placeholder="Nome do vídeo..." /></div></label>
        </div>
        <div className="production-report-table-wrap">
          <table><thead><tr><th>Vídeo</th><th>Cliente</th><th>Responsável</th><th>Concluído em</th></tr></thead><tbody>
            {report.rows.slice(0, visibleLimit).map((row) => {
              const task = taskById.get(row.taskId);
              return <tr key={row.taskId}><td>{task ? <button type="button" onClick={() => onOpenTask(task)}>{row.title}</button> : row.title}{row.archived ? <span className="report-archived" title="Arquivado"><Archive size={12} />Arquivado</span> : null}</td><td>{row.clientName}</td><td>{row.editorName}</td><td>{formatCompletedDate(row.completedAt)}</td></tr>;
            })}
          </tbody></table>
          {!report.rows.length ? <p className="production-report-empty">Nenhum vídeo corresponde aos filtros.</p> : null}
        </div>
        {report.rows.length > visibleLimit ? <button className="production-report-more" type="button" onClick={() => setVisibleLimit((current) => current + 60)}>Ver mais {Math.min(60, report.rows.length - visibleLimit)} vídeos</button> : null}
      </section>
      {exportError ? <p className="production-report-feedback error" role="alert">{exportError}</p> : null}
      {exportSuccess ? <p className="production-report-feedback" role="status">{exportSuccess}</p> : null}
    </div>
  );
}

function formatCompletedDate(value: string) {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value));
}
