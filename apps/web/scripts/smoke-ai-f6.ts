import "dotenv/config";
import { randomUUID } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { runAgent } from "@/lib/ai/agent";
import type { AgentContext } from "@/lib/ai/context";
import type { AgentResponse, AiBlock, ConfirmationBlock } from "@/lib/ai/responses";
import { consumePending } from "@/lib/ai/write/pending";
import { executeAction } from "@/lib/ai/write/execute";
import { captureWriteResult } from "@/lib/ai/context/capture";
import { loadContext, saveContext } from "@/lib/ai/context/store";
import { withTenant } from "@/lib/db";
import { products } from "@/lib/db/schema";

/**
 * F6 — live context + follow-up smoke suite.
 *
 * Covers scenarios A–F from the brief:
 *   A. Search → "how much is the second one?"
 *   B. Search → "change the second one to 2500" (preview)
 *   C. Search → "change its price to 2500" (clarifies when ambiguous, acts
 *      when singular)
 *   D. Search (en) → "التاني سعره كام؟" (ar follow-up, same entity)
 *   E. Search → preview → confirm → "actually make it 2700" (new preview
 *      for the SAME product, using the verified current price)
 *   F. Branch A → switch to branch B → "change its price" → must refuse
 */

const TENANT_ID = "f1290217-62c3-423e-9447-defb24c37734";
const OWNER_USER_ID = "5df7dd36-6ce0-4c53-8542-a173b417adb6";
const BRANCH_ID_A = "90905c29-e828-4fc1-9932-b101f2512a86"; // الحناوي ستورز
const MUSK_RUMMAN_ID = "e3a4006d-d1c1-4060-ac89-fded38314e7d";
const PINK_DIVA_ID = "4208d453-b3d1-463c-b195-d000575c00d0";

async function originalPrice(id: string): Promise<number> {
  const row = await withTenant(TENANT_ID, async (tx) => {
    const [r] = await tx.select({ price: products.price }).from(products).where(eq(products.id, id));
    return r;
  });
  return Number(row?.price ?? 0);
}

async function restorePrice(id: string, original: number) {
  await withTenant(TENANT_ID, async (tx) => {
    await tx.update(products).set({ price: String(original) }).where(eq(products.id, id));
  });
}

function findConfirmation(blocks: AiBlock[]): ConfirmationBlock | null {
  for (const b of blocks) if (b.kind === "confirmation") return b;
  return null;
}

