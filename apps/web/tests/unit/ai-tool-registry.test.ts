/**
 * Tool-registry gates: the executor must refuse to dispatch a tool when the
 * authenticated user is missing its `requiredPermission`, UNLESS the user is
 * an owner (owners implicitly hold every permission).
 *
 * We don't exercise the handlers themselves here — those hit Postgres and are
 * covered by the integration tests. This file is the FORBIDDEN / UNKNOWN_TOOL
 * safety net that keeps the registry's contract honest independent of the DB.
 */
import { describe, expect, it } from "vitest";

import type { AgentContext } from "@/lib/ai/context";
import { executeTool } from "@/lib/ai/tools";
import { ALL_TOOLS, DATA_TOOLS } from "@/lib/ai/tools";

function makeCtx(overrides: Partial<AgentContext> = {}): AgentContext {
  return {
    tenantId: "t_test",
    userId: "u_test",
    role: "staff",
    permissions: ["view_insights"],
    locale: "en",
    ...overrides,
  };
}

describe("executeTool — permission gates", () => {
  it("rejects an unknown tool name", async () => {
    const res = await executeTool(makeCtx(), "nonexistent_tool", "{}");
    expect(res).toEqual({
      ok: false,
      error: "UNKNOWN_TOOL",
      reason: "nonexistent_tool",
    });
  });

  it("rejects a tool whose requiredPermission the user lacks", async () => {
    // get_employees_on_leave requires manage_team, which the base ctx lacks.
    const res = await executeTool(
      makeCtx({ permissions: ["view_insights"], role: "staff" }),
      "get_employees_on_leave",
      "{}",
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).toBe("FORBIDDEN");
  });

  it("lets an owner through regardless of explicit permissions", async () => {
    // We don't fully execute (would need DB), but a missing-permission
    // rejection would come back BEFORE the handler tries to connect. We give
    // bad args to force an INVALID_ARGS failure deeper in the stack — the key
    // signal is that we got PAST the FORBIDDEN gate.
    const res = await executeTool(
      makeCtx({ role: "owner", permissions: [] }),
      "get_employees_on_leave",
      "{\"from\": \"not-a-date\"}",
    );
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).not.toBe("FORBIDDEN");
  });

  it("rejects malformed JSON args without executing the handler", async () => {
    const res = await executeTool(makeCtx(), "render_text", "{not json");
    expect(res).toEqual({
      ok: false,
      error: "INVALID_ARGS",
      reason: expect.stringContaining("render_text"),
    });
  });
});

describe("tool registry invariants", () => {
  it("every data tool has a required permission or opts in explicitly", () => {
    // We don't force the invariant yet (sales/brands/payments are open to
    // anyone with view_insights, which the route already gates on). What we
    // DO want is to be sure no tool silently relies on the LLM's good
    // behaviour for authorisation — the registry metadata is the audit trail.
    for (const t of DATA_TOOLS) {
      // Known-open tools (gated by route-level view_insights permission only).
      const ROUTE_GATED = new Set([
        "get_sales_overview",
        "get_sales_trend",
        "get_top_brands",
        "get_payment_mix",
        // Phase B P1 W1.2 — same shape/sensitivity as get_sales_overview
        // (period-vs-prior rollup). Gated by view_insights at the chat route.
        "get_sales_comparison",
      ]);
      if (ROUTE_GATED.has(t.name)) continue;
      expect(t.requiredPermission, `${t.name} must declare a permission`).toBeDefined();
    }
  });

  it("render_* meta-tools do NOT require a permission (they do no I/O)", () => {
    const renders = ALL_TOOLS.filter((t) => t.name.startsWith("render_"));
    expect(renders.length).toBeGreaterThan(0);
    for (const t of renders) {
      expect(t.requiredPermission).toBeUndefined();
    }
  });

  it("has no duplicate tool names", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
