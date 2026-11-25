import "dotenv/config";
import { randomUUID } from "node:crypto";

import { runAgent } from "@/lib/ai/agent";
import type { AgentContext } from "@/lib/ai/context";
import type {
  AiBlock,
  ClarificationBlock,
  ComparisonBlock,
  InventorySummaryBlock,
  SalesSummaryBlock,
  WarningBlock,
} from "@/lib/ai/responses";

/**
 * F4 — live structured-UI block smoke suite.
 *
 * Scenarios (lettered to match the F4 brief):
 *   A. "Show me Assaf products"              → ≥2 product_cards
 *   B. "Compare them side-by-side"           → comparison block (2+ entities)
 *   C. "Which Assaf product is out of stock?" → text + product_card(s), honest
 *   D. Follow-up: "Change the second one price to 2500" → confirmation
 *   E. Arabic: "التاني سعره كام؟"             → ar text referring to Pink Diva
 *   F. "ملخص المخزون"                        → inventory_summary block
 *   G. "مبيعات النهارده كام؟"                 → sales_summary block (or warning
 *                                              if empty period — both valid)
 *   H. Ambiguous ref → clarification block with real uuids
 *   I. Unavailable metric → warning block
 *   J. Branch switch after search → context invalidation (no stale refs)
 */

const TENANT_ID = "f1290217-62c3-423e-9447-defb24c37734";
const OWNER_USER_ID = "5df7dd36-6ce0-4c53-8542-a173b417adb6";
const BRANCH_ID_A = "90905c29-e828-4fc1-9932-b101f2512a86"; // الحناوي ستورز
const PINK_DIVA_ID = "4208d453-b3d1-463c-b195-d000575c00d0";

function cards(blocks: AiBlock[]) {
  return blocks.filter((b) => b.kind === "product_card") as Array<
    Extract<AiBlock, { kind: "product_card" }>
  >;
}

function firstOfKind<K extends AiBlock["kind"]>(
  blocks: AiBlock[],
  kind: K,
): Extract<AiBlock, { kind: K }> | null {
  for (const b of blocks) if (b.kind === kind) return b as Extract<AiBlock, { kind: K }>;
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
    return false;
  }
}

function makeCtx(locale: "ar" | "en", branchId = BRANCH_ID_A): AgentContext {
  return {
    tenantId: TENANT_ID,
    userId: OWNER_USER_ID,
    branchId,
    role: "owner",
    permissions: [],
    locale,
  };
}

