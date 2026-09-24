import { describe, expect, it } from 'vitest';
import { matchesTaskFilter, normalizeTaskUrl, taskDraftChanges } from './kanban';
import type { Task, TaskDraft } from '../features/workspace/types';

const draft: TaskDraft = { title: 'Vídeo', description: 'Briefing', priority: 'normal', due_at: '', client_id: '', assignee_id: '', revision_round: 1, blocked_reason: '' };

describe('Kanban helpers', () => {
  it('normaliza HTTP e endereços sem protocolo sem prefixos duplicados', () => {
    expect(normalizeTaskUrl(' http://www.google.com/test?a=1 ')).toBe('https://www.google.com/test?a=1');
    expect(normalizeTaskUrl('www.google.com')).toBe('https://www.google.com/');
    expect(normalizeTaskUrl('HTTPS://example.com/test')).toBe('https://example.com/test');
    expect(normalizeTaskUrl('')).toBe('');
    for (const url of ['javascript:alert(1)', 'file:///a.txt', 'ftp://example.com', 'https://user:pass@example.com', 'not a url']) expect(() => normalizeTaskUrl(url)).toThrow();
  });
  it('envia apenas campos editados e normaliza os opcionais', () => {
    expect(taskDraftChanges(draft, { ...draft, title: ' Novo título ', blocked_reason: ' Aguardando ' }, true)).toEqual({ title: 'Novo título', blocked_reason: 'Aguardando' });
    expect(taskDraftChanges({ ...draft, assignee_id: 'id' }, draft, true)).toEqual({ assignee_id: null });
    expect(taskDraftChanges(draft, draft, true)).toEqual({});
  });
  it('editores só alteram versão e impedimento', () => {
    expect(taskDraftChanges(draft, { ...draft, title: 'Proibido', assignee_id: 'outro', revision_round: 2, blocked_reason: 'Material' }, false)).toEqual({ revision_round: 2, blocked_reason: 'Material' });
  });
  it('filtra prazos por dia local e não inclui finalizados', () => {
    const now = new Date(2026, 8, 22, 18);
    const task = { due_at: new Date(2026, 8, 22, 12).toISOString(), completed_at: null, archived_at: null, assignee_id: null, priority: 'urgent', blocked_reason: 'Material' } as Task;
    expect(matchesTaskFilter(task, 'today', now)).toBe(true);
    expect(matchesTaskFilter(task, 'overdue', now)).toBe(false);
    for (const filter of ['unassigned', 'urgent', 'blocked'] as const) expect(matchesTaskFilter(task, filter, now)).toBe(true);
    expect(matchesTaskFilter({ ...task, completed_at: now.toISOString() }, 'urgent', now)).toBe(false);
    expect(matchesTaskFilter({ ...task, due_at: null }, 'today', now)).toBe(false);
    const submitted = { ...task, first_sent_at: new Date(2026, 8, 20).toISOString() };
    expect(matchesTaskFilter(submitted, 'overdue', new Date(2026, 8, 30))).toBe(false);
    expect(matchesTaskFilter(submitted, 'today', now)).toBe(false);
    expect(matchesTaskFilter(submitted, 'urgent', now)).toBe(true);
  });
});
