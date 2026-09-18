/**
 * Port of `formatActivityDetails` in apps/web/lib/activity-labels.ts — the
 * per-action switch that turns an activity row's metadata blob into a short
 * list of "label: value" pairs the owner can actually read: sale lines are
 * flattened to "name (qty × price)", enum values (payment method, pay type,
 * attendance source, expense category) are translated, and `changed` arrays
 * become a list of human field names.
 *
 * Labels come from the SAME dictionary the web reads, `app.activityLabels.*`
 * (fields / fieldNames / paymentMethods / payTypes / attendanceTypes /
 * attendanceSources / expenseCategories / accuracySuffix), so the two clients
 * can never drift on wording.
 *
 * `t` is injected rather than imported: this file imports nothing, so plain
 * Node can unit-test it —
 *   node --test --experimental-strip-types apps/mobile/src/lib/__tests__/activity-details.test.ts
 * — and the screen passes the real `t` from "@/i18n" at render time (never at
 * module scope, so a live locale switch re-labels on the next render).
 *
 * No Intl anywhere (Hermes ships a trimmed ICU): numbers are grouped with a
 * regex and dates are dd/mm/yyyy, the same shapes as "@/lib/format". Money
 * fields (total, price, amount, salary) take the app's currency shape through
 * the same `mobile.format.money` key `money()` reads — "3,400 ج.م" here must
 * look like "3,400 ج.م" on the notification for the same sale. The per-line
 * "qty × price" carries the currency too — "Casio (1 × 3,400 ج.م)" — so the
 * bare quantity and the money amount can never be read as two prices; only
 * quantities stay bare.
 */

export interface ActivityDetail {
  label: string;
  value: string;
}

/** Shape of `t` from "@/i18n": dictionary lookup that echoes the path when missing. */
export type Translate = (path: string, vars?: Record<string, string | number>) => string;

const NS = "app.activityLabels";

/** Optional lookup: `undefined` when the dictionary has no entry (t echoes the path). */
function tOpt(t: Translate, path: string): string | undefined {
  const v = t(path);
  return v === path ? undefined : v;
}

/** Translate an enum value from one of the `app.activityLabels.<group>` maps; raw value when unknown. */
function enumLabel(t: Translate, group: string, raw: unknown): string {
  const key = String(raw);
  return tOpt(t, `${NS}.${group}.${key}`) ?? key;
}

/**
 * Same output as the web's `toLocaleString("en-US", { maximumFractionDigits: 6 })`
 * without Intl: Latin digits, thousands commas, up to 6 fraction digits.
 */
export function formatNumber(v: unknown): string {
  if (typeof v !== "number" || !Number.isFinite(v)) return String(v);
  const rounded = Math.round(v * 1e6) / 1e6;
  const [int, frac] = Math.abs(rounded).toString().split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = rounded < 0 ? "-" : "";
  return frac ? `${sign}${grouped}.${frac}` : `${sign}${grouped}`;
}

/** The key `money()` in "@/lib/format" reads: "{amount} ج.م" in Arabic, "EGP {amount}" in English. */
const MONEY_KEY = "mobile.format.money";

/**
 * A money amount in the app's currency shape — "3,400 ج.م" / "EGP 3,400", the
 * same `mobile.format.money` string every other screen prints — resolved
 * through the injected `t` so this file stays import-free. Unlike `money()`
 * the fraction is kept (a 1,264.5 sale total must not round to 1,265). Falls
 * back to the bare grouped number when the dictionary lacks the key.
 */
function formatMoney(t: Translate, v: unknown): string {
  const amount = formatNumber(v);
  if (typeof v !== "number" || !Number.isFinite(v)) return amount;
  const shaped = t(MONEY_KEY, { amount });
  return shaped === MONEY_KEY ? amount : shaped;
}

