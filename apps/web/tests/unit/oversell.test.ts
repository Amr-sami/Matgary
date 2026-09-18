/**
 * S7 — oversell-tolerant cart path + idempotency semantics of the cart route.
 *
 * The route is exercised with every collaborator faked (auth, rate limit,
 * idempotency store, repo, activity log) so the assertions are about the
 * route's own contract:
 *   1. failures are NOT cached under the Idempotency-Key — only a 2xx is —
 *      so the mobile "sell anyway" retry (same key, `allowOversell: true`)
 *      reaches the repo and succeeds;
 *   2. `options.allowOversell` parses (default false) and is handed to
 *      recordCartSale; a replay of a landed key short-circuits.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DomainError } from "@/lib/errors";

// ─── fakes ───────────────────────────────────────────────────────────────────

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const BRANCH = "33333333-3333-4333-8333-333333333333";
const PRODUCT = "44444444-4444-4444-8444-444444444444";

vi.mock("@/lib/api/auth-helpers", () => ({
  requirePermissionWithBranch: vi.fn(async () => ({
    ok: true,
    ctx: {
      userId: USER,
      tenantId: TENANT,
      role: "owner",
      permissions: ["record_sales"],
      branchId: BRANCH,
      branchName: "Main",
      isPrimaryBranch: true,
      allowedBranchIds: [BRANCH],
    },
  })),
  requireTenantWithBranch: vi.fn(),
}));

vi.mock("@/lib/api/tenant-rate-limit", () => ({
  checkTenantRateLimit: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/repo/activity", () => ({ logActivity: vi.fn() }));

/** In-memory idempotency store standing in for Redis. */
const idempStore = new Map<string, { status: number; body: unknown }>();
vi.mock("@/lib/api/idempotency", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api/idempotency")>("@/lib/api/idempotency");
  return {
    validateIdempotencyKey: actual.validateIdempotencyKey,
    getCachedResponse: vi.fn(async (tenantId: string, key: string) => idempStore.get(`${tenantId}:${key}`) ?? null),
    rememberResponse: vi.fn(async (tenantId: string, key: string, status: number, body: unknown) => {
      idempStore.set(`${tenantId}:${key}`, { status, body });
    }),
  };
});

/** Fake repo: a single product with `stock` units; honours allowOversell the way operations.ts does. */
const repo = vi.hoisted(() => ({
  stock: 1,
  calls: [] as Array<{ lines: unknown; options: Record<string, unknown> }>,
  history: [] as Array<{ type: string; delta: number; quantityAfter: number; note: string | null }>,
}));

vi.mock("@/lib/repo/operations", () => ({
  recordCartSale: vi.fn(async (_tenantId: string, lines: Array<{ productId: string; quantity: number; pricePerUnit: number }>, options: Record<string, unknown>) => {
    repo.calls.push({ lines, options });
    const requested = lines.reduce((s, l) => s + l.quantity, 0);
    if (repo.stock < requested) {
      if (!options.allowOversell) {
        throw new DomainError("INSUFFICIENT_STOCK", 400, {
          productId: PRODUCT,
          productName: "Test",
          requested,
          available: repo.stock,
        });
      }
      // Mirrors operations.ts: per-line "sold" rows, then ONE reconciling
      // "restocked" row whose +delta brings the trail to the floor (0).
      for (const l of lines) repo.history.push({ type: "sold", delta: -l.quantity, quantityAfter: 0, note: null });
      repo.history.push({
        type: "restocked",
        delta: requested - repo.stock,
        quantityAfter: 0,
        note: `oversell: requested ${requested}, available ${repo.stock}, offline sale ${String(options.invoiceId)}`,
      });
      repo.stock = 0;
    } else {
      for (const l of lines) repo.history.push({ type: "sold", delta: -l.quantity, quantityAfter: repo.stock - requested, note: null });
      repo.stock -= requested;
    }
    return {
      oversold: repo.stock === 0 && requested > 1 ? [{ productId: PRODUCT, productName: "Test", requested, available: 1 }] : [],
      invoiceId: String(options.invoiceId ?? "INV-SERVER"),
      saleIds: ["sale-1"],
      lines: lines.map((l) => ({ productName: "Test", quantity: l.quantity, pricePerUnit: l.pricePerUnit, lineTotal: l.quantity * l.pricePerUnit })),
      total: requested * 10,
      paymentMethod: "cash",
      customerName: null,
      customerPhone: null,
      note: null,
    };
  }),
}));

import { POST } from "@/app/api/sales/cart/route";
import { getCachedResponse, rememberResponse } from "@/lib/api/idempotency";
import { recordCartSale } from "@/lib/repo/operations";

