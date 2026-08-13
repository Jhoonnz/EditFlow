import { describe, expect, it } from 'vitest';
import { DAY_MS, isActiveTask, isVisibleDeadline } from './taskStatus';

describe('taskStatus', () => {
  const now = Date.parse('2026-08-13T12:00:00.000Z');

  it('considera completed_at como fonte de conclusão', () => {
    expect(isActiveTask({ completed_at: null })).toBe(true);
    expect(isActiveTask({ completed_at: '2026-08-13T10:00:00.000Z' })).toBe(false);
  });

  it('não notifica tarefas concluídas', () => {
    expect(isVisibleDeadline({ completed_at: '2026-08-13T10:00:00.000Z', due_at: '2026-08-14T12:00:00.000Z' }, now)).toBe(false);
  });

  it('limita atrasos a 30 dias e próximos prazos a 7 dias', () => {
    expect(isVisibleDeadline({ completed_at: null, due_at: new Date(now - 29 * DAY_MS).toISOString() }, now)).toBe(true);
    expect(isVisibleDeadline({ completed_at: null, due_at: new Date(now - 31 * DAY_MS).toISOString() }, now)).toBe(false);
    expect(isVisibleDeadline({ completed_at: null, due_at: new Date(now + 6 * DAY_MS).toISOString() }, now)).toBe(true);
    expect(isVisibleDeadline({ completed_at: null, due_at: new Date(now + 8 * DAY_MS).toISOString() }, now)).toBe(false);
  });
});
