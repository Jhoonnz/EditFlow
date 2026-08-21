import { describe, expect, it } from 'vitest';
import { calculateDueDate, calendarDayOffset, dateInputValue } from './taskTemplate';

describe('task template deadlines', () => {
  it('formats dates for a date input without UTC shifts', () => {
    expect(dateInputValue(new Date(2026, 7, 21, 23, 30))).toBe('2026-08-21');
  });

  it('adds calendar days', () => {
    expect(calculateDueDate(3, false, new Date(2026, 7, 21))).toBe('2026-08-24');
  });

  it('skips weekends when using business days', () => {
    expect(calculateDueDate(3, true, new Date(2026, 7, 21))).toBe('2026-08-26');
  });

  it('supports deadlines due today', () => {
    expect(calculateDueDate(0, true, new Date(2026, 7, 23))).toBe('2026-08-23');
  });

  it('derives a safe calendar offset from an existing deadline', () => {
    expect(calendarDayOffset('2026-08-28', new Date(2026, 7, 21))).toBe(7);
    expect(calendarDayOffset('2026-08-20', new Date(2026, 7, 21))).toBe(0);
  });
});
