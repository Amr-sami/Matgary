/**
 * Doc 15 spec 13 §7 T6 — the daily digest gains the wallet bucket and the
 * per-account Transfers block (13 §4.13, acceptance 9).
 *
 * Pure part: the golden text captured from renderDigestMessage BEFORE the
 * render.ts edit (no wallet, no collections → byte-identical, ar and en), the
 * wallet segment, the includeCollections gate, the 5-row cap.
 * DB part (skipped unless DATABASE_URL names a `test` database): the block
 * equals 05's getCollectionsSummary for the same day (= the inbox Totals tab)
 * and the payments split for the same day (step 22 cross-check);
 * isDigestEmpty is false when only a pending transfer exists.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderDigestMessage } from "@/lib/digest/render";
import type { DigestCollections, DigestPayload } from "@/lib/repo/digest";

// Captured 2026-09-30 from the pre-change renderer (13 §5 step 18: "write the
// golden first"). Do not regenerate from the new code.
const GOLDEN_AR =
  "🏪 الفرع الرئيسي · يوم 2026-09-29\n\n💰 المبيعات: 12,500.50 ج.م (17 فاتورة)  ▲ 12 % مقارنة بنفس اليوم الأسبوع اللي فات\n   نقدًا 8,000 ج.م · فيزا 1,500.50 ج.م · إنستا 2,500 ج.م · آجل 500 ج.م\n\n🥇 الأعلى مبيعًا: Casio MTP (3×, 3,750 ج.م)\n\n⚠ مخزون منخفض: 2 منتجات\n   • Citizen AW (متبقي 1)\n   • Seiko 5 (متبقي 0)\n⚠ آجل متأخر: 2 فواتير 900 ج.م مستحقة منذ +7 أيام\n⚠ حضور: 1 شيفت محتاج مراجعة\n✅ مهام: لا توجد مهام جديدة بدون تأكيد\n\nافتح اللوحة → https://app.thestoro.com/";
// Intl puts a no-break space (U+00A0) between "EGP" and the amount.
const GOLDEN_EN =
  "🏪 الفرع الرئيسي · 2026-09-29\n\n💰 Sales: EGP\u00A012,500.50 (17 invoices)  ↑ 12 % vs same day last week\n   Cash EGP\u00A08,000 · Card EGP\u00A01,500.50 · InstaPay EGP\u00A02,500 · Deferred EGP\u00A0500\n\n🥇 Top seller: Casio MTP (3×, EGP\u00A03,750)\n\n⚠ Low stock: 2 SKUs\n   • Citizen AW (1 left)\n   • Seiko 5 (0 left)\n⚠ Overdue deferred: 2 invoices, EGP\u00A0900 past 7 days\n⚠ Attendance: 1 shift needs review\n✅ Tasks: no unacknowledged tasks\n\nOpen dashboard → https://app.thestoro.com/";

/** The en currency format: "EGP" + U+00A0 + amount. */
const nb = (x: string) => x.replace(/EGP /g, "EGP\u00A0");

const URL = "https://app.thestoro.com/";

function fixture(over: Partial<DigestPayload> = {}, wallet = "0"): DigestPayload {
  return {
    branchId: "b",
    branchName: "الفرع الرئيسي",
    businessDate: "2026-09-29",
    sales: {
      gross: "12500.50",
      count: 17,
      deltaPctVsSameWeekday: 12,
      byMethod: { cash: "8000", card: "1500.5", instapay: "2500", wallet, deferred: "500" },
    },
    topSku: { name: "Casio MTP", qty: 3, revenue: "3750" },
    lowStock: { totalCount: 2, top: [{ name: "Citizen AW", quantityLeft: 1 }, { name: "Seiko 5", quantityLeft: 0 }] },
    deferredOverdue: { count: 2, totalOutstanding: "900" },
    attendanceReviewCount: 1,
    unreadTaskCount: 0,
    collections: null,
    ...over,
  };
}

function account(label: string, i: number): DigestCollections["accounts"][number] {
  return {
    label,
    mask: `***${String(1000 + i)}`,
    confirmed: { count: i, amount: String(i * 100) },
    pending: { count: 1, amount: "50" },
    rejected: { count: 0, amount: "0" },
    unmatchedCredits: { count: 0, amount: "0" },
  };
}

