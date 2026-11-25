import "dotenv/config";

import { and, eq, like } from "drizzle-orm";

import {
  computeBulkPricePreview,
  resolveCandidates,
} from "@/lib/ai/bulk/products";
import { executeGroupRollback } from "@/lib/ai/operations/rollback";
import { consumePending, createPending } from "@/lib/ai/write/pending";
import { executeAction } from "@/lib/ai/write/execute";
import { withTenant } from "@/lib/db";
import { aiOperations, products } from "@/lib/db/schema";
import { addProduct, listCategories } from "@/lib/repo/catalog";

const TENANT_ID = "f1290217-62c3-423e-9447-defb24c37734";
const OWNER_USER_ID = "5df7dd36-6ce0-4c53-8542-a173b417adb6";
const BRANCH_ID_A = "90905c29-e828-4fc1-9932-b101f2512a86";

const SKU_PREFIX = "F103TEST-";

async function seedProducts(count: number, brand: string): Promise<string[]> {
  const cats = await listCategories(TENANT_ID, BRANCH_ID_A);
  const categoryId = cats[0]!.id;
  const ids: string[] = [];
  for (let i = 1; i <= count; i++) {
    const r = await addProduct(TENANT_ID, BRANCH_ID_A, {
      name: `F103 Test ${brand} ${i}`,
      categoryId,
      brand,
      quantity: 5,
      price: 100,
      lowStockThreshold: 2,
      sku: `${SKU_PREFIX}${brand.toUpperCase()}-${i}`,
    });
    ids.push(r.id);
  }
  return ids;
}

async function cleanup(prefixSuffix?: string) {
  const pattern = prefixSuffix ? `${SKU_PREFIX}${prefixSuffix}%` : `${SKU_PREFIX}%`;
  await withTenant(TENANT_ID, async (tx) => {
    await tx.delete(products).where(like(products.sku, pattern));
  });
}

