import { useMemo, useState } from 'react';
import {
  Bell,
  CalendarClock,
  CheckCheck,
  ListChecks,
  MessageCircle,
  Settings,
  Sparkles,
  UserRoundPlus,
  Users,
} from 'lucide-react';
import type { AppNotification, Task, WorkspaceMember } from '../workspace/types';

type NotificationCategory = 'all' | 'tasks' | 'messages' | 'team';

type DeadlineNotification = {
  task: Task;
  distance: number;
};

type Props = {
  notifications: AppNotification[];
  deadlines: DeadlineNotification[];
  members: WorkspaceMember[];
  onOpenNotification: (notification: AppNotification) => void;
  onOpenDeadline: (task: Task) => void;
  onMarkAllRead: () => void;
  hasMore: boolean;
  onLoadMore: () => void;
  onOpenSettings: () => void;
};

const categories: Array<{ id: NotificationCategory; label: string }> = [
  { id: 'all', label: 'Todas' },
  { id: 'tasks', label: 'Tarefas' },
  { id: 'messages', label: 'Mensagens' },
  { id: 'team', label: 'Equipe' },
];

export function NotificationsMenu({
  notifications,
  deadlines,
  members,
  onOpenNotification,
  onOpenDeadline,
  onMarkAllRead,
  hasMore,
  onLoadMore,
  onOpenSettings,
}: Props) {
  const [activeCategory, setActiveCategory] = useState<NotificationCategory>('all');
  const unreadCount = notifications.filter((notification) => !notification.read_at).length;
  const memberById = useMemo(() => new Map(members.map((member) => [member.user_id, member])), [members]);
  const notificationCounts = useMemo(() => ({
    all: notifications.length + deadlines.length,
    tasks: notifications.filter((notification) => notificationCategory(notification) === 'tasks').length + deadlines.length,
    messages: notifications.filter((notification) => notificationCategory(notification) === 'messages').length,
    team: notifications.filter((notification) => notificationCategory(notification) === 'team').length,
  }), [deadlines.length, notifications]);
  const filteredNotifications = activeCategory === 'all'
    ? notifications
    : notifications.filter((notification) => notificationCategory(notification) === activeCategory);
  const visibleDeadlines = activeCategory === 'all' || activeCategory === 'tasks' ? deadlines : [];
  const isEmpty = !filteredNotifications.length && !visibleDeadlines.length;

  return (
    <section className="notification-popover" aria-label="Central de notificações">
      <header className="notification-heading">
        <div>
          <span className="notification-heading-icon"><Bell size={17} /></span>
          <span><strong>Suas notificações</strong><small>{unreadCount ? `${unreadCount} ${unreadCount === 1 ? 'não lida' : 'não lidas'}` : 'Tudo em dia'}</small></span>
        </div>
        <div className="notification-heading-actions">
          <button type="button" disabled={!unreadCount} onClick={onMarkAllRead} title="Marcar todas como lidas" aria-label="Marcar todas como lidas"><CheckCheck size={16} /></button>
          <button type="button" onClick={onOpenSettings} title="Configurar notificações" aria-label="Configurar notificações"><Settings size={15} /></button>
        </div>
      </header>

      <nav className="notification-tabs" aria-label="Filtrar notificações">
        {categories.map((category) => (
          <button
            type="button"
            className={activeCategory === category.id ? 'active' : ''}
            aria-pressed={activeCategory === category.id}
            key={category.id}
            onClick={() => setActiveCategory(category.id)}
          >
            {category.label}<span>{notificationCounts[category.id]}</span>
          </button>
        ))}
      </nav>

      <div className="notification-scroll-area">
        {filteredNotifications.length ? (
          <div className="notification-list">
            {filteredNotifications.map((notification) => {
              const actor = notification.actor_id ? memberById.get(notification.actor_id) : undefined;
              const Icon = notificationIcon(notification.type);
              return (
                <button
                  type="button"
                  className={`notification-item ${notification.read_at ? '' : 'unread'}`}
                  key={notification.id}
                  onClick={() => onOpenNotification(notification)}
                >
                  <span className="notification-avatar">
                    {actor?.avatar_url ? <img src={actor.avatar_url} alt="" /> : actor ? actor.display_name.slice(0, 1).toUpperCase() : <Sparkles size={16} />}
                    <i className={`notification-type-icon ${notificationCategory(notification)}`}><Icon size={10} /></i>
                  </span>
                  <span className="notification-item-body">
                    <span className="notification-item-line">
                      <strong>{notificationTitle(notification.type)}</strong>
                      {!notification.read_at ? <i className="notification-unread-dot" title="Não lida" /> : null}
                    </span>
                    <span className="notification-message">{notification.message}</span>
                    <span className="notification-time"><time dateTime={notification.created_at}>{formatNotificationDate(notification.created_at)}</time><i>•</i>{relativeNotificationDate(notification.created_at)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}

        {visibleDeadlines.length ? (
          <div className="notification-deadlines">
            <div className="notification-section-label"><CalendarClock size={12} />Prazos que pedem atenção</div>
            {visibleDeadlines.map(({ task, distance }) => (
              <button type="button" className="notification-deadline" key={task.id} onClick={() => onOpenDeadline(task)}>
                <span className={distance < 0 ? 'overdue' : ''}><CalendarClock size={15} /></span>
                <span><strong>{task.title}</strong><small>{distance < 0 ? `${Math.abs(distance)} ${Math.abs(distance) === 1 ? 'dia atrasado' : 'dias atrasados'}` : deadlineLabel(distance, task.due_at)}</small></span>
              </button>
            ))}
          </div>
        ) : null}

        {isEmpty ? (
          <div className="notification-empty">
            <span><CheckCheck size={21} /></span>
            <strong>Nada novo por aqui</strong>
            <small>{activeCategory === 'all' ? 'Você está em dia com sua equipe.' : 'Não há notificações nesta categoria.'}</small>
          </div>
        ) : null}

        {hasMore ? (
          <button type="button" className="notification-load-more" onClick={onLoadMore}>
            Carregar notificações anteriores
          </button>
        ) : null}
      </div>
    </section>
  );
}

function notificationCategory(notification: AppNotification): Exclude<NotificationCategory, 'all'> {
  if (notification.type === 'chat_message') return 'messages';
  if (notification.type === 'invite_accepted') return 'team';
  return 'tasks';
}

function notificationIcon(type: AppNotification['type']) {
  if (type === 'chat_message' || type === 'comment') return MessageCircle;
  if (type === 'invite_accepted') return UserRoundPlus;
  if (type === 'assignment') return Users;
  return ListChecks;
}

function notificationTitle(type: AppNotification['type']) {
  if (type === 'chat_message') return 'Nova mensagem';
  if (type === 'assignment') return 'Tarefa atribuída';
  if (type === 'comment') return 'Novo comentário';
  if (type === 'change_request') return 'Ajuste solicitado';
  if (type === 'task_moved') return 'Tarefa movimentada';
  if (type === 'invite_accepted') return 'Novo membro na equipe';
  return 'Tarefa atualizada';
}

function formatNotificationDate(date: string) {
  return new Intl.DateTimeFormat('pt-BR', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(date));
}

function relativeNotificationDate(date: string) {
  const elapsedMinutes = Math.round((new Date(date).getTime() - Date.now()) / 60_000);
  const formatter = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });
  if (Math.abs(elapsedMinutes) < 60) return formatter.format(elapsedMinutes, 'minute');
  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (Math.abs(elapsedHours) < 24) return formatter.format(elapsedHours, 'hour');
  const elapsedDays = Math.round(elapsedHours / 24);
  return formatter.format(elapsedDays, 'day');
}

function deadlineLabel(distance: number, dueAt: string | null) {
  if (distance === 0) return 'Entrega hoje';
  if (distance === 1) return 'Entrega amanhã';
  if (!dueAt) return `${distance} dias restantes`;
  return `Entrega em ${new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(new Date(dueAt))}`;
}
