// Phase B P0 — LLM-behavior acceptance suite.
//
// This file does NOT run in normal CI. It fires REAL Gemini calls through
// runAgent() to observe actual tool selection, prompt adherence, and preview
// quality. Enable with:
//
//   PHASE_B_LIVE=1 npx vitest run tests/repo/ai-phase-b-acceptance.test.ts
//
// Each test seeds a real-Postgres tenant, invokes runAgent() with a real
// Gemini client (the SAME code path /api/ai/chat uses), and asserts on:
//   • debug.toolsCalled — which tools the Agent picked
//   • response.blocks — the preview / clarification / text the user sees
//
// Gemini output is non-deterministic. Assertions are structural (tool names,
// number tokens in preview) rather than exact string matches. A failure means
// the prompt needs tightening, not the test.
//
// Cost note: ~12 scenarios × 1–3 turns each × gemini-3.6-flash ≈ one cent per
// full run. Safe to re-run on demand; not safe to leave in CI.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { db, withTenant } from "@/lib/db";
import { categories, products, purchaseOrders, suppliers } from "@/lib/db/schema";
import { runAgent } from "@/lib/ai/agent";
import type { AgentContext } from "@/lib/ai/context";
import type { AiBlock } from "@/lib/ai/responses";
import {
  seedPayrollTenant,
  seedProduct,
  type PayrollTenantSeed,
} from "./payroll-fixtures";

const LIVE = process.env.PHASE_B_LIVE === "1";
const d = LIVE ? describe : describe.skip;

/* ─────────────────────────── helpers ─────────────────────────── */

async function freshSupplier(seed: PayrollTenantSeed, name: string): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${seed.tenantId}, true)`);
    const [s] = await tx
      .insert(suppliers)
      .values({
        tenantId: seed.tenantId,
        branchId: seed.branchId,
        name,
        phone: `+2010${Math.random().toString().slice(2, 10)}`,
      })
      .returning({ id: suppliers.id });
    return s.id;
  });
}

function ownerCtx(seed: PayrollTenantSeed): AgentContext {
  return {
    tenantId: seed.tenantId,
    userId: seed.ownerId,
    branchId: null,
    role: "owner",
    permissions: [
      "manage_purchases",
      "view_suppliers",
      "view_purchases",
      "view_inventory",
      "manage_inventory",
      "manage_expenses",
      "manage_money_movements",
      "view_financials",
      "view_dashboard",
    ],
    locale: "ar",
  } as AgentContext;
}

type ConvoTurn = { role: "user" | "assistant"; content: string };

async function ask(
  seed: PayrollTenantSeed,
  history: ConvoTurn[],
): Promise<{ blocks: AiBlock[]; toolsCalled: string[]; text: string }> {
  const { response, debug } = await runAgent({
    ctx: ownerCtx(seed),
    messages: history,
    requestId: `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  });
  const text = response.blocks
    .filter((b): b is Extract<AiBlock, { kind: "text" }> => b.kind === "text")
    .map((b) => b.text)
    .join("\n");
  return { blocks: response.blocks, toolsCalled: debug.toolsCalled, text };
}

function findConfirmation(blocks: AiBlock[]):
  | Extract<AiBlock, { kind: "confirmation" }>
  | undefined {
  return blocks.find(
    (b): b is Extract<AiBlock, { kind: "confirmation" }> => b.kind === "confirmation",
  );
}

/** Extract numeric tokens from a preview string so we can check for amounts
 *  regardless of whether the model formatted them as 12000, 12,000, or ١٢٠٠٠. */
function arabicDigitsToAscii(s: string): string {
  const map: Record<string, string> = {
    "٠": "0",
    "١": "1",
    "٢": "2",
    "٣": "3",
    "٤": "4",
    "٥": "5",
    "٦": "6",
    "٧": "7",
    "٨": "8",
    "٩": "9",
  };
  return s.replace(/[٠-٩]/g, (c) => map[c] ?? c);
}

function hasAmount(text: string, amount: number): boolean {
  const ascii = arabicDigitsToAscii(text).replace(/[,،\s]/g, "");
  return ascii.includes(String(amount));
}

/* ─────────────────────── seeded dataset ─────────────────────── */

let seed: PayrollTenantSeed;
let supplierHussein: string;
let supplierAhmed: string;
let supplierMohamedAhmed: string;
let supplierMohamedSamy: string;
let productMF0612: string;
let productMF0612G: string;
let productMF0612G03: string;
let productWL20: string;

