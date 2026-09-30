/**
 * Digital collections 05 §7 — the L1 ledger against a real database
 * (lib/repo/collections.ts, lib/repo/collection-accounts.ts and the
 * operations.ts hooks). Same harness as oversell-repo.test.ts: its own
 * tenant, never truncates; skipped unless DATABASE_URL names a `test` DB.
 *
 * Covers the §6 acceptance criteria the DB can prove: book-and-flag on the
 * cart (2, 3), durable replay (4), four-eyes (5), reject debt/loss (7),
 * reopen byte-for-byte / window / settled (8), split reconcile (9), digital
 * settlement + voiding (10), existing-mutation hooks (11), accounts rules.
 */
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, withTenant } from "@/lib/db";
import {
  branches,
  categories,
  collectionEvents,
  collections,
  salePayments,
  shopSettings,
  tenantMembers,
  tenants,
  users,
} from "@/lib/db/schema";
import { isDomainError } from "@/lib/errors";
import { isUniqueViolation, SALES_IDEMPOTENCY_INDEX } from "@/lib/api/idempotency";
import { addProduct } from "@/lib/repo/catalog";
import {
  bulkDeleteSales,
  findCartSaleByIdempotencyKey,
  recordCartSale,
  recordReturn,
  recordSale,
  settleCustomerPayment,
  updateSale,
  voidSale,
  type CartSaleOptions,
} from "@/lib/repo/operations";
import {
  confirmCollection,
  getCollection,
  getCollectionsSummary,
  listCollections,
  rejectCollection,
  reopenCollection,
  saveCollectionSettings,
  updatePendingCollection,
  type DecisionActor,
} from "@/lib/repo/collections";
import {
  archiveCollectionAccount,
  createCollectionAccount,
  listCollectionAccounts,
  updateCollectionAccount,
  type AccountActor,
} from "@/lib/repo/collection-accounts";
import { seedCornerStorePreset } from "@/lib/seeds/cornerstore";

const url = process.env.DATABASE_URL ?? "";
const hasTestDb = /test/i.test(url);

let tenantId: string;
let branchId: string;
let ownerId: string;
let staffA: string;
let staffB: string;
let categoryId: string;
let productId: string;
let vfAccountId: string;
const savedEnv = process.env.COLLECTIONS_ENABLED;

const owner = (): DecisionActor => ({ userId: ownerId, isOwner: true, accessibleBranchIds: null });
const staff = (id: string): DecisionActor => ({ userId: id, isOwner: false, accessibleBranchIds: [branchId] });
const ownerAccounts = (): AccountActor => ({
  userId: ownerId,
  isOwner: true,
  activeBranchId: branchId,
  accessibleBranchIds: null,
});

