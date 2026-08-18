import { describe, expect, it, vi } from 'vitest';
import { fetchAllRows } from './paginatedQuery';

describe('fetchAllRows', () => {
  it('combina todas as páginas até encontrar uma página incompleta', async () => {
    const loadPage = vi.fn(async (from: number, to: number) => ({
      data: from === 0 ? [1, 2] : from === 2 ? [3, 4] : [5],
      error: null,
      range: [from, to],
    }));

    await expect(fetchAllRows(loadPage, 2)).resolves.toEqual({
      data: [1, 2, 3, 4, 5],
      error: null,
    });
    expect(loadPage.mock.calls).toEqual([[0, 1], [2, 3], [4, 5]]);
  });

  it('trata uma resposta sem dados como uma página vazia', async () => {
    await expect(fetchAllRows(async () => ({ data: null, error: null }), 10)).resolves.toEqual({
      data: [],
      error: null,
    });
  });

  it('interrompe o carregamento e preserva o erro retornado', async () => {
    const failure = { message: 'Falha de rede' };
    const loadPage = vi.fn(async (from: number) => from === 0
      ? { data: [1, 2], error: null }
      : { data: null, error: failure });

    await expect(fetchAllRows(loadPage, 2)).resolves.toEqual({ data: null, error: failure });
    expect(loadPage).toHaveBeenCalledTimes(2);
  });
});
