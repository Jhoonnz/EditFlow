import { describe, expect, it } from 'vitest';
import {
  currentFinancialCycle,
  financialCycleRange,
  isDateInRange,
  normalizeCycleStartDay,
  shiftMonthKey,
} from './financialCycle';

describe('financial cycles', () => {
  it('starts a day-28 cycle on the contract anniversary', () => {
    expect(currentFinancialCycle(28, new Date(2026, 7, 27, 12))).toBe('2026-07');
    expect(currentFinancialCycle(28, new Date(2026, 7, 28, 12))).toBe('2026-08');

    const range = financialCycleRange('2026-08', 28);
    expect(range.start).toEqual(new Date(2026, 7, 28));
    expect(range.end).toEqual(new Date(2026, 8, 28));
    expect(isDateInRange(new Date(2026, 8, 27, 23, 59), range)).toBe(true);
    expect(isDateInRange(new Date(2026, 8, 28), range)).toBe(false);
  });

  it('uses the last available day in shorter months', () => {
    const january = financialCycleRange('2026-01', 31);
    const february = financialCycleRange('2026-02', 31);
    expect(january.start).toEqual(new Date(2026, 0, 31));
    expect(january.end).toEqual(new Date(2026, 1, 28));
    expect(february.start).toEqual(new Date(2026, 1, 28));
    expect(february.end).toEqual(new Date(2026, 2, 31));
  });

  it('navigates across years and rejects invalid days', () => {
    expect(shiftMonthKey('2026-01', -1)).toBe('2025-12');
    expect(shiftMonthKey('2026-12', 1)).toBe('2027-01');
    expect(normalizeCycleStartDay(0)).toBe(1);
    expect(normalizeCycleStartDay(28)).toBe(28);
  });
});
