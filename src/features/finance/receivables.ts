import type { FinancialCycleRange } from '../../lib/financialCycle';
import type { Earning } from '../workspace/types';

// Debt is the client's unpaid gross amount, not profit or a transfer estimate.
// USD uses the current quote; missing conversion must never appear as zero.
export function receivableTotal(entries: Earning[], usdBrlRate: number | null) {
  const totals = { BRL: 0, USD: 0 };
  const pending = entries.filter((entry) => entry.status === 'pending');
  pending.forEach((entry) => { totals[entry.currency] += entry.amount_usd; });
  const validRate = usdBrlRate !== null && Number.isFinite(usdBrlRate) && usdBrlRate > 0;
  return {
    count: pending.length,
    brl: totals.BRL,
    usd: totals.USD,
    totalBrl: totals.USD && !validRate ? null : totals.BRL + totals.USD * (validRate ? usdBrlRate : 0),
  };
}

export function splitReceivables(entries: Earning[], range: FinancialCycleRange) {
  const cycle: Earning[] = [];
  const previous: Earning[] = [];
  for (const entry of entries) {
    if (entry.status !== 'pending') continue;
    const date = new Date(entry.earned_at);
    if (date < range.start) previous.push(entry);
    else if (date >= range.start && date < range.end) cycle.push(entry);
  }
  return { cycle, previous };
}