const KEY = "INV-OVERSELL-TEST-0001";

function post(body: unknown, key: string | null = KEY): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key) headers["Idempotency-Key"] = key;
  return new NextRequest("http://localhost/api/sales/cart", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function cart(quantity: number, options: Record<string, unknown> = {}) {
  return {
    lines: [{ productId: PRODUCT, quantity, pricePerUnit: 10 }],
    options: { invoiceId: KEY, paymentMethod: "cash", ...options },
  };
}

beforeEach(() => {
  idempStore.clear();
  repo.stock = 1;
  repo.calls.length = 0;
  repo.history.length = 0;
  vi.mocked(getCachedResponse).mockClear();
  vi.mocked(rememberResponse).mockClear();
  vi.mocked(recordCartSale).mockClear();
});

// ─── tests ───────────────────────────────────────────────────────────────────

describe("POST /api/sales/cart — S7 oversell + idempotency", () => {
  it("refuses an oversell with allowOversell:false (default) and does NOT cache the 400", async () => {
    const res = await POST(post(cart(3)));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail: { requested: number; available: number } };
    expect(body.error).toBe("INSUFFICIENT_STOCK");
    expect(body.detail).toMatchObject({ requested: 3, available: 1 });
    // allowOversell defaulted to false on the way to the repo
    expect(repo.calls[0]?.options.allowOversell).toBe(false);
    // the failure was not remembered under the key
    expect(rememberResponse).not.toHaveBeenCalled();
    expect(idempStore.size).toBe(0);
    expect(repo.stock).toBe(1);
  });

  it("a corrected retry under the SAME key with allowOversell:true books the sale, floors stock, writes the discrepancy", async () => {
    const first = await POST(post(cart(3)));
    expect(first.status).toBe(400);

    const second = await POST(post(cart(3, { allowOversell: true })));
    expect(second.status).toBe(201);
    const body = (await second.json()) as { invoiceId: string; lines: Array<{ quantity: number }> };
    expect(body.invoiceId).toBe(KEY);
    expect(body.lines[0]?.quantity).toBe(3);

    // The repo actually ran the second time (not short-circuited by a cached 400)
    expect(recordCartSale).toHaveBeenCalledTimes(2);
    expect(repo.calls[1]?.options.allowOversell).toBe(true);
    expect(repo.stock).toBe(0);
    expect(repo.history).toHaveLength(2);
    expect(repo.history[1]?.note).toBe(`oversell: requested 3, available 1, offline sale ${KEY}`);
    // The trail reconciles: shelf 1, sold -3, reconciled +2 → 0.
    expect(1 + repo.history.reduce((sum, h) => sum + h.delta, 0)).toBe(repo.stock);

    // Only the 2xx was remembered
    expect(rememberResponse).toHaveBeenCalledTimes(1);
    expect(rememberResponse).toHaveBeenCalledWith(TENANT, KEY, 201, expect.objectContaining({ invoiceId: KEY }));
  });

  it("a replay of a landed key returns the cached 201 without re-running the sale", async () => {
    const first = await POST(post(cart(1)));
    expect(first.status).toBe(201);
    expect(repo.stock).toBe(0);

    const replay = await POST(post(cart(1)));
    expect(replay.status).toBe(201);
    expect(await replay.json()).toMatchObject({ invoiceId: KEY });
    expect(recordCartSale).toHaveBeenCalledTimes(1);
    expect(repo.stock).toBe(0);
  });

  it("a 500 from the repo is not cached either, so the next attempt reaches the repo", async () => {
    vi.mocked(recordCartSale).mockRejectedValueOnce(new Error("pool exhausted"));
    const first = await POST(post(cart(1)));
    expect(first.status).toBe(500);
    expect(rememberResponse).not.toHaveBeenCalled();

    const second = await POST(post(cart(1)));
    expect(second.status).toBe(201);
    expect(recordCartSale).toHaveBeenCalledTimes(2);
  });

  it("refuses allowOversell:true without an Idempotency-Key (only outbox replays carry one)", async () => {
    const res = await POST(post(cart(3, { allowOversell: true }), null));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "OVERSELL_REQUIRES_IDEMPOTENCY_KEY" });
    expect(recordCartSale).not.toHaveBeenCalled();
    expect(repo.stock).toBe(1);
  });

  it("rejects a non-boolean allowOversell", async () => {
    const res = await POST(post(cart(3, { allowOversell: "yes" })));
    expect(res.status).toBe(400);
    expect(recordCartSale).not.toHaveBeenCalled();
    expect(rememberResponse).not.toHaveBeenCalled();
  });
});
