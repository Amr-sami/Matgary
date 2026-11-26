// Shared filename helper for Payroll PDFs.
//
// Shape:
//   • Register   → `Payroll-YYYY-MM-{StoreName}.pdf`
//   • Statement  → `Payroll-YYYY-MM-{EmployeeName}.pdf`
//
// Names are slugified to keep iOS / Android / Linux file systems happy:
// unsafe characters are dropped, whitespace collapses to a single `-`. If
// the resulting name ends up empty (all-emoji store name, etc.) we fall
// back to the literal "Store" / "Employee" to keep the filename meaningful.
//
// Pure — no Intl, no I/O. Callable from edge routes and React Native alike.

export interface PayrollFilenameInput {
  /** The month the sheet belongs to — month part is extracted. */
  periodStart: string | Date;
  /** Store or employee name; slugified. */
  entityName: string | null | undefined;
  /** "register" for the whole store, "statement" for a single employee. */
  kind: "register" | "statement";
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function toDate(v: string | Date): Date {
  return v instanceof Date ? v : new Date(v);
}

/** Drop unsafe filename characters, collapse whitespace to a single dash, strip
 *  leading/trailing dashes. Keeps Unicode letters/digits so Arabic names
 *  survive, which is important for the mobile share sheet. */
export function slugifyForFilename(input: string): string {
  const stripped = input
    .replace(/[\\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return stripped;
}

export function payrollFilename(input: PayrollFilenameInput): string {
  const d = toDate(input.periodStart);
  const y = d.getUTCFullYear();
  const m = pad2(d.getUTCMonth() + 1);
  const raw = (input.entityName ?? "").trim();
  const slug = raw ? slugifyForFilename(raw) : "";
  const fallback = input.kind === "register" ? "Store" : "Employee";
  const safe = slug || fallback;
  return `Payroll-${y}-${m}-${safe}.pdf`;
}
