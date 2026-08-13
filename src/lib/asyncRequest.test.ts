import { describe, expect, it } from 'vitest';
import { LatestRequestGate } from './asyncRequest';

describe('LatestRequestGate', () => {
  it('aceita somente a resposta mais recente', () => {
    const gate = new LatestRequestGate();
    const first = gate.begin();
    const second = gate.begin();
    expect(gate.isLatest(first)).toBe(false);
    expect(gate.isLatest(second)).toBe(true);
  });

  it('invalida respostas pendentes ao cancelar', () => {
    const gate = new LatestRequestGate();
    const request = gate.begin();
    gate.cancel();
    expect(gate.isLatest(request)).toBe(false);
  });
});