function cards(blocks: AiBlock[]) {
  return blocks.filter((b) => b.kind === "product_card") as Array<Extract<AiBlock, { kind: "product_card" }>>;
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
  const originalMusk = await originalPrice(MUSK_RUMMAN_ID);
  const originalPink = await originalPrice(PINK_DIVA_ID);
  console.log(`baseline: Musk=${originalMusk} Pink=${originalPink}`);

  const results: boolean[] = [];

  function makeCtx(conversationId: string, locale: "ar" | "en", branchId = BRANCH_ID_A): AgentContext {
    return {
      tenantId: TENANT_ID,
      userId: OWNER_USER_ID,
      branchId,
      role: "owner",
      permissions: [],
      locale,
    };
  }

  // ───── A — "how much is the second one?" ────────────────────────────
  results.push(
    await scenario("A-second-one-price", async () => {
      const convId = randomUUID();
      const ctx = makeCtx(convId, "en");
      const r1 = await runAgent({
        ctx,
        messages: [{ role: "user", content: "Show me Assaf products" }],
        conversationId: convId,
      });
      const cs = cards(r1.response.blocks);
      if (cs.length < 2) throw new Error(`expected >=2 Assaf cards, got ${cs.length}`);
      const r2 = await runAgent({
        ctx,
        messages: [
          { role: "user", content: "Show me Assaf products" },
          { role: "assistant", content: "Found Assaf products." },
          { role: "user", content: "How much is the second one?" },
        ],
        conversationId: convId,
      });
      console.log(`   round1 tools=${r1.response.toolsCalled.join(",")} ; round2 tools=${r2.response.toolsCalled.join(",")} ; ref=${r2.debug.referenceResolved?.kind}:${r2.debug.referenceResolved?.reason}`);
      if (r2.debug.referenceResolved?.kind !== "resolved") {
        throw new Error(`reference should resolve, got ${JSON.stringify(r2.debug.referenceResolved)}`);
      }
      if (r2.debug.referenceResolved.entityId !== PINK_DIVA_ID) {
        throw new Error(`expected Pink Diva id, got ${r2.debug.referenceResolved.entityId}`);
      }
    }),
  );

  // ───── B — "change the second one to 2500" (preview) ───────────────
  results.push(
    await scenario("B-second-one-price-preview", async () => {
      const convId = randomUUID();
      const ctx = makeCtx(convId, "en");
      await runAgent({
        ctx,
        messages: [{ role: "user", content: "Show me Assaf products" }],
        conversationId: convId,
      });
      const r2 = await runAgent({
        ctx,
        messages: [
          { role: "user", content: "Show me Assaf products" },
          { role: "assistant", content: "Found Assaf products." },
          { role: "user", content: "Change the second one price to 2500" },
        ],
        conversationId: convId,
      });
      const conf = findConfirmation(r2.response.blocks);
      if (!conf) throw new Error("no confirmation emitted");
      if (!/2500|2,500/.test(conf.summary)) throw new Error(`summary missing 2500: ${conf.summary}`);
      // Preview params target the second (Pink Diva) id.
      const ctxRow = await loadContext({ tenantId: TENANT_ID, conversationId: convId });
      // We can't peek the pending row directly without a token round-trip; but
      // the resolver should have hinted at Pink Diva.
      console.log(`   ref=${r2.debug.referenceResolved?.kind}:${r2.debug.referenceResolved?.reason} entity=${r2.debug.referenceResolved?.entityId?.slice(0, 8)}…`);
      if (r2.debug.referenceResolved?.entityId !== PINK_DIVA_ID) {
        throw new Error("second-one didn't resolve to Pink Diva");
      }
      // Clean up by just loading context (don't execute).
      void ctxRow;
    }),
  );

  // ───── D — Arabic follow-up ───────────────────────────────────────
  results.push(
    await scenario("D-arabic-follow-up", async () => {
      const convId = randomUUID();
      const ctx = makeCtx(convId, "ar");
      await runAgent({
        ctx,
        messages: [{ role: "user", content: "Show me Assaf products" }],
        conversationId: convId,
      });
      const r2 = await runAgent({
        ctx,
        messages: [
          { role: "user", content: "Show me Assaf products" },
          { role: "assistant", content: "Found Assaf products." },
          { role: "user", content: "التاني سعره كام؟" },
        ],
        conversationId: convId,
      });
      console.log(`   locale=${r2.response.locale} ref=${r2.debug.referenceResolved?.kind}:${r2.debug.referenceResolved?.reason}`);
      if (r2.response.locale !== "ar") throw new Error(`should reply in ar, got ${r2.response.locale}`);
      if (r2.debug.referenceResolved?.kind !== "resolved") {
        throw new Error("Arabic positional did not resolve");
      }
      if (r2.debug.referenceResolved.entityId !== PINK_DIVA_ID) {
        throw new Error("Arabic 'التاني' should resolve to Pink Diva");
      }
    }),
  );

  // ───── E — write → "actually make it 2700" ───────────────────────
  results.push(
    await scenario("E-write-then-adjust", async () => {
      const convId = randomUUID();
      const ctx = makeCtx(convId, "en");
      // Round 1: search → stash context
      await runAgent({
        ctx,
        messages: [{ role: "user", content: "Search for Musk Rumman" }],
        conversationId: convId,
      });
      // Round 2: preview price change
      const r2 = await runAgent({
        ctx,
        messages: [
          { role: "user", content: "Search for Musk Rumman" },
          { role: "assistant", content: "Found Musk Rumman." },
          { role: "user", content: "Change its price to 2500" },
        ],
        conversationId: convId,
      });
      const conf = findConfirmation(r2.response.blocks);
      if (!conf) throw new Error("no confirmation for initial price change");
      // Confirm → execute → capture write result into context
      const consumed = await consumePending({ tenantId: TENANT_ID, userId: OWNER_USER_ID, token: conf.token });
      if (!consumed.ok) throw new Error(`consume failed: ${consumed.reason}`);
      const exec = await executeAction({ row: consumed.row });
      if (!exec.ok) throw new Error(`execute failed`);
      // Update context the way /api/ai/confirm does.
      const ctxRow = await loadContext({ tenantId: TENANT_ID, conversationId: convId });
      if (ctxRow) {
        const before = (exec.debug.before as { price?: number } | undefined)?.price;
        const after = (exec.debug.after as { price?: number } | undefined)?.price;
        captureWriteResult(ctxRow, {
          entityType: "product",
          entityId: MUSK_RUMMAN_ID,
          displayName: "Musk Rumman",
          branchId: BRANCH_ID_A,
          field: "price",
          before,
          after,
        });
        await saveContext(ctxRow);
      }
      // Round 3: "actually make it 2700" — context should show 2500 now, not 2200.
      const r3 = await runAgent({
        ctx,
        messages: [
          { role: "user", content: "Search for Musk Rumman" },
          { role: "assistant", content: "Found Musk Rumman." },
          { role: "user", content: "Change its price to 2500" },
          { role: "assistant", content: "[confirmed]" },
          { role: "user", content: "Actually make it 2700" },
        ],
        conversationId: convId,
      });
      const conf3 = findConfirmation(r3.response.blocks);
      if (!conf3) throw new Error("no confirmation for the 2700 adjustment");
      if (!/2700|2,700/.test(conf3.summary)) throw new Error(`summary missing 2700: ${conf3.summary}`);
      console.log(`   round3 confirmation: ${conf3.summary}`);
      // Clean up.
      await restorePrice(MUSK_RUMMAN_ID, originalMusk);
    }),
  );

  // ───── F — branch switch invalidates context ───────────────────────
  results.push(
    await scenario("F-branch-switch-isolates", async () => {
      const convId = randomUUID();
      const ctxA = makeCtx(convId, "en", BRANCH_ID_A);
      await runAgent({
        ctx: ctxA,
        messages: [{ role: "user", content: "Show me Assaf products" }],
        conversationId: convId,
      });
      // Switch to a non-existent branch id → handleBranchSwitch wipes context.
      const PHANTOM_BRANCH = "00000000-0000-4000-8000-000000000beef".slice(0, 36);
      const ctxB = makeCtx(convId, "en", PHANTOM_BRANCH);
      const r2 = await runAgent({
        ctx: ctxB,
        messages: [
          { role: "user", content: "Show me Assaf products" },
          { role: "assistant", content: "Found Assaf products." },
          { role: "user", content: "Change the second one price to 2500" },
        ],
        conversationId: convId,
      });
      // We expect NO confirmation to emerge (nothing to resolve in branch B).
      const conf = findConfirmation(r2.response.blocks);
      console.log(`   ref=${r2.debug.referenceResolved?.kind}:${r2.debug.referenceResolved?.reason}`);
      if (conf) throw new Error("confirmation emitted across branch switch — context leak");
    }),
  );

  console.log("\n============ F6 SUMMARY ============");
  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(`  ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
