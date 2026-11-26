// Payroll V1 — route-level `manage_payroll` enforcement.
//
// Same pattern as tests/repo/pnl-permissions.test.ts: mock the auth helper
// so routes behave exactly as in production for both the grant and deny
// branches, then invoke each route handler directly and check the HTTP
// shape + that no mutation leaked through on denial.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

/** Set of permissions the caller "holds". Each test tweaks this. */
const holds = new Set<string>();

vi.mock("@/lib/api/auth-helpers", () => ({
  requirePermission: vi.fn(async (perm: string) => {
    if (holds.has(perm)) {
      return {
        ok: true as const,
        ctx: {
          userId: USER,
          tenantId: TENANT,
          role: "staff" as const,
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
  requirePermissionAudited: vi.fn(),
  requirePermissionWithBranch: vi.fn(),
  requirePermissionWithBranchEnforced: vi.fn(),
  requireTenant: vi.fn(),
  requireTenantWithBranch: vi.fn(),
}));

// Mock the repo layer so permitted calls complete without needing real DB.
const upsertSpy = vi.fn(async () => ({
  lifecycle: "DRAFT" as const,
  periodId: "33333333-3333-4333-8333-333333333333",
  periodStart: "2026-03-01T00:00:00.000Z",
  periodEnd: "2026-04-01T00:00:00.000Z",
  employeeId: "44444444-4444-4444-8444-444444444444",
  employeeName: "Test",
  role: "staff",
  snapshot: { grossAmount: 0, netAmount: 0 } as unknown,
  compensationSnapshot: null,
  finalizedAt: null,
  finalizedByUserId: null,
  voidedAt: null,
  voidedByUserId: null,
  voidReason: null,
}));
const finalizeSpy = vi.fn(async () => ({
  ...(await upsertSpy()),
  lifecycle: "FINALIZED" as const,
  finalizedAt: "2026-03-31T00:00:00.000Z",
  finalizedByUserId: USER,
}));
const voidSpy = vi.fn(async () => ({
  id: "33333333-3333-4333-8333-333333333333",
  tenantId: TENANT,
  employeeId: "44444444-4444-4444-8444-444444444444",
  periodStart: new Date("2026-03-01T00:00:00Z"),
  periodEnd: new Date("2026-04-01T00:00:00Z"),
  regularHours: "0",
  overtimeHours: "0",
  grossAmount: "0",
  adjustmentsAmount: "0",
  adjustmentsNote: null,
  snapshot: null,
  compensationSnapshot: null,
  calculationVersion: 1,
  commissionAmount: "0",
  adjustmentsTotal: "0",
  netAmount: "0",
  status: "voided",
  finalizedAt: new Date(),
  finalizedByUserId: USER,
  voidedAt: new Date(),
  voidedByUserId: USER,
  voidReason: null,
}));
const createAdjSpy = vi.fn(async () => ({
  id: "55555555-5555-4555-8555-555555555555",
  tenantId: TENANT,
  employeeId: "44444444-4444-4444-8444-444444444444",
  periodMonth: new Date("2026-03-01T00:00:00Z"),
  kind: "bonus",
  amount: "100",
  reason: null,
  createdByUserId: USER,
  createdAt: new Date(),
  voidedAt: null,
  voidedByUserId: null,
}));
const voidAdjSpy = vi.fn(async () => createAdjSpy());
const listPeriodSpy = vi.fn(async () => []);
const listAdjSpy = vi.fn(async () => []);
const getSheetSpy = vi.fn(async () => null);

vi.mock("@/lib/repo/payroll-periods", () => ({
  PayrollLifecycleError: class PayrollLifecycleError extends Error {
    code: string;
    constructor(code: string, msg: string) {
      super(msg);
      this.code = code;
      this.name = "PayrollLifecycleError";
    }
  },
  listPayrollMonth: listPeriodSpy,
  getEmployeePayrollMonth: getSheetSpy,
  upsertPayrollDraft: upsertSpy,
  finalizePayrollPeriod: finalizeSpy,
  voidPayrollPeriod: voidSpy,
  createPayrollAdjustment: createAdjSpy,
  voidPayrollAdjustment: voidAdjSpy,
  listPayrollAdjustments: listAdjSpy,
}));

vi.mock("@/lib/repo/activity", () => ({
  logActivity: vi.fn(),
}));

/* Each test refreshes `holds`. */
beforeEach(() => {
  holds.clear();
  vi.clearAllMocks();
});

/* ─────────────────────────── GET register ────────────────────────────── */

describe("GET /api/payroll/period/[month]", () => {
  async function invoke(month: string) {
    const { GET } = await import("@/app/api/payroll/period/[month]/route");
    return GET(new NextRequest("http://test/api/payroll/period/" + month), {
      params: Promise.resolve({ month }),
    });
  }

  it("denies without manage_payroll (403) and does not read the register", async () => {
    const res = await invoke("2026-03");
    expect(res.status).toBe(403);
    expect(listPeriodSpy).not.toHaveBeenCalled();
  });

  it("allows with manage_payroll (200)", async () => {
    holds.add("manage_payroll");
    const res = await invoke("2026-03");
    expect(res.status).toBe(200);
    expect(listPeriodSpy).toHaveBeenCalledOnce();
  });
});

/* ─────────────────────────── POST calculate ──────────────────────────── */

describe("POST /api/payroll/calculate", () => {
  async function invoke(body: object) {
    const { POST } = await import("@/app/api/payroll/calculate/route");
    return POST(
      new NextRequest("http://test/api/payroll/calculate", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    );
  }
  const good = { employeeId: "44444444-4444-4444-8444-444444444444", month: "2026-03" };

  it("denies without manage_payroll (403) and does not call the repo", async () => {
    const res = await invoke(good);
    expect(res.status).toBe(403);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it("allows with manage_payroll (200)", async () => {
    holds.add("manage_payroll");
    const res = await invoke(good);
    expect(res.status).toBe(200);
    expect(upsertSpy).toHaveBeenCalledOnce();
  });
});

/* ─────────────────────────── POST finalize ───────────────────────────── */

describe("POST /api/payroll/finalize", () => {
  async function invoke(body: object) {
    const { POST } = await import("@/app/api/payroll/finalize/route");
    return POST(
      new NextRequest("http://test/api/payroll/finalize", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    );
  }
  const good = { employeeId: "44444444-4444-4444-8444-444444444444", month: "2026-03" };

  it("denies without manage_payroll (403)", async () => {
    const res = await invoke(good);
    expect(res.status).toBe(403);
    expect(finalizeSpy).not.toHaveBeenCalled();
  });

  it("allows with manage_payroll (200)", async () => {
    holds.add("manage_payroll");
    const res = await invoke(good);
    expect(res.status).toBe(200);
    expect(finalizeSpy).toHaveBeenCalledOnce();
  });
});

/* ─────────────────────────── POST void ───────────────────────────────── */

describe("POST /api/payroll/void", () => {
  async function invoke(body: object) {
    const { POST } = await import("@/app/api/payroll/void/route");
    return POST(
      new NextRequest("http://test/api/payroll/void", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    );
  }
  const good = { periodId: "33333333-3333-4333-8333-333333333333", reason: "test" };

  it("denies without manage_payroll (403)", async () => {
    const res = await invoke(good);
    expect(res.status).toBe(403);
    expect(voidSpy).not.toHaveBeenCalled();
  });

  it("allows with manage_payroll (200)", async () => {
    holds.add("manage_payroll");
    const res = await invoke(good);
    expect(res.status).toBe(200);
    expect(voidSpy).toHaveBeenCalledOnce();
  });
});

/* ─────────────────────────── POST adjustments ────────────────────────── */

describe("POST /api/payroll/adjustments", () => {
  async function invoke(body: object) {
    const { POST } = await import("@/app/api/payroll/adjustments/route");
    return POST(
      new NextRequest("http://test/api/payroll/adjustments", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "content-type": "application/json" },
      }),
    );
  }
  const good = {
    employeeId: "44444444-4444-4444-8444-444444444444",
    month: "2026-03",
    kind: "bonus" as const,
    amount: 250,
    reason: "test",
  };

  it("denies without manage_payroll (403)", async () => {
    const res = await invoke(good);
    expect(res.status).toBe(403);
    expect(createAdjSpy).not.toHaveBeenCalled();
  });

  it("allows with manage_payroll (201)", async () => {
    holds.add("manage_payroll");
    const res = await invoke(good);
    expect(res.status).toBe(201);
    expect(createAdjSpy).toHaveBeenCalledOnce();
  });

  it("rejects a bonus with negative amount (400) WITH permission — DB CHECK pre-screened", async () => {
    holds.add("manage_payroll");
    const res = await invoke({ ...good, amount: -50 });
    expect(res.status).toBe(400);
    expect(createAdjSpy).not.toHaveBeenCalled();
  });
});

/* ─────────────────────────── DELETE adjustments/[id] ─────────────────── */

describe("DELETE /api/payroll/adjustments/[id]", () => {
  async function invoke(id: string) {
    const { DELETE } = await import("@/app/api/payroll/adjustments/[id]/route");
    return DELETE(new NextRequest("http://test/api/payroll/adjustments/" + id, { method: "DELETE" }), {
      params: Promise.resolve({ id }),
    });
  }
  const id = "55555555-5555-4555-8555-555555555555";

  it("denies without manage_payroll (403)", async () => {
    const res = await invoke(id);
    expect(res.status).toBe(403);
    expect(voidAdjSpy).not.toHaveBeenCalled();
  });

  it("allows with manage_payroll (200)", async () => {
    holds.add("manage_payroll");
    const res = await invoke(id);
    expect(res.status).toBe(200);
    expect(voidAdjSpy).toHaveBeenCalledOnce();
  });
});