async function scenario(name: string, fn: () => Promise<void>): Promise<boolean> {
  console.log(`\n── [${name}]`);
  const start = Date.now();
  try {
    await fn();
    console.log(`   ✅ PASS (${Date.now() - start}ms)`);
    return true;
  } catch (e) {
    console.log(`   ❌ FAIL (${Date.now() - start}ms)`);
    console.log(`     - ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function main() {
  await cleanup();
  const results: boolean[] = [];

  /* ───── A — preview is deterministic + bounded ────────────────── */
  results.push(
    await scenario("A-preview-is-deterministic", async () => {
      await seedProducts(3, "F103BrandA");
      const candidates = await resolveCandidates({
        tenantId: TENANT_ID,
        branchId: BRANCH_ID_A,
        filter: { brand: "F103BrandA" },
      });
      if (candidates.length !== 3) throw new Error(`expected 3, got ${candidates.length}`);
      const preview = computeBulkPricePreview({
        candidates,
        mode: "increase_pct",
        value: 10,
      });
      if (preview.totalMatched !== 3 || preview.totalEligible !== 3) {
        throw new Error(`mismatch counts: ${JSON.stringify(preview)}`);
      }
      // Each product went from 100 → 110.
      for (const c of preview.changes) {
        if (c.beforePrice !== 100 || c.afterPrice !== 110 || c.delta !== 10) {
          throw new Error(`unexpected delta: ${JSON.stringify(c)}`);
        }
      }
      console.log(`   3 products @ 100 → 110 · total delta=${preview.totalPriceDelta}`);
    }),
  );

  /* ───── B — safety caps reject >50% ───────────────────────────── */
  results.push(
    await scenario("B-safety-cap-rejects-huge-pct", async () => {
      const candidates = await resolveCandidates({
        tenantId: TENANT_ID,
        branchId: BRANCH_ID_A,
        filter: { brand: "F103BrandA" },
      });
      let threw: unknown = null;
      try {
        computeBulkPricePreview({ candidates, mode: "increase_pct", value: 75 });
      } catch (e) {
        threw = e;
      }
      if (!threw) throw new Error("accepted 75% change");
      const err = threw as { code?: string };
      if (err.code !== "INVALID_VALUE") throw new Error(`wrong error: ${JSON.stringify(err)}`);
      console.log(`   75% rejected: ${err.code}`);
    }),
  );

  /* ───── C — full execute lifecycle via F5 confirm ─────────────── */
  let groupId: string | null = null;
  results.push(
    await scenario("C-execute-via-f5", async () => {
      const candidates = await resolveCandidates({
        tenantId: TENANT_ID,
        branchId: BRANCH_ID_A,
        filter: { brand: "F103BrandA" },
      });
      const preview = computeBulkPricePreview({
        candidates,
        mode: "increase_pct",
        value: 10,
      });
      const pending = await createPending({
        tenantId: TENANT_ID,
        userId: OWNER_USER_ID,
        branchId: BRANCH_ID_A,
        action: "bulk_price_update",
        params: {
          mode: "increase_pct",
          value: 10,
          changes: preview.changes.map((c) => ({
            productId: c.productId,
            before: c.beforePrice,
            after: c.afterPrice,
          })),
        },
        preview: { locale: "en", operationKind: "product.price.update" },
      });
      const consumed = await consumePending({
        tenantId: TENANT_ID,
        userId: OWNER_USER_ID,
        token: pending.token,
      });
      if (!consumed.ok) throw new Error(`consume failed: ${consumed.reason}`);
      const r = await executeAction({ row: consumed.row });
      if (!r.ok) throw new Error(`execute failed: ${JSON.stringify(r.debug)}`);
      groupId = r.debug.targetId ?? null;
      // Verify DB.
      const live = await withTenant(TENANT_ID, async (tx) =>
        tx.select().from(products).where(like(products.sku, `${SKU_PREFIX}F103BRANDA-%`)),
      );
      if (live.length !== 3) throw new Error(`expected 3 rows, got ${live.length}`);
      for (const p of live) {
        if (Number(p.price) !== 110) throw new Error(`price not updated: ${p.price}`);
      }
      console.log(`   3 updated to 110; group=${groupId?.slice(0, 8)}…`);
    }),
  );

  /* ───── D — concurrent human change blocks the affected row ───── */
  results.push(
    await scenario("D-concurrent-change-blocks-one", async () => {
      await cleanup("F103BRANDD-");
      await seedProducts(2, "F103BrandD");
      const candidates = await resolveCandidates({
        tenantId: TENANT_ID,
        branchId: BRANCH_ID_A,
        filter: { brand: "F103BrandD" },
      });
      // Flip product 0's price between preview and execute so concurrency
      // gate triggers on that row.
      const preview = computeBulkPricePreview({
        candidates,
        mode: "increase_pct",
        value: 10,
      });
      await withTenant(TENANT_ID, async (tx) => {
        await tx
          .update(products)
          .set({ price: "999" })
          .where(eq(products.id, candidates[0]!.id));
      });
      const pending = await createPending({
        tenantId: TENANT_ID,
        userId: OWNER_USER_ID,
        branchId: BRANCH_ID_A,
        action: "bulk_price_update",
        params: {
          mode: "increase_pct",
          value: 10,
          changes: preview.changes.map((c) => ({
            productId: c.productId,
            before: c.beforePrice,
            after: c.afterPrice,
          })),
        },
        preview: { locale: "en" },
      });
      const consumed = await consumePending({
        tenantId: TENANT_ID,
        userId: OWNER_USER_ID,
        token: pending.token,
      });
      if (!consumed.ok) throw new Error(`consume: ${consumed.reason}`);
      const r = await executeAction({ row: consumed.row });
      const result = r.blocks.find((b) => b.kind === "bulk_result");
      if (!result || result.kind !== "bulk_result") throw new Error("no bulk_result");
      // Expect: 1 updated (the untouched row), 1 skipped (concurrent), 0 failed.
      if (result.updated !== 1 || result.skipped !== 1 || result.failed !== 0) {
        throw new Error(`unexpected counts: ${JSON.stringify(result)}`);
      }
      console.log(`   updated=1 skipped=1 (CONCURRENT_CHANGE) failed=0`);
      // Verify the concurrently-edited row kept its human price.
      const live = await withTenant(TENANT_ID, async (tx) => {
        const [p] = await tx.select().from(products).where(eq(products.id, candidates[0]!.id));
        return p!;
      });
      if (Number(live.price) !== 999) {
        throw new Error(`human price overwritten! price=${live.price}`);
      }
    }),
  );

  /* ───── E — group rollback restores bulk updates ──────────────── */
  results.push(
    await scenario("E-group-rollback", async () => {
      if (!groupId) throw new Error("no group from scenario C");
      const rb = await executeGroupRollback({
        tenantId: TENANT_ID,
        groupId,
        actorUserId: OWNER_USER_ID,
        actorName: null,
        conversationId: null,
      });
      if (rb.reversed !== 3) {
        throw new Error(`expected 3 reversed, got ${JSON.stringify(rb)}`);
      }
      const live = await withTenant(TENANT_ID, async (tx) =>
        tx.select().from(products).where(like(products.sku, `${SKU_PREFIX}F103BRANDA-%`)),
      );
      for (const p of live) {
        if (Number(p.price) !== 100) throw new Error(`price not restored: ${p.price}`);
      }
      console.log(`   reversed=3; DB prices back to 100`);
    }),
  );

  /* ───── F — empty filter path ─────────────────────────────────── */
  results.push(
    await scenario("F-empty-filter", async () => {
      const candidates = await resolveCandidates({
        tenantId: TENANT_ID,
        branchId: BRANCH_ID_A,
        filter: { brand: "NonExistentBrand-XYZ" },
      });
      if (candidates.length !== 0) throw new Error(`expected 0, got ${candidates.length}`);
      console.log(`   non-matching filter → 0 candidates`);
    }),
  );

  // Final cleanup.
  await cleanup();
  void aiOperations;

  console.log("\n============ F10.3 SUMMARY ============");
  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(`  ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
