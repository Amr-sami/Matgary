import "dotenv/config";

import { runAgent } from "@/lib/ai/agent";
import type { AgentContext } from "@/lib/ai/context";
import { classifyText } from "@/lib/ai/language";
import type { AgentResponse, AiBlock } from "@/lib/ai/responses";

/**
 * W3 production-readiness smoke test (server-side, no HTTP layer).
 *
 * Exercises the real agent against:
 *   • a real Groq key (GROQ_API_KEY from .env)
 *   • a real Postgres tenant (DATABASE_URL from .env)
 *   • the real tool handlers (sales / brands / employees / renders)
 *
 * Pass CLI args to pick which scenarios to run; default is all.
 *
 * Usage:
 *   npx tsx apps/web/scripts/smoke-ai-w3.ts
 *   npx tsx apps/web/scripts/smoke-ai-w3.ts arabic-sales english-sales
 */

const TENANT_ID = "f1290217-62c3-423e-9447-defb24c37734"; // الحناوي ستور
const OWNER_USER_ID = "5df7dd36-6ce0-4c53-8542-a173b417adb6";
const BRANCH_ID = "90905c29-e828-4fc1-9932-b101f2512a86"; // الحناوي ستورز

interface Scenario {
  id: string;
  title: string;
  locale: "ar" | "en";
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  /** Checks run against the final AgentResponse. */
  expect: (res: AgentResponse) => string[];
}

const SCENARIOS: Scenario[] = [
  {
    id: "arabic-sales-chart",
    title: "Arabic — sales trend as a chart (expect chart block + Arabic locale)",
    locale: "ar",
    messages: [{ role: "user", content: "اوريني مبيعات آخر ٧ أيام في رسم بياني." }],
    expect: (r) => {
      const errs: string[] = [];
      if (r.locale !== "ar") errs.push(`locale expected ar, got ${r.locale}`);
      if (!r.blocks.some((b) => b.kind === "chart")) errs.push("no chart block emitted");
      if (!r.toolsCalled.includes("get_sales_trend") && !r.toolsCalled.includes("get_sales_overview")) {
        errs.push("no sales-data tool called");
      }
      // Language-match on every TEXT block.
      for (const b of r.blocks) {
        if (b.kind === "text" && classifyText(b.text) === "en") {
          errs.push(`text block in english: ${JSON.stringify(b.text).slice(0, 80)}`);
        }
        if (b.kind === "chart" && classifyText(b.title) === "en") {
          errs.push(`chart title in english: ${JSON.stringify(b.title)}`);
        }
      }
      return errs;
    },
  },
  {
    id: "english-overview-kpi",
    title: "English — monthly overview KPIs",
    locale: "en",
    messages: [{ role: "user", content: "How are my sales this month? Show KPIs." }],
    expect: (r) => {
      const errs: string[] = [];
      if (r.locale !== "en") errs.push(`locale expected en, got ${r.locale}`);
      if (!r.toolsCalled.includes("get_sales_overview")) errs.push("expected get_sales_overview");
      if (!r.blocks.some((b) => b.kind === "kpi" || b.kind === "text")) errs.push("no KPI or text block");
      for (const b of r.blocks) {
        if (b.kind === "text" && classifyText(b.text) === "ar") {
          errs.push(`text block in arabic: ${JSON.stringify(b.text).slice(0, 80)}`);
        }
      }
      return errs;
    },
  },
  {
    id: "english-top-customers-table",
    title: "English — top customers as a table",
    locale: "en",
    messages: [{ role: "user", content: "Who are my top 5 customers by total spend? Show them as a table." }],
    expect: (r) => {
      const errs: string[] = [];
      if (r.locale !== "en") errs.push(`locale expected en, got ${r.locale}`);
      if (!r.toolsCalled.includes("get_top_customers")) errs.push("expected get_top_customers");
      if (!r.blocks.some((b) => b.kind === "table")) errs.push("no table block emitted");
      return errs;
    },
  },
  {
    id: "arabic-employees-on-leave",
    title: "Arabic — employees on leave this week",
    locale: "ar",
    messages: [{ role: "user", content: "مين الموظفين اللي عندهم إجازة الأسبوع ده؟" }],
    expect: (r) => {
      const errs: string[] = [];
      if (r.locale !== "ar") errs.push(`locale expected ar, got ${r.locale}`);
      if (!r.toolsCalled.includes("get_employees_on_leave")) {
        errs.push("expected get_employees_on_leave");
      }
      return errs;
    },
  },
  {
    id: "arabic-attendance-summary",
    title: "Arabic — attendance summary last 30 days",
    locale: "ar",
    messages: [{ role: "user", content: "اعرضلي ملخص حضور الموظفين آخر شهر." }],
    expect: (r) => {
      const errs: string[] = [];
      if (r.locale !== "ar") errs.push(`locale expected ar, got ${r.locale}`);
      if (!r.toolsCalled.includes("get_attendance_summary")) {
        errs.push("expected get_attendance_summary");
      }
      return errs;
    },
  },
  {
    id: "mid-chat-switch-ar-to-en",
    title: "Mid-chat language switch — Arabic → English",
    locale: "en",
    messages: [
      { role: "user", content: "اوريني مبيعات اليوم." },
      { role: "assistant", content: "تمام، إجمالي مبيعات اليوم 500 جنيه." },
      { role: "user", content: "Thanks. Now show me the top 3 brands this month in English." },
    ],
    expect: (r) => {
      const errs: string[] = [];
      if (r.locale !== "en") errs.push(`locale expected en after switch, got ${r.locale}`);
      for (const b of r.blocks) {
        if (b.kind === "text" && classifyText(b.text) === "ar") {
          errs.push(`post-switch text in arabic: ${JSON.stringify(b.text).slice(0, 80)}`);
        }
      }
      return errs;
    },
  },
  {
    id: "mid-chat-switch-en-to-ar",
    title: "Mid-chat language switch — English → Arabic",
    locale: "ar",
    messages: [
      { role: "user", content: "Show me today's revenue." },
      { role: "assistant", content: "Today's revenue is 500 EGP." },
      { role: "user", content: "تمام، عايز قائمة أهم البراندات دلوقتي." },
    ],
    expect: (r) => {
      const errs: string[] = [];
      if (r.locale !== "ar") errs.push(`locale expected ar after switch, got ${r.locale}`);
      for (const b of r.blocks) {
        if (b.kind === "text" && classifyText(b.text) === "en") {
          errs.push(`post-switch text in english: ${JSON.stringify(b.text).slice(0, 80)}`);
        }
      }
      return errs;
    },
  },
  {
    id: "multi-tool",
    title: "Multi-tool — overview + brands",
    locale: "en",
    messages: [
      {
        role: "user",
        content: "Give me a monthly overview and then the top 3 brands this month.",
      },
    ],
    expect: (r) => {
      const errs: string[] = [];
      if (r.toolsCalled.length < 2) {
        errs.push(`expected >= 2 tool calls, got ${r.toolsCalled.length}: ${r.toolsCalled.join(",")}`);
      }
      return errs;
    },
  },
];

