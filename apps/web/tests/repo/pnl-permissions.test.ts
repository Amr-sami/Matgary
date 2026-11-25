// Slice 1 hardening — route-level permission enforcement for the new
// Financials APIs. Unlike the engine tests (which exercise pure math) and
// the integration tests (which exercise the SQL path), this file proves the
// authorization gate on the route handlers themselves.
//
// Approach matches the existing route-handler test pattern (see
// tests/unit/oversell.test.ts): mock `@/lib/api/auth-helpers` and invoke the
// route function directly. No forged cookies, no NextAuth internals.
//
// What's asserted:
//   • A deny from `requirePermission` surfaces as HTTP 403 — the real
//     function already returns 403 (see `apps/web/lib/api/auth-helpers.ts`),
//     so we just make sure the route surfaces that response untouched.
//   • The /pnl route honours `view_profit` by redacting profit fields when
//     the caller lacks it, without failing the request.
//   • The /pnl route never leaks profit numbers to a caller without
//     `view_profit` even when the user has `view_financials`.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

// The context we return from the mocked requirePermission for a happy path.
const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

/** Switcher toggled per test. requirePermission's mock returns context when
 *  `holds.has(perm)`, and a 403 response otherwise. */
const holds = new Set<string>();

vi.mock("@/lib/api/auth-helpers", async () => {
  // Not using `importActual` — the real module pulls in auth() and headers()
  // which need a request scope. We mimic the deny shape the real function
  // returns (403 "Forbidden") so routes behave as in production.
  return {
    requirePermission: vi.fn(async (perm: string) => {
      if (holds.has(perm)) {
        return {
          ok: true as const,
          ctx: {
            userId: USER,
            tenantId: TENANT,
            role: "staff" as const,
            // `view_profit` conditionally present so the /pnl redaction
            // branch can be exercised.
            permissions: Array.from(holds),
            locale: "en" as const,
          },
        };
      }
      return {
        ok: false as const,
        response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      };
    }),
    // Also stubbed so unrelated helpers resolved via `@/lib/api/auth-helpers`
    // don't blow up at import time.
    requirePermissionAudited: vi.fn(),
    requirePermissionWithBranch: vi.fn(),
    requirePermissionWithBranchEnforced: vi.fn(),
    requireTenant: vi.fn(),
    requireTenantWithBranch: vi.fn(),
  };
});

// Stub DB-touching modules so route handlers don't try to hit Postgres when
// they're allowed through. Each test sets the return value that fits.
vi.mock("@/lib/finance/pnl", async () => {
  const actual = await vi.importActual<typeof import("@/lib/finance/pnl")>(
    "@/lib/finance/pnl",
  );
  return {
    ...actual,
    fetchPnLSource: vi.fn(async () => ({
      sales: [],
      returns: [],
      expenses: [],
      payrollExpenses: [],
      moneyMovements: [],
    })),
  };
});
vi.mock("@/lib/finance/categories", () => ({
  listCategoriesTree: vi.fn(async () => []),
}));
vi.mock("@/lib/db", () => ({
  withTenant: vi.fn(async (_t: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      // Stub `tx.select(...).from(...).where(...)` chain used by
      // /overview to count rows. Everything returns 0.
      select: () => ({
        from: () => ({
          where: async () => [{ n: 0 }],
        }),
      }),
    }),
  ),
}));

// Import the route handlers AFTER the mocks are in place.
import { GET as overviewGET } from "@/app/api/financials/overview/route";
import { GET as pnlGET } from "@/app/api/financials/pnl/route";
import { GET as categoriesGET } from "@/app/api/financials/categories/route";

function req(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, { method: "GET" });
}

beforeAll(() => {
  holds.clear();
});

afterAll(() => {
  holds.clear();
});

describe("Financials API — permission enforcement", () => {
  it("denies /overview with 403 when the caller lacks view_financials", async () => {
    holds.clear(); // no permissions
    const res = await overviewGET(req("/api/financials/overview"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe("Forbidden");
  });

  it("denies /pnl with 403 when the caller lacks view_financials", async () => {
    holds.clear();
    const res = await pnlGET(req("/api/financials/pnl"));
    expect(res.status).toBe(403);
  });

  it("denies /categories with 403 when the caller lacks view_financials", async () => {
    holds.clear();
    const res = await categoriesGET(req("/api/financials/categories"));
    expect(res.status).toBe(403);
  });

  it("allows /overview with 200 once the caller holds view_financials", async () => {
    holds.clear();
    holds.add("view_financials");
    const res = await overviewGET(req("/api/financials/overview"));
    expect(res.status).toBe(200);
  });

  it("allows /categories with 200 once the caller holds view_financials", async () => {
    holds.clear();
    holds.add("view_financials");
    const res = await categoriesGET(req("/api/financials/categories"));
    expect(res.status).toBe(200);
  });

  it("/pnl: profit fields are REDACTED (null) when view_profit is missing", async () => {
    holds.clear();
    holds.add("view_financials");
    // Deliberately NO view_profit.
    const res = await pnlGET(req("/api/financials/pnl"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.seesProfit).toBe(false);
    expect(body.data.grossProfit).toBeNull();
    expect(body.data.operatingProfit).toBeNull();
    expect(body.data.netProfit).toBeNull();
    expect(body.data.grossMargin).toBeNull();
    expect(body.data.netMargin).toBeNull();
    // Non-profit fields remain visible so a store manager can still see spend.
    expect(typeof body.data.grossSales).toBe("number");
    expect(typeof body.data.operatingExpenses).toBe("number");
    expect(typeof body.data.netSales).toBe("number");
  });

  it("/pnl: profit fields REVEALED when the caller also holds view_profit", async () => {
    holds.clear();
    holds.add("view_financials");
    holds.add("view_profit");
    const res = await pnlGET(req("/api/financials/pnl"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.seesProfit).toBe(true);
    // Real numbers (0 from the empty mock, but numeric — not null).
    expect(body.data.grossProfit).toBe(0);
    expect(body.data.netProfit).toBe(0);
    expect(body.data.netMargin).toBe(0);
  });
});
