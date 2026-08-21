export function dateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function calculateDueDate(offsetDays: number, businessDays = false, start = new Date()) {
  const result = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 12);
  let remaining = Math.max(0, Math.trunc(offsetDays));

  while (remaining > 0) {
    result.setDate(result.getDate() + 1);
    const day = result.getDay();
    if (!businessDays || (day !== 0 && day !== 6)) remaining -= 1;
  }

  return dateInputValue(result);
}

export function calendarDayOffset(date: string, start = new Date()) {
  if (!date) return 7;
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(year, month - 1, day, 12);
  const origin = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 12);
  return Math.max(0, Math.min(365, Math.round((target.getTime() - origin.getTime()) / 86_400_000)));
}