function blockSummary(b: AiBlock): string {
  switch (b.kind) {
    case "text":
      return `text(${b.text.length} chars): ${b.text.slice(0, 60).replace(/\n/g, " ")}…`;
    case "chart":
      return `chart(${b.chartType}, "${b.title}", ${b.data.length} rows, ${b.series.length} series)`;
    case "table":
      return `table("${b.title}", ${b.columns.length} cols × ${b.rows.length} rows)`;
    case "kpi":
      return `kpi(${b.items.length} items: ${b.items.map((i) => i.label).join(" | ")})`;
    case "confirmation":
      return `confirmation("${b.title}")`;
  }
}

async function runScenario(s: Scenario): Promise<{ ok: boolean; errors: string[]; resp: AgentResponse | null; elapsedMs: number }> {
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
    const { response, debug } = await runAgent({
      ctx,
      messages: s.messages,
    });
    const errors = s.expect(response);
    console.log(`\n── [${s.id}] ${s.title}`);
    console.log(`   provider=${debug.provider} model=${debug.model} locale=${response.locale} rounds=${debug.roundsUsed} tools=[${response.toolsCalled.join(", ")}] blocks=${response.blocks.length}`);
    for (const b of response.blocks) console.log(`     • ${blockSummary(b)}`);
    if (errors.length === 0) {
      console.log(`   ✅ PASS (${Date.now() - start}ms)`);
    } else {
      console.log(`   ❌ FAIL (${Date.now() - start}ms)`);
      for (const e of errors) console.log(`     - ${e}`);
    }
    return { ok: errors.length === 0, errors, resp: response, elapsedMs: Date.now() - start };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`\n── [${s.id}] ${s.title}`);
    console.log(`   💥 THREW: ${msg}`);
    return { ok: false, errors: [msg], resp: null, elapsedMs: Date.now() - start };
  }
}

async function main() {
  // AI_PROVIDER picks gemini (default) or groq; the chosen key must be set.
  const want = process.env.AI_PROVIDER === "groq" ? "GROQ_API_KEY" : "GEMINI_API_KEY";
  if (!process.env[want]) {
    console.error(`${want} missing — set it in apps/web/.env (AI_PROVIDER=${process.env.AI_PROVIDER ?? "gemini"})`);
    process.exit(2);
  }
  if (!process.env.APP_DATABASE_URL && !process.env.DATABASE_URL) {
    console.error("APP_DATABASE_URL / DATABASE_URL missing — set in apps/web/.env");
    process.exit(2);
  }

  const pick = process.argv.slice(2);
  const scenarios = pick.length === 0 ? SCENARIOS : SCENARIOS.filter((s) => pick.includes(s.id));
  if (scenarios.length === 0) {
    console.error(`No scenarios matched: ${pick.join(", ")}`);
    console.error("Known:", SCENARIOS.map((s) => s.id).join(", "));
    process.exit(2);
  }

  console.log(`Running ${scenarios.length} W3 smoke scenarios against tenant ${TENANT_ID}`);

  const results: Array<{ id: string; ok: boolean; errors: string[]; elapsedMs: number }> = [];
  // Groq free-tier TPM = 8000 on a rolling 60s window; each scenario burns
  // ~2.5k tokens, so 15s between runs is NOT enough — the window hasn't
  // cleared. 60s per scenario is safe on free tier (switch to parallel +
  // short pause on a Dev-tier key, TPM there is 300k).
  const PAUSE_MS = 60_000;
  for (let i = 0; i < scenarios.length; i++) {
    const s = scenarios[i]!;
    const r = await runScenario(s);
    results.push({ id: s.id, ok: r.ok, errors: r.errors, elapsedMs: r.elapsedMs });
    if (i < scenarios.length - 1) {
      process.stdout.write(`   (sleeping ${PAUSE_MS / 1000}s to respect TPM)\n`);
      await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    }
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
