import { describe, expect, it } from 'vitest';
import { DAY_MS, deliveryLabel, isActiveTask, isVisibleDeadline, taskDeadlineDistance } from './taskStatus';

describe('taskStatus', () => {
  const now = Date.parse('2026-08-13T12:00:00.000Z');

  it('considera completed_at como fonte de conclusão', () => {
    expect(isActiveTask({ completed_at: null })).toBe(true);
    expect(isActiveTask({ completed_at: '2026-08-13T10:00:00.000Z' })).toBe(false);
  });

  it('não notifica tarefas concluídas', () => {
    expect(isVisibleDeadline({ completed_at: '2026-08-13T10:00:00.000Z', due_at: '2026-08-14T12:00:00.000Z' }, now)).toBe(false);
  });

  it('envio encerra os alertas de prazo, mas não conclui a tarefa', () => {
    const task = { completed_at: null, due_at: '2026-08-01T12:00:00Z', first_sent_at: '2026-08-01T22:00:00Z', first_sent_late: false };
    expect(isActiveTask(task)).toBe(true);
    expect(isVisibleDeadline(task, now)).toBe(false);
    expect(taskDeadlineDistance(task, now)).toBeNull();
    expect(deliveryLabel(task)).toBe('Enviado no prazo');
    expect(deliveryLabel({ ...task, first_sent_late: true })).toBe('Enviado com atraso');
    expect(deliveryLabel({ ...task, first_sent_late: null })).toBe('Enviado sem prazo');
    expect(deliveryLabel({ first_sent_at: null })).toBeNull();
  });

  it('limita atrasos a 30 dias e próximos prazos a 7 dias', () => {
    expect(isVisibleDeadline({ completed_at: null, due_at: new Date(now - 29 * DAY_MS).toISOString() }, now)).toBe(true);
    expect(isVisibleDeadline({ completed_at: null, due_at: new Date(now - 31 * DAY_MS).toISOString() }, now)).toBe(false);
    expect(isVisibleDeadline({ completed_at: null, due_at: new Date(now + 6 * DAY_MS).toISOString() }, now)).toBe(true);
    expect(isVisibleDeadline({ completed_at: null, due_at: new Date(now + 8 * DAY_MS).toISOString() }, now)).toBe(false);
  });
});
