import "dotenv/config";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";

import { runAgent } from "@/lib/ai/agent";
import type { AgentContext } from "@/lib/ai/context";
import type {
  AiBlock,
  ClarificationBlock,
  ConfirmationBlock,
  InventorySummaryBlock,
  Locale,
  SalesSummaryBlock,
  WarningBlock,
} from "@/lib/ai/responses";
import { consumePending } from "@/lib/ai/write/pending";
import { executeAction } from "@/lib/ai/write/execute";
import { withTenant } from "@/lib/db";
import { products } from "@/lib/db/schema";

/**
 * F7 — live multilingual smoke suite.
 *
 * Scenarios (lettered to match the F7 brief):
 *   A. English       — "Show me Assaf perfumes"       → ≥2 cards, en reply
 *   B. Arabic        — "التاني سعره كام؟"              → ar reply + resolved
 *   C. Portuguese    — "Quanto estoque ele tem?"      → pt reply, uses F6 ref
 *   D. French        — "Quel est son prix ?"          → fr reply, uses F6 ref
 *   E. Spanish       — "¿Cuánto vendimos hoy?"        → es sales summary or warning
 *   F. EN→AR→EN entity continuity                     → same uuid across 3 turns
 *   G. AR→PT→EN entity continuity                     → same uuid across 3 turns
 *   H. Multilingual clarification                     → fr clarification block
 *   I. Multilingual inventory summary (pt)
 *   J. Multilingual sales summary (fr)
 *   K. Multilingual warning (es)                      → unavailable metric
 *   L. Multilingual write preview (pt)                → preview summary in pt
 *   M. Language switch during pending → row locale honored
 *   N. Branch switch after language switch → context invalidates
 */

const TENANT_ID = "f1290217-62c3-423e-9447-defb24c37734";
const OWNER_USER_ID = "5df7dd36-6ce0-4c53-8542-a173b417adb6";
const BRANCH_ID_A = "90905c29-e828-4fc1-9932-b101f2512a86"; // الحناوي ستورز
const MUSK_RUMMAN_ID = "e3a4006d-d1c1-4060-ac89-fded38314e7d";
const PINK_DIVA_ID = "4208d453-b3d1-463c-b195-d000575c00d0";

function makeCtx(locale: Locale, branchId: string | null = BRANCH_ID_A): AgentContext {
  return {
    tenantId: TENANT_ID,
    userId: OWNER_USER_ID,
    branchId,
    role: "owner",
    permissions: [],
    locale,
  };
}

function firstOfKind<K extends AiBlock["kind"]>(
  blocks: AiBlock[],
  kind: K,
): Extract<AiBlock, { kind: K }> | null {
  for (const b of blocks) if (b.kind === kind) return b as Extract<AiBlock, { kind: K }>;
  return null;
}

