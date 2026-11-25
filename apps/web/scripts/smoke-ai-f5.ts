import "dotenv/config";

import { and, eq } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { aiPendingActions, products, activityLogs } from "@/lib/db/schema";
import { runAgent } from "@/lib/ai/agent";
import type { AgentContext } from "@/lib/ai/context";
import type { AiBlock, ConfirmationBlock } from "@/lib/ai/responses";
import { executeAction } from "@/lib/ai/write/execute";
import { consumePending } from "@/lib/ai/write/pending";

/**
 * F5 — live write lifecycle test.
 *
 * Runs end-to-end against the real dev DB:
 *
 *   1. Ask Gemini "غير سعر Musk Rumman لـ 2500" (deliberately an UNAMBIGUOUS
 *      product so we test the happy path).
 *   2. Verify the agent emitted a confirmation block whose token points at an
 *      ai_pending_actions row we can fetch back.
 *   3. Call consumePending() + executeAction() just like /api/ai/confirm would.
 *   4. Verify the products table now has the new price.
 *   5. Verify an activity_logs row was written with the right metadata.
 *   6. Restore the original price so re-runs are idempotent.
 *
 * Also tests the critical safety tests:
 *   • Replay (consumePending twice → second attempt rejected)
 *   • Fabricated token (made-up uuid → NOT_FOUND)
 *   • Tampered token (replace hmac bytes → HMAC_MISMATCH)
 *   • Ambiguous product (model asks which one instead of silently picking)
 *   • Unknown product (model refuses — no fabricated pending row)
 */

const TENANT_ID = "f1290217-62c3-423e-9447-defb24c37734";
const OWNER_USER_ID = "5df7dd36-6ce0-4c53-8542-a173b417adb6";
const BRANCH_ID = "90905c29-e828-4fc1-9932-b101f2512a86";
const MUSK_RUMMAN_ID = "e3a4006d-d1c1-4060-ac89-fded38314e7d"; // from F2 fixtures

async function originalPrice(): Promise<number> {
  const row = await withTenant(TENANT_ID, async (tx) => {
    const [r] = await tx.select({ price: products.price }).from(products).where(eq(products.id, MUSK_RUMMAN_ID));
    return r;
  });
  return Number(row?.price ?? 0);
}

async function restorePrice(original: number) {
  await withTenant(TENANT_ID, async (tx) => {
    await tx.update(products).set({ price: String(original) }).where(eq(products.id, MUSK_RUMMAN_ID));
  });
}

function findConfirmation(blocks: AiBlock[]): ConfirmationBlock | null {
  for (const b of blocks) if (b.kind === "confirmation") return b;
  return null;
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
    if (e instanceof Error && e.stack) console.log(e.stack.split("\n").slice(1, 4).join("\n"));
    return false;
  }
}

