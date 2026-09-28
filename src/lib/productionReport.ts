import type { Client, Task, WorkspaceMember } from '../features/workspace/types';
import { isDateInRange, type FinancialCycleRange } from './financialCycle';

export type ProductionReportFilters = {
  clientId: string;
  editorId: string;
  currentUserId: string;
  canSeeTeam: boolean;
  search?: string;
};

export type ProductionReportRow = {
  taskId: string;
  title: string;
  clientId: string | null;
  clientName: string;
  editorId: string | null;
  editorName: string;
  completedAt: string;
  archived: boolean;
};

export function buildProductionReport(
  tasks: Task[],
  clients: Client[],
  members: WorkspaceMember[],
  range: FinancialCycleRange,
  filters: ProductionReportFilters,
) {
  const clientNames = new Map(clients.map((client) => [client.id, client.name]));
  const editorNames = new Map(members.map((member) => [member.user_id, member.display_name]));
  const normalizedSearch = normalizeSearch(filters.search ?? '');
  const rows: ProductionReportRow[] = tasks
    .filter((task) => task.completed_at && isDateInRange(task.completed_at, range))
    .filter((task) => filters.canSeeTeam || task.assignee_id === filters.currentUserId)
    .filter((task) => filters.clientId === 'all' || (filters.clientId === 'none' ? !task.client_id : task.client_id === filters.clientId))
    .filter((task) => filters.editorId === 'all' || (filters.editorId === 'none' ? !task.assignee_id : task.assignee_id === filters.editorId))
    .map((task) => ({
      taskId: task.id,
      title: task.title,
      clientId: task.client_id,
      clientName: task.client_id ? clientNames.get(task.client_id) ?? 'Cliente removido' : 'Sem cliente',
      editorId: task.assignee_id,
      editorName: task.assignee_id ? editorNames.get(task.assignee_id) ?? 'Membro removido' : 'Sem responsável',
      completedAt: task.completed_at!,
      archived: Boolean(task.archived_at),
    }))
    .filter((row) => !normalizedSearch || normalizeSearch(`${row.title} ${row.clientName} ${row.editorName}`).includes(normalizedSearch))
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt) || left.taskId.localeCompare(right.taskId));

  const byClient = [...rows.reduce((grouped, row) => {
    const key = row.clientId ?? 'none';
    const current = grouped.get(key) ?? { clientId: row.clientId, clientName: row.clientName, count: 0 };
    current.count += 1;
    grouped.set(key, current);
    return grouped;
  }, new Map<string, { clientId: string | null; clientName: string; count: number }>()).values()]
    .sort((left, right) => right.count - left.count || left.clientName.localeCompare(right.clientName, 'pt-BR'));

  return {
    rows,
    byClient,
    total: rows.length,
    clientCount: byClient.filter((group) => group.clientId !== null).length,
    editorCount: new Set(rows.map((row) => row.editorId).filter(Boolean)).size,
  };
}

function normalizeSearch(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('pt-BR');
}
