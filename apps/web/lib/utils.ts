export function formatPrice(amount: number): string {
  return `${amount.toLocaleString("ar-EG")} ج.م`;
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString("ar-EG", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function formatDateTime(date: Date): string {
  return date.toLocaleString("ar-EG", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function cn(...classes: (string | undefined | null | false)[]): string {
  return classes.filter(Boolean).join(" ");
}

export function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function endOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(23, 59, 59, 999);
  return d;
}

export function isBetween(date: Date, start: Date, end: Date): boolean {
  const time = date.getTime();
  return time >= start.getTime() && time <= end.getTime();
}

export function getTodayRange() {
  const start = startOfDay(new Date());
  const end = endOfDay(new Date());
  return { start, end };
}

export function getYesterdayRange() {
  const start = startOfDay(new Date());
  start.setDate(start.getDate() - 1);
  const end = endOfDay(start);
  return { start, end };
}

export function getThisMonthRange() {
  const now = new Date();
  const start = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1));
  const end = endOfDay(now);
  return { start, end };
}