describe("renderDigestMessage — golden and wallet (13 §4.13, T6)", () => {
  it("no wallet + collections null → byte-identical to the pre-change text (ar, en)", () => {
    expect(renderDigestMessage(fixture(), { locale: "ar", dashboardUrl: URL })).toBe(GOLDEN_AR);
    expect(renderDigestMessage(fixture(), { locale: "en", dashboardUrl: URL })).toBe(GOLDEN_EN);
    // includeCollections with a null block changes nothing either.
    expect(renderDigestMessage(fixture(), { locale: "ar", dashboardUrl: URL, includeCollections: true })).toBe(GOLDEN_AR);
  });

  it("wallet > 0 → one segment, before deferred", () => {
    const ar = renderDigestMessage(fixture({}, "750"), { locale: "ar", dashboardUrl: URL });
    const en = renderDigestMessage(fixture({}, "750"), { locale: "en", dashboardUrl: URL });
    expect(ar).toContain("إنستا 2,500 ج.م · محفظة موبايل 750 ج.م · آجل 500 ج.م");
    expect(en).toContain(nb("InstaPay EGP 2,500 · Mobile wallet EGP 750 · Deferred EGP 500"));
    // Everything else unchanged.
    expect(ar.replace(" · محفظة موبايل 750 ج.م", "")).toBe(GOLDEN_AR);
    expect(en.replace(nb(" · Mobile wallet EGP 750"), "")).toBe(GOLDEN_EN);
  });

  const block: DigestCollections = {
    accounts: [account("CIB business", 1), { ...account("VF", 2), mask: null }, { ...account("x", 3), label: null, mask: null }],
    cashRemainder: "50",
    pendingAll: { count: 4, amount: "1234.5" },
  };

  it("includeCollections false (default) → no block, even when the payload carries one", () => {
    const p = fixture({ collections: block });
    expect(renderDigestMessage(p, { locale: "ar", dashboardUrl: URL })).toBe(GOLDEN_AR);
    expect(renderDigestMessage(p, { locale: "en", dashboardUrl: URL, includeCollections: false })).toBe(GOLDEN_EN);
  });

  it("includeCollections true → the Transfers block after the sales lines (ar, en)", () => {
    const ar = renderDigestMessage(fixture({ collections: block }), { locale: "ar", dashboardUrl: URL, includeCollections: true });
    expect(ar).toContain(
      [
        "   نقدًا 8,000 ج.م · فيزا 1,500.50 ج.م · إنستا 2,500 ج.م · آجل 500 ج.م",
        "",
        "📲 التحويلات:",
        "   • CIB business ***1001: ✅ 1 · 100 ج.م | ⏳ 1 · 50 ج.م | ❌ 0 · 0 ج.م",
        "   • VF: ✅ 2 · 200 ج.م | ⏳ 1 · 50 ج.م | ❌ 0 · 0 ج.م",
        "   • بدون حساب: ✅ 3 · 300 ج.م | ⏳ 1 · 50 ج.م | ❌ 0 · 0 ج.م",
        "   💵 المتبقي نقدًا: 50 ج.م",
        "⏳ ما زال في انتظار التأكيد: 4 (1,234.50 ج.م)",
        "",
        "🥇 الأعلى مبيعًا",
      ].join("\n"),
    );
    const en = renderDigestMessage(fixture({ collections: block }), { locale: "en", dashboardUrl: URL, includeCollections: true });
    expect(en).toContain(nb("📲 Transfers:\n   • CIB business ***1001: ✅ 1 · EGP 100 | ⏳ 1 · EGP 50 | ❌ 0 · EGP 0"));
    expect(en).toContain("   • No account: ✅ 3");
    expect(en).toContain(nb("   💵 Cash remainder: EGP 50\n⏳ Still awaiting confirmation: 4 (EGP 1,234.50)"));
  });

  it("7 accounts → 5 rows + '+2'; a zero cash remainder and no pending print nothing", () => {
    const seven: DigestCollections = {
      accounts: Array.from({ length: 7 }, (_, i) => account(`A${i + 1}`, i + 1)),
      cashRemainder: "0",
      pendingAll: { count: 0, amount: "0" },
    };
    const en = renderDigestMessage(fixture({ collections: seven }), { locale: "en", dashboardUrl: URL, includeCollections: true });
    expect(en.match(/^ {3}• A\d/gm)).toHaveLength(5);
    expect(en).toContain("   • A5 ***1005");
    expect(en).not.toContain("A6");
    expect(en).toContain("   +2 more");
    expect(en).not.toContain("Cash remainder");
    expect(en).not.toContain("Still awaiting");
    const ar = renderDigestMessage(fixture({ collections: seven }), { locale: "ar", dashboardUrl: URL, includeCollections: true });
    expect(ar).toContain("\n   +2\n");
  });

  it("never prints a payer field or a full account number (Q18)", () => {
    const ar = renderDigestMessage(fixture({ collections: block }), { locale: "ar", dashboardUrl: URL, includeCollections: true });
    expect(ar).not.toMatch(/\d{7,}/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const hasTestDb = /test/i.test(process.env.DATABASE_URL ?? "");
const saved = process.env.COLLECTIONS_ENABLED;

describe.skipIf(!hasTestDb)("computeDigest collections block = the inbox Totals (DB, acceptance 9, step 22)", () => {
  let fx: import("./helpers/collections-report-fixture").ReportFixture;
  let today = "";

  beforeAll(async () => {
    process.env.COLLECTIONS_ENABLED = "on";
    const { seedReportFixture, tenantToday } = await import("./helpers/collections-report-fixture");
    fx = await seedReportFixture("t6");
    today = await tenantToday(fx.tenantId);
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.COLLECTIONS_ENABLED;
    else process.env.COLLECTIONS_ENABLED = saved;
  });

  it("wallet bucket, and the block equals getCollectionsSummary for the same day", async () => {
    const { computeDigest } = await import("@/lib/repo/digest");
    const { getCollectionsSummary } = await import("@/lib/repo/collections");
    const d = await computeDigest(fx.tenantId, fx.branchId, today);
    expect(Number(d.sales.byMethod.wallet)).toBe(200);
    const s = await getCollectionsSummary(fx.tenantId, { date: today, branchId: fx.branchId });

    const byLabel = new Map(d.collections!.accounts.map((a) => [a.label, a] as const));
    for (const row of s.accounts) {
      const a = byLabel.get(row.label)!;
      expect(a.confirmed).toEqual({
        count: row.confirmed.count + row.autoConfirmed.count,
        amount: String(row.confirmed.amount + row.autoConfirmed.amount),
      });
      expect(a.pending).toEqual({ count: row.pending.count, amount: String(row.pending.amount) });
      expect(a.rejected).toEqual({
        count: row.rejectedDebt.count + row.rejectedLoss.count,
        amount: String(row.rejectedDebt.amount + row.rejectedLoss.amount),
      });
    }
    expect(d.collections!.accounts).toHaveLength(s.accounts.length);
    expect(d.collections!.cashRemainder).toBe(String(s.totals.cashRemainder));
    // The fixture's exact numbers (CIB ***4821, VF).
    expect(byLabel.get("CIB business")).toMatchObject({
      mask: "***4821",
      confirmed: { count: 1, amount: "300" },
      pending: { count: 0, amount: "0" },
      rejected: { count: 2, amount: "140" },
    });
    expect(byLabel.get("VF counter")).toMatchObject({ pending: { count: 1, amount: "150" }, rejected: { count: 0, amount: "0" } });
    expect(d.collections!.cashRemainder).toBe("50");
    expect(d.collections!.pendingAll).toEqual({ count: 1, amount: "150" });
  });

  it("the digest, the summary and the payments split agree for the day (13 §5 step 22)", async () => {
    const { computeDigest } = await import("@/lib/repo/digest");
    const { getCollectionsSummary } = await import("@/lib/repo/collections");
    const { loadPaymentMixReport } = await import("@/lib/repo/insights-deep");
    const d = await computeDigest(fx.tenantId, fx.branchId, today);
    const s = await getCollectionsSummary(fx.tenantId, { date: today, branchId: fx.branchId });
    const p = await loadPaymentMixReport(fx.tenantId, { from: new Date(Date.now() - 36 * 3_600_000), to: new Date(Date.now() + 60_000) }, fx.branchId);
    const split = p.collections!;
    const sum = (k: "confirmed" | "autoConfirmed" | "pending" | "rejectedDebt" | "rejectedLoss") =>
      split.byMethod.instapay[k] + split.byMethod.wallet[k];
    expect(s.totals.confirmed.amount + s.totals.autoConfirmed.amount).toBe(sum("confirmed") + sum("autoConfirmed"));
    expect(s.totals.pending.amount).toBe(sum("pending"));
    expect(s.totals.rejectedDebt.amount).toBe(sum("rejectedDebt"));
    expect(s.totals.rejectedLoss.amount).toBe(sum("rejectedLoss"));
    expect(s.totals.cashRemainder).toBe(split.cashRemainder);
    const digestConfirmed = d.collections!.accounts.reduce((x, a) => x + Number(a.confirmed.amount), 0);
    expect(digestConfirmed).toBe(sum("confirmed") + sum("autoConfirmed"));
    const digestRejected = d.collections!.accounts.reduce((x, a) => x + Number(a.rejected.amount), 0);
    expect(digestRejected).toBe(sum("rejectedDebt") + sum("rejectedLoss"));
  });

  it("isDigestEmpty is false when only a pending transfer exists; true with the block empty", async () => {
    const { isDigestEmpty } = await import("@/lib/repo/digest");
    const empty = fixture({
      sales: { gross: "0", count: 0, deltaPctVsSameWeekday: null, byMethod: { cash: "0", card: "0", instapay: "0", wallet: "0", deferred: "0" } },
      topSku: null,
      lowStock: { totalCount: 0, top: [] },
      deferredOverdue: { count: 0, totalOutstanding: "0" },
      attendanceReviewCount: 0,
      unreadTaskCount: 0,
    });
    expect(isDigestEmpty(empty)).toBe(true);
    expect(isDigestEmpty({ ...empty, collections: { accounts: [], cashRemainder: "0", pendingAll: { count: 0, amount: "0" } } })).toBe(true);
    expect(isDigestEmpty({ ...empty, collections: { accounts: [], cashRemainder: "0", pendingAll: { count: 1, amount: "50" } } })).toBe(false);
  });

  it("feature off (env) → collections: null", async () => {
    const { computeDigest } = await import("@/lib/repo/digest");
    process.env.COLLECTIONS_ENABLED = "off";
    const d = await computeDigest(fx.tenantId, fx.branchId, today);
    process.env.COLLECTIONS_ENABLED = "on";
    expect(d.collections).toBeNull();
  });
});
