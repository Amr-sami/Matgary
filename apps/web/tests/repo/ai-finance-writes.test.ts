// Real-Postgres integration tests for the AI Agent's new Financials /
// Receipt write path.
//
// Scope: end-to-end lifecycle for each new action — createPending → consume
// → executeAction → DB side-effect + audit + (where applicable) P&L impact.
// Also covers the token-security contract (expired, tampered, wrong tenant,
// wrong action, reuse), tenant isolation across tenants A/B, and the
// permission-revocation gate the confirm route performs after consume.
//
// No mocks. All mutations hit real Postgres via the project's withTenant()
// transactional setup. Tenants are torn down via CASCADE in afterAll.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";

import { db, withTenant } from "@/lib/db";
import {
  aiPendingActions,
  branches,
  expenses as expensesTable,
  financialCategories,
  moneyMovements,
  shopSettings,
  tenants,
  tenantMembers,
  users,
} from "@/lib/db/schema";
import { consumePending, createPending, signPending } from "@/lib/ai/write/pending";
import { executeAction } from "@/lib/ai/write/execute";
import { computePnLFromSource, fetchPnLSource } from "@/lib/finance/pnl";
import { resolvePreset, DEFAULT_REPORTING_TZ } from "@/lib/finance/dates";
import { getShopSettings } from "@/lib/repo/settings";

// Seeded system category ids from migration 0064 — safe to reuse for the
// create-expense tests (they're tenant-visible because their tenant_id is
// NULL).
const CAT_RENT = "00000000-0000-4012-0000-000000000001";
const CAT_SALARIES = "00000000-0000-4011-0000-000000000001";
const CAT_PEOPLE_GROUP = "00000000-0000-4001-0000-000000000001";

let tenantA: { tenantId: string; userId: string; branchId: string };
let tenantB: { tenantId: string; userId: string; branchId: string };

async function freshTenant(suffix: string) {
  return db.transaction(async (tx) => {
    const email = `ai-fin-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@test.local`;
    const [u] = await tx
      .insert(users)
      .values({ email, name: `AI-fin ${suffix}`, passwordHash: "x" })
      .returning({ id: users.id });
    const slug = `ai-fin-${suffix}-${Math.random().toString(36).slice(2, 8)}`;
    const [t] = await tx
      .insert(tenants)
      .values({ name: `AI-fin ${suffix}`, slug })
      .returning({ id: tenants.id });
    await tx.execute(sql`select set_config('app.tenant_id', ${t.id}, true)`);
    const [b] = await tx
      .insert(branches)
      .values({ tenantId: t.id, slug: "main", name: "Main", isPrimary: true })
      .returning({ id: branches.id });
    await tx.insert(tenantMembers).values({
      tenantId: t.id,
      userId: u.id,
      role: "owner",
    });
    await tx.insert(shopSettings).values({
      tenantId: t.id,
      branchId: b.id,
      shopName: `AI-fin ${suffix}`,
    });
    return { tenantId: t.id, userId: u.id, branchId: b.id };
  });
}

async function cleanup(id: string) {
  await db.execute(sql`delete from tenants where id = ${id}`);
}

/** Helper: replay the confirm route's consume → permission → execute flow.
 *  The route performs a secondary permission check AFTER consume. These
 *  tests simulate that so a permission revocation between preview and
 *  confirm still blocks execution — mirroring /api/ai/confirm/route.ts. */
async function confirmAs(
  tenantId: string,
  userId: string,
  token: string,
  session: { role: "owner" | "staff"; permissions: string[] },
  ACTION_PERMISSION: Record<string, string>,
): Promise<{ ok: boolean; reason?: string; afterAction?: string }> {
  const consumed = await consumePending({ tenantId, userId, token });
  if (!consumed.ok) return { ok: false, reason: consumed.reason };
  const needed = ACTION_PERMISSION[consumed.row.action];
  if (needed && !session.permissions.includes(needed) && session.role !== "owner") {
    return { ok: false, reason: "FORBIDDEN_AT_CONFIRM", afterAction: consumed.row.action };
  }
  const res = await executeAction({ row: consumed.row });
  return { ok: res.ok, reason: res.ok ? undefined : (res.debug.reason ?? "UNKNOWN"), afterAction: consumed.row.action };
}

