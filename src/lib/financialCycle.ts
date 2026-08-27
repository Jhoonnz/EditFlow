export type FinancialCycleRange = {
  start: Date;
  end: Date;
};

export function normalizeCycleStartDay(value: unknown) {
  const day = Number(value);
  return Number.isInteger(day) && day >= 1 && day <= 31 ? day : 1;
}

export function shiftMonthKey(monthKey: string, offset: number) {
  const [year, month] = parseMonthKey(monthKey);
  const shifted = new Date(year, month - 1 + offset, 1);
  return toMonthKey(shifted.getFullYear(), shifted.getMonth() + 1);
}

export function financialCycleRange(monthKey: string, startDay: number): FinancialCycleRange {
  const normalizedDay = normalizeCycleStartDay(startDay);
  const [year, month] = parseMonthKey(monthKey);
  return {
    start: cycleBoundary(year, month, normalizedDay),
    end: cycleBoundaryForMonthKey(shiftMonthKey(monthKey, 1), normalizedDay),
  };
}

export function currentFinancialCycle(startDay: number, reference = new Date()) {
  const currentMonthKey = toMonthKey(reference.getFullYear(), reference.getMonth() + 1);
  const currentBoundary = financialCycleRange(currentMonthKey, startDay).start;
  return reference < currentBoundary ? shiftMonthKey(currentMonthKey, -1) : currentMonthKey;
}

export function isDateInRange(value: string | Date, range: FinancialCycleRange) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) && date >= range.start && date < range.end;
}

export function formatFinancialCycle(range: FinancialCycleRange) {
  const inclusiveEnd = new Date(range.end);
  inclusiveEnd.setDate(inclusiveEnd.getDate() - 1);
  const start = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(range.start);
  const end = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).format(inclusiveEnd);
  return `${start} – ${end}`;
}

function cycleBoundaryForMonthKey(monthKey: string, startDay: number) {
  const [year, month] = parseMonthKey(monthKey);
  return cycleBoundary(year, month, startDay);
}

function cycleBoundary(year: number, month: number, startDay: number) {
  const lastDay = new Date(year, month, 0).getDate();
  return new Date(year, month - 1, Math.min(startDay, lastDay), 0, 0, 0, 0);
}

function parseMonthKey(monthKey: string): [number, number] {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) throw new Error('Invalid financial cycle month');
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error('Invalid financial cycle month');
  return [year, month];
}

function toMonthKey(year: number, month: number) {
  return `${year}-${String(month).padStart(2, '0')}`;
}
