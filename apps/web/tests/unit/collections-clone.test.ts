/**
 * Doc 15 spec 04 §7.3 — the demo-store clone knows the digital-collections
 * tables (lib/demo/clone-tenant.ts, §4.6 "clone accounts only"):
 *   1. createDemoClone copies non-archived collection accounts (branch remapped,
 *      creator remapped, L2 state reset) and no collections / events; cloned
 *      sales and sale_payments never carry the template's collection link;
 *   2. resetDemoClone survives the RESTRICT FKs (collections, credits and
 *      ingest devices → accounts and branches) once the visitor has recorded a
 *      collection and (M2, 0056) linked a phone that reported a credit;
 *   3. the template is untouched.
 *
 * DB-backed through the BYPASSRLS admin pool (clone-tenant.ts runs there).
 * Runs only when BOTH DATABASE_URL and ADMIN_DATABASE_URL name a "test"
 * database: tests/setup.ts loads .env, so a lone DATABASE_URL override would
 * leave the admin pool on the dev DB (spec 04 §8 R9). Creates its own template
 * tenant, never truncates, and deletes everything it created in afterAll.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getAdminDb } from "@/lib/admin/db";
import {
  branches,
  categories,
  collectionAccounts,
  collectionCredits,
  collectionEvents,
  collectionIngestDevices,
  collectionRawMessages,
  collections,
  products,
  salePayments,
  sales,
  shopSettings,
  tenantMembers,
  tenants,
  users,
} from "@/lib/db/schema";
import { createDemoClone, deleteDemoClone, resetDemoClone } from "@/lib/demo/clone-tenant";

const namesTestDb = (u: string | undefined) => /(?:^|[/_\-])test(?:[/_\-]|$)/i.test(u ?? "");
const hasTestDb = namesTestDb(process.env.DATABASE_URL) && namesTestDb(process.env.ADMIN_DATABASE_URL);

describe.skipIf(!hasTestDb)("demo clone × collection tables (spec 04 §7.3)", () => {
  const tag = Math.random().toString(36).slice(2, 8);
  let templateId: string;
  let templateOwnerId: string;
  let visitorId: string;
  let templateBranch2: string;
  let templateAccountActive: string;
  let cloneId: string | undefined;

  const db = () => getAdminDb();
  const count = async (
    table:
      | typeof collectionAccounts
      | typeof collections
      | typeof collectionEvents
      | typeof collectionIngestDevices
      | typeof collectionRawMessages
      | typeof collectionCredits,
    tenantId: string,
  ) => (await db().select({ id: table.id }).from(table).where(eq(table.tenantId, tenantId))).length;

  beforeAll(async () => {
    const adb = db();
    const [owner] = await adb
      .insert(users)
      .values({ email: `clone-owner-${tag}@iso.test`, name: "Template owner", passwordHash: "x" })
      .returning({ id: users.id });
    const [visitor] = await adb
      .insert(users)
      .values({ email: `clone-visitor-${tag}@iso.test`, name: "Visitor", passwordHash: "x" })
      .returning({ id: users.id });
    templateOwnerId = owner!.id;
    visitorId = visitor!.id;

    const [t] = await adb
      .insert(tenants)
      .values({ name: "Collections clone template", slug: `clone-tpl-${tag}`, isDemo: true })
      .returning({ id: tenants.id });
    templateId = t!.id;
    await adb.insert(tenantMembers).values({ tenantId: templateId, userId: templateOwnerId, role: "owner" });

    const [b1] = await adb
      .insert(branches)
      .values({ tenantId: templateId, slug: "main", name: "Main", isPrimary: true })
      .returning({ id: branches.id });
    const [b2] = await adb
      .insert(branches)
      .values({ tenantId: templateId, slug: "second", name: "Second" })
      .returning({ id: branches.id });
    templateBranch2 = b2!.id;
    await adb.insert(shopSettings).values([
      { tenantId: templateId, branchId: b1!.id, shopName: "Main" },
      { tenantId: templateId, branchId: templateBranch2, shopName: "Second" },
    ]);

    // One active account on branch 2 (with L2 state that must NOT survive the
    // clone) and one archived account (must not be copied at all).
    const [active] = await adb
      .insert(collectionAccounts)
      .values({
        tenantId: templateId,
        branchId: templateBranch2,
        rail: "wallet",
        provider: "vodafone_cash",
        label: "VF template",
        walletMsisdn: "+201001234567",
        isPosDefault: true,
        autoConfirmEnabled: true,
        balanceBaseline: "1234.50",
        balanceBaselineAt: new Date(),
        balanceChainBrokenAt: new Date(),
        createdByUserId: templateOwnerId,
      })
      .returning({ id: collectionAccounts.id });
    templateAccountActive = active!.id;
    await adb.insert(collectionAccounts).values({
      tenantId: templateId,
      rail: "instapay",
      provider: "cib",
      label: "CIB archived",
      accountLast4: "4321",
      archivedAt: new Date(),
    });

    // A digital sale with its pending collection, event and a settlement row
    // linked to the collection — the clone must copy the sale but not the link.
    const [cat] = await adb
      .insert(categories)
      .values({ tenantId: templateId, branchId: templateBranch2, key: `watches-${tag}`, label: "Watches" })
      .returning({ id: categories.id });
    const [prod] = await adb
      .insert(products)
      .values({
        tenantId: templateId,
        branchId: templateBranch2,
        categoryId: cat!.id,
        name: "Clone watch",
        price: "150",
        quantity: 3,
      })
      .returning({ id: products.id });
    const [sale] = await adb
      .insert(sales)
      .values({
        tenantId: templateId,
        branchId: templateBranch2,
        invoiceId: `CLONE-COL-${tag}`,
        productId: prod!.id,
        productName: "Clone watch",
        categoryId: cat!.id,
        quantitySold: 1,
        pricePerUnit: "150",
        subtotal: "150",
        totalPrice: "150",
        paymentMethod: "wallet",
        amountPaid: "150",
        collectionStatus: "pending",
      })
      .returning({ id: sales.id });
    const [col] = await adb
      .insert(collections)
      .values({
        tenantId: templateId,
        branchId: templateBranch2,
        sourceType: "sale",
        invoiceId: `CLONE-COL-${tag}`,
        anchorSaleId: sale!.id,
        method: "wallet",
        collectionAccountId: templateAccountActive,
        amount: "150.00",
        rungAt: new Date(),
        recordedByUserId: templateOwnerId,
      })
      .returning({ id: collections.id });
    await adb.insert(collectionEvents).values({
      tenantId: templateId,
      collectionId: col!.id,
      kind: "created",
      toStatus: "pending",
      actorUserId: templateOwnerId,
    });
    await adb.insert(salePayments).values({
      tenantId: templateId,
      saleId: sale!.id,
      amount: "150",
      method: "wallet",
      collectionId: col!.id,
    });
  });

  afterAll(async () => {
    if (!templateId) return;
    const adb = db();
    if (cloneId) await deleteDemoClone(cloneId);
    // Tenant delete cascades through every tenant_id FK (spec 04 §4.5).
    await adb.delete(tenants).where(eq(tenants.id, templateId));
    const ids = [templateOwnerId, visitorId].filter(Boolean);
    if (ids.length) await adb.delete(users).where(inArray(users.id, ids));
  });

  it("createDemoClone copies the active account only: branch remapped, creator remapped, L2 reset", async () => {
    const res = await createDemoClone({ templateId, ownerUserId: visitorId, locale: "ar" });
    cloneId = res.tenantId;
    const adb = db();

    const accounts = await adb
      .select()
      .from(collectionAccounts)
      .where(eq(collectionAccounts.tenantId, cloneId));
    expect(accounts).toHaveLength(1);
    const acc = accounts[0]!;
    const [cloneBranch2] = await adb
      .select({ id: branches.id })
      .from(branches)
      .where(and(eq(branches.tenantId, cloneId), eq(branches.slug, "second")));
    expect(acc.branchId).toBe(cloneBranch2!.id);
    expect(acc.branchId).not.toBe(templateBranch2);
    expect(acc.id).not.toBe(templateAccountActive);
    expect(acc.label).toBe("VF template");
    expect(acc.walletMsisdn).toBe("+201001234567");
    expect(acc.isPosDefault).toBe(true);
    expect(acc.autoConfirmEnabled).toBe(false);
    expect(acc.balanceBaseline).toBeNull();
    expect(acc.balanceBaselineAt).toBeNull();
    expect(acc.balanceChainBrokenAt).toBeNull();
    expect(acc.createdByUserId).toBe(visitorId); // template owner → clone owner

    expect(await count(collections, cloneId)).toBe(0);
    expect(await count(collectionEvents, cloneId)).toBe(0);
  });

  it("cloned sales and sale_payments never carry the template's collection link", async () => {
    expect(cloneId).toBeDefined();
    const adb = db();
    const cloneSales = await adb
      .select({ status: sales.collectionStatus, method: sales.paymentMethod })
      .from(sales)
      .where(eq(sales.tenantId, cloneId!));
    expect(cloneSales).toEqual([{ status: null, method: "wallet" }]);
    const clonePayments = await adb
      .select({ collectionId: salePayments.collectionId, method: salePayments.method })
      .from(salePayments)
      .where(eq(salePayments.tenantId, cloneId!));
    expect(clonePayments).toEqual([{ collectionId: null, method: "wallet" }]);
  });

  it("resetDemoClone survives the RESTRICT FKs once the visitor recorded a collection", async () => {
    expect(cloneId).toBeDefined();
    const adb = db();
    const [acc] = await adb
      .select({ id: collectionAccounts.id, branchId: collectionAccounts.branchId })
      .from(collectionAccounts)
      .where(eq(collectionAccounts.tenantId, cloneId!));
    const [col] = await adb
      .insert(collections)
      .values({
        tenantId: cloneId!,
        branchId: acc!.branchId!,
        sourceType: "sale",
        invoiceId: `VISITOR-${randomUUID().slice(0, 8)}`,
        method: "wallet",
        collectionAccountId: acc!.id,
        amount: "75.00",
        rungAt: new Date(),
        recordedByUserId: visitorId,
      })
      .returning({ id: collections.id });
    await adb.insert(collectionEvents).values({
      tenantId: cloneId!,
      collectionId: col!.id,
      kind: "created",
      toStatus: "pending",
      actorUserId: visitorId,
    });

    // M2 (0056): a linked phone on the clone's branch, one forwarded message
    // and the credit it produced, matched to the collection above. The device
    // and credit branch / account FKs are RESTRICT, so the wipe order matters.
    const [dev] = await adb
      .insert(collectionIngestDevices)
      .values({
        tenantId: cloneId!,
        branchId: acc!.branchId!,
        createdByUserId: visitorId,
        label: "Visitor iPhone",
        platform: "ios_shortcut",
        channels: ["ios_sms"],
        accountIds: [acc!.id],
        tokenHash: randomUUID().replace(/-/g, "").padEnd(64, "0"),
        tokenPrefix: "clonetst",
        consentVersion: "2026-10-01",
        consentAt: new Date(),
        consentUserId: visitorId,
      })
      .returning({ id: collectionIngestDevices.id });
    const [raw] = await adb
      .insert(collectionRawMessages)
      .values({
        tenantId: cloneId!,
        ingestDeviceId: dev!.id,
        channel: "ios_sms",
        senderKind: "alphanumeric",
        clientFingerprint: `clone_${tag}_0123456789`,
        bodySha256: "d".repeat(64),
        parseStatus: "parsed",
        receivedAt: new Date(),
        expiresAt: new Date(Date.now() + 7 * 864e5),
      })
      .returning({ id: collectionRawMessages.id });
    const [credit] = await adb
      .insert(collectionCredits)
      .values({
        tenantId: cloneId!,
        branchId: acc!.branchId!,
        collectionAccountId: acc!.id,
        ingestDeviceId: dev!.id,
        rawMessageId: raw!.id,
        direction: "credit",
        channels: ["ios_sms"],
        templateId: "vodafone_cash.sms.credit.v1",
        amount: "75.00",
        senderKind: "alphanumeric",
        occurredAt: new Date(),
        deviceReceivedAt: new Date(),
        state: "matched",
        matchedCollectionId: col!.id,
        dedupeKey: `b:clone-${tag}:7500:1`,
      })
      .returning({ id: collectionCredits.id });
    await adb.update(collections).set({ matchedCreditId: credit!.id }).where(eq(collections.id, col!.id));
    await adb.insert(collectionEvents).values({
      tenantId: cloneId!,
      collectionId: col!.id,
      kind: "matched",
      actorDeviceId: dev!.id,
      creditId: credit!.id,
    });

    await expect(resetDemoClone({ cloneId: cloneId!, ownerUserId: visitorId })).resolves.toBeUndefined();

    expect(await count(collectionAccounts, cloneId!)).toBe(1);
    expect(await count(collections, cloneId!)).toBe(0);
    expect(await count(collectionEvents, cloneId!)).toBe(0);
    expect(await count(collectionIngestDevices, cloneId!)).toBe(0);
    expect(await count(collectionRawMessages, cloneId!)).toBe(0);
    expect(await count(collectionCredits, cloneId!)).toBe(0);
  });

  it("the template is untouched: 2 accounts, 1 collection, 1 event", async () => {
    expect(await count(collectionAccounts, templateId)).toBe(2);
    expect(await count(collections, templateId)).toBe(1);
    expect(await count(collectionEvents, templateId)).toBe(1);
  });
});
