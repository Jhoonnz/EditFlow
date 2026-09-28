import type { FinancialCycleRange } from './financialCycle';

export type ShortProductionPeriod = 'week' | 'fortnight';

export function toLocalDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function shortProductionPeriodRange(dateKey: string, kind: ShortProductionPeriod): FinancialCycleRange {
  const date = parseLocalDateKey(dateKey);
  if (kind === 'week') {
    const start = new Date(date.getFullYear(), date.getMonth(), date.getDate() - ((date.getDay() + 6) % 7));
    return { start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7) };
  }

  const firstHalf = date.getDate() <= 15;
  return {
    start: new Date(date.getFullYear(), date.getMonth(), firstHalf ? 1 : 16),
    end: new Date(date.getFullYear(), date.getMonth() + (firstHalf ? 0 : 1), firstHalf ? 16 : 1),
  };
}

export function shiftShortProductionPeriod(dateKey: string, kind: ShortProductionPeriod, offset: -1 | 1) {
  const { start } = shortProductionPeriodRange(dateKey, kind);
  if (kind === 'week') return toLocalDateKey(new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset * 7));
  if (offset === 1) return toLocalDateKey(start.getDate() === 1
    ? new Date(start.getFullYear(), start.getMonth(), 16)
    : new Date(start.getFullYear(), start.getMonth() + 1, 1));
  return toLocalDateKey(start.getDate() === 1
    ? new Date(start.getFullYear(), start.getMonth() - 1, 16)
    : new Date(start.getFullYear(), start.getMonth(), 1));
}

export function formatShortProductionPeriod(range: FinancialCycleRange) {
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
