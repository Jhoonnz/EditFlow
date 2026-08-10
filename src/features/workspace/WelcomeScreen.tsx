import { useEffect, useMemo, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import {
  ArrowRight,
  Bell,
  BriefcaseBusiness,
  CheckCircle2,
  Clock3,
  LoaderCircle,
  MessageSquareWarning,
  Sparkles,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { supabase } from '../../lib/supabase';
import type { AppNotification, Task, WelcomeStartupAction, WorkspaceSummary } from './types';

type SummaryCard = {
  key: string;
  label: string;
  value: number;
  detail: string;
  tone: 'violet' | 'blue' | 'amber' | 'rose' | 'green';
  icon: typeof Bell;
  action: WelcomeStartupAction;
};

type WelcomeSummary = {
  tasks: Task[];
  unreadNotifications: AppNotification[];
  newTasks: Task[];
  activeTasks: Task[];
  overdueTasks: Task[];
  dueSoonTasks: Task[];
  adjustmentTaskIds: string[];
};

const emptySummary: WelcomeSummary = {
  tasks: [],
  unreadNotifications: [],
  newTasks: [],
  activeTasks: [],
  overdueTasks: [],
  dueSoonTasks: [],
  adjustmentTaskIds: [],
};

export function WelcomeScreen({
  user,
  workspaces,
  invitationCount,
  isFirstAccess,
  previousOpenedAt,
  onContinue,
  onDisableWelcome,
}: {
  user: User;
  workspaces: WorkspaceSummary[];
  invitationCount: number;
  isFirstAccess: boolean;
  previousOpenedAt: string | null;
  onContinue: (action: WelcomeStartupAction) => void;
  onDisableWelcome: () => Promise<void>;
}) {
  const [summary, setSummary] = useState<WelcomeSummary>(emptySummary);
  const [loading, setLoading] = useState(true);
  const [disableWelcome, setDisableWelcome] = useState(false);
  const firstName = getFirstName(user);

  useEffect(() => {
    if (!supabase) return;
    const client = supabase;
    let cancelled = false;

    const loadSummary = async () => {
      const workspaceIds = workspaces.map((workspace) => workspace.id);
      const now = new Date();
      const soonLimit = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
      const [taskResult, columnResult, notificationResult, adjustmentResult] = await Promise.all([
        client.from('tasks').select('*').in('workspace_id', workspaceIds).order('created_at', { ascending: false }),
        client.from('columns').select('id, name'),
        client.from('notifications').select('*').eq('user_id', user.id).is('read_at', null).order('created_at', { ascending: false }).limit(30),
        client.from('task_comments').select('task_id').in('workspace_id', workspaceIds).eq('kind', 'change_request').eq('is_resolved', false),
      ]);

      if (cancelled) return;
      const tasks = (taskResult.data ?? []) as Task[];
      const columnNames = new Map((columnResult.data ?? []).map((column) => [column.id as string, String(column.name).toLocaleLowerCase('pt-BR')]));
      const isDelivered = (task: Task) => columnNames.get(task.column_id)?.includes('entregue') ?? false;
      const activeTasks = tasks.filter((task) => !isDelivered(task));
      const overdueTasks = activeTasks.filter((task) => task.due_at && new Date(task.due_at) < now);
      const dueSoonTasks = activeTasks.filter((task) => {
        if (!task.due_at) return false;
        const dueDate = new Date(task.due_at);
        return dueDate >= now && dueDate <= soonLimit;
      });
      const newTasks = previousOpenedAt
        ? tasks.filter((task) => new Date(task.created_at) > new Date(previousOpenedAt))
        : tasks;

      setSummary({
        tasks,
        unreadNotifications: (notificationResult.data ?? []) as AppNotification[],
        newTasks,
        activeTasks,
        overdueTasks,
        dueSoonTasks,
        adjustmentTaskIds: Array.from(new Set((adjustmentResult.data ?? []).map((item) => item.task_id as string))),
      });
      setLoading(false);
    };

    void loadSummary();
    return () => { cancelled = true; };
  }, [previousOpenedAt, user.id, workspaces]);

  const cards = useMemo<SummaryCard[]>(() => [
    {
      key: 'notifications',
      label: 'Novas notificações',
      value: summary.unreadNotifications.length,
      detail: summary.unreadNotifications.length ? 'Aguardando sua leitura' : 'Nenhuma novidade por aqui',
      tone: 'violet',
      icon: Bell,
      action: { kind: 'notifications', workspaceId: summary.unreadNotifications[0]?.workspace_id },
    },
    {
      key: 'new-tasks',
      label: isFirstAccess ? 'Tarefas disponíveis' : 'Novas tarefas',
      value: summary.newTasks.length,
      detail: isFirstAccess ? 'Visíveis para a sua conta' : 'Desde o seu último acesso',
      tone: 'blue',
      icon: BriefcaseBusiness,
      action: summary.newTasks[0] ? { kind: 'task', taskId: summary.newTasks[0].id, workspaceId: summary.newTasks[0].workspace_id } : { kind: 'board' },
    },
    {
      key: 'due-soon',
      label: 'Próximos prazos',
      value: summary.dueSoonTasks.length,
      detail: 'Para os próximos 3 dias',
      tone: 'amber',
      icon: Clock3,
      action: summary.dueSoonTasks[0] ? { kind: 'task', taskId: summary.dueSoonTasks[0].id, workspaceId: summary.dueSoonTasks[0].workspace_id } : { kind: 'board' },
    },
    {
      key: 'overdue',
      label: 'Trabalhos atrasados',
      value: summary.overdueTasks.length,
      detail: summary.overdueTasks.length ? 'Precisam de atenção' : 'Todos os prazos em dia',
      tone: 'rose',
      icon: TriangleAlert,
      action: summary.overdueTasks[0] ? { kind: 'task', taskId: summary.overdueTasks[0].id, workspaceId: summary.overdueTasks[0].workspace_id } : { kind: 'board' },
    },
    {
      key: 'adjustments',
      label: 'Ajustes pendentes',
      value: summary.adjustmentTaskIds.length,
      detail: summary.adjustmentTaskIds.length ? 'Feedbacks ainda abertos' : 'Nenhum ajuste pendente',
      tone: 'rose',
      icon: MessageSquareWarning,
      action: summary.adjustmentTaskIds[0]
        ? {
            kind: 'task',
            taskId: summary.adjustmentTaskIds[0],
            workspaceId: summary.tasks.find((task) => task.id === summary.adjustmentTaskIds[0])?.workspace_id ?? workspaces[0].id,
          }
        : { kind: 'board' },
    },
    {
      key: 'active',
      label: 'Em produção',
      value: summary.activeTasks.length,
      detail: `${workspaces.length} ${workspaces.length === 1 ? 'equipe conectada' : 'equipes conectadas'}`,
      tone: 'green',
      icon: Users,
      action: { kind: 'board' },
    },
  ], [isFirstAccess, summary, workspaces.length]);

  const totalAttention = summary.unreadNotifications.length
    + summary.overdueTasks.length
    + summary.adjustmentTaskIds.length
    + invitationCount;

  const continueTo = async (action: WelcomeStartupAction) => {
    if (disableWelcome) await onDisableWelcome();
    onContinue(action);
  };

  return (
    <main className="welcome-page">
      <div className="welcome-aurora welcome-aurora-blue" />
      <div className="welcome-aurora welcome-aurora-pink" />
      <div className="welcome-aurora welcome-aurora-violet" />
      <div className="welcome-grid" />
      <div className="page-noise" />

      <section className="welcome-glass">
        <div className="welcome-glass-shine" />
        <header className="welcome-header">
          <div className="welcome-brand"><span><Sparkles size={18} /></span>EditFlow</div>
          <span className="welcome-date">{formatLongDate(new Date())}</span>
        </header>

        <div className="welcome-hero">
          <span className="welcome-kicker">{isFirstAccess ? 'SEU NOVO ESPAÇO DE PRODUÇÃO' : `${timeGreeting()}, ${firstName}`}</span>
          <h1>{isFirstAccess ? `Bem-vindo ao EditFlow, ${firstName}.` : `Bem-vindo de volta, ${firstName}.`}</h1>
          <p>{loading
            ? 'Preparando um resumo do seu espaço de trabalho…'
            : totalAttention
              ? `Há ${totalAttention} ${totalAttention === 1 ? 'item esperando' : 'itens esperando'} por você. Aqui está o que merece atenção primeiro.`
              : 'Tudo tranquilo por aqui. Seus trabalhos estão organizados e não há nenhuma pendência urgente.'}</p>
        </div>

        {loading ? (
          <div className="welcome-loading"><LoaderCircle className="spinner" size={28} /><span>Sincronizando seu resumo</span></div>
        ) : (
          <div className="welcome-summary-grid">
            {cards.map((card, index) => {
              const Icon = card.icon;
              return (
                <button
                  className={`welcome-summary-card ${card.tone}`}
                  style={{ '--welcome-delay': `${140 + index * 70}ms` } as React.CSSProperties}
                  key={card.key}
                  onClick={() => void continueTo(card.action)}
                >
                  <span className="welcome-card-icon"><Icon size={18} /></span>
                  <span className="welcome-card-value">{card.value}</span>
                  <strong>{card.label}</strong>
                  <small>{card.detail}</small>
                  <ArrowRight className="welcome-card-arrow" size={15} />
                </button>
              );
            })}
          </div>
        )}

        <footer className="welcome-footer">
          <label className="welcome-hide-option">
            <input type="checkbox" checked={disableWelcome} onChange={(event) => setDisableWelcome(event.target.checked)} />
            <span>Não mostrar este resumo ao abrir</span>
          </label>
          <div className="welcome-footer-actions">
            {invitationCount ? <span className="welcome-invites"><Bell size={13} />{invitationCount} {invitationCount === 1 ? 'convite pendente' : 'convites pendentes'}</span> : null}
            <button className="welcome-enter" disabled={loading} onClick={() => void continueTo({ kind: 'board' })}>
              <span>Entrar na produção</span><ArrowRight size={18} />
            </button>
          </div>
        </footer>

        {!loading && totalAttention === 0 ? <div className="welcome-all-clear"><CheckCircle2 size={15} />Tudo em dia</div> : null}
      </section>
    </main>
  );
}

function getFirstName(user: User) {
  const name = String(user.user_metadata.full_name ?? '').trim();
  if (name) return name.split(/\s+/)[0];
  return user.email?.split('@')[0] || 'você';
}

function timeGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Bom dia';
  if (hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

function formatLongDate(date: Date) {
  return new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
  }).format(date);
}
