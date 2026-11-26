import "dotenv/config";

import { runAgent } from "@/lib/ai/agent";
import type { AgentContext } from "@/lib/ai/context";
import type { AiBlock, AgentResponse } from "@/lib/ai/responses";

/**
 * F2/F3 grounded-product regression suite.
 *
 * MANDATORY per the F-plan: the "عندك برفانات assaf؟" scenario and its
 * variants MUST return real database products (there are two Assaf products
 * in the dev tenant: "Musk Rumman" and "Pink Diva"), and MUST refuse to
 * invent a product for an unknown term.
 *
 * Run with:  npx tsx --import ./scripts/_stub-server-only.ts scripts/smoke-ai-f2.ts
 */

const TENANT_ID = "f1290217-62c3-423e-9447-defb24c37734";
const OWNER_USER_ID = "5df7dd36-6ce0-4c53-8542-a173b417adb6";
const BRANCH_ID = "90905c29-e828-4fc1-9932-b101f2512a86";

interface Scenario {
  id: string;
  title: string;
  locale: "ar" | "en";
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  expect: (res: AgentResponse) => string[];
}

const KNOWN_ASSAF_PRODUCT_IDS = new Set([
  "e3a4006d-d1c1-4060-ac89-fded38314e7d", // Musk Rumman
  "4208d453-b3d1-463c-b195-d000575c00d0", // Pink Diva
]);

const SCENARIOS: Scenario[] = [
  {
    id: "assaf-ar-plural",
    title: "عندك برفانات assaf؟ — Arabic plural, Latin brand",
    locale: "ar",
    messages: [{ role: "user", content: "عندك برفانات assaf؟" }],
    expect: (r) => assertAssafProductsReturned(r, 2),
  },
  {
    id: "assaf-ar-singular",
    title: "عندك برفان assaf؟ — Arabic singular",
    locale: "ar",
    messages: [{ role: "user", content: "عندك برفان assaf؟" }],
    expect: (r) => assertAssafProductsReturned(r, 1),
  },
  {
    id: "assaf-ar-script",
    title: "برفان أساف — Arabic script",
    locale: "ar",
    messages: [{ role: "user", content: "برفان أساف" }],
    expect: (r) => assertAssafProductsReturned(r, 1),
  },
  {
    id: "assaf-ar-script-no-hamza",
    title: "برفان اساف — Arabic script, no hamza",
    locale: "ar",
    messages: [{ role: "user", content: "برفان اساف" }],
    expect: (r) => assertAssafProductsReturned(r, 1),
  },
  {
    id: "assaf-en",
    title: "Assaf perfume — English",
    locale: "en",
    messages: [{ role: "user", content: "Do you have Assaf perfume?" }],
    expect: (r) => assertAssafProductsReturned(r, 1),
  },
  {
    id: "assaf-en-show",
    title: "Show me Assaf products — English",
    locale: "en",
    messages: [{ role: "user", content: "Show me Assaf products." }],
    expect: (r) => assertAssafProductsReturned(r, 2),
  },
  {
    id: "unknown-product",
    title: "برفان XYZ12345 — unknown product MUST NOT be invented",
    locale: "ar",
    messages: [{ role: "user", content: "عندك برفان XYZ12345؟" }],
    expect: (r) => {
      const errs: string[] = [];
      const cards = r.blocks.filter((b) => b.kind === "product_card");
      if (cards.length > 0) {
        errs.push(`FABRICATED: emitted ${cards.length} product_card for an unknown query`);
      }
      // Must contain SOME user-facing content (text) that says no match.
      const hasText = r.blocks.some((b) => b.kind === "text");
      if (!hasText) errs.push("no text block explaining the miss");
      return errs;
    },
  },
];