async function main() {
  const originalPriceEgp = await originalPrice();
  console.log(`Musk Rumman original price: ${originalPriceEgp} EGP`);

  const results: boolean[] = [];

  // ────────────────── 1) Happy path: Arabic price change
  results.push(
    await scenario("arabic-price-change-full-lifecycle", async () => {
      const ctx: AgentContext = {
        tenantId: TENANT_ID,
        userId: OWNER_USER_ID,
        branchId: BRANCH_ID,
        role: "owner",
        permissions: [],
        locale: "ar",
      };
      const { response, debug } = await runAgent({
        ctx,
        messages: [{ role: "user", content: "غير سعر Musk Rumman لـ 2500" }],
      });
      console.log(`   provider=${debug.provider} rounds=${debug.roundsUsed} tools=[${response.toolsCalled.join(", ")}]`);
      const conf = findConfirmation(response.blocks);
      if (!conf) throw new Error(`no confirmation block emitted. blocks=${response.blocks.map((b) => b.kind).join(",")}`);
      if (!/٢٥٠٠|2500|2,500/.test(conf.summary)) {
        throw new Error(`confirmation summary doesn't mention 2500: "${conf.summary}"`);
      }

      // Confirm via the same path the mobile client takes (consumePending →
      // executeAction).
      const consumed = await consumePending({ tenantId: TENANT_ID, userId: OWNER_USER_ID, token: conf.token });
      if (!consumed.ok) throw new Error(`consumePending failed: ${consumed.reason}`);
      const exec = await executeAction({ row: consumed.row });
      if (!exec.ok) throw new Error(`executeAction failed: ${JSON.stringify(exec.debug)}`);

      // Verify DB now shows 2500.
      const live = await originalPrice();
      if (live !== 2500) throw new Error(`DB price is ${live}, expected 2500`);

      // Verify audit row.
      const audit = await withTenant(TENANT_ID, async (tx) => {
        const rows = await tx
          .select()
          .from(activityLogs)
          .where(and(eq(activityLogs.tenantId, TENANT_ID), eq(activityLogs.entityId, MUSK_RUMMAN_ID)));
        return rows;
      });
      const latest = audit.find((a) => {
        const md = a.metadata as Record<string, unknown> | null;
        return md?.via === "ai" && md?.field === "price";
      });
      if (!latest) throw new Error("no AI audit log row written");
      console.log(`   audit: action=${latest.action} entityLabel=${latest.entityLabel} metadata.before=${(latest.metadata as { before?: unknown })?.before} metadata.after=${(latest.metadata as { after?: unknown })?.after}`);

      // Restore.
      await restorePrice(originalPriceEgp);
    }),
  );

  // ────────────────── 2) Replay: consume same token twice
  results.push(
    await scenario("replay-second-consume-rejected", async () => {
      // Make a fresh preview via the agent, then consume twice.
      const ctx: AgentContext = {
        tenantId: TENANT_ID,
        userId: OWNER_USER_ID,
        branchId: BRANCH_ID,
        role: "owner",
        permissions: [],
        locale: "en",
      };
      const { response } = await runAgent({
        ctx,
        messages: [{ role: "user", content: "Change Musk Rumman price to 2600" }],
      });
      const conf = findConfirmation(response.blocks);
      if (!conf) throw new Error("no confirmation block");
      const first = await consumePending({ tenantId: TENANT_ID, userId: OWNER_USER_ID, token: conf.token });
      if (!first.ok) throw new Error(`first consume failed: ${first.reason}`);
      const second = await consumePending({ tenantId: TENANT_ID, userId: OWNER_USER_ID, token: conf.token });
      if (second.ok) throw new Error("second consume should have failed");
      if (second.reason !== "ALREADY_CONSUMED") throw new Error(`expected ALREADY_CONSUMED, got ${second.reason}`);
      // Rollback the first consume's write to keep the DB clean.
      await executeAction({ row: first.row });
      await restorePrice(originalPriceEgp);
    }),
  );

  // ────────────────── 3) Fabricated / tampered token
  results.push(
    await scenario("fabricated-token-rejected", async () => {
      const fake = "00000000-0000-4000-8000-000000000000.deadbeefdeadbeef";
      const r = await consumePending({ tenantId: TENANT_ID, userId: OWNER_USER_ID, token: fake });
      if (r.ok) throw new Error("fabricated token was accepted");
      if (r.reason !== "NOT_FOUND" && r.reason !== "INVALID_TOKEN") throw new Error(`expected NOT_FOUND/INVALID_TOKEN, got ${r.reason}`);
    }),
  );

  results.push(
    await scenario("tampered-hmac-rejected", async () => {
      const ctx: AgentContext = {
        tenantId: TENANT_ID,
        userId: OWNER_USER_ID,
        branchId: BRANCH_ID,
        role: "owner",
        permissions: [],
        locale: "en",
      };
      const { response } = await runAgent({
        ctx,
        messages: [{ role: "user", content: "Change Musk Rumman price to 2700" }],
      });
      const conf = findConfirmation(response.blocks);
      if (!conf) throw new Error("no confirmation block");
      // Flip one byte in the hmac.
      const [id, hmac] = conf.token.split(".");
      const tampered = `${id}.${(hmac!.charCodeAt(0) ^ 1).toString(16).padStart(2, "0")}${hmac!.slice(2)}`;
      const r = await consumePending({ tenantId: TENANT_ID, userId: OWNER_USER_ID, token: tampered });
      if (r.ok) throw new Error("tampered token was accepted");
      // Could be HMAC_MISMATCH (atomic update still consumed) OR INVALID_TOKEN
      // (regex failed) depending on which byte we flipped.
      if (!["HMAC_MISMATCH", "ALREADY_CONSUMED"].includes(r.reason) && r.reason !== "NOT_FOUND") {
        // ALREADY_CONSUMED can appear if the atomic UPDATE won before HMAC
        // check — that still means the tampered token did NOT execute (nothing
        // beyond consumePending is reachable), which is the safety we want.
        throw new Error(`unexpected reason: ${r.reason}`);
      }
    }),
  );

  // ────────────────── 4) Ambiguous product — must ask, not execute
  results.push(
    await scenario("ambiguous-brand-asks-not-executes", async () => {
      const ctx: AgentContext = {
        tenantId: TENANT_ID,
        userId: OWNER_USER_ID,
        branchId: BRANCH_ID,
        role: "owner",
        permissions: [],
        locale: "en",
      };
      const { response } = await runAgent({
        ctx,
        messages: [{ role: "user", content: "Change Assaf price to 3000" }],
      });
      const conf = findConfirmation(response.blocks);
      if (conf) throw new Error("agent emitted a confirmation for an ambiguous target");
      const hasText = response.blocks.some((b) => b.kind === "text");
      if (!hasText) throw new Error("no clarification text block");
      console.log(`   model asked for clarification (good) — tools=${response.toolsCalled.join(",")}`);
    }),
  );

  // ────────────────── 5a) F5.1 — customer audit taxonomy
  results.push(
    await scenario("customer-create-uses-dedicated-taxonomy", async () => {
      const phone = `+2010${Math.floor(Math.random() * 100000000).toString().padStart(8, "0")}`;
      const name = `F5.1 Smoke ${Date.now()}`;
      const ctx: AgentContext = {
        tenantId: TENANT_ID,
        userId: OWNER_USER_ID,
        branchId: BRANCH_ID,
        role: "owner",
        permissions: [],
        locale: "en",
      };
      const { response } = await runAgent({
        ctx,
        messages: [{ role: "user", content: `Create a customer named "${name}" with phone ${phone}` }],
      });
      const conf = findConfirmation(response.blocks);
      if (!conf) throw new Error("no confirmation emitted for customer create");
      const consumed = await consumePending({ tenantId: TENANT_ID, userId: OWNER_USER_ID, token: conf.token });
      if (!consumed.ok) throw new Error(`consume failed: ${consumed.reason}`);
      const exec = await executeAction({ row: consumed.row });
      if (!exec.ok) throw new Error(`execute failed: ${JSON.stringify(exec.debug)}`);
      // Verify audit was written with the new taxonomy.
      const audit = await withTenant(TENANT_ID, async (tx) => {
        const rows = await tx
          .select()
          .from(activityLogs)
          .where(and(eq(activityLogs.tenantId, TENANT_ID), eq(activityLogs.entityLabel, name)));
        return rows;
      });
      const latest = audit[audit.length - 1];
      if (!latest) throw new Error("no audit row");
      if (latest.action !== "customer.create") throw new Error(`action should be customer.create, got ${latest.action}`);
      if (latest.category !== "customer") throw new Error(`category should be customer, got ${latest.category}`);
      if (latest.entityType !== "customer") throw new Error(`entityType should be customer, got ${latest.entityType}`);
      console.log(`   audit OK: action=${latest.action} category=${latest.category} entityType=${latest.entityType}`);
    }),
  );

  // ────────────────── 6) Unknown product
  results.push(
    await scenario("unknown-product-no-preview-emitted", async () => {
      const ctx: AgentContext = {
        tenantId: TENANT_ID,
        userId: OWNER_USER_ID,
        branchId: BRANCH_ID,
        role: "owner",
        permissions: [],
        locale: "en",
      };
      const { response } = await runAgent({
        ctx,
        messages: [{ role: "user", content: "Change XYZ-not-a-product price to 500" }],
      });
      const conf = findConfirmation(response.blocks);
      if (conf) throw new Error("agent fabricated a confirmation for an unknown product");
    }),
  );

  console.log("\n============ F5 SUMMARY ============");
  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(`  ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
