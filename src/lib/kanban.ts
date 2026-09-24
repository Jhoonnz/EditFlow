import type { Task, TaskDraft } from '../features/workspace/types';

export type QuickTaskFilter = 'all' | 'overdue' | 'today' | 'unassigned' | 'urgent' | 'blocked';

export function matchesTaskFilter(task: Task, filter: QuickTaskFilter, now = new Date()) {
  if (filter === 'all') return true;
  if (task.completed_at || task.archived_at) return false;
  if (filter === 'unassigned') return !task.assignee_id;
  if (filter === 'urgent') return task.priority === 'urgent';
  if (filter === 'blocked') return Boolean(task.blocked_reason);
  if (!task.due_at || task.first_sent_at) return false;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const due = new Date(task.due_at);
  const day = new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime();
  return filter === 'today' ? day === today : day < today;
}

export function normalizeTaskUrl(raw: string) {
  const text = raw.trim();
  if (!text) return '';
  if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^https?:\/\//i.test(text)) {
    throw new Error('Use um endereço de site HTTP ou HTTPS.');
  }
  const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  if (!url.hostname.includes('.') || url.username || url.password) throw new Error('Digite um endereço de site válido, sem usuário ou senha.');
  url.protocol = 'https:';
  return url.href;
}

/** Only edited fields are sent; a version check at the database prevents stale writes. */
export function taskDraftChanges(initial: TaskDraft, draft: TaskDraft, canManage: boolean) {
  const changes: Record<string, string | number | null> = {};
  for (const key of Object.keys(draft) as Array<keyof TaskDraft>) {
    if (draft[key] === initial[key] || (!canManage && key !== 'revision_round' && key !== 'blocked_reason')) continue;
    if (key === 'due_at') changes[key] = draft[key] ? new Date(`${draft[key]}T12:00:00`).toISOString() : null;
    else if (key === 'client_id' || key === 'assignee_id' || key === 'blocked_reason') changes[key] = String(draft[key]).trim() || null;
    else changes[key] = typeof draft[key] === 'string' ? String(draft[key]).trim() : draft[key];
  }
  return changes;
}
