import { describe, expect, it } from 'vitest';
import { findMentionContext } from './chatMentions';

describe('findMentionContext', () => {
  it('abre a busca depois de @ e preserva a posição de substituição', () => {
    expect(findMentionContext('Olá @jo', 7)).toEqual({ start: 4, end: 7, query: 'jo' });
  });

  it('permite pesquisar nomes compostos', () => {
    expect(findMentionContext('@Maria Silva', 12)).toEqual({ start: 0, end: 12, query: 'Maria Silva' });
  });

  it('não interpreta o arroba dentro de um e-mail como menção', () => {
    expect(findMentionContext('teste@email.com', 15)).toBeNull();
  });

  it('fecha a busca ao encontrar pontuação', () => {
    expect(findMentionContext('Oi @João, tudo bem?', 20)).toBeNull();
  });
});
