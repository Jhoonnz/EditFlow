import { describe, expect, it } from 'vitest';
import { financialCycleRange } from '../../lib/financialCycle';
import type { Earning } from '../workspace/types';
import { receivableTotal, splitReceivables } from './receivables';

const entry = (values: Partial<Earning> = {}) => ({
  id: 'entry', currency: 'BRL', amount_usd: 100, net_amount_usd: 80,
  status: 'pending', earned_at: new Date(2026, 8, 10).toISOString(), ...values,
}) as Earning;

describe('client receivables', () => {
  it('leaves only the unpaid second fortnight after receiving the first', () => {
    const entries = [entry({ amount_usd: 1200 }), entry({ amount_usd: 800 })];
    expect(receivableTotal(entries, null).totalBrl).toBe(2000);
    const received = entries.map((item, index) => index === 0 ? { ...item, status: 'received' as const } : item);
    expect(receivableTotal(received, null)).toMatchObject({ count: 1, totalBrl: 800 });
    expect(receivableTotal(received.map((item) => ({ ...item, status: 'received' })), null).totalBrl).toBe(0);
    expect(receivableTotal(entries, null).totalBrl).toBe(2000);
  });

  it('separates outstanding older cycles and excludes paid or future entries', () => {
    const range = financialCycleRange('2026-08', 28);
    const old = entry({ id: 'old', earned_at: new Date(2026, 7, 27, 23, 59).toISOString() });
    const start = entry({ id: 'start', earned_at: range.start.toISOString() });
    const end = entry({ id: 'end', earned_at: range.end.toISOString() });
    const paid = entry({ ...old, id: 'paid', status: 'received' });
    const result = splitReceivables([old, start, end, paid, entry({ earned_at: 'invalid' })], range);
    expect(result.previous.map((item) => item.id)).toEqual(['old']);
    expect(result.cycle.map((item) => item.id)).toEqual(['start']);
    const nextCycle = splitReceivables([old, start, end, paid], financialCycleRange('2026-09', 28));
    expect(nextCycle.previous.map((item) => item.id)).toEqual(['old', 'start']);
    expect(nextCycle.cycle.map((item) => item.id)).toEqual(['end']);
  });

  it('uses gross debt before fees and keeps currencies distinct without a quote', () => {
    const entries = [entry({ amount_usd: 500 }), entry({ currency: 'USD', amount_usd: 200, net_amount_usd: 180 })];
    expect(receivableTotal(entries, 5)).toMatchObject({ totalBrl: 1500, brl: 500, usd: 200 });
    expect(receivableTotal(entries, null).totalBrl).toBeNull();
    expect(receivableTotal(entries, 0).totalBrl).toBeNull();
    expect(receivableTotal([], null).totalBrl).toBe(0);
    expect(receivableTotal([entry()], NaN).totalBrl).toBe(100);
  });

  it('only reduces the selected client balance for a batch receipt and restores it when reopened', () => {
    const pending = [entry({ client_id: 'a' }), entry({ client_id: 'a' }), entry({ client_id: 'b', amount_usd: 500 })];
    const paid = pending.map((item) => item.client_id === 'a' ? { ...item, status: 'received' as const, payment_id: 'batch' } : item);
    expect(receivableTotal(paid, null).totalBrl).toBe(500);
    expect(receivableTotal(paid.filter((item) => item.client_id === 'a'), null).totalBrl).toBe(0);
    const reopened = paid.map((item) => item.payment_id === 'batch' ? { ...item, status: 'pending' as const, payment_id: null } : item);
    expect(receivableTotal(reopened, null).totalBrl).toBe(700);
  });
});