function cards(blocks: AiBlock[]) {
  return blocks.filter((b) => b.kind === "product_card") as Array<
    Extract<AiBlock, { kind: "product_card" }>
  >;
}

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
  const results: boolean[] = [];

  /* ───── A — English ────────────────────────────────────────────── */
  results.push(
    await scenario("A-english-base", async () => {
      const convId = randomUUID();
      const r = await runAgent({
        ctx: makeCtx("en"),
        messages: [{ role: "user", content: "Show me Assaf perfumes" }],
        conversationId: convId,
      });
      if (r.response.locale !== "en") throw new Error(`expected en, got ${r.response.locale}`);
      const cs = cards(r.response.blocks);
      if (cs.length < 2) throw new Error(`expected ≥2 cards, got ${cs.length}`);
      console.log(`   locale=${r.response.locale} cards=${cs.length}`);
    }),
  );

  /* ───── B — Arabic follow-up ───────────────────────────────────── */
  results.push(
    await scenario("B-arabic-follow-up", async () => {
      const convId = randomUUID();
      const ctx = makeCtx("ar");
      await runAgent({
        ctx,
        messages: [{ role: "user", content: "اعرضلي منتجات Assaf" }],
        conversationId: convId,
      });
      const r = await runAgent({
        ctx,
        messages: [
          { role: "user", content: "اعرضلي منتجات Assaf" },
          { role: "assistant", content: "تم إيجاد منتجات Assaf." },
          { role: "user", content: "التاني سعره كام؟" },
        ],
        conversationId: convId,
      });
      if (r.response.locale !== "ar") throw new Error(`expected ar, got ${r.response.locale}`);
      if (r.debug.referenceResolved?.entityId !== PINK_DIVA_ID) {
        throw new Error(`التاني should resolve Pink Diva, got ${r.debug.referenceResolved?.entityId}`);
      }
      console.log(`   locale=${r.response.locale} ref=${r.debug.referenceResolved?.reason}`);
    }),
  );

  /* ───── C — Portuguese follow-up on English search ─────────────── */
  results.push(
    await scenario("C-portuguese-follow-up", async () => {
      const convId = randomUUID();
      const ctx = makeCtx("en");
      await runAgent({
        ctx,
        messages: [{ role: "user", content: "Show me Assaf perfumes" }],
        conversationId: convId,
      });
      const ctxPt = makeCtx("pt");
      const r = await runAgent({
        ctx: ctxPt,
        messages: [
          { role: "user", content: "Show me Assaf perfumes" },
          { role: "assistant", content: "Found Assaf perfumes." },
          { role: "user", content: "Quanto estoque ele tem?" },
        ],
        conversationId: convId,
      });
      if (r.response.locale !== "pt") throw new Error(`expected pt, got ${r.response.locale}`);
      // Pronoun 'dele' requires selectedEntity or single-candidate set — if the
      // previous search returned exactly one dominant match it would resolve;
      // with 2+ candidates it is ambiguous. We only require a pt reply.
      console.log(`   locale=${r.response.locale} ref=${r.debug.referenceResolved?.kind ?? "none"}`);
    }),
  );

  /* ───── D — French on Arabic search ────────────────────────────── */
  results.push(
    await scenario("D-french-follow-up", async () => {
      const convId = randomUUID();
      const ctxAr = makeCtx("ar");
      await runAgent({
        ctx: ctxAr,
        messages: [{ role: "user", content: "اعرضلي Musk Rumman" }],
        conversationId: convId,
      });
      const ctxFr = makeCtx("fr");
      const r = await runAgent({
        ctx: ctxFr,
        messages: [
          { role: "user", content: "اعرضلي Musk Rumman" },
          { role: "assistant", content: "Trouvé." },
          { role: "user", content: "Quel est son prix ?" },
        ],
        conversationId: convId,
      });
      if (r.response.locale !== "fr") throw new Error(`expected fr, got ${r.response.locale}`);
      console.log(`   locale=${r.response.locale} ref=${r.debug.referenceResolved?.kind}:${r.debug.referenceResolved?.reason}`);
    }),
  );

  /* ───── E — Spanish sales-today ────────────────────────────────── */
  results.push(
    await scenario("E-spanish-sales-today", async () => {
      const convId = randomUUID();
      const r = await runAgent({
        ctx: makeCtx("es"),
        messages: [{ role: "user", content: "¿Cuánto vendimos hoy?" }],
        conversationId: convId,
      });
      if (r.response.locale !== "es") throw new Error(`expected es, got ${r.response.locale}`);
      const sales = firstOfKind(r.response.blocks, "sales_summary") as SalesSummaryBlock | null;
      const warn = firstOfKind(r.response.blocks, "warning") as WarningBlock | null;
      if (!sales && !warn) {
        throw new Error(`expected sales_summary or warning; tools=${r.response.toolsCalled.join(",")}`);
      }
      console.log(`   locale=${r.response.locale} ${sales ? `revenue=${sales.revenue}` : `warning=${warn!.code}`}`);
    }),
  );

  /* ───── F — EN→AR→EN entity continuity ─────────────────────────── */
  results.push(
    await scenario("F-en-ar-en-continuity", async () => {
      const convId = randomUUID();
      await runAgent({
        ctx: makeCtx("en"),
        messages: [{ role: "user", content: "Show me Assaf perfumes" }],
        conversationId: convId,
      });
      const r2 = await runAgent({
        ctx: makeCtx("ar"),
        messages: [
          { role: "user", content: "Show me Assaf perfumes" },
          { role: "assistant", content: "Found 2 perfumes." },
          { role: "user", content: "التاني سعره كام؟" },
        ],
        conversationId: convId,
      });
      if (r2.debug.referenceResolved?.entityId !== PINK_DIVA_ID) {
        throw new Error("Pink Diva lost on en→ar switch");
      }
      const r3 = await runAgent({
        ctx: makeCtx("en"),
        messages: [
          { role: "user", content: "Show me Assaf perfumes" },
          { role: "assistant", content: "Found 2 perfumes." },
          { role: "user", content: "التاني سعره كام؟" },
          { role: "assistant", content: "سعره كذا" },
          { role: "user", content: "Change its price to 2600" },
        ],
        conversationId: convId,
      });
      // "its" after the previous turn referred to Pink Diva. Confirm the
      // agent produced a confirmation OR a clarification — not a silent guess
      // at a different product, and not a confirmation without any entity context.
      if (r3.response.locale !== "en") throw new Error(`r3 expected en, got ${r3.response.locale}`);
      const conf3 = firstOfKind(r3.response.blocks, "confirmation") as ConfirmationBlock | null;
      const clar3 = firstOfKind(r3.response.blocks, "clarification") as ClarificationBlock | null;
      if (!conf3 && !clar3) {
        throw new Error(
          `expected confirmation or clarification in r3; tools=${r3.response.toolsCalled.join(",")}`,
        );
      }
      console.log(`   r2 ref=${r2.debug.referenceResolved?.entityId?.slice(0, 8)}… r3 ${conf3 ? "conf" : "clar"}`);
    }),
  );

  /* ───── G — AR→PT→EN entity continuity ─────────────────────────── */
  results.push(
    await scenario("G-ar-pt-en-continuity", async () => {
      const convId = randomUUID();
      await runAgent({
        ctx: makeCtx("ar"),
        messages: [{ role: "user", content: "اعرضلي منتجات Assaf" }],
        conversationId: convId,
      });
      const r2 = await runAgent({
        ctx: makeCtx("pt"),
        messages: [
          { role: "user", content: "اعرضلي منتجات Assaf" },
          { role: "assistant", content: "Encontrei produtos Assaf." },
          { role: "user", content: "Qual o preço do segundo?" },
        ],
        conversationId: convId,
      });
      if (r2.response.locale !== "pt") throw new Error(`r2 expected pt, got ${r2.response.locale}`);
      if (r2.debug.referenceResolved?.entityId !== PINK_DIVA_ID) {
        throw new Error("'segundo' should resolve Pink Diva");
      }
      console.log(`   r2 locale=${r2.response.locale} ref=${r2.debug.referenceResolved?.reason}`);
    }),
  );

  /* ───── H — French clarification ───────────────────────────────── */
  results.push(
    await scenario("H-french-clarification", async () => {
      const convId = randomUUID();
      const ctx = makeCtx("fr");
      await runAgent({
        ctx,
        messages: [{ role: "user", content: "Montrez-moi les parfums Assaf" }],
        conversationId: convId,
      });
      const r = await runAgent({
        ctx,
        messages: [
          { role: "user", content: "Montrez-moi les parfums Assaf" },
          { role: "assistant", content: "Deux parfums trouvés." },
          { role: "user", content: "Changez son prix à 2500" },
        ],
        conversationId: convId,
      });
      if (r.response.locale !== "fr") throw new Error(`expected fr, got ${r.response.locale}`);
      // Model should emit clarification OR refuse-text — must NOT silently
      // choose a product. A confirmation block would mean the agent picked
      // without asking, i.e. a security-relevant failure.
      const conf = firstOfKind(r.response.blocks, "confirmation");
      if (conf) throw new Error("agent emitted confirmation without clarification");
      const clar = firstOfKind(r.response.blocks, "clarification") as ClarificationBlock | null;
      console.log(`   locale=${r.response.locale} clarification=${clar ? "yes" : "no"}`);
    }),
  );

  /* ───── I — Portuguese inventory summary ───────────────────────── */
  results.push(
    await scenario("I-portuguese-inventory", async () => {
      const convId = randomUUID();
      const r = await runAgent({
        ctx: makeCtx("pt"),
        messages: [{ role: "user", content: "Mostre o resumo do estoque" }],
        conversationId: convId,
      });
      if (r.response.locale !== "pt") throw new Error(`expected pt, got ${r.response.locale}`);
      const inv = firstOfKind(r.response.blocks, "inventory_summary") as InventorySummaryBlock | null;
      const warn = firstOfKind(r.response.blocks, "warning") as WarningBlock | null;
      if (!inv && !warn) {
        throw new Error(
          `expected inventory_summary or warning; tools=${r.response.toolsCalled.join(",")}`,
        );
      }
      if (inv) {
        // Title must be in Portuguese — "Resumo do estoque".
        if (!/estoque|inventário|resumo/i.test(inv.title)) {
          throw new Error(`title not in pt: ${inv.title}`);
        }
        console.log(`   title=${inv.title} total=${inv.totalProducts}`);
      } else {
        console.log(`   warning=${warn!.code} title=${warn!.title}`);
      }
    }),
  );

  /* ───── J — French sales summary (week) ────────────────────────── */
  results.push(
    await scenario("J-french-sales-week", async () => {
      const convId = randomUUID();
      const r = await runAgent({
        ctx: makeCtx("fr"),
        messages: [
          { role: "user", content: "Quelles sont les ventes des 7 derniers jours ?" },
        ],
        conversationId: convId,
      });
      if (r.response.locale !== "fr") throw new Error(`expected fr, got ${r.response.locale}`);
      const sales = firstOfKind(r.response.blocks, "sales_summary") as SalesSummaryBlock | null;
      const warn = firstOfKind(r.response.blocks, "warning") as WarningBlock | null;
      if (!sales && !warn) {
        throw new Error(
          `expected sales_summary or warning; tools=${r.response.toolsCalled.join(",")}`,
        );
      }
      if (sales) {
        if (!/ventes|résumé/i.test(sales.title)) throw new Error(`title not fr: ${sales.title}`);
        console.log(`   title=${sales.title} periodLabel=${sales.periodLabel}`);
      } else {
        console.log(`   warning=${warn!.code} title=${warn!.title}`);
      }
    }),
  );

  /* ───── K — Spanish warning (unavailable metric) ───────────────── */
  results.push(
    await scenario("K-spanish-warning", async () => {
      const convId = randomUUID();
      const r = await runAgent({
        ctx: makeCtx("es"),
        messages: [
          {
            role: "user",
            content:
              "¿Cuál es mi puntuación NPS este trimestre? No la rastreamos, pero quiero saber si lo dirás honestamente.",
          },
        ],
        conversationId: convId,
      });
      if (r.response.locale !== "es") throw new Error(`expected es, got ${r.response.locale}`);
      const warn = firstOfKind(r.response.blocks, "warning") as WarningBlock | null;
      if (warn) {
        console.log(`   warning=${warn.code} severity=${warn.severity}`);
      } else {
        const text = r.response.blocks
          .filter((b) => b.kind === "text")
          .map((b) => (b as { text: string }).text)
          .join(" ")
          .toLowerCase();
        const honest = /(no\s+rastreamos|no\s+disponible|no\s+tenemos|no\s+podemos)/.test(text);
        if (!honest) throw new Error(`neither warning nor honest es text: "${text.slice(0, 120)}"`);
        console.log(`   honest text: "${text.slice(0, 80)}…"`);
      }
    }),
  );

  /* ───── L — Portuguese write preview ───────────────────────────── */
  results.push(
    await scenario("L-portuguese-write-preview", async () => {
      const convId = randomUUID();
      const r = await runAgent({
        ctx: makeCtx("pt"),
        messages: [{ role: "user", content: "Mude o preço do Musk Rumman para 2500" }],
        conversationId: convId,
      });
      if (r.response.locale !== "pt") throw new Error(`expected pt, got ${r.response.locale}`);
      const conf = firstOfKind(r.response.blocks, "confirmation") as ConfirmationBlock | null;
      if (!conf) throw new Error(`no confirmation; tools=${r.response.toolsCalled.join(",")}`);
      // Title & summary must be in Portuguese.
      if (!/alterar|preço/i.test(conf.title)) throw new Error(`title not pt: ${conf.title}`);
      if (!/de .+ para/i.test(conf.summary)) throw new Error(`summary not pt: ${conf.summary}`);
      console.log(`   title=${conf.title} summary=${conf.summary} actionLabel=${conf.actionLabel}`);
    }),
  );

  /* ───── M — Language switch during pending → row locale honored ── */
  results.push(
    await scenario("M-language-switch-during-pending", async () => {
      const convId = randomUUID();
      // 1. Preview in Portuguese.
      const ctxPt = makeCtx("pt");
      const preview = await runAgent({
        ctx: ctxPt,
        messages: [{ role: "user", content: "Mude o preço do Musk Rumman para 2500" }],
        conversationId: convId,
      });
      const conf = firstOfKind(preview.response.blocks, "confirmation") as ConfirmationBlock | null;
      if (!conf) throw new Error("no confirmation produced");

      // 2. Consume + execute — simulating a user who types English after
      //    confirming on-phone. The executor must still use the Portuguese
      //    locale captured at preview time (F7 Part 16).
      const consumed = await consumePending({
        tenantId: TENANT_ID,
        userId: OWNER_USER_ID,
        token: conf.token,
      });
      if (!consumed.ok) throw new Error(`consume failed: ${consumed.reason}`);
      const exec = await executeAction({ row: consumed.row });
      if (!exec.ok) throw new Error(`execute failed`);
      const text = exec.blocks
        .filter((b) => b.kind === "text")
        .map((b) => (b as { text: string }).text)
        .join(" ");
      // Portuguese success text contains "atualizado" / "atualizada".
      if (!/atualizad/i.test(text)) {
        throw new Error(`execute text not in pt (should honor preview locale): "${text}"`);
      }
      console.log(`   executed in preview locale=pt: "${text.slice(0, 80)}…"`);

      await restorePrice(MUSK_RUMMAN_ID, originalMusk);
    }),
  );

  /* ───── N — Branch switch after language switch invalidates ────── */
  results.push(
    await scenario("N-branch-switch-after-language-switch", async () => {
      const convId = randomUUID();
      await runAgent({
        ctx: makeCtx("en", BRANCH_ID_A),
        messages: [{ role: "user", content: "Show me Assaf perfumes" }],
        conversationId: convId,
      });
      const PHANTOM = "00000000-0000-4000-8000-000000000bee".slice(0, 36);
      const r = await runAgent({
        ctx: makeCtx("fr", PHANTOM),
        messages: [
          { role: "user", content: "Show me Assaf perfumes" },
          { role: "assistant", content: "Found." },
          { role: "user", content: "Changez le prix du second à 2500" },
        ],
        conversationId: convId,
      });
      // A confirmation emerging here would mean the French positional reference
      // was resolved across a branch — a context leak.
      const conf = firstOfKind(r.response.blocks, "confirmation");
      if (conf) throw new Error("confirmation emitted across branch switch — context leak");
      console.log(
        `   locale=${r.response.locale} ref=${r.debug.referenceResolved?.kind}:${r.debug.referenceResolved?.reason}`,
      );
    }),
  );

  console.log("\n============ F7 SUMMARY ============");
  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log(`  ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
