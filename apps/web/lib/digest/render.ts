// Pure renderer: DigestPayload → WhatsApp-friendly text.
// Locale-aware; uses the project's existing number/currency formatters.

import { formatCurrency, formatNumber } from "@/lib/i18n/format";
import type { Locale } from "@/lib/i18n/config";
import type { DigestPayload } from "@/lib/repo/digest";

export interface RenderOpts {
  locale: Locale;
  dashboardUrl: string;
  /** Doc 15 spec 13 §4.13 / D13-7: print the per-account Transfers block
   *  (owners, the digest owner_phone, managers holding view_collections;
   *  never extra recipients). Default false. */
  includeCollections?: boolean;
}

/** At most this many account rows in the Transfers block, then "+N". */
const MAX_COLLECTION_ROWS = 5;

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
    // The wallet segment prints only when > 0 (13 §4.13), so a shop with no
    // wallet sales gets byte-identical text.
    byMethod: (cash: string, card: string, instapay: string, deferred: string, wallet: string | null) =>
      `   نقدًا ${cash} · فيزا ${card} · إنستا ${instapay}${wallet ? ` · محفظة موبايل ${wallet}` : ""} · آجل ${deferred}`,
    top: (name: string, qty: string, revenue: string) =>
      `🥇 الأعلى مبيعًا: ${name} (${qty}×, ${revenue})`,
    lowStockHead: (count: string) => `⚠ مخزون منخفض: ${count} منتجات`,
    lowStockLine: (name: string, qty: string) => `   • ${name} (متبقي ${qty})`,
    deferred: (count: string, amount: string) =>
      `⚠ آجل متأخر: ${count} فواتير ${amount} مستحقة منذ +7 أيام`,
    attendance: (count: string) => `⚠ حضور: ${count} شيفت محتاج مراجعة`,
    tasksOk: "✅ مهام: لا توجد مهام جديدة بدون تأكيد",
    tasksPending: (count: string) =>
      `⚠ ${count} مهام موكلة بدون قراءة من الموظف`,
    openDashboard: "افتح اللوحة",
    collectionsHead: "📲 التحويلات:",
    collectionsRow: (label: string, c: string, p: string, r: string) => `   • ${label}: ✅ ${c} | ⏳ ${p} | ❌ ${r}`,
    collectionsMore: (k: string) => `   +${k}`,
    collectionsNoAccount: "بدون حساب",
    collectionsCash: (amt: string) => `   💵 المتبقي نقدًا: ${amt}`,
    collectionsPendingAll: (k: string, amt: string) => `⏳ ما زال في انتظار التأكيد: ${k} (${amt})`,
  },
  en: {
    branchHeader: (b: string, d: string) => `🏪 ${b} · ${d}`,
    salesLine: (gross: string, count: number) =>
      `💰 Sales: ${gross} (${count} invoices)`,
    deltaSame: "vs same day last week",
    deltaUnknown: "—",
    byMethod: (cash: string, card: string, instapay: string, deferred: string, wallet: string | null) =>
      `   Cash ${cash} · Card ${card} · InstaPay ${instapay}${wallet ? ` · Mobile wallet ${wallet}` : ""} · Deferred ${deferred}`,
    top: (name: string, qty: string, revenue: string) =>
      `🥇 Top seller: ${name} (${qty}×, ${revenue})`,
    lowStockHead: (count: string) => `⚠ Low stock: ${count} SKUs`,
    lowStockLine: (name: string, qty: string) => `   • ${name} (${qty} left)`,
    deferred: (count: string, amount: string) =>
      `⚠ Overdue deferred: ${count} invoices, ${amount} past 7 days`,
    attendance: (count: string) => `⚠ Attendance: ${count} shift needs review`,
    tasksOk: "✅ Tasks: no unacknowledged tasks",
    tasksPending: (count: string) => `⚠ ${count} tasks assigned but not yet seen`,
    openDashboard: "Open dashboard",
    collectionsHead: "📲 Transfers:",
    collectionsRow: (label: string, c: string, p: string, r: string) => `   • ${label}: ✅ ${c} | ⏳ ${p} | ❌ ${r}`,
    collectionsMore: (k: string) => `   +${k} more`,
    collectionsNoAccount: "No account",
    collectionsCash: (amt: string) => `   💵 Cash remainder: ${amt}`,
    collectionsPendingAll: (k: string, amt: string) => `⏳ Still awaiting confirmation: ${k} (${amt})`,
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
      Number(payload.sales.byMethod.wallet ?? 0) > 0
        ? money(payload.sales.byMethod.wallet, opts.locale)
        : null,
    ),
  );

  const col = opts.includeCollections ? payload.collections : null;
  if (col) {
    const lines: string[] = [];
    const bucket = (b: { count: number; amount: string }) => `${n(b.count, opts.locale)} · ${money(b.amount, opts.locale)}`;
    for (const a of col.accounts.slice(0, MAX_COLLECTION_ROWS)) {
      const label = [a.label ?? t.collectionsNoAccount, a.mask].filter(Boolean).join(" ");
      lines.push(t.collectionsRow(label, bucket(a.confirmed), bucket(a.pending), bucket(a.rejected)));
    }
    if (col.accounts.length > MAX_COLLECTION_ROWS) {
      lines.push(t.collectionsMore(n(col.accounts.length - MAX_COLLECTION_ROWS, opts.locale)));
    }
    if (Number(col.cashRemainder) > 0) lines.push(t.collectionsCash(money(col.cashRemainder, opts.locale)));
    if (col.pendingAll.count > 0) {
      lines.push(t.collectionsPendingAll(n(col.pendingAll.count, opts.locale), money(col.pendingAll.amount, opts.locale)));
    }
    if (lines.length > 0) {
      out.push("");
      out.push(t.collectionsHead);
      out.push(...lines);
    }
  }

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
