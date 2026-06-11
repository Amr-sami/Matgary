// Pure renderer: DigestPayload → WhatsApp-friendly text.
// Locale-aware; uses the project's existing number/currency formatters.

import { formatCurrency, formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/config";
import type { DigestPayload } from "@/lib/repo/digest";

export interface RenderOpts {
  locale: Locale;
  dashboardUrl: string;
}

const CURRENCY_SYMBOL = "₤"; // EGP symbol used by the rest of the app

function pct(n: number, locale: Locale): string {
  const sign = n > 0 ? (locale === "ar" ? "▲" : "↑") : n < 0 ? (locale === "ar" ? "▼" : "↓") : "·";
  return `${sign} ${formatNumber(Math.abs(n), locale)} %`;
}

function money(s: string, locale: Locale): string {
  return formatCurrency(Number(s), locale);
}

function n(num: number, locale: Locale): string {
  return formatNumber(num, locale);
}

const T = {
  ar: {
    branchHeader: (b: string, d: string) => `🏪 ${b} · يوم ${d}`,
    salesLine: (gross: string, count: number) =>
      `💰 المبيعات: ${gross} (${count} فاتورة)`,
    deltaSame: "مقارنة بنفس اليوم الأسبوع اللي فات",
    deltaUnknown: "—",
    byMethod: (cash: string, card: string, instapay: string, deferred: string) =>
      `   نقدًا ${cash} · فيزا ${card} · إنستا ${instapay} · آجل ${deferred}`,
    top: (name: string, qty: string, revenue: string) =>
      `🥇 الأعلى مبيعًا: ${name} (${qty}×, ${revenue})`,
    lowStockHead: (count: string) => `⚠ مخزون منخفض: ${count} منتجات`,
    lowStockLine: (name: string, qty: string) => `   • ${name} (متبقي ${qty})`,
    deferred: (count: string, amount: string) =>
      `⚠ آجل متأخر: ${count} فواتير ${amount} مستحقة منذ +7 أيام`,
    attendance: (count: string) => `⚠ حضور: ${count} شيفت محتاج مراجعة`,
    cashShort: (cashier: string, amount: string) =>
      `⚠ خزينة: عجز ${amount} في شيفت ${cashier}`,
    cashOpen: (cashier: string) => `⚠ شيفت خزينة لم يُقفل: ${cashier}`,
    cashAllOk: "✅ كل الشيفتات مقفولة بدون فروقات",
    tasksOk: "✅ مهام: لا توجد مهام جديدة بدون تأكيد",
    tasksPending: (count: string) =>
      `⚠ ${count} مهام موكلة بدون قراءة من الموظف`,
    openDashboard: "افتح اللوحة",
  },
  en: {
    branchHeader: (b: string, d: string) => `🏪 ${b} · ${d}`,
    salesLine: (gross: string, count: number) =>
      `💰 Sales: ${gross} (${count} invoices)`,
    deltaSame: "vs same day last week",
    deltaUnknown: "—",
    byMethod: (cash: string, card: string, instapay: string, deferred: string) =>
      `   Cash ${cash} · Card ${card} · InstaPay ${instapay} · Deferred ${deferred}`,
    top: (name: string, qty: string, revenue: string) =>
      `🥇 Top seller: ${name} (${qty}×, ${revenue})`,
    lowStockHead: (count: string) => `⚠ Low stock: ${count} SKUs`,
    lowStockLine: (name: string, qty: string) => `   • ${name} (${qty} left)`,
    deferred: (count: string, amount: string) =>
      `⚠ Overdue deferred: ${count} invoices, ${amount} past 7 days`,
    attendance: (count: string) => `⚠ Attendance: ${count} shift needs review`,
    cashShort: (cashier: string, amount: string) =>
      `⚠ Cash: ${amount} short in ${cashier}'s shift`,
    cashOpen: (cashier: string) => `⚠ Cash shift still open: ${cashier}`,
    cashAllOk: "✅ All shifts closed with no variance",
    tasksOk: "✅ Tasks: no unacknowledged tasks",
    tasksPending: (count: string) => `⚠ ${count} tasks assigned but not yet seen`,
    openDashboard: "Open dashboard",
  },
} as const;

export function renderDigestMessage(
  payload: DigestPayload,
  opts: RenderOpts,
): string {
  const t = T[opts.locale];
  const out: string[] = [];

  out.push(t.branchHeader(payload.branchName, payload.businessDate));
  out.push("");
  let salesLine = t.salesLine(money(payload.sales.gross, opts.locale), payload.sales.count);
  if (payload.sales.deltaPctVsSameWeekday != null) {
    salesLine += `  ${pct(payload.sales.deltaPctVsSameWeekday, opts.locale)} ${t.deltaSame}`;
  }
  out.push(salesLine);
  out.push(
    t.byMethod(
      money(payload.sales.byMethod.cash, opts.locale),
      money(payload.sales.byMethod.card, opts.locale),
      money(payload.sales.byMethod.instapay, opts.locale),
      money(payload.sales.byMethod.deferred, opts.locale),
    ),
  );

  if (payload.topSku) {
    out.push("");
    out.push(
      t.top(
        payload.topSku.name,
        n(payload.topSku.qty, opts.locale),
        money(payload.topSku.revenue, opts.locale),
      ),
    );
  }

  const warnings: string[] = [];
  if (payload.lowStock.totalCount > 0) {
    warnings.push(t.lowStockHead(n(payload.lowStock.totalCount, opts.locale)));
    for (const item of payload.lowStock.top) {
      warnings.push(
        t.lowStockLine(item.name, n(item.quantityLeft, opts.locale)),
      );
    }
  }
  if (payload.deferredOverdue.count > 0) {
    warnings.push(
      t.deferred(
        n(payload.deferredOverdue.count, opts.locale),
        money(payload.deferredOverdue.totalOutstanding, opts.locale),
      ),
    );
  }
  if (payload.attendanceReviewCount > 0) {
    warnings.push(t.attendance(n(payload.attendanceReviewCount, opts.locale)));
  }

  for (const s of payload.cash.shortShifts) {
    warnings.push(t.cashShort(s.cashier, money(s.shortBy, opts.locale)));
  }
  for (const s of payload.cash.openShifts) {
    warnings.push(t.cashOpen(s.cashier));
  }
  if (
    payload.cash.shortShifts.length === 0 &&
    payload.cash.openShifts.length === 0 &&
    payload.cash.closedShifts > 0
  ) {
    warnings.push(t.cashAllOk);
  }

  if (payload.unreadTaskCount > 0) {
    warnings.push(t.tasksPending(n(payload.unreadTaskCount, opts.locale)));
  } else {
    warnings.push(t.tasksOk);
  }

  if (warnings.length > 0) {
    out.push("");
    out.push(...warnings);
  }

  out.push("");
  out.push(`${t.openDashboard} → ${opts.dashboardUrl}`);

  return out.join("\n");
}

// re-export for convenience
export { CURRENCY_SYMBOL };
