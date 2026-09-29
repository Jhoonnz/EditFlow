import { describe, expect, it } from 'vitest';
import { isDateInRange } from './financialCycle';
import { customProductionPeriodRange, formatProductionDateRange, shiftWeeklyProductionPeriod, weeklyProductionPeriodRange } from './productionPeriod';

describe('production report periods', () => {
  it('uses Monday through Sunday, including a year boundary', () => {
    const range = weeklyProductionPeriodRange('2027-01-01');
    expect(range.start).toEqual(new Date(2026, 11, 28));
    expect(range.end).toEqual(new Date(2027, 0, 4));
    expect(isDateInRange(new Date(2027, 0, 3, 23, 59), range)).toBe(true);
    expect(isDateInRange(new Date(2027, 0, 4), range)).toBe(false);
    expect(shiftWeeklyProductionPeriod('2027-01-01', 1)).toBe('2027-01-04');
    expect(formatProductionDateRange(range)).toContain('2026');
    expect(formatProductionDateRange(range)).toContain('2027');
  });

  it('includes both selected dates across month boundaries', () => {
    const range = customProductionPeriodRange('2026-08-13', '2026-08-28');
    expect(range).toEqual({ start: new Date(2026, 7, 13), end: new Date(2026, 7, 29) });
    expect(isDateInRange(new Date(2026, 7, 28, 23, 59), range)).toBe(true);
    expect(isDateInRange(new Date(2026, 7, 29), range)).toBe(false);
    expect(customProductionPeriodRange('2028-02-28', '2028-03-01').end).toEqual(new Date(2028, 2, 2));
    expect(customProductionPeriodRange('2026-09-28', '2026-09-28').end).toEqual(new Date(2026, 8, 29));
  });

  it('rejects impossible or inverted dates', () => {
    expect(() => weeklyProductionPeriodRange('2026-02-30')).toThrow();
    expect(() => customProductionPeriodRange('2026-02-30', '2026-03-01')).toThrow();
    expect(() => customProductionPeriodRange('2026-09-29', '2026-09-28')).toThrow();
  });
});
