// Shared helpers for the /api/payroll/* routes.
//
// Month params come in as "YYYY-MM" in the URL path. We parse into the
// canonical first-of-UTC-month Date the engine expects, and reject anything
// else at the edge (so handlers never see a half-valid month).

export function parseMonthParam(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  if (!m) return null;
  const y = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(y) || y < 2000 || y > 2100) return null;
  if (!Number.isFinite(mm) || mm < 1 || mm > 12) return null;
  return new Date(Date.UTC(y, mm - 1, 1, 0, 0, 0, 0));
}