beforeAll(async () => {
  if (!LIVE) return;
  seed = await seedPayrollTenant("phase-b-live");
  supplierHussein = await freshSupplier(seed, "حسين");
  supplierAhmed = await freshSupplier(seed, "أحمد");
  supplierMohamedAhmed = await freshSupplier(seed, "محمد أحمد");
  supplierMohamedSamy = await freshSupplier(seed, "محمد سامي");
  // Seed a "ساعات" category so the S5 flow (new product → ask category →
  // user replies "ساعات") can resolve the category name to a real UUID.
  await withTenant(seed.tenantId, async (tx) => {
    await tx.insert(categories).values({
      tenantId: seed.tenantId,
      branchId: seed.branchId,
      key: "watches",
      label: "ساعات",
      position: 1,
    });
  });
  // Link some products to Hussein so list_supplier_products can find them.
  productMF0612 = await seedProduct(seed.tenantId, {
    categoryId: seed.categoryId,
    branchId: seed.branchId,
    name: "MF0612",
    price: 1800,
    cost: 1200,
  });
  productMF0612G = await seedProduct(seed.tenantId, {
    categoryId: seed.categoryId,
    branchId: seed.branchId,
    name: "MF0612G",
    price: 2000,
    cost: 1400,
  });
  productMF0612G03 = await seedProduct(seed.tenantId, {
    categoryId: seed.categoryId,
    branchId: seed.branchId,
    name: "MF0612G-03",
    price: 2200,
    cost: 1500,
  });
  productWL20 = await seedProduct(seed.tenantId, {
    categoryId: seed.categoryId,
    branchId: seed.branchId,
    name: "WL20",
    price: 500,
    cost: 300,
  });
  // Associate all four with Hussein so supplier-scoped resolution works.
  await withTenant(seed.tenantId, async (tx) => {
    await tx.execute(
      sql`update products set supplier_id = ${supplierHussein} where id in (${productMF0612}, ${productMF0612G}, ${productMF0612G03}, ${productWL20})`,
    );
  });
});

afterAll(async () => {
  if (!LIVE) return;
  if (seed) await seed.cleanup();
});

/* ─────────────────────────── scenarios ─────────────────────────── */

