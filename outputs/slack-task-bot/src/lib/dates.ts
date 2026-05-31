import { format, isToday, parseISO, startOfDay } from "date-fns";

export function parseDueDate(input: string): Date | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const iso = parseISO(trimmed);
  if (!Number.isNaN(iso.getTime())) return startOfDay(iso);

  const match = trimmed.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
  if (!match) return null;

  const now = new Date();
  const month = Number(match[1]) - 1;
  const day = Number(match[2]);
  const year = match[3] ? normalizeYear(Number(match[3])) : now.getFullYear();
  return startOfDay(new Date(year, month, day));
}

export function formatDate(date: Date | null | undefined): string {
  if (!date) return "None";
  return format(date, "yyyy-MM-dd");
}

export function dueDateLabel(date: Date | null | undefined): string {
  if (!date) return "No due date";
  return isToday(date) ? `${formatDate(date)} (today)` : formatDate(date);
}

function normalizeYear(year: number): number {
  if (year < 100) return 2000 + year;
  return year;
}