function assertAssafProductsReturned(r: AgentResponse, minCards: number): string[] {
  const errs: string[] = [];
  const cards = r.blocks.filter((b): b is Extract<AiBlock, { kind: "product_card" }> => b.kind === "product_card");
  if (cards.length < minCards) {
    errs.push(`expected >= ${minCards} product_card(s), got ${cards.length}`);
  }
  for (const c of cards) {
    if (!KNOWN_ASSAF_PRODUCT_IDS.has(c.productId)) {
      errs.push(`ungrounded product_id: ${c.productId} (name=${c.name}) — NOT an Assaf product in the DB`);
    }
    if (c.price <= 0) errs.push(`card ${c.name} has no price`);
  }
  // Language check — rough; locale enforcement is tested elsewhere.
  if (r.locale === "ar") {
    for (const b of r.blocks) {
      if (b.kind === "text" && /[a-z]{10,}/i.test(b.text)) {
        errs.push(`text block looks heavily English despite locale=ar: ${b.text.slice(0, 80)}`);
      }
    }
  }
  return errs;
}

function blockSummary(b: AiBlock): string {
  switch (b.kind) {
    case "text":
      return `text(${b.text.length} chars): ${b.text.slice(0, 60).replace(/\n/g, " ")}…`;
    case "chart":
      return `chart(${b.chartType}, "${b.title}")`;
    case "table":
      return `table("${b.title}", ${b.rows.length} rows)`;
    case "kpi":
      return `kpi(${b.items.length} items)`;
    case "confirmation":
      return `confirmation("${b.title}")`;
    case "product_card":
      return `product_card(id=${b.productId.slice(0, 8)}…, name="${b.name}", brand="${b.brand ?? "-"}", price=${b.price}, qty=${b.quantity})`;
  }
}

async function runScenario(s: Scenario): Promise<{ ok: boolean; errors: string[]; elapsedMs: number }> {
  const start = Date.now();
  const ctx: AgentContext = {
    tenantId: TENANT_ID,
    userId: OWNER_USER_ID,
    branchId: BRANCH_ID,
    role: "owner",
    permissions: [],
    locale: s.locale,
  };
  try {
    const { response, debug } = await runAgent({ ctx, messages: s.messages });
    const errors = s.expect(response);
    console.log(`\n── [${s.id}] ${s.title}`);
    console.log(`   provider=${debug.provider} model=${debug.model} rounds=${debug.roundsUsed} tools=[${response.toolsCalled.join(", ")}]`);
    for (const b of response.blocks) console.log(`     • ${blockSummary(b)}`);
    if (errors.length === 0) {
      console.log(`   ✅ PASS (${Date.now() - start}ms)`);
    } else {
      console.log(`   ❌ FAIL (${Date.now() - start}ms)`);
      for (const e of errors) console.log(`     - ${e}`);
    }
    return { ok: errors.length === 0, errors, elapsedMs: Date.now() - start };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`\n── [${s.id}] ${s.title}`);
    console.log(`   💥 THREW: ${msg}`);
    return { ok: false, errors: [msg], elapsedMs: Date.now() - start };
  }
}

async function main() {
  const want = process.env.AI_PROVIDER === "groq" ? "GROQ_API_KEY" : "GEMINI_API_KEY";
  if (!process.env[want]) {
    console.error(`${want} missing — set it in apps/web/.env`);
    process.exit(2);
  }
  if (!process.env.APP_DATABASE_URL && !process.env.DATABASE_URL) {
    console.error("APP_DATABASE_URL / DATABASE_URL missing");
    process.exit(2);
  }

  const pick = process.argv.slice(2);
  const scenarios = pick.length === 0 ? SCENARIOS : SCENARIOS.filter((s) => pick.includes(s.id));
  if (scenarios.length === 0) {
    console.error("No scenarios matched");
    console.error("Known:", SCENARIOS.map((s) => s.id).join(", "));
    process.exit(2);
  }

  console.log(`Running ${scenarios.length} F2/F3 scenarios against tenant ${TENANT_ID}`);
  const results: Array<{ id: string; ok: boolean; errors: string[]; elapsedMs: number }> = [];
  for (const s of scenarios) {
    const r = await runScenario(s);
    results.push({ id: s.id, ok: r.ok, errors: r.errors, elapsedMs: r.elapsedMs });
  }

  console.log("\n============ SUMMARY ============");
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  for (const r of results) {
    console.log(`  ${r.ok ? "✅" : "❌"} ${r.id}  (${r.elapsedMs}ms)`);
    if (!r.ok) for (const e of r.errors) console.log(`      · ${e}`);
  }
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