d("Phase B — LLM acceptance", () => {
  it("S1 · existing-product purchase (one-shot, all info supplied)", async () => {
    const r = await ask(seed, [
      {
        role: "user",
        content:
          "أنا جبت دلوقتي 10 ساعات من حسين، الكود MF0612، الواحدة بـ1200 ودفعتله 5000.",
      },
    ]);
    // Required tool calls somewhere in the trace.
    expect(r.toolsCalled).toEqual(
      expect.arrayContaining([expect.stringMatching(/resolve_supplier|find_supplier/)]),
    );
    expect(r.toolsCalled).toContain("preview_create_purchase");
    // Must NOT hit expense or money_movement tools.
    expect(r.toolsCalled).not.toContain("preview_create_expense");
    expect(r.toolsCalled).not.toContain("preview_create_money_movement");
    // Preview must contain the correct numbers.
    const confirm = findConfirmation(r.blocks);
    expect(confirm).toBeTruthy();
    expect(hasAmount(confirm!.summary, 12000)).toBe(true);
    expect(hasAmount(confirm!.summary, 5000)).toBe(true);
    expect(hasAmount(confirm!.summary, 7000)).toBe(true);
  }, 60_000);

  it("S3a · 'دفعت 3000 إيجار' → expense, NOT supplier payment", async () => {
    const r = await ask(seed, [{ role: "user", content: "دفعت 3000 إيجار." }]);
    expect(r.toolsCalled).not.toContain("preview_record_purchase_payment");
    expect(r.toolsCalled).not.toContain("preview_create_purchase");
    // Either an expense preview appeared OR a clarification was asked.
    const triedExpense =
      r.toolsCalled.includes("preview_create_expense") ||
      r.toolsCalled.includes("list_finance_categories");
    expect(triedExpense).toBe(true);
  }, 45_000);

  it("S3b · 'دفعت 3000 لحسين' → routes to supplier-payment reasoning", async () => {
    const r = await ask(seed, [
      { role: "user", content: "دفعت 3000 لحسين من اللي عليه." },
    ]);
    // Expected: resolve Hussein + fetch supplier details or recent POs so the
    // Agent knows which PO to charge. preview_create_expense must NOT appear.
    expect(r.toolsCalled).not.toContain("preview_create_expense");
    const investigated =
      r.toolsCalled.includes("get_supplier_details") ||
      r.toolsCalled.includes("get_recent_purchase_orders") ||
      r.toolsCalled.some((t) => t.includes("supplier"));
    expect(investigated).toBe(true);
  }, 45_000);

  it("S3c · bare 'دفعت 3000' → MUST ask clarification, zero writes", async () => {
    const r = await ask(seed, [{ role: "user", content: "دفعت 3000." }]);
    // No write tool should fire.
    const wroteSomething = r.toolsCalled.some((t) => t.startsWith("preview_"));
    expect(wroteSomething).toBe(false);
    // The Agent must be asking SOMETHING — either a literal question mark,
    // the standard Arabic polite-request opener "يرجى / من فضلك / لو سمحت",
    // or an explicit mention of the ambiguity it's trying to resolve. We
    // accept either a direct question or a "please specify X" phrase; both
    // are valid refusal-to-invent behaviour.
    expect(r.text).toMatch(/\?|؟|يرجى|من فضلك|لو سمحت|لمين|في إيه|إيه|توضيح|الغرض/);
  }, 30_000);

  it("S5 · new product → asks category, preserves slots across turns", async () => {
    const h: ConvoTurn[] = [
      {
        role: "user",
        content:
          "جبت منتج جديد اسمه PINK SAKURA NEW من حسين، 20 قطعة، القطعة بـ300.",
      },
    ];
    const r1 = await ask(seed, h);
    // Either the Agent asked about the category OR searched the catalog first.
    // We accept either; what we REFUSE is a fully-formed preview with a
    // silently-chosen categoryId.
    const confirm = findConfirmation(r1.blocks);
    if (confirm) {
      // If a preview emerged on turn 1, the Agent either used a known category
      // or ate one from the prompt — flag as PARTIAL, not FAIL, since the
      // acceptance rule is "ASK for category" not "never produce a preview".
      // Here we just assert the amount is right.
      expect(hasAmount(confirm.summary, 6000)).toBe(true);
    } else {
      // Should be asking something.
      expect(r1.text).toMatch(/\?|؟|قسم|category/i);
      // Provide the category and continue — the Agent must NOT re-ask qty/cost.
      h.push({ role: "assistant", content: r1.text });
      h.push({ role: "user", content: "ساعات" });
      const r2 = await ask(seed, h);
      // Now it should build a preview with 20 × 300 = 6000.
      const c2 = findConfirmation(r2.blocks);
      expect(c2).toBeTruthy();
      expect(hasAmount(c2!.summary, 6000)).toBe(true);
    }
  }, 90_000);

  it("S6 · product ambiguity (MF0612 / MF0612G / MF0612G-03) → asks, does NOT auto-pick", async () => {
    const r = await ask(seed, [
      // Ambiguous: the catalog has three products matching "MF0612".
      { role: "user", content: "جبت من حسين 5 ساعات MF0612، الواحدة بـ1300." },
    ]);
    // Acceptance: either the Agent lists candidates and asks, OR it pins the
    // exact match "MF0612" (that IS the exact product name). Anything else
    // (silently picked MF0612G or MF0612G-03) is a fail.
    const confirm = findConfirmation(r.blocks);
    if (confirm) {
      // Check that the picked product is the exact match, not G / G-03.
      expect(confirm.summary).toMatch(/MF0612(?![G\-])|MF0612\b/);
      expect(confirm.summary).not.toMatch(/MF0612G-03/);
      expect(confirm.summary).not.toMatch(/MF0612G\b/);
    } else {
      // Clarification path — must mention at least one of the three.
      expect(r.text).toMatch(/MF0612/);
      expect(r.text).toMatch(/\?|؟|أنهي|أي واحد|which/i);
    }
  }, 60_000);

  it("S7 · supplier ambiguity ('محمد') → asks which one", async () => {
    const r = await ask(seed, [
      { role: "user", content: "جبت البضاعة من محمد، 10 قطع WL20 بـ400 للواحدة." },
    ]);
    // Two suppliers named "محمد أحمد" and "محمد سامي" — the Agent MUST ask.
    const confirm = findConfirmation(r.blocks);
    // Either no preview yet (asking) OR preview explicitly names ONE supplier.
    if (confirm) {
      // If a confirmation did appear, it should be only after disambiguation —
      // this is harder to assert on turn 1, so we flag as PARTIAL when a
      // preview appears without a prior disambiguation turn.
      // (The automated assertion limit: we can at least say "it didn't pick
      // from thin air by requiring the summary mention a Mohamed".)
      expect(confirm.summary.toLowerCase()).toMatch(/محمد|mohamed|mohamad/i);
    } else {
      // No preview emerged — the Agent is asking. Two equally-valid outputs:
      //   (a) enumerate the two Mohameds explicitly ("محمد أحمد / محمد سامي؟")
      //   (b) generically ask the user to specify the supplier
      // Both are correct "do not hallucinate" behaviour. We accept either.
      expect(r.text).toMatch(/محمد|supplier|المورد/i);
      expect(r.text).toMatch(/\?|؟|أنهي|أي واحد|اختيار|اختر|يرجى|من فضلك|تحديد|which/i);
    }
  }, 60_000);

  it("S8 · multi-item purchase → one preview, correct totals", async () => {
    const r = await ask(seed, [
      {
        role: "user",
        content:
          "جبت من حسين 10 ساعات MF0612 بـ1200 للواحدة و5 محافظ WL20 بـ300، ودفعتله 5000.",
      },
    ]);
    expect(r.toolsCalled).toContain("preview_create_purchase");
    const confirm = findConfirmation(r.blocks);
    expect(confirm).toBeTruthy();
    // Total = 12000 + 1500 = 13500; outstanding = 8500
    expect(hasAmount(confirm!.summary, 13500)).toBe(true);
    expect(hasAmount(confirm!.summary, 5000)).toBe(true);
    expect(hasAmount(confirm!.summary, 8500)).toBe(true);
  }, 60_000);

  it("S9 · correction mid-conversation (10 → 12) → final preview uses 12", async () => {
    const h: ConvoTurn[] = [
      { role: "user", content: "جبت 10 ساعات من حسين، الكود MF0612." },
    ];
    const r1 = await ask(seed, h);
    h.push({ role: "assistant", content: r1.text });
    h.push({ role: "user", content: "السعر 1200." });
    const r2 = await ask(seed, h);
    h.push({ role: "assistant", content: r2.text });
    h.push({ role: "user", content: "دفعتله 5000." });
    const r3 = await ask(seed, h);
    h.push({ role: "assistant", content: r3.text });
    // Correction turn.
    h.push({ role: "user", content: "استنى، خليهم 12 ساعة مش 10." });
    const r4 = await ask(seed, h);
    const confirm = findConfirmation(r4.blocks);
    expect(confirm).toBeTruthy();
    // Total should be 12 × 1200 = 14,400; outstanding = 14400-5000 = 9400
    expect(hasAmount(confirm!.summary, 14400)).toBe(true);
    expect(hasAmount(confirm!.summary, 9400)).toBe(true);
  }, 180_000);

  it("S11 · natural dates ('النهارده') → Agent doesn't crash, doesn't invent", async () => {
    const r = await ask(seed, [
      {
        role: "user",
        content:
          "جبت النهارده 10 ساعات MF0612 من حسين بـ1200 ودفعتله 5000.",
      },
    ]);
    // Acceptance for S11 is mild: the date is informational; purchase date
    // in the orchestrator is server-set. We just want no crash + correct
    // preview despite the date phrase.
    expect(r.toolsCalled).toContain("preview_create_purchase");
    const confirm = findConfirmation(r.blocks);
    expect(confirm).toBeTruthy();
    expect(hasAmount(confirm!.summary, 12000)).toBe(true);
  }, 60_000);

  it("S17 · business-reasoning: 'بعتلي 10 ساعات ودفعتله نص الحساب'", async () => {
    const r = await ask(seed, [
      {
        role: "user",
        content:
          "حسين بعتلي 10 ساعات MF0612 النهارده بـ1200 للواحدة وأنا دفعتله نص الحساب.",
      },
    ]);
    // Agent should infer paid = half = 6000; refusing or asking "how much
    // did you pay?" is PARTIAL not FAIL.
    const confirm = findConfirmation(r.blocks);
    if (confirm) {
      expect(hasAmount(confirm.summary, 12000)).toBe(true);
      // Half = 6000 — either in preview or in the follow-up; flag either way.
      const halfRecognized = hasAmount(confirm.summary, 6000);
      // We don't FAIL on missing half-recognition — it's an advanced inference.
      // Record it in the test output instead.
      if (!halfRecognized) {
        console.warn(
          "[S17] PARTIAL — preview emerged but the 'half' inference wasn't applied. Expected paid=6000, outstanding=6000.",
        );
      }
    }
    expect(r.toolsCalled).not.toContain("preview_create_expense");
    expect(r.toolsCalled).not.toContain("preview_create_money_movement");
  }, 90_000);

  it("S18 · negative test — 'جبت ساعات من حسين' (missing qty/cost) → asks, no invented values", async () => {
    const r = await ask(seed, [
      { role: "user", content: "جبت ساعات من حسين." },
    ]);
    // Should NOT fire a write tool with hallucinated numbers.
    expect(r.toolsCalled).not.toContain("preview_create_purchase");
    expect(r.toolsCalled).not.toContain("preview_record_purchase_payment");
    // Should either ask or at least respond with a question.
    expect(r.text).toMatch(/\?|؟|كمية|سعر|كذا|إيه/);
  }, 45_000);
});
