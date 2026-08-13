import type { Task } from '../features/workspace/types';

export const DAY_MS = 24 * 60 * 60 * 1000;

export function isActiveTask(task: Pick<Task, 'completed_at'>) {
  return !task.completed_at;
}

export function taskDeadlineDistance(task: Pick<Task, 'due_at'>, now = Date.now()) {
  return task.due_at ? new Date(task.due_at).getTime() - now : null;
}

export function isVisibleDeadline(
  task: Pick<Task, 'completed_at' | 'due_at'>,
  now = Date.now(),
  overdueHistoryDays = 30,
  upcomingDays = 7,
) {
  if (!isActiveTask(task)) return false;
  const distance = taskDeadlineDistance(task, now);
  return distance !== null && distance >= -overdueHistoryDays * DAY_MS && distance < upcomingDays * DAY_MS;
}
