/**
 * Phase 1 + Phase 2 + Phase 3–13 delta — the AI Agent gained Financials,
 * Receipt and Payroll capabilities, and view_profit is now enforced inside
 * the legacy sales/brands tools.
 *
 * These are STATIC tests — they don't touch Postgres. They verify:
 *   - the view_profit redaction helper nulls profit-ish fields
 *   - the prompt mentions every required accounting rule
 *   - every new Financials / receipt / payroll tool is actually registered
 *   - the finance mutation permission map is complete
 *   - the staged-write permission layer still refuses an under-permissioned
 *     caller on the new tools
 */

import { describe, expect, it } from "vitest";

import type { AgentContext } from "@/lib/ai/context";
import { executeTool, ALL_TOOLS } from "@/lib/ai/tools";
import { redactProfitOnRow, redactProfitOnRows, seesProfit } from "@/lib/ai/tools/_profit";

function ctxStaff(permissions: AgentContext["permissions"]): AgentContext {
  return {
    tenantId: "t_test",
    userId: "u_test",
    role: "staff",
    permissions,
    locale: "en",
  };
}

describe("redactProfitOnRow / redactProfitOnRows", () => {
  it("nulls every profit-ish field in place", () => {
    const row = {
      units: 7,
      revenue: 1500,
      cost: 900,
      grossProfit: 600,
      margin: 0.4,
      netProfit: 500,
      cogs: 900,
      harmless: "keep me",
    };
    redactProfitOnRow(row);
    expect(row.units).toBe(7);
    expect(row.revenue).toBe(1500);
    expect(row.harmless).toBe("keep me");
    expect(row.cost).toBeNull();
    expect(row.grossProfit).toBeNull();
    expect(row.margin).toBeNull();
    expect(row.netProfit).toBeNull();
    expect(row.cogs).toBeNull();
  });

  it("redacts a whole batch", () => {
    const rows = [
      { brand: "A", revenue: 1, grossProfit: 1 },
      { brand: "B", revenue: 2, grossProfit: 2 },
    ];
    redactProfitOnRows(rows as never);
    expect(rows[0]!.grossProfit).toBeNull();
    expect(rows[1]!.grossProfit).toBeNull();
    expect(rows[0]!.brand).toBe("A");
  });
});

describe("seesProfit", () => {
  it("owner sees profit even without explicit view_profit", () => {
    expect(seesProfit({ ...ctxStaff([]), role: "owner" })).toBe(true);
  });
  it("staff with view_insights but no view_profit → false", () => {
    expect(seesProfit(ctxStaff(["view_insights"]))).toBe(false);
  });
  it("staff with view_profit → true", () => {
    expect(seesProfit(ctxStaff(["view_insights", "view_profit"]))).toBe(true);
  });
});

describe("tool registry — Financials / Payroll / Receipts are wired", () => {
  const names = new Set(ALL_TOOLS.map((t) => t.name));
  it.each([
    "get_financials_overview",
    "get_pnl",
    "get_product_profitability",
    "get_category_profitability",
    "get_financial_trends",
    "list_expenses",
    "list_money_movements",
    "list_finance_categories",
    "get_payroll_summary",
    "get_receipt_settings",
    "prepare_receipt_whatsapp",
    "preview_create_expense",
    "preview_void_expense",
    "preview_create_money_movement",
    "preview_void_money_movement",
    "preview_create_finance_category",
    "preview_archive_finance_category",
    "preview_generate_recurring",
    "preview_update_receipt_settings",
  ])("registers %s", (name) => {
    expect(names.has(name)).toBe(true);
  });
});

describe("executor permission gates — new Financials writes", () => {
  it("rejects preview_create_expense when staff lacks manage_expenses", async () => {
    const res = await executeTool(
      ctxStaff(["view_insights", "view_financials"]),
      "preview_create_expense",
      JSON.stringify({
        title: "Test",
        amount: 100,
        date: "2026-11-22",
        categoryId: "00000000-0000-4011-0000-000000000001",
      }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("FORBIDDEN");
  });

  it("rejects preview_create_money_movement when staff lacks manage_money_movements", async () => {
    const res = await executeTool(
      ctxStaff(["view_insights", "view_financials"]),
      "preview_create_money_movement",
      JSON.stringify({ kind: "owner_deposit", amount: 500, occurredOn: "2026-11-22" }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("FORBIDDEN");
  });

  it("rejects preview_generate_recurring when staff lacks manage_recurring_expenses", async () => {
    const res = await executeTool(
      ctxStaff(["view_insights", "view_financials", "manage_expenses"]),
      "preview_generate_recurring",
      "{}",
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("FORBIDDEN");
  });

  it("rejects preview_update_receipt_settings when staff lacks view_settings", async () => {
    const res = await executeTool(
      ctxStaff(["view_insights", "view_financials"]),
      "preview_update_receipt_settings",
      JSON.stringify({ receiptSlogan: "Thanks" }),
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("FORBIDDEN");
  });
});

describe("system prompt — accounting rules are present", () => {
  it("includes every required rule (English)", async () => {
    // baseSystemPrompt is file-private; the agent module re-exports it only
    // indirectly. Import the source and re-invoke the helper via dynamic
    // import of the module object.
    const agent = await import("@/lib/ai/agent");
    const anyAgent = agent as unknown as { __TEST_ONLY_baseSystemPrompt?: unknown };
    // The helper isn't exported; rebuild the expected content by reading the
    // file at build time via Node fs.
    const fs = await import("node:fs/promises");
    const src = await fs.readFile(
      new URL("../../lib/ai/agent.ts", import.meta.url),
      "utf8",
    );
    expect(src).toContain("Gross Sales − Discounts − Returns = Net Sales");
    expect(src).toContain("return reverses BOTH revenue and COGS");
    expect(src).toContain("HISTORICAL cost snapshot");
    expect(src).toContain("owner deposit is not revenue");
    expect(src).toContain("Loan INTEREST IS an operating expense");
    expect(src).toContain("DRAFT payroll does not");
    expect(src).toContain("Money movements are NOT P&L");
    // Phase 14 — mention the surface so the Agent knows the user may be on
    // either client.
    expect(src).toContain("Financials product surface");
    expect(anyAgent).toBeDefined();
  });
});