/** ISO / date-only string → "18/09/2026" (mirrors shortDate in "@/lib/format"); the input when unparsable. */
function formatDateValue(v: unknown): string {
  if (typeof v !== "string") return String(v);
  const d = new Date(v);
  if (!Number.isFinite(d.valueOf())) return v;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

/** `changed: ["shopName", "phone"]` → "اسم المتجر • الهاتف" — fieldNames first, then fields, then the raw key. */
function listOfChangedFields(t: Translate, keys: unknown): string {
  if (!Array.isArray(keys)) return String(keys);
  return keys
    .map((k) => {
      const key = String(k);
      return tOpt(t, `${NS}.fieldNames.${key}`) ?? tOpt(t, `${NS}.fields.${key}`) ?? key;
    })
    .join(" • ");
}

interface SaleLine {
  productName?: unknown;
  quantity?: unknown;
  pricePerUnit?: unknown;
  lineTotal?: unknown;
}

/** `lines: [{productName, quantity, pricePerUnit}]` → "Pepsi (2 × 15 ج.م), Chips (1)" (locale separator). */
function summariseSaleLines(lines: SaleLine[], t: Translate): string {
  return lines
    .map((l) => {
      const name = l.productName ? String(l.productName) : "—";
      const qty = typeof l.quantity === "number" ? l.quantity : null;
      const price = typeof l.pricePerUnit === "number" ? l.pricePerUnit : null;
      if (qty != null && price != null) return `${name} (${formatNumber(qty)} × ${formatMoney(t, price)})`;
      if (qty != null) return `${name} (${formatNumber(qty)})`;
      return name;
    })
    .join(t(`${NS}.listSeparator`));
}

/**
 * Translate the metadata blob attached to an activity row into a small list
 * of "label: value" pairs. Returns an empty array when there is nothing
 * meaningful to show. Unknown actions fall back to exposing only the keys the
 * dictionary knows how to label — internal ids never leak into the row.
 *
 * `entityLabel` is the row's own label (the API sets it to the invoice id for
 * sales), which the screen already prints as the title's grey "— INV-…"
 * suffix. Pass it so the first detail line does not repeat the same id.
 */
export function formatActivityDetails(
  action: string,
  metadata: Record<string, unknown> | null | undefined,
  t: Translate,
  opts?: { entityLabel?: string | null },
): ActivityDetail[] {
  if (!metadata) return [];
  const out: ActivityDetail[] = [];
  const m = metadata;
  const f = (key: string) => t(`${NS}.fields.${key}`);
  const entityLabel = opts?.entityLabel ?? null;

  switch (action) {
    case "sale.create": {
      if (m.invoiceId && String(m.invoiceId) !== entityLabel)
        out.push({ label: f("invoiceId"), value: String(m.invoiceId) });
      if (Array.isArray(m.lines) && m.lines.length > 0)
        out.push({ label: f("lines"), value: summariseSaleLines(m.lines as SaleLine[], t) });
      if (typeof m.totalQuantity === "number")
        out.push({ label: f("totalQuantity"), value: formatNumber(m.totalQuantity) });
      if (typeof m.total === "number") out.push({ label: f("total"), value: formatMoney(t, m.total) });
      if (typeof m.quantitySold === "number")
        out.push({ label: f("quantitySold"), value: formatNumber(m.quantitySold) });
      if (typeof m.pricePerUnit === "number")
        out.push({ label: f("pricePerUnit"), value: formatMoney(t, m.pricePerUnit) });
      if (m.paymentMethod)
        out.push({ label: f("paymentMethod"), value: enumLabel(t, "paymentMethods", m.paymentMethod) });
      if (m.customerName) out.push({ label: f("customerName"), value: String(m.customerName) });
      if (m.customerPhone) out.push({ label: f("customerPhone"), value: String(m.customerPhone) });
      if (m.note) out.push({ label: f("note"), value: String(m.note) });
      return out;
    }
    case "attendance.check_in":
    case "attendance.check_out": {
      if (m.source) out.push({ label: f("source"), value: enumLabel(t, "attendanceSources", m.source) });
      return out;
    }
    case "attendance.geofence_rejected": {
      if (m.type) out.push({ label: f("attemptType"), value: enumLabel(t, "attendanceTypes", m.type) });
      if (typeof m.latitude === "number" && typeof m.longitude === "number")
        out.push({
          label: f("loggedLocation"),
          value: `${m.latitude.toFixed(6)}, ${m.longitude.toFixed(6)}`,
        });
      if (typeof m.accuracyM === "number")
        out.push({
          label: f("locationAccuracy"),
          value: t(`${NS}.accuracySuffix`, { n: formatNumber(m.accuracyM) }),
        });
      return out;
    }
    case "team.add": {
      if (m.username) out.push({ label: f("username"), value: String(m.username) });
      if (Array.isArray(m.permissions))
        out.push({ label: f("permissionsCount"), value: formatNumber(m.permissions.length) });
      return out;
    }
    case "team.update":
    case "product.update":
    case "settings.update":
    case "settings.attendance_update": {
      if (Array.isArray(m.changed) && m.changed.length > 0)
        out.push({ label: f("changed"), value: listOfChangedFields(t, m.changed) });
      return out;
    }
    case "team.compensation_set": {
      if (m.payType) out.push({ label: f("payType"), value: enumLabel(t, "payTypes", m.payType) });
      if (m.baseSalaryMonthly != null)
        out.push({ label: f("baseSalaryMonthly"), value: formatMoney(t, m.baseSalaryMonthly) });
      if (m.hourlyRate != null) out.push({ label: f("hourlyRate"), value: formatMoney(t, m.hourlyRate) });
      return out;
    }
    case "product.create": {
      if (typeof m.quantity === "number")
        out.push({ label: f("initialQuantity"), value: formatNumber(m.quantity) });
      if (typeof m.price === "number") out.push({ label: f("price"), value: formatMoney(t, m.price) });
      return out;
    }
    case "product.adjust": {
      if (typeof m.delta === "number") {
        const sign = m.delta > 0 ? "+" : "";
        out.push({ label: f("delta"), value: `${sign}${formatNumber(m.delta)}` });
      }
      if (typeof m.newQuantity === "number")
        out.push({ label: f("newQuantity"), value: formatNumber(m.newQuantity) });
      return out;
    }
    case "expense.create": {
      if (typeof m.amount === "number") out.push({ label: f("amount"), value: formatMoney(t, m.amount) });
      if (m.category) out.push({ label: f("type"), value: enumLabel(t, "expenseCategories", m.category) });
      return out;
    }
    case "leave.submit": {
      if (m.startDate) out.push({ label: f("startDate"), value: formatDateValue(m.startDate) });
      if (m.endDate) out.push({ label: f("endDate"), value: formatDateValue(m.endDate) });
      return out;
    }
    case "leave.approve":
    case "leave.reject": {
      if (m.note) out.push({ label: f("note"), value: String(m.note) });
      return out;
    }
    default: {
      // Generic best-effort: expose only the keys the dictionary can label.
      for (const [k, v] of Object.entries(m)) {
        if (v == null || v === "") continue;
        const label = tOpt(t, `${NS}.fields.${k}`) ?? tOpt(t, `${NS}.fieldNames.${k}`);
        if (!label) continue;
        out.push({ label, value: typeof v === "object" ? JSON.stringify(v) : String(v) });
      }
      return out;
    }
  }
}
