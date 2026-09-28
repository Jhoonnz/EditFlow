import { describe, expect, it } from 'vitest';
import { financialCycleRange } from './financialCycle';
import { buildProductionReport, latestCompletionMoves } from './productionReport';
import { shortProductionPeriodRange } from './productionPeriod';
import type { Client, Task, WorkspaceMember } from '../features/workspace/types';

const client = { id: 'client-a', name: 'Canal A' } as Client;
const editor = { user_id: 'editor-a', display_name: 'Ana' } as WorkspaceMember;
const task = (id: string, completedAt: string | null, extras: Partial<Task> = {}) => ({
  id, title: `Vídeo ${id}`, client_id: client.id, assignee_id: editor.user_id,
  completed_at: completedAt, archived_at: null, ...extras,
}) as Task;
const filters = { clientId: 'all', editorId: 'all', currentUserId: editor.user_id, canSeeTeam: true };

describe('production report', () => {
  it('counts finished videos once, including archived tasks, without counting drafts or payments', () => {
    const rows = [
      task('a', '2026-09-03T15:00:00Z'),
      task('b', '2026-09-05T15:00:00Z', { archived_at: '2026-09-15T12:00:00Z' }),
      task('c', null),
      task('d', '2026-08-30T15:00:00Z'),
    ];
    const report = buildProductionReport(rows, [client], [editor], financialCycleRange('2026-09', 1), filters);
    expect(report.total).toBe(2);
    expect(report.byClient).toEqual([{ clientId: client.id, clientName: client.name, count: 2 }]);
    expect(report.rows[0].taskId).toBe('b');
    expect(report.rows[0].archived).toBe(true);
  });

  it('uses the configured cycle and limits editors to their own assigned tasks', () => {
    const rows = [
      task('a', '2026-08-28T15:00:00Z'),
      task('b', '2026-09-27T15:00:00Z', { assignee_id: 'editor-b' }),
      task('c', '2026-09-28T15:00:00Z'),
    ];
    const cycle = financialCycleRange('2026-08', 28);
    expect(buildProductionReport(rows, [client], [editor], cycle, { ...filters, canSeeTeam: false }).rows.map((row) => row.taskId)).toEqual(['a']);
    expect(buildProductionReport(rows, [client], [editor], cycle, { ...filters, clientId: 'none' }).total).toBe(0);
  });

  it('applies accent-insensitive search to totals and client breakdown', () => {
    const rows = [
      task('a', '2026-09-03T15:00:00Z', { title: 'Edição principal' }),
      task('b', '2026-09-05T15:00:00Z', { title: 'Short extra' }),
    ];
    const report = buildProductionReport(rows, [client], [editor], financialCycleRange('2026-09', 1), { ...filters, search: 'edicao' });
    expect(report.total).toBe(1);
    expect(report.rows[0].title).toBe('Edição principal');
    expect(report.byClient[0].count).toBe(1);
  });

  it('uses the same weekly and fortnightly boundaries for counts', () => {
    const rows = [
      task('a', '2026-09-14T15:00:00Z'),
      task('b', '2026-09-15T15:00:00Z'),
      task('c', '2026-09-16T15:00:00Z'),
      task('d', '2026-09-21T15:00:00Z'),
    ];
    expect(buildProductionReport(rows, [client], [editor], shortProductionPeriodRange('2026-09-16', 'week'), filters).total).toBe(3);
    expect(buildProductionReport(rows, [client], [editor], shortProductionPeriodRange('2026-09-15', 'fortnight'), filters).total).toBe(2);
    expect(buildProductionReport(rows, [client], [editor], shortProductionPeriodRange('2026-09-16', 'fortnight'), filters).total).toBe(2);
  });

  it('uses the latest real move into the final column instead of a later backfilled timestamp', () => {
    const moves = latestCompletionMoves([
      { task_id: 'a', created_at: '2026-08-12T14:00:00Z', details: { to_column_id: 'final' } },
      { task_id: 'a', created_at: '2026-08-12T15:00:00Z', details: { to_column_id: 'editing' } },
      { task_id: 'a', created_at: '2026-08-15T13:26:00Z', details: { to_column_id: 'final' } },
      { task_id: 'b', created_at: '2026-09-10T10:00:00Z', details: { to_column_id: 'other' } },
    ], 'final');
    const rows = [
      task('a', '2026-09-10T12:00:00Z'),
      task('b', '2026-09-10T12:00:00Z'),
    ];
    const august = buildProductionReport(rows, [client], [editor], financialCycleRange('2026-08', 1), filters, moves);
    const september = buildProductionReport(rows, [client], [editor], financialCycleRange('2026-09', 1), filters, moves);
    expect(august.rows.map((row) => row.taskId)).toEqual(['a']);
    expect(august.rows[0].completedAt).toBe('2026-08-15T13:26:00Z');
    expect(september.rows.map((row) => row.taskId)).toEqual(['b']);
  });
});
