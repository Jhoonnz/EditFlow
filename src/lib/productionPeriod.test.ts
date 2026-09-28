import { describe, expect, it } from 'vitest';
import { isDateInRange } from './financialCycle';
import { formatShortProductionPeriod, shiftShortProductionPeriod, shortProductionPeriodRange } from './productionPeriod';

describe('production report short periods', () => {
  it('uses Monday through Sunday, including a year boundary', () => {
    const range = shortProductionPeriodRange('2027-01-01', 'week');
    expect(range.start).toEqual(new Date(2026, 11, 28));
    expect(range.end).toEqual(new Date(2027, 0, 4));
    expect(isDateInRange(new Date(2027, 0, 3, 23, 59), range)).toBe(true);
    expect(isDateInRange(new Date(2027, 0, 4), range)).toBe(false);
    expect(shiftShortProductionPeriod('2027-01-01', 'week', 1)).toBe('2027-01-04');
    expect(formatShortProductionPeriod(range)).toContain('2026');
    expect(formatShortProductionPeriod(range)).toContain('2027');
  });

  it('splits each calendar month into days 1-15 and 16-end', () => {
    const first = shortProductionPeriodRange('2028-02-15', 'fortnight');
    const second = shortProductionPeriodRange('2028-02-16', 'fortnight');
    expect(first).toEqual({ start: new Date(2028, 1, 1), end: new Date(2028, 1, 16) });
    expect(second).toEqual({ start: new Date(2028, 1, 16), end: new Date(2028, 2, 1) });
    expect(shiftShortProductionPeriod('2028-02-15', 'fortnight', 1)).toBe('2028-02-16');
    expect(shiftShortProductionPeriod('2028-02-16', 'fortnight', 1)).toBe('2028-03-01');
    expect(shiftShortProductionPeriod('2028-02-01', 'fortnight', -1)).toBe('2028-01-16');
  });

  it('rejects impossible dates', () => {
    expect(() => shortProductionPeriodRange('2026-02-30', 'week')).toThrow();
  });
});