// Mirror of the real ACTION_PERMISSION map in /api/ai/confirm/route.ts.
const ACTION_PERMISSION: Record<string, string> = {
  create_expense: "manage_expenses",
  void_expense: "manage_expenses",
  create_money_movement: "manage_money_movements",
  void_money_movement: "manage_money_movements",
  create_finance_category: "manage_expense_categories",
  archive_finance_category: "manage_expense_categories",
  generate_recurring: "manage_recurring_expenses",
  update_receipt_settings: "view_settings",
};

async function thisMonthPnLSource(tenantId: string) {
  const period = resolvePreset("this_month", { tz: DEFAULT_REPORTING_TZ });
  return fetchPnLSource(tenantId, period);
}

async function thisMonthPnL(tenantId: string) {
  const src = await thisMonthPnLSource(tenantId);
  return computePnLFromSource(src);
}

beforeAll(async () => {
  tenantA = await freshTenant("a");
  tenantB = await freshTenant("b");
});

afterAll(async () => {
  if (tenantA?.tenantId) await cleanup(tenantA.tenantId);
  if (tenantB?.tenantId) await cleanup(tenantB.tenantId);
});

// ────────────────────────── create_expense ──────────────────────────────

describe("AI create_expense — lifecycle + P&L impact", () => {
  it("preview → confirm → row exists → P&L reflects it", async () => {
    const todayIsoDay = new Date().toISOString().slice(0, 10);
    const pending = await createPending({
      tenantId: tenantA.tenantId,
      userId: tenantA.userId,
      branchId: null,
      action: "create_expense",
      params: {
        title: "AI test rent",
        amount: 1500,
        date: todayIsoDay,
        categoryId: CAT_RENT,
        paymentMethod: "cash",
        referenceNumber: null,
        note: null,
        supplierId: null,
      },
      preview: { locale: "en" },
    });
    const pnlBefore = await thisMonthPnL(tenantA.tenantId);
    const opexBefore = pnlBefore.operatingExpenses;

    const result = await confirmAs(
      tenantA.tenantId,
      tenantA.userId,
      pending.token,
      { role: "owner", permissions: [] },
      ACTION_PERMISSION,
    );
    expect(result.ok).toBe(true);

    // Row exists, belongs to tenant A, status posted.
    const rows = await withTenant(tenantA.tenantId, (tx) =>
      tx
        .select()
        .from(expensesTable)
        .where(and(eq(expensesTable.tenantId, tenantA.tenantId), eq(expensesTable.title, "AI test rent"))),
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("posted");
    expect(Number(rows[0]!.amount)).toBe(1500);

    // P&L rose by exactly 1500 EGP in operatingExpenses.
    const pnlAfter = await thisMonthPnL(tenantA.tenantId);
    expect(pnlAfter.operatingExpenses).toBe(opexBefore + 1500);
  });

  it("double-confirm never creates a second expense (DB-atomic consume)", async () => {
    const pending = await createPending({
      tenantId: tenantA.tenantId,
      userId: tenantA.userId,
      branchId: null,
      action: "create_expense",
      params: {
        title: "AI test double",
        amount: 50,
        date: new Date().toISOString().slice(0, 10),
        categoryId: CAT_RENT,
        paymentMethod: "cash",
      },
      preview: { locale: "en" },
    });
    const first = await confirmAs(
      tenantA.tenantId,
      tenantA.userId,
      pending.token,
      { role: "owner", permissions: [] },
      ACTION_PERMISSION,
    );
    expect(first.ok).toBe(true);
    const second = await confirmAs(
      tenantA.tenantId,
      tenantA.userId,
      pending.token,
      { role: "owner", permissions: [] },
      ACTION_PERMISSION,
    );
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("ALREADY_CONSUMED");

    const rows = await withTenant(tenantA.tenantId, (tx) =>
      tx
        .select()
        .from(expensesTable)
        .where(and(eq(expensesTable.tenantId, tenantA.tenantId), eq(expensesTable.title, "AI test double"))),
    );
    expect(rows.length).toBe(1);
  });

  it("permission revoked between preview and confirm blocks execution + leaves no mutation", async () => {
    const pending = await createPending({
      tenantId: tenantA.tenantId,
      userId: tenantA.userId,
      branchId: null,
      action: "create_expense",
      params: {
        title: "AI test revoked",
        amount: 999,
        date: new Date().toISOString().slice(0, 10),
        categoryId: CAT_RENT,
      },
      preview: { locale: "en" },
    });
    // Simulate a staff caller whose manage_expenses was revoked post-preview.
    const result = await confirmAs(
      tenantA.tenantId,
      tenantA.userId,
      pending.token,
      { role: "staff", permissions: ["view_insights", "view_financials"] },
      ACTION_PERMISSION,
    );
    // The row is already consumed (the HMAC consume is atomic by design to
    // prevent replay). The permission check then rejects execution, so no
    // mutation happens.
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("FORBIDDEN_AT_CONFIRM");
    const rows = await withTenant(tenantA.tenantId, (tx) =>
      tx
        .select()
        .from(expensesTable)
        .where(and(eq(expensesTable.tenantId, tenantA.tenantId), eq(expensesTable.title, "AI test revoked"))),
    );
    expect(rows.length).toBe(0);
  });
});

// ────────────────────────── void_expense ────────────────────────────────

describe("AI void_expense — lifecycle + P&L impact", () => {
  it("creates then voids an expense; P&L excludes the voided row", async () => {
    // Create directly via the service so the test doesn't depend on the
    // create_expense lifecycle also working.
    const [inserted] = await withTenant(tenantA.tenantId, async (tx) =>
      tx
        .insert(expensesTable)
        .values({
          tenantId: tenantA.tenantId,
          title: "AI test to-void",
          amount: "2200",
          category: "rent",
          categoryId: CAT_RENT,
          date: new Date(),
          status: "posted",
          createdByUserId: tenantA.userId,
        })
        .returning({ id: expensesTable.id }),
    );
    const pnlBefore = await thisMonthPnL(tenantA.tenantId);

    const pending = await createPending({
      tenantId: tenantA.tenantId,
      userId: tenantA.userId,
      branchId: null,
      action: "void_expense",
      params: { expenseId: inserted!.id, reason: "test void" },
      preview: { locale: "en" },
    });
    const result = await confirmAs(
      tenantA.tenantId,
      tenantA.userId,
      pending.token,
      { role: "owner", permissions: [] },
      ACTION_PERMISSION,
    );
    expect(result.ok).toBe(true);

    const [row] = await withTenant(tenantA.tenantId, (tx) =>
      tx
        .select()
        .from(expensesTable)
        .where(eq(expensesTable.id, inserted!.id)),
    );
    expect(row.status).toBe("voided");

    // P&L drops by exactly the voided amount.
    const pnlAfter = await thisMonthPnL(tenantA.tenantId);
    expect(pnlAfter.operatingExpenses).toBe(pnlBefore.operatingExpenses - 2200);
  });
});

// ─────────────────────── create_money_movement ──────────────────────────

describe("AI money movements — NOT P&L", () => {
  it("owner_deposit → cash movement recorded; P&L unchanged", async () => {
    const pnlBefore = await thisMonthPnL(tenantA.tenantId);
    const srcBefore = await thisMonthPnLSource(tenantA.tenantId);
    const inBefore = srcBefore.moneyMovements.filter((m) => m.direction === "in").length;

    const pending = await createPending({
      tenantId: tenantA.tenantId,
      userId: tenantA.userId,
      branchId: null,
      action: "create_money_movement",
      params: {
        kind: "owner_deposit",
        amount: 5000,
        occurredOn: new Date().toISOString().slice(0, 10),
        description: "AI test deposit",
        paymentMethod: "cash",
      },
      preview: { locale: "en" },
    });
    const result = await confirmAs(
      tenantA.tenantId,
      tenantA.userId,
      pending.token,
      { role: "owner", permissions: [] },
      ACTION_PERMISSION,
    );
    expect(result.ok).toBe(true);

    // Row written.
    const rows = await withTenant(tenantA.tenantId, (tx) =>
      tx
        .select()
        .from(moneyMovements)
        .where(
          and(
            eq(moneyMovements.tenantId, tenantA.tenantId),
            eq(moneyMovements.description, "AI test deposit"),
          ),
        ),
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe("owner_deposit");
    expect(Number(rows[0]!.amount)).toBe(5000);

    // Count of "in" movements increased; P&L revenue / profit unchanged.
    const srcAfter = await thisMonthPnLSource(tenantA.tenantId);
    expect(srcAfter.moneyMovements.filter((m) => m.direction === "in").length).toBe(inBefore + 1);
    const pnlAfter = await thisMonthPnL(tenantA.tenantId);
    expect(pnlAfter.grossSales).toBe(pnlBefore.grossSales);
    expect(pnlAfter.netSales).toBe(pnlBefore.netSales);
    expect(pnlAfter.operatingExpenses).toBe(pnlBefore.operatingExpenses);
    expect(pnlAfter.operatingProfit).toBe(pnlBefore.operatingProfit);
    expect(pnlAfter.netProfit).toBe(pnlBefore.netProfit);
  });

  it("owner_withdrawal is not treated as expense; loan_principal_repayment is not expense", async () => {
    for (const kind of ["owner_withdrawal", "loan_principal_repayment"] as const) {
      const pnlBefore = await thisMonthPnL(tenantA.tenantId);
      const pending = await createPending({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId,
        branchId: null,
        action: "create_money_movement",
        params: {
          kind,
          amount: 750,
          occurredOn: new Date().toISOString().slice(0, 10),
          description: `AI mm ${kind}`,
          paymentMethod: "cash",
        },
        preview: { locale: "en" },
      });
      const result = await confirmAs(
        tenantA.tenantId,
        tenantA.userId,
        pending.token,
        { role: "owner", permissions: [] },
        ACTION_PERMISSION,
      );
      expect(result.ok).toBe(true);
      const pnlAfter = await thisMonthPnL(tenantA.tenantId);
      expect(pnlAfter.operatingExpenses).toBe(pnlBefore.operatingExpenses);
      expect(pnlAfter.operatingProfit).toBe(pnlBefore.operatingProfit);
      expect(pnlAfter.netProfit).toBe(pnlBefore.netProfit);
    }
  });

  it("void_money_movement excludes the row from the P&L source list", async () => {
    // Insert directly, then void via the lifecycle.
    const [mm] = await withTenant(tenantA.tenantId, async (tx) =>
      tx
        .insert(moneyMovements)
        .values({
          tenantId: tenantA.tenantId,
          kind: "cash_transfer",
          amount: "100",
          occurredAt: new Date(),
          createdByUserId: tenantA.userId,
        })
        .returning({ id: moneyMovements.id }),
    );
    const beforeHasIt = (await thisMonthPnLSource(tenantA.tenantId)).moneyMovements.some(
      (m) => m.movementId === mm!.id,
    );
    expect(beforeHasIt).toBe(true);

    const pending = await createPending({
      tenantId: tenantA.tenantId,
      userId: tenantA.userId,
      branchId: null,
      action: "void_money_movement",
      params: { movementId: mm!.id, reason: "test" },
      preview: { locale: "en" },
    });
    const result = await confirmAs(
      tenantA.tenantId,
      tenantA.userId,
      pending.token,
      { role: "owner", permissions: [] },
      ACTION_PERMISSION,
    );
    expect(result.ok).toBe(true);

    const afterHasIt = (await thisMonthPnLSource(tenantA.tenantId)).moneyMovements.some(
      (m) => m.movementId === mm!.id,
    );
    expect(afterHasIt).toBe(false);
  });
});

// ────────────────────── finance category create/archive ─────────────────

describe("AI finance-category write path", () => {
  it("creates a tenant-custom subcategory, archives it when unused", async () => {
    const suffix = Math.random().toString(36).slice(2, 6);
    const pendingCreate = await createPending({
      tenantId: tenantA.tenantId,
      userId: tenantA.userId,
      branchId: null,
      action: "create_finance_category",
      params: {
        parentId: CAT_PEOPLE_GROUP,
        nameEn: `AI Test Cat ${suffix}`,
        nameAr: `اختبار ${suffix}`,
      },
      preview: { locale: "en" },
    });
    const create = await confirmAs(
      tenantA.tenantId,
      tenantA.userId,
      pendingCreate.token,
      { role: "owner", permissions: [] },
      ACTION_PERMISSION,
    );
    expect(create.ok).toBe(true);

    const [row] = await withTenant(tenantA.tenantId, (tx) =>
      tx
        .select()
        .from(financialCategories)
        .where(
          and(
            eq(financialCategories.tenantId, tenantA.tenantId),
            eq(financialCategories.nameEn, `AI Test Cat ${suffix}`),
          ),
        ),
    );
    expect(row).toBeDefined();
    expect(row!.parentId).toBe(CAT_PEOPLE_GROUP);
    expect(row!.kind).toBe("opex");

    // Archive while unused → succeeds, row still exists but archivedAt set.
    const pendingArchive = await createPending({
      tenantId: tenantA.tenantId,
      userId: tenantA.userId,
      branchId: null,
      action: "archive_finance_category",
      params: { categoryId: row!.id },
      preview: { locale: "en" },
    });
    const archive = await confirmAs(
      tenantA.tenantId,
      tenantA.userId,
      pendingArchive.token,
      { role: "owner", permissions: [] },
      ACTION_PERMISSION,
    );
    expect(archive.ok).toBe(true);
    const [after] = await withTenant(tenantA.tenantId, (tx) =>
      tx.select().from(financialCategories).where(eq(financialCategories.id, row!.id)),
    );
    expect(after!.archivedAt).not.toBeNull();
  });

  it("archive is blocked when a posted expense still references the category (historical data safe)", async () => {
    const suffix = Math.random().toString(36).slice(2, 6);
    // Create a tenant-custom category then post an expense against it.
    const [cat] = await withTenant(tenantA.tenantId, async (tx) =>
      tx
        .insert(financialCategories)
        .values({
          tenantId: tenantA.tenantId,
          parentId: CAT_PEOPLE_GROUP,
          slug: `ai-test-inuse-${suffix}`,
          nameEn: `AI In Use ${suffix}`,
          nameAr: `قيد الاستخدام ${suffix}`,
          kind: "opex",
          isSystem: false,
        })
        .returning({ id: financialCategories.id }),
    );
    await withTenant(tenantA.tenantId, (tx) =>
      tx.insert(expensesTable).values({
        tenantId: tenantA.tenantId,
        title: "blocks archive",
        amount: "10",
        category: "salaries",
        categoryId: cat!.id,
        date: new Date(),
        status: "posted",
        createdByUserId: tenantA.userId,
      }),
    );

    const pending = await createPending({
      tenantId: tenantA.tenantId,
      userId: tenantA.userId,
      branchId: null,
      action: "archive_finance_category",
      params: { categoryId: cat!.id },
      preview: { locale: "en" },
    });
    const result = await confirmAs(
      tenantA.tenantId,
      tenantA.userId,
      pending.token,
      { role: "owner", permissions: [] },
      ACTION_PERMISSION,
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("IN_USE");

    // Historical expense still intact.
    const [exp] = await withTenant(tenantA.tenantId, (tx) =>
      tx
        .select()
        .from(expensesTable)
        .where(
          and(
            eq(expensesTable.tenantId, tenantA.tenantId),
            eq(expensesTable.title, "blocks archive"),
          ),
        ),
    );
    expect(exp).toBeDefined();
    expect(exp!.status).toBe("posted");
  });
});

// ────────────────────── update_receipt_settings ─────────────────────────

describe("AI update_receipt_settings — persists to real shop_settings", () => {
  it("staged update writes exactly the fields provided, leaves others untouched", async () => {
    const before = await getShopSettings(tenantA.tenantId, tenantA.branchId);
    const marker = `AI slogan ${Date.now()}`;
    const pending = await createPending({
      tenantId: tenantA.tenantId,
      userId: tenantA.userId,
      branchId: null,
      action: "update_receipt_settings",
      params: {
        receiptSlogan: marker,
        receiptShowSlogan: true,
      },
      preview: { locale: "en" },
    });
    const result = await confirmAs(
      tenantA.tenantId,
      tenantA.userId,
      pending.token,
      { role: "owner", permissions: [] },
      ACTION_PERMISSION,
    );
    expect(result.ok).toBe(true);

    const after = await getShopSettings(tenantA.tenantId, tenantA.branchId);
    expect(after.receiptSlogan).toBe(marker);
    expect(after.receiptShowSlogan).toBe(true);
    // Unrelated fields must not be touched.
    expect(after.shopName).toBe(before.shopName);
    expect(after.receiptLanguage).toBe(before.receiptLanguage);
  });
});

// ─────────────────────── token security contract ────────────────────────

describe("AI pending-token security", () => {
  it("expired token is rejected", async () => {
    const pending = await createPending({
      tenantId: tenantA.tenantId,
      userId: tenantA.userId,
      branchId: null,
      action: "create_expense",
      params: {
        title: "AI expired",
        amount: 1,
        date: new Date().toISOString().slice(0, 10),
        categoryId: CAT_RENT,
      },
      preview: { locale: "en" },
      ttlSec: 1,
    });
    // Age the row past expiry without waiting.
    await withTenant(tenantA.tenantId, (tx) =>
      tx
        .update(aiPendingActions)
        .set({ expiresAt: new Date(Date.now() - 10_000) })
        .where(eq(aiPendingActions.id, pending.id)),
    );
    const consumed = await consumePending({
      tenantId: tenantA.tenantId,
      userId: tenantA.userId,
      token: pending.token,
    });
    expect(consumed.ok).toBe(false);
    expect((consumed as { reason: string }).reason).toBe("EXPIRED");
  });

  it("tampered HMAC is rejected", async () => {
    const pending = await createPending({
      tenantId: tenantA.tenantId,
      userId: tenantA.userId,
      branchId: null,
      action: "create_expense",
      params: {
        title: "AI tampered",
        amount: 1,
        date: new Date().toISOString().slice(0, 10),
        categoryId: CAT_RENT,
      },
      preview: { locale: "en" },
    });
    const flipped = pending.token.slice(0, -2) + (pending.token.endsWith("00") ? "11" : "00");
    const consumed = await consumePending({
      tenantId: tenantA.tenantId,
      userId: tenantA.userId,
      token: flipped,
    });
    expect(consumed.ok).toBe(false);
    expect((consumed as { reason: string }).reason).toBe("HMAC_MISMATCH");
  });

  it("wrong tenant cannot consume another tenant's token", async () => {
    const pending = await createPending({
      tenantId: tenantA.tenantId,
      userId: tenantA.userId,
      branchId: null,
      action: "create_expense",
      params: {
        title: "AI cross-tenant",
        amount: 1,
        date: new Date().toISOString().slice(0, 10),
        categoryId: CAT_RENT,
      },
      preview: { locale: "en" },
    });
    const consumed = await consumePending({
      tenantId: tenantB.tenantId,
      userId: tenantB.userId,
      token: pending.token,
    });
    expect(consumed.ok).toBe(false);
    // The atomic UPDATE filters on tenant_id so tenant B's request never
    // matches tenant A's row — the probe then diagnoses TENANT_MISMATCH so
    // ops has an informative signal. The security property we care about:
    // tenant B's attempt did NOT consume or execute the row, and tenant B
    // never gets to see A's params.
    expect((consumed as { reason: string }).reason).toBe("TENANT_MISMATCH");

    // Prove the row is still intact for tenant A — A can still consume it.
    const consumedByA = await consumePending({
      tenantId: tenantA.tenantId,
      userId: tenantA.userId,
      token: pending.token,
    });
    expect(consumedByA.ok).toBe(true);
  });

  it("action-swap attack: mutating the stored action without re-signing fails HMAC", async () => {
    const pending = await createPending({
      tenantId: tenantA.tenantId,
      userId: tenantA.userId,
      branchId: null,
      action: "create_expense",
      params: {
        title: "AI swap",
        amount: 1,
        date: new Date().toISOString().slice(0, 10),
        categoryId: CAT_RENT,
      },
      preview: { locale: "en" },
    });
    // Attacker rewrites the stored row to a higher-privilege action.
    await withTenant(tenantA.tenantId, (tx) =>
      tx
        .update(aiPendingActions)
        .set({ action: "void_expense" })
        .where(eq(aiPendingActions.id, pending.id)),
    );
    const consumed = await consumePending({
      tenantId: tenantA.tenantId,
      userId: tenantA.userId,
      token: pending.token,
    });
    expect(consumed.ok).toBe(false);
    expect((consumed as { reason: string }).reason).toBe("HMAC_MISMATCH");
  });

  it("second consume of a valid token returns ALREADY_CONSUMED (no replay)", async () => {
    const pending = await createPending({
      tenantId: tenantA.tenantId,
      userId: tenantA.userId,
      branchId: null,
      action: "create_expense",
      params: {
        title: `AI reuse ${Math.random()}`,
        amount: 1,
        date: new Date().toISOString().slice(0, 10),
        categoryId: CAT_RENT,
      },
      preview: { locale: "en" },
    });
    const first = await consumePending({
      tenantId: tenantA.tenantId,
      userId: tenantA.userId,
      token: pending.token,
    });
    expect(first.ok).toBe(true);
    const second = await consumePending({
      tenantId: tenantA.tenantId,
      userId: tenantA.userId,
      token: pending.token,
    });
    expect(second.ok).toBe(false);
    expect((second as { reason: string }).reason).toBe("ALREADY_CONSUMED");
  });

  it("signPending canonical JSON is stable (reordered params produce the same HMAC)", () => {
    const secret = "test-secret";
    const base = {
      id: "11111111-1111-4111-8111-111111111111",
      tenantId: "22222222-2222-4222-8222-222222222222",
      userId: "33333333-3333-4333-8333-333333333333",
      branchId: null as string | null,
      action: "create_expense" as const,
      expiresAt: new Date("2099-01-01T00:00:00Z"),
    };
    const a = signPending(secret, { ...base, params: { title: "x", amount: 1, date: "2026-01-01" } });
    const b = signPending(secret, { ...base, params: { date: "2026-01-01", amount: 1, title: "x" } });
    expect(a).toBe(b);
  });
});

// ────────────────────────── tenant isolation ────────────────────────────

describe("Tenant isolation across tenants A and B", () => {
  it("tenant A cannot see tenant B's expenses via the P&L source", async () => {
    // Insert a tagged expense in tenant B and verify it never appears in A's P&L.
    await withTenant(tenantB.tenantId, (tx) =>
      tx.insert(expensesTable).values({
        tenantId: tenantB.tenantId,
        title: "B-only expense",
        amount: "9999",
        category: "rent",
        categoryId: CAT_RENT,
        date: new Date(),
        status: "posted",
        createdByUserId: tenantB.userId,
      }),
    );
    const srcA = await thisMonthPnLSource(tenantA.tenantId);
    const leaked = srcA.expenses.some((e) => e.amount === 9999);
    expect(leaked).toBe(false);
  });

  it("tenant A cannot archive a category created inside tenant B", async () => {
    const suffix = Math.random().toString(36).slice(2, 6);
    const [bCat] = await withTenant(tenantB.tenantId, async (tx) =>
      tx
        .insert(financialCategories)
        .values({
          tenantId: tenantB.tenantId,
          parentId: CAT_PEOPLE_GROUP,
          slug: `b-only-${suffix}`,
          nameEn: `B Only ${suffix}`,
          nameAr: `ب فقط ${suffix}`,
          kind: "opex",
          isSystem: false,
        })
        .returning({ id: financialCategories.id }),
    );
    // Tenant A tries to archive B's category.
    const pending = await createPending({
      tenantId: tenantA.tenantId,
      userId: tenantA.userId,
      branchId: null,
      action: "archive_finance_category",
      params: { categoryId: bCat!.id },
      preview: { locale: "en" },
    });
    const result = await confirmAs(
      tenantA.tenantId,
      tenantA.userId,
      pending.token,
      { role: "owner", permissions: [] },
      ACTION_PERMISSION,
    );
    expect(result.ok).toBe(false);
    // B's category still active.
    const [bRow] = await withTenant(tenantB.tenantId, (tx) =>
      tx.select().from(financialCategories).where(eq(financialCategories.id, bCat!.id)),
    );
    expect(bRow!.archivedAt).toBeNull();
  });
});

// ──────────────────────── recurring idempotency ─────────────────────────

describe("AI generate_recurring — reuses existing idempotent service", () => {
  it("double-fires are safe (consume + execute both times; DB-level UNIQUE prevents duplicate children)", async () => {
    // Create a recurring template due today.
    const [tmpl] = await withTenant(tenantA.tenantId, async (tx) =>
      tx
        .insert(expensesTable)
        .values({
          tenantId: tenantA.tenantId,
          title: `AI recurring template ${Math.random()}`,
          amount: "100",
          category: "rent",
          categoryId: CAT_RENT,
          date: new Date(),
          status: "posted",
          isRecurring: true,
          recurrencePeriod: "monthly",
          nextOccurrenceDate: new Date(),
          createdByUserId: tenantA.userId,
        })
        .returning({ id: expensesTable.id }),
    );

    const run = async () => {
      const pending = await createPending({
        tenantId: tenantA.tenantId,
        userId: tenantA.userId,
        branchId: null,
        action: "generate_recurring",
        params: {},
        preview: { locale: "en" },
      });
      return confirmAs(
        tenantA.tenantId,
        tenantA.userId,
        pending.token,
        { role: "owner", permissions: [] },
        ACTION_PERMISSION,
      );
    };
    const first = await run();
    const second = await run();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    // At most one child expense exists for this template on this nextOccurrence
    // date (the partial-UNIQUE index in migration 0064 enforces it).
    const children = await withTenant(tenantA.tenantId, (tx) =>
      tx
        .select()
        .from(expensesTable)
        .where(
          and(
            eq(expensesTable.tenantId, tenantA.tenantId),
            eq(expensesTable.parentExpenseId, tmpl!.id),
          ),
        ),
    );
    // Allow 0 or 1 depending on whether the next-occurrence date resolved to
    // "due now" under the server timezone — but NEVER 2.
    expect(children.length).toBeLessThanOrEqual(1);
  });
});
