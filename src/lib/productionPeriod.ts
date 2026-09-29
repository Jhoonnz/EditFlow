import type { FinancialCycleRange } from './financialCycle';

export function toLocalDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function weeklyProductionPeriodRange(dateKey: string): FinancialCycleRange {
  const date = parseLocalDateKey(dateKey);
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7));
  return { start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7) };
}

export function shiftWeeklyProductionPeriod(dateKey: string, offset: -1 | 1) {
  const { start } = weeklyProductionPeriodRange(dateKey);
  return toLocalDateKey(new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset * 7));
}

export function customProductionPeriodRange(startKey: string, endKey: string): FinancialCycleRange {
  const start = parseLocalDateKey(startKey);
  const lastDay = parseLocalDateKey(endKey);
  if (start > lastDay) throw new Error('A data inicial deve ser anterior ou igual à data final');
  return { start, end: new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() + 1) };
}

export function formatProductionDateRange(range: FinancialCycleRange) {
  const endInclusive = new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate() - 1);
  const formatter = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' });
  return `${formatter.format(range.start)} – ${formatter.format(endInclusive)}`;
}

function parseLocalDateKey(value: string) {
  const match = /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(value);
  if (!match) throw new Error('Data inválida para o relatório');
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) {
    throw new Error('Data inválida para o relatório');
  }
  return date;
}
