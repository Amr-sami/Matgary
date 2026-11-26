/**
 * Shared DB fixture for doc 15 spec 13 §7 T4 (payments split), T5 (dashboard
 * card) and T6 (digest block): one tenant rung through the REAL paths
 * (recordCartSale → collections, confirm/reject repos), so the three reports
 * read the same rows the inbox Totals tab reads.
 *
 * Today (tenant-local), one branch, rung by the owner (four-eyes exempt):
 *   cash      100                                   → no collection
 *   instapay  300  confirmed                        (CIB ***4821)
 *   wallet    200  one 150 pending part + 50 cash   (VF)
 *   instapay   80  rejected, outcome loss           (CIB)
 *   instapay   60  rejected, outcome debt (lines → deferred)
 *   instapay   40  rung while COLLECTIONS_ENABLED=off → collection_status NULL
 *
 * Not a test file (no `.test.ts`), so vitest does not collect it.
 */
import { randomInt } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import { branches, categories, shopSettings, tenantMembers, tenants, users } from "@/lib/db/schema";
import { addProduct } from "@/lib/repo/catalog";
import { recordCartSale, type CartSaleOptions } from "@/lib/repo/operations";
import { confirmCollection, rejectCollection, saveCollectionSettings, type DecisionActor } from "@/lib/repo/collections";
import { createCollectionAccount, type AccountActor } from "@/lib/repo/collection-accounts";
import { seedCornerStorePreset } from "@/lib/seeds/cornerstore";

export interface ReportFixture {
  tenantId: string;
  branchId: string;
  ownerId: string;
  /** record_sales + view_collections */
  viewerId: string;
  /** record_sales only */
  cashierId: string;
  cibId: string;
  vfId: string;
  invoices: Record<"cash" | "confirmed" | "split" | "loss" | "debt" | "unverified", string>;
}

const rnd = () => Math.random().toString(36).slice(2, 8);

export async function seedReportFixture(label: string): Promise<ReportFixture> {
  const prev = process.env.COLLECTIONS_ENABLED;
  process.env.COLLECTIONS_ENABLED = "on";
  const t8 = rnd();
  const made = await db.transaction(async (tx) => {
    const mk = async (who: string) =>
      (
        await tx
          .insert(users)
          .values({ email: `dc13-${label}-${who}-${t8}@iso.test`, name: `DC13 ${who}`, passwordHash: "x" })
          .returning({ id: users.id })
      )[0]!.id;
    const o = await mk("owner");
    const v = await mk("viewer");
    const c = await mk("cashier");
    const [t] = await tx
      .insert(tenants)
      .values({ name: `DC13 ${label}`, slug: `dc13-${label}-${t8}` })
      .returning({ id: tenants.id });
    await tx.execute(sql`select set_config('app.tenant_id', ${t!.id}, true)`);
    const [br] = await tx
      .insert(branches)
      .values({ tenantId: t!.id, slug: "main", name: "الفرع الرئيسي", isPrimary: true })
      .returning({ id: branches.id });
    await tx.insert(tenantMembers).values([
      { tenantId: t!.id, userId: o, role: "owner" },
      { tenantId: t!.id, userId: v, role: "staff", branchId: br!.id, branchIds: [br!.id], permissions: ["record_sales", "view_collections"] },
      { tenantId: t!.id, userId: c, role: "staff", branchId: br!.id, branchIds: [br!.id], permissions: ["record_sales"] },
    ]);
    await tx.insert(shopSettings).values({ tenantId: t!.id, branchId: br!.id, shopName: `DC13 ${label}` });
    await seedCornerStorePreset(tx, t!.id, br!.id);
    return { tenantId: t!.id, branchId: br!.id, ownerId: o, viewerId: v, cashierId: c };
  });
  const { tenantId, branchId, ownerId } = made;
  const [cat] = await withTenant(tenantId, (tx) =>
    tx.select({ id: categories.id }).from(categories).where(eq(categories.tenantId, tenantId)).limit(1),
  );
  const { id: productId } = await addProduct(tenantId, branchId, {
    name: `DC13 ${rnd()}`,
    categoryId: cat!.id,
    quantity: 10_000,
    price: 10,
    lowStockThreshold: 0,
  });
  await saveCollectionSettings(tenantId, branchId, { collectionsEnabled: true });
  const actor: AccountActor = { userId: ownerId, isOwner: true, activeBranchId: branchId, accessibleBranchIds: null };
  const cib = await createCollectionAccount(tenantId, actor, {
    rail: "instapay",
    provider: "cib",
    label: "CIB business",
    ipaHandle: `dc13${t8}@instapay`,
    accountLast4: "4821",
    branchId: null,
  });
  const vf = await createCollectionAccount(tenantId, actor, {
    rail: "wallet",
    provider: "vodafone_cash",
    label: "VF counter",
    walletMsisdn: `010${randomInt(10_000_000, 99_999_999)}`,
    branchId: null,
  });

  const ring = (price: number, opts: Partial<CartSaleOptions>) =>
    recordCartSale(tenantId, [{ productId, quantity: 1, pricePerUnit: price }], {
      branchId,
      recordedByUserId: ownerId,
      recordedByRole: "owner",
      ...opts,
    });
  const owner: DecisionActor = { userId: ownerId, isOwner: true, accessibleBranchIds: null };

  const cash = await ring(100, { paymentMethod: "cash" });
  const confirmed = await ring(300, { paymentMethod: "instapay", collectionAccountId: cib.id });
  await confirmCollection(tenantId, confirmed.collectionIds[0]!, owner, {});
  const split = await ring(200, {
    paymentMethod: "wallet",
    collectionParts: [{ accountId: vf.id, amount: 150 }],
  });
  const loss = await ring(80, { paymentMethod: "instapay", collectionAccountId: cib.id });
  await rejectCollection(tenantId, loss.collectionIds[0]!, owner, { reason: "not_received", outcome: "loss" });
  const debt = await ring(60, {
    paymentMethod: "instapay",
    collectionAccountId: cib.id,
    customerPhone: `+2011${randomInt(10_000_000, 99_999_999)}`,
  });
  await rejectCollection(tenantId, debt.collectionIds[0]!, owner, { reason: "wrong_amount", outcome: "debt" });
  process.env.COLLECTIONS_ENABLED = "off";
  const unverified = await ring(40, { paymentMethod: "instapay", collectionAccountId: cib.id });
  if (prev === undefined) delete process.env.COLLECTIONS_ENABLED;
  else process.env.COLLECTIONS_ENABLED = prev;

  return {
    ...made,
    cibId: cib.id,
    vfId: vf.id,
    invoices: {
      cash: cash.invoiceId,
      confirmed: confirmed.invoiceId,
      split: split.invoiceId,
      loss: loss.invoiceId,
      debt: debt.invoiceId,
      unverified: unverified.invoiceId,
    },
  };
}

/** The tenant-local business day of `now` (Africa/Cairo default), YYYY-MM-DD. */
export async function tenantToday(tenantId: string): Promise<string> {
  const [r] = (await db.execute(sql`
    SELECT to_char((now() AT TIME ZONE COALESCE((SELECT timezone FROM tenants WHERE id = ${tenantId}), 'Africa/Cairo'))::date, 'YYYY-MM-DD') AS d
  `)) as unknown as Array<{ d: string }>;
  return r!.d;
}