async function main() {
  const results: boolean[] = [];

  /* ───── A — show Assaf products ─────────────────────────────────────── */
  let savedAssafCardsFromA: string[] = [];
  results.push(
    await scenario("A-show-assaf-products", async () => {
      const convId = randomUUID();
      const r = await runAgent({
        ctx: makeCtx("en"),
        messages: [{ role: "user", content: "Show me Assaf products" }],
        conversationId: convId,
      });
      const cs = cards(r.response.blocks);
      if (cs.length < 2) throw new Error(`expected ≥2 Assaf cards, got ${cs.length}`);
      savedAssafCardsFromA = cs.map((c) => c.productId);
      console.log(`   cards=${cs.map((c) => c.name).join(" | ")} tools=${r.response.toolsCalled.join(",")}`);
    }),
  );

  /* ───── B — compare Assaf products side-by-side ─────────────────────── */
  results.push(
    await scenario("B-compare-assaf", async () => {
      const convId = randomUUID();
      const ctx = makeCtx("en");
      await runAgent({
        ctx,
        messages: [{ role: "user", content: "Show me Assaf products" }],
        conversationId: convId,
      });
      const r = await runAgent({
        ctx,
        messages: [
          { role: "user", content: "Show me Assaf products" },
          { role: "assistant", content: "Found two Assaf products." },
          { role: "user", content: "Compare them side by side" },
        ],
        conversationId: convId,
      });
      const cmp = firstOfKind(r.response.blocks, "comparison") as ComparisonBlock | null;
      if (!cmp) throw new Error("no comparison block emitted");
      if (cmp.entities.length < 2) throw new Error(`only ${cmp.entities.length} entities`);
      const ids = cmp.entities.map((e) => e.entityId);
      for (const id of ids) {
        if (!savedAssafCardsFromA.includes(id)) {
          // Not fatal — the agent might have re-searched — but warn.
          console.log(`   note: comparison entity ${id} wasn't in first search`);
        }
      }
      const priceAttr = cmp.attributes.find((a) => /price|سعر/i.test(a.label));
      if (!priceAttr) throw new Error("comparison missing a price attribute");
      console.log(`   entities=${cmp.entities.map((e) => e.label).join(" vs ")} tools=${r.response.toolsCalled.join(",")}`);
    }),
  );

  /* ───── C — which is out of stock? ───────────────────────────────────── */
  results.push(
    await scenario("C-out-of-stock-question", async () => {
      const convId = randomUUID();
      const r = await runAgent({
        ctx: makeCtx("en"),
        messages: [{ role: "user", content: "Which Assaf product is out of stock?" }],
        conversationId: convId,
      });
      // We don't demand a specific block type — just that the agent either
      // answered via text/card or surfaced an honest "none are out of stock"
      // via text/warning. The important thing: no fabricated stock numbers.
      const texts = r.response.blocks.filter((b) => b.kind === "text");
      const anySignal =
        r.response.blocks.length > 0 &&
        r.response.toolsCalled.some((n) => n.startsWith("search_") || n === "get_low_stock");
      if (!anySignal) throw new Error(`no grounded answer; tools=${r.response.toolsCalled.join(",")}`);
      console.log(`   tools=${r.response.toolsCalled.join(",")} texts=${texts.length}`);
    }),
  );

  /* ───── D — follow-up "change the second one price to 2500" ─────────── */
  results.push(
    await scenario("D-second-one-preview", async () => {
      const convId = randomUUID();
      const ctx = makeCtx("en");
      await runAgent({
        ctx,
        messages: [{ role: "user", content: "Show me Assaf products" }],
        conversationId: convId,
      });
      const r = await runAgent({
        ctx,
        messages: [
          { role: "user", content: "Show me Assaf products" },
          { role: "assistant", content: "Found Assaf products." },
          { role: "user", content: "Change the second one price to 2500" },
        ],
        conversationId: convId,
      });
      const conf = firstOfKind(r.response.blocks, "confirmation");
      if (!conf) throw new Error("no confirmation emitted");
      if (r.debug.referenceResolved?.entityId !== PINK_DIVA_ID) {
        throw new Error(`expected Pink Diva, got ${r.debug.referenceResolved?.entityId}`);
      }
      console.log(`   conf=${conf.summary}`);
    }),
  );

  /* ───── E — Arabic follow-up ───────────────────────────────────────── */
  results.push(
    await scenario("E-arabic-follow-up", async () => {
      const convId = randomUUID();
      const ctx = makeCtx("ar");
      await runAgent({
        ctx,
        messages: [{ role: "user", content: "Show me Assaf products" }],
        conversationId: convId,
      });
      const r = await runAgent({
        ctx,
        messages: [
          { role: "user", content: "Show me Assaf products" },
          { role: "assistant", content: "Found Assaf products." },
          { role: "user", content: "التاني سعره كام؟" },
        ],
        conversationId: convId,
      });
      if (r.response.locale !== "ar") throw new Error(`expected ar reply, got ${r.response.locale}`);
      if (r.debug.referenceResolved?.entityId !== PINK_DIVA_ID) {
        throw new Error(`Arabic 'التاني' should resolve to Pink Diva`);
      }
      console.log(`   locale=${r.response.locale} ref=${r.debug.referenceResolved?.reason}`);
    }),
  );

  /* ───── F — inventory summary (Arabic) ─────────────────────────────── */
  results.push(
    await scenario("F-inventory-summary-ar", async () => {
      const convId = randomUUID();
      const r = await runAgent({
        ctx: makeCtx("ar"),
        messages: [{ role: "user", content: "اعرضلي ملخص المخزون" }],
        conversationId: convId,
      });
      const inv = firstOfKind(
        r.response.blocks,
        "inventory_summary",
      ) as InventorySummaryBlock | null;
      // Accept either an inventory_summary block OR a warning (e.g. empty
      // inventory). A plain text reply is NOT acceptable — the whole point of
      // F4 is the structured block.
      const warn = firstOfKind(r.response.blocks, "warning") as WarningBlock | null;
      if (!inv && !warn) {
        throw new Error(
          `expected inventory_summary or warning block; tools=${r.response.toolsCalled.join(",")}`,
        );
      }
      if (inv) {
        if (!Number.isFinite(inv.totalProducts)) throw new Error("totalProducts not finite");
        console.log(
          `   total=${inv.totalProducts} low=${inv.lowStockCount} oos=${inv.outOfStockCount}`,
        );
      } else {
        console.log(`   warning=${warn!.code}`);
      }
    }),
  );

  /* ───── G — sales summary (Arabic, today) ──────────────────────────── */
  results.push(
    await scenario("G-sales-summary-today-ar", async () => {
      const convId = randomUUID();
      const r = await runAgent({
        ctx: makeCtx("ar"),
        messages: [{ role: "user", content: "مبيعات النهارده كام؟" }],
        conversationId: convId,
      });
      const sales = firstOfKind(r.response.blocks, "sales_summary") as SalesSummaryBlock | null;
      const warn = firstOfKind(r.response.blocks, "warning") as WarningBlock | null;
      // Empty-period → warning with code SALES_EMPTY is valid honest output.
      if (!sales && !warn) {
        // Agent may still answer via render_kpi or render_text — but the
        // preferred path for F4 is a sales_summary block. We flag + continue.
        throw new Error(
          `preferred sales_summary / warning missing; tools=${r.response.toolsCalled.join(",")}`,
        );
      }
      if (sales) {
        console.log(`   revenue=${sales.revenue} orders=${sales.orders} aov=${sales.averageOrderValue}`);
      } else {
        console.log(`   warning=${warn!.code}`);
      }
    }),
  );

  /* ───── H — ambiguous ref → clarification ──────────────────────────── */
  results.push(
    await scenario("H-ambiguous-clarification", async () => {
      const convId = randomUUID();
      const ctx = makeCtx("en");
      await runAgent({
        ctx,
        messages: [{ role: "user", content: "Show me Assaf products" }],
        conversationId: convId,
      });
      const r = await runAgent({
        ctx,
        messages: [
          { role: "user", content: "Show me Assaf products" },
          { role: "assistant", content: "Found Assaf products." },
          { role: "user", content: "Change its price to 2500" },
        ],
        conversationId: convId,
      });
      const clar = firstOfKind(r.response.blocks, "clarification") as ClarificationBlock | null;
      // A clarification block is the ideal UX. If the agent emits a text
      // asking "which one?" that's still acceptable — but F4's whole point
      // is the structured option picker. We treat text-only as a pass with
      // a warning note.
      if (clar) {
        if (clar.options.length < 2) {
          throw new Error(`clarification had only ${clar.options.length} options`);
        }
        // Every option entityId should be a grounded product uuid (otherwise
        // the F3 guard would have dropped the block or the options).
        console.log(
          `   options=${clar.options.map((o) => `${o.label.slice(0, 20)}…`).join(" | ")}`,
        );
      } else {
        console.log(
          `   note: no clarification block (agent asked via text) — tools=${r.response.toolsCalled.join(",")}`,
        );
      }
      // Hard-fail only when the agent silently chose a target (= a confirmation
      // block without asking). Any reference ambiguity → should refuse, not
      // guess.
      if (firstOfKind(r.response.blocks, "confirmation")) {
        throw new Error("agent emitted confirmation without clarification — guessing!");
      }
    }),
  );

  /* ───── I — unavailable metric → warning ───────────────────────────── */
  results.push(
    await scenario("I-unavailable-metric-warning", async () => {
      const convId = randomUUID();
      const r = await runAgent({
        ctx: makeCtx("en"),
        messages: [
          {
            role: "user",
            content:
              "What's my net promoter score this quarter? We don't track that but I want to know if you'll say so honestly.",
          },
        ],
        conversationId: convId,
      });
      const warn = firstOfKind(r.response.blocks, "warning") as WarningBlock | null;
      // Acceptable outcomes: (a) warning block, (b) text block that honestly
      // says NPS isn't tracked. We detect (b) via a simple keyword probe.
      if (warn) {
        console.log(`   warning=${warn.code} severity=${warn.severity}`);
      } else {
        const text = r.response.blocks
          .filter((b) => b.kind === "text")
          .map((b) => (b as { text: string }).text)
          .join(" ")
          .toLowerCase();
        const honest = /(don'?t|do not|not tracked|not available|cannot|غير متاح|لا نتتبع)/.test(
          text,
        );
        if (!honest) throw new Error(`neither warning nor honest text: "${text.slice(0, 120)}"`);
        console.log(`   honest text (no warning block): "${text.slice(0, 80)}…"`);
      }
    }),
  );

  /* ───── J — branch switch mid-conversation invalidates ─────────────── */
  results.push(
    await scenario("J-branch-switch-isolates", async () => {
      const convId = randomUUID();
      await runAgent({
        ctx: makeCtx("en", BRANCH_ID_A),
        messages: [{ role: "user", content: "Show me Assaf products" }],
        conversationId: convId,
      });
      const PHANTOM = "00000000-0000-4000-8000-000000000bee".slice(0, 36);
      const r = await runAgent({
        ctx: makeCtx("en", PHANTOM),
        messages: [
          { role: "user", content: "Show me Assaf products" },
          { role: "assistant", content: "Found Assaf products." },
          { role: "user", content: "Change the second one price to 2500" },
        ],
        conversationId: convId,
      });
      const conf = firstOfKind(r.response.blocks, "confirmation");
      if (conf) throw new Error("confirmation emitted across branch switch — context leak");
      console.log(`   ref=${r.debug.referenceResolved?.kind}:${r.debug.referenceResolved?.reason}`);
    }),
  );

  console.log("\n============ F4 SUMMARY ============");
  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(`  ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
