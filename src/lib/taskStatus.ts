import type { Task } from '../features/workspace/types';

export const DAY_MS = 24 * 60 * 60 * 1000;

export function isActiveTask(task: Pick<Task, 'completed_at'>) {
  return !task.completed_at;
}

type DeliverySnapshot = Partial<Pick<Task, 'first_sent_at' | 'first_sent_late'>>;

export function deliveryLabel(task: DeliverySnapshot) {
  if (!task.first_sent_at) return null;
  if (task.first_sent_late === null || task.first_sent_late === undefined) return 'Enviado sem prazo';
  return task.first_sent_late ? 'Enviado com atraso' : 'Enviado no prazo';
}

export function taskDeadlineDistance(task: Pick<Task, 'due_at'> & DeliverySnapshot, now = Date.now()) {
  if (task.first_sent_at) return null;
  return task.due_at ? new Date(task.due_at).getTime() - now : null;
}

export function isVisibleDeadline(
  task: Pick<Task, 'completed_at' | 'due_at'> & DeliverySnapshot,
  now = Date.now(),
  overdueHistoryDays = 30,
  upcomingDays = 7,
) {
  if (!isActiveTask(task)) return false;
  const distance = taskDeadlineDistance(task, now);
  return distance !== null && distance >= -overdueHistoryDays * DAY_MS && distance < upcomingDays * DAY_MS;
}