function uniquePhone(): string {
  return `+2010${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
}

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return isDomainError(err) ? `${err.httpStatus}:${err.code}` : String(err);
  }
}

async function newProduct(atBranch = branchId): Promise<string> {
  const { id } = await addProduct(tenantId, atBranch, {
    name: `DC ${Math.random().toString(36).slice(2, 7)}`,
    categoryId,
    quantity: 10_000,
    price: 10,
    lowStockThreshold: 0,
  });
  return id;
}

function cart(prices: number[], opts: Partial<CartSaleOptions> = {}, pid = productId) {
  return recordCartSale(
    tenantId,
    prices.map((p) => ({ productId: pid, quantity: 1, pricePerUnit: p })),
    { branchId, recordedByUserId: ownerId, recordedByRole: "owner", paymentMethod: "wallet", ...opts },
  );
}

interface LineRow {
  id: string;
  amount_paid: string;
  total_price: string;
  is_paid: boolean;
  paid_at: string | null;
  partial_paid_at: string | null;
  payment_method: string | null;
  customer_phone: string | null;
  collection_status: string | null;
}

async function lineRows(invoiceId: string): Promise<LineRow[]> {
  return withTenant(tenantId, async (tx) =>
    (await tx.execute(sql`
      SELECT id, amount_paid::text AS amount_paid, total_price::text AS total_price, is_paid,
             to_json(paid_at) #>> '{}' AS paid_at, to_json(partial_paid_at) #>> '{}' AS partial_paid_at,
             payment_method, customer_phone, collection_status
        FROM sales WHERE tenant_id = ${tenantId} AND invoice_id = ${invoiceId} ORDER BY id
    `)) as unknown as LineRow[],
  );
}

async function partsOf(invoiceId: string) {
  return withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(collections)
      .where(and(eq(collections.tenantId, tenantId), eq(collections.invoiceId, invoiceId)))
      .orderBy(collections.sourceType, collections.partNo),
  );
}

async function row(id: string) {
  const [r] = await withTenant(tenantId, (tx) =>
    tx.select().from(collections).where(and(eq(collections.tenantId, tenantId), eq(collections.id, id))),
  );
  return r!;
}

async function eventsOf(id: string) {
  return withTenant(tenantId, (tx) =>
    tx
      .select()
      .from(collectionEvents)
      .where(and(eq(collectionEvents.tenantId, tenantId), eq(collectionEvents.collectionId, id)))
      .orderBy(collectionEvents.createdAt, collectionEvents.id),
  );
}

async function newBranch(slug: string): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const [b] = await tx
      .insert(branches)
      .values({ tenantId, slug, name: slug, isPrimary: false })
      .returning({ id: branches.id });
    await tx.insert(shopSettings).values({ tenantId, branchId: b!.id, shopName: slug, collectionsEnabled: true });
    return b!.id;
  });
}

beforeAll(async () => {
  if (!hasTestDb) return;
  process.env.COLLECTIONS_ENABLED = "on";
  const made = await db.transaction(async (tx) => {
    const mk = async (label: string) =>
      (
        await tx
          .insert(users)
          .values({ email: `dc05-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@iso.test`, name: `DC ${label}`, passwordHash: "x" })
          .returning({ id: users.id })
      )[0]!.id;
    const o = await mk("owner");
    const a = await mk("staffa");
    const b = await mk("staffb");
    const [t] = await tx
      .insert(tenants)
      .values({ name: "DC05", slug: `dc05-${Math.random().toString(36).slice(2, 8)}` })
      .returning({ id: tenants.id });
    await tx.execute(sql`select set_config('app.tenant_id', ${t!.id}, true)`);
    const [br] = await tx
      .insert(branches)
      .values({ tenantId: t!.id, slug: "main", name: "الفرع الرئيسي", isPrimary: true })
      .returning({ id: branches.id });
    await tx.insert(tenantMembers).values({ tenantId: t!.id, userId: o, role: "owner" });
    const perms = ["record_sales", "view_collections", "confirm_collections"];
    await tx.insert(tenantMembers).values({ tenantId: t!.id, userId: a, role: "staff", permissions: perms, branchIds: [br!.id] });
    await tx.insert(tenantMembers).values({ tenantId: t!.id, userId: b, role: "staff", permissions: perms, branchIds: [br!.id] });
    await tx.insert(shopSettings).values({ tenantId: t!.id, branchId: br!.id, shopName: "DC05" });
    await seedCornerStorePreset(tx, t!.id, br!.id);
    return { tenantId: t!.id, branchId: br!.id, o, a, b };
  });
  tenantId = made.tenantId;
  branchId = made.branchId;
  ownerId = made.o;
  staffA = made.a;
  staffB = made.b;
  const cats = await withTenant(tenantId, (tx) =>
    tx.select({ id: categories.id }).from(categories).where(eq(categories.tenantId, tenantId)).limit(1),
  );
  categoryId = cats[0]!.id;
  productId = await newProduct();
  await saveCollectionSettings(tenantId, branchId, { collectionsEnabled: true });
  // Tenant-wide wallet POS default (branch NULL): the default for every branch.
  const vf = await createCollectionAccount(tenantId, ownerAccounts(), {
    rail: "wallet",
    provider: "vodafone_cash",
    label: "VF cash",
    walletMsisdn: "01012345678",
    isPosDefault: true,
    branchId: null,
  });
  vfAccountId = vf.id;
});

afterAll(() => {
  if (savedEnv === undefined) delete process.env.COLLECTIONS_ENABLED;
  else process.env.COLLECTIONS_ENABLED = savedEnv;
});

describe.skipIf(!hasTestDb)("cart → pending (05 §4.6, acceptance 2–4)", () => {
  it("a wallet cart books one pending part on the POS default; every line reads pending; paid fields unchanged", async () => {
    const res = await cart([60, 40]);
    expect(res.collectionStatus).toBe("pending");
    expect(res.collectionIds).toHaveLength(1);
    const [p] = await partsOf(res.invoiceId);
    expect(p).toMatchObject({ status: "pending", sourceType: "sale", method: "wallet", amount: "100.00", partNo: 1, collectionAccountId: vfAccountId, flags: [] });
    const lines = await lineRows(res.invoiceId);
    expect(lines.map((l) => l.collection_status)).toEqual(["pending", "pending"]);
    for (const l of lines) {
      expect(l.is_paid).toBe(true);
      expect(Number(l.amount_paid)).toBe(Number(l.total_price));
    }
    const ev = await eventsOf(res.collectionIds[0]!);
    expect(ev.map((e) => e.kind)).toEqual(["created"]);
  });

  it("feature off (env or branch switch) → no collection, collectionStatus null", async () => {
    process.env.COLLECTIONS_ENABLED = "off";
    const a = await cart([10]);
    process.env.COLLECTIONS_ENABLED = "on";
    expect(a.collectionStatus).toBeNull();
    expect(a.collectionIds).toEqual([]);
    expect(await partsOf(a.invoiceId)).toHaveLength(0);
    expect((await lineRows(a.invoiceId))[0]!.collection_status).toBeNull();

    await saveCollectionSettings(tenantId, branchId, { collectionsEnabled: false });
    const b = await cart([10]);
    await saveCollectionSettings(tenantId, branchId, { collectionsEnabled: true });
    expect(b.collectionStatus).toBeNull();
    expect(await partsOf(b.invoiceId)).toHaveLength(0);
  });

  it("cash / card carts never create a collection", async () => {
    const res = await cart([10], { paymentMethod: "cash" });
    expect(res.collectionStatus).toBeNull();
    expect(await partsOf(res.invoiceId)).toHaveLength(0);
  });

  it("unknown account → account_missing; archived account → account_inactive; both still book", async () => {
    const unknown = await cart([25], { collectionAccountId: "99999999-9999-4999-8999-999999999999" });
    const [u] = await partsOf(unknown.invoiceId);
    expect(u).toMatchObject({ collectionAccountId: null, flags: ["account_missing"], status: "pending" });

    const acc = await createCollectionAccount(tenantId, ownerAccounts(), {
      rail: "wallet",
      provider: "orange_cash",
      label: "Orange old",
      walletMsisdn: "01212345678",
      branchId,
    });
    await archiveCollectionAccount(tenantId, ownerAccounts(), acc.id);
    const archived = await cart([25], { collectionAccountId: acc.id });
    const [a] = await partsOf(archived.invoiceId);
    expect(a).toMatchObject({ collectionAccountId: acc.id, flags: ["account_inactive"] });
  });

  it("instapay with no instapay POS default → account_missing (method and account are independent)", async () => {
    const res = await cart([30], { paymentMethod: "instapay" });
    const [p] = await partsOf(res.invoiceId);
    expect(p).toMatchObject({ method: "instapay", collectionAccountId: null, flags: ["account_missing"] });
  });

  it("4 parts above the total are clamped from the last part; Σ = total; every part flagged", async () => {
    const res = await cart([100], {
      collectionParts: [40, 40, 40, 40].map((amount) => ({ accountId: vfAccountId, amount })),
    });
    const parts = await partsOf(res.invoiceId);
    expect(parts.map((p) => p.amount)).toEqual(["40.00", "40.00", "20.00"]);
    expect(parts.map((p) => p.partNo)).toEqual([1, 2, 3]);
    for (const p of parts) expect(p.flags).toContain("parts_clamped");
    expect(res.collectionIds).toHaveLength(3);
  });

  it("an offline replay (customDate > 5 min old) is flagged offline_rung and rung at the customDate", async () => {
    const at = new Date(Date.now() - 3 * 3_600_000);
    const res = await cart([15], { customDate: at });
    const [p] = await partsOf(res.invoiceId);
    expect(p!.flags).toContain("offline_rung");
    expect(p!.rungAt.toISOString()).toBe(at.toISOString());
  });

  it("durable replay: same Idempotency-Key after a Redis loss → same collectionIds, no second row", async () => {
    const key = `dc05-dur-${Math.random().toString(36).slice(2, 10)}`;
    const first = await cart([33], { idempotencyKey: key });
    let err: unknown = null;
    try {
      await cart([33], { idempotencyKey: key });
    } catch (e) {
      err = e;
    }
    // The anchor INSERT fails first (the route maps this to the replay).
    expect(isUniqueViolation(err, SALES_IDEMPOTENCY_INDEX)).toBe(true);
    const replay = await findCartSaleByIdempotencyKey(tenantId, key);
    expect(replay!.sale.collectionIds).toEqual(first.collectionIds);
    expect(replay!.sale.collectionStatus).toBe("pending");
    expect(await partsOf(first.invoiceId)).toHaveLength(1);
  });

  it("legacy single-line sale: one part per invoice that accumulates while pending", async () => {
    const inv = `DC-LEG-${Math.random().toString(36).slice(2, 8)}`;
    const base = { productId, quantitySold: 1, branchId, recordedByUserId: ownerId, paymentMethod: "wallet" as const, invoiceId: inv };
    const a = await recordSale(tenantId, { ...base, pricePerUnit: 100 });
    const b = await recordSale(tenantId, { ...base, pricePerUnit: 50 });
    expect(a.collectionStatus).toBe("pending");
    expect(b.collectionIds).toEqual(a.collectionIds);
    const [p] = await partsOf(inv);
    expect(p!.amount).toBe("150.00");
    expect((await eventsOf(p!.id)).map((e) => e.kind)).toEqual(["created", "amount_changed"]);
    // A decided part is never edited: it is flagged instead.
    await confirmCollection(tenantId, p!.id, owner(), {});
    await recordSale(tenantId, { ...base, pricePerUnit: 20 });
    const after = await row(p!.id);
    expect(after.amount).toBe("150.00");
    expect(after.flags).toContain("total_changed");
  });
});

describe.skipIf(!hasTestDb)("decisions (05 §4.9–§4.11, acceptance 5–9)", () => {
  it("confirm: status, decider, lines confirmed; a second confirm by the same user is the durable 200, by another 409", async () => {
    const res = await cart([80]);
    const id = res.collectionIds[0]!;
    const out = await confirmCollection(tenantId, id, owner(), { note: "seen in the app" });
    expect(out.replayed).toBe(false);
    expect(out.dto).toMatchObject({ status: "confirmed", decidedBy: { id: ownerId } });
    expect((await lineRows(res.invoiceId))[0]!.collection_status).toBe("confirmed");
    const again = await confirmCollection(tenantId, id, owner(), {});
    expect(again.replayed).toBe(true);
    expect(await codeOf(confirmCollection(tenantId, id, staff(staffB), {}))).toBe("409:COLLECTION_NOT_PENDING");
  });

  it("four-eyes: the recording staff member is refused; another staff member and the owner (own sale) may decide", async () => {
    const byA = await cart([20], { recordedByUserId: staffA, recordedByRole: "staff" });
    expect(await codeOf(confirmCollection(tenantId, byA.collectionIds[0]!, staff(staffA), {}))).toBe("403:SELF_CONFIRM_FORBIDDEN");
    expect(await codeOf(rejectCollection(tenantId, byA.collectionIds[0]!, staff(staffA), { reason: "not_received" }))).toBe(
      "403:SELF_CONFIRM_FORBIDDEN",
    );
    expect((await confirmCollection(tenantId, byA.collectionIds[0]!, staff(staffB), {})).dto.status).toBe("confirmed");
    const byOwner = await cart([20]);
    expect((await confirmCollection(tenantId, byOwner.collectionIds[0]!, owner(), {})).dto.status).toBe("confirmed");
  });

  it("a collection outside the caller's branches answers 404", async () => {
    const res = await cart([20]);
    const outsider: DecisionActor = { userId: staffB, isOwner: false, accessibleBranchIds: ["00000000-0000-4000-8000-000000000001"] };
    expect(await codeOf(confirmCollection(tenantId, res.collectionIds[0]!, outsider, {}))).toBe("404:COLLECTION_NOT_FOUND");
  });

  it("reject → debt: every line deferred, Σ paid drops by the part, phone filled, snapshot; reopen restores byte-for-byte", async () => {
    const res = await cart([60, 40]);
    const before = await lineRows(res.invoiceId);
    const phone = uniquePhone();
    const out = await rejectCollection(tenantId, res.collectionIds[0]!, owner(), {
      reason: "not_received",
      outcome: "debt",
      customerPhone: phone,
    });
    expect(out.dto).toMatchObject({ status: "rejected", rejectOutcome: "debt", rejectReason: "not_received" });
    const after = await lineRows(res.invoiceId);
    expect(after.map((l) => l.payment_method)).toEqual(["deferred", "deferred"]);
    expect(after.map((l) => l.customer_phone)).toEqual([phone, phone]);
    expect(after.reduce((s, l) => s + Number(l.amount_paid), 0)).toBe(0);
    expect(after.every((l) => !l.is_paid && l.paid_at === null && l.collection_status === "rejected")).toBe(true);
    const [created, rejected] = await eventsOf(res.collectionIds[0]!);
    expect(created!.kind).toBe("created");
    const d = rejected!.details as { outcome: string; lines: unknown[]; unallocated: string; voidedPaymentIds: unknown[] };
    expect(d.outcome).toBe("debt");
    expect(d.lines).toHaveLength(2);
    expect(d.unallocated).toBe("0.00");

    const reopened = await reopenCollection(tenantId, res.collectionIds[0]!, owner(), {});
    expect(reopened.dto.status).toBe("pending");
    expect(reopened.fromStatus).toBe("rejected");
    const restored = await lineRows(res.invoiceId);
    expect(restored).toEqual(before);
  });

  it("reject → debt on a split takes the part from the LAST line backwards; the cash remainder stays paid", async () => {
    const phone = uniquePhone();
    // 100 total, one transfer part of 60, 40 cash at the counter.
    const res = await cart([60, 40], {
      customerPhone: phone,
      collectionParts: [{ accountId: vfAccountId, amount: 60 }],
    });
    await rejectCollection(tenantId, res.collectionIds[0]!, owner(), { reason: "wrong_amount" });
    const after = await lineRows(res.invoiceId);
    expect(after.reduce((s, l) => s + Number(l.amount_paid), 0)).toBe(40);
    expect(after.every((l) => l.payment_method === "deferred")).toBe(true);
    // Invoice order is (sale_date, id) and both lines share sale_date, so the
    // higher id is the "last" line: emptied first, the rest from the other.
    const [first, last] = [...after].sort((a, b) => (a.id < b.id ? -1 : 1));
    expect(Number(last!.amount_paid)).toBe(0);
    expect(last!.is_paid).toBe(false);
    const takenFromFirst = 60 - Number(last!.total_price);
    expect(Number(first!.amount_paid)).toBe(Number(first!.total_price) - takenFromFirst);
    // A line left partly paid dates its partial payment at the sale.
    if (Number(first!.amount_paid) > 0 && Number(first!.amount_paid) < Number(first!.total_price)) {
      expect(first!.partial_paid_at).not.toBeNull();
    }
  });

  it("reject with no phone anywhere: default outcome is loss (lines untouched); debt → 400 REJECT_OUTCOME_REQUIRES_PHONE", async () => {
    const a = await cart([45]);
    expect(await codeOf(rejectCollection(tenantId, a.collectionIds[0]!, owner(), { reason: "not_received", outcome: "debt" }))).toBe(
      "400:REJECT_OUTCOME_REQUIRES_PHONE",
    );
    const before = await lineRows(a.invoiceId);
    const out = await rejectCollection(tenantId, a.collectionIds[0]!, owner(), { reason: "not_received" });
    expect(out.outcome).toBe("loss");
    expect(out.dto.rejectOutcome).toBe("loss");
    const after = await lineRows(a.invoiceId);
    const money = (l: LineRow) => [l.id, l.amount_paid, l.is_paid, l.paid_at, l.partial_paid_at, l.payment_method, l.customer_phone];
    expect(after.map(money)).toEqual(before.map(money));
    expect(after[0]!.collection_status).toBe("rejected");
  });

  it("split invoice status: pending until every part is decided, rejected if any part was, else confirmed", async () => {
    const res = await cart([100], {
      collectionParts: [
        { accountId: vfAccountId, amount: 50 },
        { accountId: vfAccountId, amount: 50 },
      ],
    });
    const [p1, p2] = res.collectionIds;
    await confirmCollection(tenantId, p1!, owner(), {});
    expect((await lineRows(res.invoiceId))[0]!.collection_status).toBe("pending");
    await rejectCollection(tenantId, p2!, owner(), { reason: "other", outcome: "loss" });
    expect((await lineRows(res.invoiceId))[0]!.collection_status).toBe("rejected");
    await reopenCollection(tenantId, p2!, owner(), {});
    expect((await lineRows(res.invoiceId))[0]!.collection_status).toBe("pending");
    await confirmCollection(tenantId, p2!, owner(), {});
    expect((await lineRows(res.invoiceId))[0]!.collection_status).toBe("confirmed");
  });

  it("reopen: owner only, not a pending one, not after 7 days, not after a settlement on the debt", async () => {
    const a = await cart([10]);
    expect(await codeOf(reopenCollection(tenantId, a.collectionIds[0]!, staff(staffB), {}))).toBe("403:Forbidden");
    expect(await codeOf(reopenCollection(tenantId, a.collectionIds[0]!, owner(), {}))).toBe("409:COLLECTION_NOT_REOPENABLE");

    await confirmCollection(tenantId, a.collectionIds[0]!, owner(), {});
    await withTenant(tenantId, (tx) =>
      tx.execute(sql`UPDATE collections SET decided_at = now() - interval '8 days' WHERE id = ${a.collectionIds[0]!}`),
    );
    expect(await codeOf(reopenCollection(tenantId, a.collectionIds[0]!, owner(), {}))).toBe("409:REOPEN_WINDOW_CLOSED");

    const phone = uniquePhone();
    const b = await cart([90], { customerPhone: phone });
    await rejectCollection(tenantId, b.collectionIds[0]!, owner(), { reason: "not_received" });
    await settleCustomerPayment(tenantId, {
      customerPhone: phone,
      amount: 30,
      method: "cash",
      recordedByUserId: ownerId,
      branchId,
    });
    const code = await codeOf(reopenCollection(tenantId, b.collectionIds[0]!, owner(), {}));
    expect(code).toBe("409:REOPEN_BLOCKED_SETTLED");
    try {
      await reopenCollection(tenantId, b.collectionIds[0]!, owner(), {});
    } catch (err) {
      expect(isDomainError(err) && err.detail).toEqual({ reason: "payment_after_reject" });
    }
  });

  it("detail: events in order; line snapshots stripped for non-owners", async () => {
    const res = await cart([12], { customerPhone: uniquePhone() });
    await rejectCollection(tenantId, res.collectionIds[0]!, owner(), { reason: "duplicate" });
    const own = await getCollection(tenantId, res.collectionIds[0]!, { accessibleBranchIds: null, includeSnapshots: true });
    const other = await getCollection(tenantId, res.collectionIds[0]!, { accessibleBranchIds: [branchId], includeSnapshots: false });
    expect(own!.events.map((e) => e.kind)).toEqual(["created", "rejected"]);
    expect(own!.events[1]!.details).toHaveProperty("lines");
    expect(other!.events[1]!.details).not.toHaveProperty("lines");
    expect(other!.events[1]!.details).toHaveProperty("outcome", "debt");
  });

  it("patch while pending: account change clears account flags + account_changed; recorder-only rule", async () => {
    const res = await cart([18], { collectionAccountId: "99999999-9999-4999-8999-999999999999", recordedByUserId: staffA });
    const id = res.collectionIds[0]!;
    const denied = await codeOf(
      updatePendingCollection(tenantId, id, { ...staff(staffB), mustBeRecorder: true }, { payerPhoneLast4: "1111" }),
    );
    expect(denied).toBe("403:Forbidden");
    const out = await updatePendingCollection(
      tenantId,
      id,
      { ...staff(staffA), mustBeRecorder: true },
      { collectionAccountId: vfAccountId, payerReference: "AB12CD" },
    );
    expect(out.dto.account?.id).toBe(vfAccountId);
    expect(out.dto.flags).toEqual([]);
    expect(out.dto.payerReference).toBe("ab12cd");
    expect((await eventsOf(id)).map((e) => e.kind)).toEqual(["created", "account_changed", "note"]);
    await confirmCollection(tenantId, id, staff(staffB), {});
    expect(
      await codeOf(updatePendingCollection(tenantId, id, { ...owner(), mustBeRecorder: false }, { payerPhoneLast4: "2222" })),
    ).toBe("409:COLLECTION_NOT_PENDING");
  });
});

describe.skipIf(!hasTestDb)("digital settlement (05 §4.8, acceptance 10)", () => {
  it("a wallet settle drops the debt now, creates one settlement collection, stamps its sale_payments; reject voids them; reopen restores", async () => {
    const phone = uniquePhone();
    const debt = await cart([100], { paymentMethod: "deferred", customerPhone: phone, amountPaidNow: 0 });
    expect(debt.collectionStatus).toBeNull();
    const settled = await settleCustomerPayment(tenantId, {
      customerPhone: phone,
      amount: 70,
      method: "wallet",
      recordedByUserId: ownerId,
      branchId,
      collection: { payerPhoneLast4: "9876" },
    });
    expect(settled.appliedAmount).toBe(70);
    expect(settled.collectionStatus).toBe("pending");
    const c = await row(settled.collectionId!);
    expect(c).toMatchObject({ sourceType: "settlement", amount: "70.00", invoiceId: debt.invoiceId, collectionAccountId: vfAccountId, payerPhoneLast4: "9876" });
    const pays = await withTenant(tenantId, (tx) =>
      tx.select().from(salePayments).where(and(eq(salePayments.tenantId, tenantId), eq(salePayments.collectionId, c.id))),
    );
    expect(pays).toHaveLength(1);
    expect(pays[0]!.method).toBe("wallet");
    // Settlement parts never write the sale's own collection status.
    expect((await lineRows(debt.invoiceId))[0]).toMatchObject({ amount_paid: "70.00", collection_status: null });

    const rej = await rejectCollection(tenantId, c.id, owner(), { reason: "not_received", outcome: "loss" });
    expect(rej.outcome).toBe("debt");
    const voided = await withTenant(tenantId, (tx) =>
      tx.select().from(salePayments).where(and(eq(salePayments.tenantId, tenantId), eq(salePayments.collectionId, c.id))),
    );
    expect(voided[0]!.voidedAt).not.toBeNull();
    expect(Number((await lineRows(debt.invoiceId))[0]!.amount_paid)).toBe(0);

    await reopenCollection(tenantId, c.id, owner(), {});
    const back = await withTenant(tenantId, (tx) =>
      tx.select().from(salePayments).where(and(eq(salePayments.tenantId, tenantId), eq(salePayments.collectionId, c.id))),
    );
    expect(back[0]!.voidedAt).toBeNull();
    expect((await lineRows(debt.invoiceId))[0]!.amount_paid).toBe("70.00");
  });

  it("a cash settle creates no collection", async () => {
    const phone = uniquePhone();
    await cart([50], { paymentMethod: "deferred", customerPhone: phone, amountPaidNow: 0 });
    const s = await settleCustomerPayment(tenantId, { customerPhone: phone, amount: 10, method: "cash", recordedByUserId: ownerId, branchId });
    expect(s.collectionId).toBeNull();
    expect(s.collectionStatus).toBeNull();
  });
});

describe.skipIf(!hasTestDb)("existing mutations (05 §4.12, acceptance 11)", () => {
  it("deleting the last line voids the invoice's parts; deleting one of two flags total_changed", async () => {
    const one = await cart([22]);
    await voidSale(tenantId, one.saleIds[0]!);
    const [p] = await partsOf(one.invoiceId);
    expect(p!.status).toBe("void");
    const ev = await eventsOf(p!.id);
    expect(ev.at(-1)).toMatchObject({ kind: "voided", fromStatus: "pending", toStatus: "void" });
    expect(ev.at(-1)!.details).toMatchObject({ reason: "sale_deleted", previousStatus: "pending" });

    const two = await cart([10, 10]);
    await voidSale(tenantId, two.saleIds[0]!);
    const [q] = await partsOf(two.invoiceId);
    expect(q!.status).toBe("pending");
    expect(q!.flags).toContain("total_changed");

    const bulk = await cart([5, 5]);
    await bulkDeleteSales(tenantId, bulk.saleIds);
    expect((await partsOf(bulk.invoiceId))[0]!.status).toBe("void");
  });

  it("editing a pure-transfer sale moves the pending amount (amount_changed); a split is flagged instead", async () => {
    const res = await cart([100]);
    await updateSale(tenantId, res.saleIds[0]!, { pricePerUnit: 80 });
    const [p] = await partsOf(res.invoiceId);
    expect(p!.amount).toBe("80.00");
    const ev = await eventsOf(p!.id);
    expect(ev.at(-1)).toMatchObject({ kind: "amount_changed" });
    expect(ev.at(-1)!.details).toMatchObject({ from: "100.00", to: "80.00" });

    const split = await cart([100], { collectionParts: [{ accountId: vfAccountId, amount: 60 }] });
    await updateSale(tenantId, split.saleIds[0]!, { pricePerUnit: 90 });
    const [s] = await partsOf(split.invoiceId);
    expect(s!.amount).toBe("60.00");
    expect(s!.flags).toContain("total_changed");
  });

  it("a return flags `returned` with no money change", async () => {
    const res = await cart([40]);
    await recordReturn(tenantId, { saleId: res.saleIds[0]!, productId, returnedQuantity: 1, reason: "test" });
    const [p] = await partsOf(res.invoiceId);
    expect(p!.flags).toContain("returned");
    expect(p!.amount).toBe("40.00");
    expect((await eventsOf(p!.id)).at(-1)!.details).toMatchObject({ reason: "returned", qty: 1 });
  });
});

describe.skipIf(!hasTestDb)("list + summary (05 §4.13)", () => {
  it("keyset pages, the recorder filter, stale and the badge counts", async () => {
    const b = await newBranch(`dc-list-${Math.random().toString(36).slice(2, 6)}`);
    const pid = await newProduct(b);
    const mk = (by = ownerId) =>
      recordCartSale(tenantId, [{ productId: pid, quantity: 1, pricePerUnit: 10 }], {
        branchId: b,
        recordedByUserId: by,
        recordedByRole: "owner",
        paymentMethod: "wallet",
      });
    const x = await mk();
    const y = await mk(staffA);
    const z = await mk();
    await withTenant(tenantId, (tx) =>
      tx.execute(sql`UPDATE collections SET rung_at = now() - interval '3 hours' WHERE id = ${x.collectionIds[0]!}`),
    );
    const p1 = await listCollections(tenantId, { branchId: b, statuses: ["pending"], limit: 2 });
    expect(p1.data).toHaveLength(2);
    expect(p1.nextCursor).not.toBeNull();
    expect(p1.counts).toEqual({ pending: 3, stale: 1 });
    const p2 = await listCollections(tenantId, { branchId: b, statuses: ["pending"], limit: 2, cursor: p1.nextCursor });
    expect(p2.data).toHaveLength(1);
    expect(p2.nextCursor).toBeNull();
    const all = [...p1.data, ...p2.data].map((c) => c.id).sort();
    expect(all).toEqual([x, y, z].map((r) => r.collectionIds[0]!).sort());
    const own = await listCollections(tenantId, { branchId: b, recordedByUserId: staffA });
    expect(own.data.map((c) => c.id)).toEqual(y.collectionIds);
    const stale = await listCollections(tenantId, { branchId: b, stale: true });
    expect(stale.data.map((c) => c.id)).toEqual(x.collectionIds);
    expect(stale.data[0]!.isStale).toBe(true);
    expect(await codeOf(listCollections(tenantId, { branchId: b, cursor: "garbage" }))).toBe("400:INVALID_CURSOR");
  });

  it("per-account day totals and the cash remainder of split invoices", async () => {
    const b = await newBranch(`dc-sum-${Math.random().toString(36).slice(2, 6)}`);
    const pid = await newProduct(b);
    const ring = (price: number, extra: Partial<CartSaleOptions> = {}) =>
      recordCartSale(tenantId, [{ productId: pid, quantity: 1, pricePerUnit: price }], {
        branchId: b,
        recordedByUserId: ownerId,
        recordedByRole: "owner",
        paymentMethod: "wallet",
        ...extra,
      });
    const a = await ring(100);
    await confirmCollection(tenantId, a.collectionIds[0]!, owner(), {});
    await ring(50);
    const c = await ring(30);
    await rejectCollection(tenantId, c.collectionIds[0]!, owner(), { reason: "not_received", outcome: "loss" });
    await ring(100, { collectionParts: [{ accountId: vfAccountId, amount: 60 }] });
    const s = await getCollectionsSummary(tenantId, { branchId: b });
    expect(s.accounts).toHaveLength(1);
    expect(s.accounts[0]).toMatchObject({
      accountId: vfAccountId,
      label: "VF cash",
      rail: "wallet",
      confirmed: { count: 1, amount: 100 },
      pending: { count: 2, amount: 110 },
      rejectedLoss: { count: 1, amount: 30 },
      rejectedDebt: { count: 0, amount: 0 },
      unmatchedCredits: { count: 0, amount: 0 },
      limitWarnings: [],
    });
    expect(s.totals.cashRemainder).toBe(40);
    expect(s.totals.pending).toEqual({ count: 2, amount: 110 });
    const other = await getCollectionsSummary(tenantId, { branchId: b, date: "2020-01-01" });
    expect(other.accounts).toEqual([]);
    expect(other.date).toBe("2020-01-01");
  });
});

describe.skipIf(!hasTestDb)("receiving accounts (05 §4.14)", () => {
  it("duplicate wallet number → 409 COLLECTION_ACCOUNT_DUPLICATE; validation codes", async () => {
    expect(
      await codeOf(
        createCollectionAccount(tenantId, ownerAccounts(), { rail: "wallet", provider: "vodafone_cash", label: "dup", walletMsisdn: "+201012345678" }),
      ),
    ).toBe("409:COLLECTION_ACCOUNT_DUPLICATE");
    expect(
      await codeOf(createCollectionAccount(tenantId, ownerAccounts(), { rail: "instapay", provider: "cib", label: "no id" })),
    ).toBe("400:ACCOUNT_IDENTITY_REQUIRED");
    expect(
      await codeOf(createCollectionAccount(tenantId, ownerAccounts(), { rail: "instapay", provider: "cib", label: "x", iban: "EG380019000500000000263180003" })),
    ).toBe("400:INVALID_IBAN");
    expect(
      await codeOf(createCollectionAccount(tenantId, ownerAccounts(), { rail: "wallet", provider: "we_pay", label: "x", walletMsisdn: "0131234567" })),
    ).toBe("400:INVALID_WALLET_NUMBER");
    expect(
      await codeOf(createCollectionAccount(tenantId, ownerAccounts(), { rail: "instapay", provider: "cib", label: "x", ipaLink: "https://ipn.eg.evil.com/S/a/instapay/b" })),
    ).toBe("400:INVALID_IPA_LINK");
    expect(
      await codeOf(createCollectionAccount(tenantId, ownerAccounts(), { rail: "wallet", provider: "cib", label: "x", walletMsisdn: "01112345678" })),
    ).toBe("400:PROVIDER_RAIL_MISMATCH");
  });

  it("an IPA link derives the handle; the IBAN is normalised; a second POS default clears the first", async () => {
    const b = await newBranch(`dc-acc-${Math.random().toString(36).slice(2, 6)}`);
    const first = await createCollectionAccount(tenantId, ownerAccounts(), {
      rail: "instapay",
      provider: "cib",
      label: "CIB 1",
      ipaLink: "https://ipn.eg/S/Amr.Shop/instapay/AbC123",
      iban: "eg38 0019 0005 0000 0000 2631 8000 2",
      branchId: b,
      isPosDefault: true,
    });
    expect(first.ipaHandle).toBe("amr.shop@instapay");
    expect(first.iban).toBe("EG380019000500000000263180002");
    expect(first.mask).toBe("***@instapay");
    const second = await createCollectionAccount(tenantId, ownerAccounts(), {
      rail: "instapay",
      provider: "nbe",
      label: "NBE",
      accountLast4: "0150",
      branchId: b,
      isPosDefault: true,
    });
    const listed = await listCollectionAccounts(tenantId, {
      activeBranchId: b,
      scope: "branch",
      includeArchived: false,
      canManage: false,
      accessibleBranchIds: [b],
    });
    const byId = new Map(listed.map((a) => [a.id, a] as const));
    expect(byId.get(second.id)!.isPosDefault).toBe(true);
    expect(byId.get(first.id)!.isPosDefault).toBe(false);
    expect(byId.get(first.id)!.iban).toBeNull();
    expect(byId.get(first.id)!.ibanLast4).toBe("0002");
    // Tenant-wide accounts show on every branch.
    expect(byId.has(vfAccountId)).toBe(true);

    // Changing the identity restarts the balance chain.
    const upd = await updateCollectionAccount(tenantId, ownerAccounts(), second.id, { accountLast4: "0151" });
    expect(upd.changed).toContain("accountLast4");
    expect(upd.dto.balanceChainBrokenAt).not.toBeNull();
  });

  it("archive keeps pending collections pointing at the account; archived → 404 on PATCH", async () => {
    const acc = await createCollectionAccount(tenantId, ownerAccounts(), {
      rail: "wallet",
      provider: "etisalat_money",
      label: "e& money",
      walletMsisdn: "01112345678",
      branchId,
    });
    const res = await cart([35], { collectionAccountId: acc.id });
    const arch = await archiveCollectionAccount(tenantId, ownerAccounts(), acc.id);
    expect(arch.pendingCollections).toBe(1);
    const [p] = await partsOf(res.invoiceId);
    expect(p!.collectionAccountId).toBe(acc.id);
    expect(await codeOf(updateCollectionAccount(tenantId, ownerAccounts(), acc.id, { label: "x" }))).toBe(
      "404:COLLECTION_ACCOUNT_NOT_FOUND",
    );
    // The number is free again once archived (the unique index skips archived rows).
    const again = await createCollectionAccount(tenantId, ownerAccounts(), {
      rail: "wallet",
      provider: "etisalat_money",
      label: "e& money 2",
      walletMsisdn: "01112345678",
      branchId,
    });
    expect(again.id).not.toBe(acc.id);
  });

  it("staff may only write their own branch; a tenant-wide account is an owner decision", async () => {
    const staffActor: AccountActor = { userId: staffA, isOwner: false, activeBranchId: branchId, accessibleBranchIds: [branchId] };
    expect(
      await codeOf(createCollectionAccount(tenantId, staffActor, { rail: "wallet", provider: "we_pay", label: "x", walletMsisdn: "01512345678", branchId: null })),
    ).toBe("403:FORBIDDEN_BRANCH");
    const mine = await createCollectionAccount(tenantId, staffActor, { rail: "wallet", provider: "we_pay", label: "WE", walletMsisdn: "01512345678" });
    expect(mine.branchId).toBe(branchId);
  });
});
