import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Bell,
  BriefcaseBusiness,
  CalendarClock,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  MessageSquare,
  Plus,
  Sparkles,
  TriangleAlert,
  UserRoundPlus,
  Users,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import type {
  AppNotification,
  BoardColumn,
  Client,
  Earning,
  Task,
  WorkspaceMember,
  WorkspaceSummary,
} from './types';

type Props = {
  workspace: WorkspaceSummary;
  currentUserId: string;
  displayName: string;
  tasks: Task[];
  columns: BoardColumn[];
  clients: Client[];
  members: WorkspaceMember[];
  notifications: AppNotification[];
  onOpenTask: (task: Task) => void;
  onOpenNotification: (notification: AppNotification) => void;
  onOpenBoard: () => void;
  onOpenTeam: () => void;
  onOpenFinance: () => void;
  onOpenNotifications: () => void;
  onCreateTask: () => void;
};

type FinanceSummary = {
  totalBrl: number;
  entries: number;
  pending: number;
};

const emptyFinance: FinanceSummary = { totalBrl: 0, entries: 0, pending: 0 };

export function MyWorkView({
  workspace,
  currentUserId,
  displayName,
  tasks,
  columns,
  clients,
  members,
  notifications,
  onOpenTask,
  onOpenNotification,
  onOpenBoard,
  onOpenTeam,
  onOpenFinance,
  onOpenNotifications,
  onCreateTask,
}: Props) {
  const canManage = workspace.role === 'owner' || workspace.role === 'admin';
  const [finance, setFinance] = useState<FinanceSummary>(emptyFinance);
  const [financeLoading, setFinanceLoading] = useState(workspace.role === 'owner');
  const financeReloadTimer = useRef<number | null>(null);

  const loadFinance = useCallback(async () => {
    if (!supabase || workspace.role !== 'owner') {
      setFinanceLoading(false);
      return;
    }
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const nextMonth = new Date(monthStart);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    const [earningResult, rateResult] = await Promise.all([
      supabase
        .from('earnings')
        .select('currency, net_amount_usd, status, earned_at, amount_brl')
        .eq('workspace_id', workspace.id)
        .gte('earned_at', monthStart.toISOString())
        .lt('earned_at', nextMonth.toISOString()),
      window.editflow.getUsdBrlRate().catch(() => null),
    ]);
    if (earningResult.error) {
      setFinanceLoading(false);
      return;
    }
    const rate = rateResult?.rate ?? 0;
    const rows = (earningResult.data ?? []) as Pick<Earning, 'currency' | 'net_amount_usd' | 'status' | 'earned_at' | 'amount_brl'>[];
    setFinance({
      entries: rows.length,
      pending: rows.filter((earning) => earning.status === 'pending').length,
      totalBrl: rows.reduce((total, earning) => {
        if (earning.amount_brl !== null) return total + Number(earning.amount_brl);
        if (earning.currency === 'BRL') return total + Number(earning.net_amount_usd);
        return total + Number(earning.net_amount_usd) * rate;
      }, 0),
    });
    setFinanceLoading(false);
  }, [workspace.id, workspace.role]);

  useEffect(() => {
    void loadFinance();
    if (!supabase || workspace.role !== 'owner') return;
    const realtimeClient = supabase;
    const channel = realtimeClient
      .channel(`editflow-my-work-finance:${workspace.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'earnings', filter: `workspace_id=eq.${workspace.id}` }, () => {
        if (financeReloadTimer.current) window.clearTimeout(financeReloadTimer.current);
        financeReloadTimer.current = window.setTimeout(() => void loadFinance(), 250);
      })
      .subscribe();
    return () => {
      if (financeReloadTimer.current) window.clearTimeout(financeReloadTimer.current);
      void realtimeClient.removeChannel(channel);
    };
  }, [loadFinance, workspace.id, workspace.role]);

  const now = new Date();
  const todayStart = startOfDay(now).getTime();
  const tomorrowStart = addDays(startOfDay(now), 1).getTime();
  const soonLimit = addDays(startOfDay(now), 7).getTime();
  const activeTasks = useMemo(() => tasks.filter((task) => !task.completed_at), [tasks]);
  const personalTasks = useMemo(
    () => activeTasks.filter((task) => task.assignee_id === currentUserId),
    [activeTasks, currentUserId],
  );
  const focusPool = canManage ? activeTasks : personalTasks;
  const overdueTasks = focusPool.filter((task) => taskDueTime(task) < todayStart);
  const todayTasks = focusPool.filter((task) => {
    const dueTime = taskDueTime(task);
    return dueTime >= todayStart && dueTime < tomorrowStart;
  });
  const dueSoonTasks = focusPool.filter((task) => {
    const dueTime = taskDueTime(task);
    return dueTime >= tomorrowStart && dueTime < soonLimit;
  });
  const unreadNotifications = notifications.filter((notification) => !notification.read_at);
  const unreadMentions = unreadNotifications.filter((notification) => notification.type === 'chat_mention');
  const unreadMessages = unreadNotifications.filter((notification) => notification.type === 'chat_message' || notification.type === 'chat_mention');
  const pendingFeedback = unreadNotifications.filter((notification) => notification.type === 'change_request');
  const unassignedTasks = canManage ? activeTasks.filter((task) => !task.assignee_id) : [];
  const stalledTasks = canManage ? activeTasks.filter((task) => now.getTime() - new Date(task.updated_at).getTime() >= 3 * 86_400_000) : [];
  const onlineMembers = members.filter((member) => member.availability !== 'offline');

  const focusTasks = focusPool
    .slice()
    .sort((first, second) => taskFocusScore(first, todayStart) - taskFocusScore(second, todayStart)
      || taskDueTime(first) - taskDueTime(second))
    .slice(0, 6);
  const notificationPreview = unreadNotifications.slice(0, 5);
  const clientById = new Map(clients.map((client) => [client.id, client]));
  const columnById = new Map(columns.map((column) => [column.id, column]));
  const memberById = new Map(members.map((member) => [member.user_id, member]));
  const firstName = displayName.trim().split(/\s+/)[0] || 'você';
  const attentionTotal = overdueTasks.length + todayTasks.length + pendingFeedback.length + unreadMentions.length;

  return (
    <div className="my-work-view">
      <section className="my-work-hero">
        <div className="my-work-hero-orb"><Sparkles size={22} /></div>
        <div>
          <span>{formatLongDate(now)}</span>
          <h2>{timeGreeting()}, {firstName}.</h2>
          <p>{attentionTotal
            ? `Você tem ${attentionTotal} ${attentionTotal === 1 ? 'item que merece' : 'itens que merecem'} atenção hoje.`
            : 'Tudo organizado por aqui. Você pode seguir para a próxima entrega com tranquilidade.'}</p>
        </div>
        <div className="my-work-hero-actions">
          {canManage ? <button type="button" className="my-work-primary-action" onClick={onCreateTask}><Plus size={16} />Nova tarefa</button> : null}
          <button type="button" className="my-work-secondary-action" onClick={onOpenBoard}>Abrir produção<ArrowRight size={15} /></button>
        </div>
      </section>

      <section className="my-work-metrics" aria-label="Resumo do dia">
        <button className="my-work-metric danger" type="button" onClick={() => overdueTasks[0] ? onOpenTask(overdueTasks[0]) : onOpenBoard()}>
          <span><TriangleAlert size={17} /></span><strong>{overdueTasks.length}</strong><small>Atrasadas</small><i>{overdueTasks.length ? 'Precisam de atenção' : 'Tudo em dia'}</i>
        </button>
        <button className="my-work-metric amber" type="button" onClick={() => todayTasks[0] ? onOpenTask(todayTasks[0]) : onOpenBoard()}>
          <span><CalendarClock size={17} /></span><strong>{todayTasks.length}</strong><small>Para hoje</small><i>{dueSoonTasks.length} nos próximos 7 dias</i>
        </button>
        <button className="my-work-metric violet" type="button" onClick={onOpenNotifications}>
          <span><MessageSquare size={17} /></span><strong>{unreadMessages.length}</strong><small>Mensagens</small><i>{unreadMentions.length ? `${unreadMentions.length} menções diretas` : 'Nenhuma menção pendente'}</i>
        </button>
        <button className="my-work-metric blue" type="button" onClick={onOpenBoard}>
          <span><BriefcaseBusiness size={17} /></span><strong>{canManage ? activeTasks.length : personalTasks.length}</strong><small>Em andamento</small><i>{canManage ? 'Em toda a equipe' : 'Atribuídas a você'}</i>
        </button>
      </section>

      <div className="my-work-grid">
        <section className="my-work-card my-work-focus-card">
          <header><div><span><Clock3 size={16} /></span><div><h3>{canManage ? 'O que pede atenção' : 'Seu foco agora'}</h3><p>Organizado por prazo e prioridade.</p></div></div><button type="button" onClick={onOpenBoard}>Ver quadro<ArrowRight size={14} /></button></header>
          <div className="my-work-task-list">
            {focusTasks.map((task) => {
              const client = task.client_id ? clientById.get(task.client_id) : null;
              const column = columnById.get(task.column_id);
              const assignee = task.assignee_id ? memberById.get(task.assignee_id) : null;
              const overdue = taskDueTime(task) < todayStart;
              return (
                <button className={`my-work-task ${overdue ? 'overdue' : ''}`} type="button" key={task.id} onClick={() => onOpenTask(task)}>
                  <i style={{ background: column?.color ?? '#7467dd' }} />
                  <span className="my-work-task-copy"><strong>{task.title}</strong><small>{client?.name ?? 'Sem cliente'} · {column?.name ?? 'Produção'}</small></span>
                  <span className="my-work-task-owner">{assignee?.avatar_url ? <img src={assignee.avatar_url} alt="" /> : assignee ? initials(assignee.display_name) : <UserRoundPlus size={13} />}</span>
                  <span className={`my-work-task-due ${overdue ? 'overdue' : ''}`}>{dueLabel(task, now)}</span>
                </button>
              );
            })}
            {!focusTasks.length ? <div className="my-work-empty"><span><CheckCircle2 size={20} /></span><strong>Nenhuma prioridade agora</strong><small>As próximas tarefas aparecerão aqui automaticamente.</small></div> : null}
          </div>
        </section>

        <section className="my-work-card my-work-news-card">
          <header><div><span><Bell size={16} /></span><div><h3>Novidades</h3><p>Mensagens e mudanças que você ainda não viu.</p></div></div><button type="button" onClick={onOpenNotifications}>Ver todas<ArrowRight size={14} /></button></header>
          <div className="my-work-news-list">
            {notificationPreview.map((notification) => {
              const actor = notification.actor_id ? memberById.get(notification.actor_id) : null;
              return <button type="button" key={notification.id} onClick={() => onOpenNotification(notification)}><span className="my-work-news-avatar">{actor?.avatar_url ? <img src={actor.avatar_url} alt="" /> : initials(actor?.display_name ?? 'EditFlow')}</span><span><strong>{notificationTitle(notification)}</strong><small>{notification.message}</small><time>{relativeTime(notification.created_at)}</time></span>{notification.type === 'chat_mention' ? <i>@</i> : null}</button>;
            })}
            {!notificationPreview.length ? <div className="my-work-empty compact"><span><CheckCircle2 size={18} /></span><strong>Você está em dia</strong><small>Não há nenhuma novidade não lida.</small></div> : null}
          </div>
        </section>

        {canManage ? <section className="my-work-card my-work-team-card">
          <header><div><span><Users size={16} /></span><div><h3>Pulso da equipe</h3><p>Uma leitura rápida da produção atual.</p></div></div><button type="button" onClick={onOpenTeam}>Ver equipe<ArrowRight size={14} /></button></header>
          <div className="my-work-team-stats">
            <button type="button" onClick={onOpenTeam}><strong>{onlineMembers.length}</strong><span>online agora</span></button>
            <button type="button" onClick={onOpenBoard}><strong>{unassignedTasks.length}</strong><span>sem responsável</span></button>
            <button type="button" onClick={onOpenBoard}><strong>{stalledTasks.length}</strong><span>paradas há 3 dias</span></button>
          </div>
          <div className="my-work-member-row">
            {members.slice(0, 7).map((member) => <span key={member.user_id} title={`${member.display_name} · ${availabilityLabel(member)}`}>{member.avatar_url ? <img src={member.avatar_url} alt="" /> : initials(member.display_name)}<i className={member.availability} /></span>)}
            <small>{members.length} {members.length === 1 ? 'pessoa na equipe' : 'pessoas na equipe'}</small>
          </div>
        </section> : null}

        {workspace.role === 'owner' ? <section className="my-work-card my-work-finance-card">
          <header><div><span><CircleDollarSign size={16} /></span><div><h3>Ganhos do mês</h3><p>Estimativa líquida registrada no EditFlow.</p></div></div><button type="button" onClick={onOpenFinance}>Ver ganhos<ArrowRight size={14} /></button></header>
          <div className="my-work-finance-total"><small>Total estimado</small><strong>{financeLoading ? 'Calculando…' : formatCurrency(finance.totalBrl)}</strong><span>{finance.entries} {finance.entries === 1 ? 'lançamento' : 'lançamentos'} · {finance.pending} pendentes</span></div>
          <div className="my-work-finance-bar"><i style={{ width: `${finance.entries ? Math.max(12, ((finance.entries - finance.pending) / finance.entries) * 100) : 0}%` }} /></div>
        </section> : null}
      </div>
    </div>
  );
}

function taskDueTime(task: Task) {
  return task.due_at ? startOfDay(new Date(task.due_at)).getTime() : Number.POSITIVE_INFINITY;
}

function taskFocusScore(task: Task, todayStart: number) {
  const dueTime = taskDueTime(task);
  if (dueTime < todayStart) return -1_000_000 + dueTime / 1e10;
  const priorityScore = task.priority === 'urgent' ? -400 : task.priority === 'high' ? -250 : task.priority === 'normal' ? -100 : 0;
  return priorityScore + (Number.isFinite(dueTime) ? dueTime / 1e10 : 1_000_000);
}

function dueLabel(task: Task, now: Date) {
  if (!task.due_at) return 'Sem prazo';
  const distance = Math.round((taskDueTime(task) - startOfDay(now).getTime()) / 86_400_000);
  if (distance < 0) return `${Math.abs(distance)}d atrasada`;
  if (distance === 0) return 'Hoje';
  if (distance === 1) return 'Amanhã';
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(new Date(task.due_at));
}

function startOfDay(date: Date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return `${parts[0]?.[0] ?? 'E'}${parts.length > 1 ? parts.at(-1)?.[0] ?? '' : ''}`.toUpperCase();
}

function formatCurrency(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}

function formatLongDate(date: Date) {
  return new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: '2-digit', month: 'long' }).format(date);
}

function timeGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Bom dia';
  if (hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

function notificationTitle(notification: AppNotification) {
  if (notification.type === 'chat_mention') return 'Você foi mencionado';
  if (notification.type === 'chat_message') return 'Nova mensagem';
  if (notification.type === 'assignment') return 'Nova tarefa para você';
  if (notification.type === 'change_request') return 'Ajuste solicitado';
  if (notification.type === 'invite_accepted') return 'Novo membro na equipe';
  return 'Atualização na produção';
}

function relativeTime(value: string) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours} h`;
  const days = Math.floor(hours / 24);
  return `há ${days} d`;
}

function availabilityLabel(member: WorkspaceMember) {
  if (member.availability === 'available') return 'Disponível';
  if (member.availability === 'busy') return 'Ocupado';
  if (member.availability === 'away') return 'Ausente';
  return 'Offline';
}
