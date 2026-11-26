/**
 * C20 — unknown-id handling on the `[id]` routes that answered 500 (or a
 * silent 200) when probed with an id that does not exist or is not a uuid.
 * Every collaborator is faked (auth, repos, activity log) so the assertions
 * are about the routes' own contract:
 *   - a non-uuid id → 404 { error: "NOT_FOUND" } and NO repo call at all
 *     (Postgres would otherwise refuse the uuid cast → 500);
 *   - an unknown uuid → 404 NOT_FOUND: the mutator reports "no row matched"
 *     and no activity row is written;
 *   - a known id still goes through to the mutator;
 *   - attendance PATCH `{}` → 400 EMPTY_PATCH (drizzle "No values to set" was
 *     a 500 whether or not the id existed);
 *   - DELETE attendance stays idempotent: an unknown uuid is still 200;
 *   - /sales/invoice/[id]/paid keys on the free-text invoice id, so there is
 *     no uuid gate — only the "no row matched → 404" half applies.
 *
 * The by-id mutators (lib/repo/catalog.ts, catalog-admin.ts, expenses.ts,
 * operations.ts) return whether a row matched; the fakes answer true for
 * C.KNOWN only, which is the whole lookup the routes rely on.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

const C = vi.hoisted(() => ({
  TENANT: "11111111-1111-4111-8111-111111111111",
  USER: "22222222-2222-4222-8222-222222222222",
  KNOWN: "44444444-4444-4444-8444-444444444444",
  UNKNOWN: "00000000-0000-4000-8000-000000000000",
  CONFLICT: "55555555-5555-4555-8555-555555555555",
  BAD: "not-a-uuid",
  KNOWN_INVOICE: "INV-2026-000042",
}));

// ─── fakes ───────────────────────────────────────────────────────────────────

/** A by-id mutator that found a row for C.KNOWN and nothing else. */
const byKnownId = vi.hoisted(
  () => () => vi.fn(async (_tenantId: string, id: string) => id === C.KNOWN),
);

vi.mock("@/lib/api/auth-helpers", () => {
  const ctx = { userId: C.USER, tenantId: C.TENANT, role: "owner", permissions: [], walls: [] };
  return {
    requireTenant: vi.fn(async () => ({ ok: true, ctx })),
    requirePermission: vi.fn(async () => ({ ok: true, ctx })),
    requirePermissionAudited: vi.fn(async () => ({ ok: true, ctx })),
  };
});

vi.mock("@/lib/repo/operations", () => ({
  getSaleById: vi.fn(async (_tenantId: string, id: string) => (id === C.KNOWN ? { id } : null)),
  updateSale: vi.fn(async () => undefined),
  voidSale: vi.fn(async () => undefined),
  markSalePaid: byKnownId(),
  markInvoicePaid: vi.fn(async (_tenantId: string, id: string) => id === C.KNOWN_INVOICE),
  deleteExpense: byKnownId(),
}));

vi.mock("@/lib/repo/attendance-events", () => ({
  // The UPDATE … RETURNING is the lookup: null means no row matched.
  updateAttendanceEvent: vi.fn(async (_tenantId: string, id: string) =>
    id === C.KNOWN ? { id, type: "check_in" } : null,
  ),
  deleteAttendanceEvent: vi.fn(async () => undefined),
}));

vi.mock("@/lib/repo/catalog", () => ({
  updateProduct: byKnownId(),
  deleteProduct: byKnownId(),
}));

vi.mock("@/lib/repo/catalog-admin", () => {
  class CatalogConflictError extends Error {}
  return {
    CatalogConflictError,
    updateCategory: byKnownId(),
    deleteCategory: vi.fn(async (_tenantId: string, id: string) => {
      if (id === C.CONFLICT) throw new CatalogConflictError("Cannot delete: 3 منتج يستخدم هذا القسم");
      return id === C.KNOWN;
    }),
    updateBrand: byKnownId(),
    deleteBrand: byKnownId(),
    updateAttribute: byKnownId(),
    deleteAttribute: byKnownId(),
    updateAttributeValue: byKnownId(),
    deleteAttributeValue: byKnownId(),
  };
});

vi.mock("@/lib/repo/activity", () => ({ logActivity: vi.fn() }));

import * as attendance from "@/app/api/attendance/events/[id]/route";
import * as attributeValues from "@/app/api/attribute-values/[id]/route";
import * as attributes from "@/app/api/attributes/[id]/route";
import * as brands from "@/app/api/brands/[id]/route";
import * as categories from "@/app/api/categories/[id]/route";
import * as expenses from "@/app/api/expenses/[id]/route";
import * as products from "@/app/api/products/[id]/route";
import * as salePaid from "@/app/api/sales/[id]/paid/route";
import * as sales from "@/app/api/sales/[id]/route";
import * as invoicePaid from "@/app/api/sales/invoice/[id]/paid/route";
import { logActivity } from "@/lib/repo/activity";
import { deleteAttendanceEvent, updateAttendanceEvent } from "@/lib/repo/attendance-events";
import { deleteProduct, updateProduct } from "@/lib/repo/catalog";
import {
  deleteAttribute,
  deleteAttributeValue,
  deleteBrand,
  deleteCategory,
  updateAttribute,
  updateAttributeValue,
  updateBrand,
  updateCategory,
} from "@/lib/repo/catalog-admin";
import {
  deleteExpense,
  getSaleById,
  markInvoicePaid,
  markSalePaid,
  updateSale,
  voidSale,
} from "@/lib/repo/operations";

type Handler = (
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) => Promise<Response>;

async function call(handler: Handler, method: string, id: string, body?: unknown) {
  const req = new NextRequest(`http://localhost/api/x/${id}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await handler(req, { params: Promise.resolve({ id }) });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const allMocks: Mock[] = [
  getSaleById as Mock,
  updateSale as Mock,
  voidSale as Mock,
  markSalePaid as Mock,
  markInvoicePaid as Mock,
  deleteExpense as Mock,
  updateAttendanceEvent as Mock,
  deleteAttendanceEvent as Mock,
  updateProduct as Mock,
  deleteProduct as Mock,
  updateCategory as Mock,
  deleteCategory as Mock,
  updateBrand as Mock,
  deleteBrand as Mock,
  updateAttribute as Mock,
  deleteAttribute as Mock,
  updateAttributeValue as Mock,
  deleteAttributeValue as Mock,
  logActivity as Mock,
];

beforeEach(() => {
  for (const m of allMocks) m.mockClear();
});

const NOT_FOUND = { status: 404, json: { error: "NOT_FOUND" } };

/**
 * [label, handler, method, valid body, the mutator (+ activity log) the route
 * calls on a known id — asserted called with (tenant, id, …) on success and
 * never called on a non-uuid id]
 */
const routes: Array<[string, Handler, string, unknown, Mock[]]> = [
  ["GET /api/sales/[id]", sales.GET, "GET", undefined, []],
  ["PATCH /api/sales/[id]", sales.PATCH, "PATCH", { note: "x" }, [updateSale as Mock]],
  ["DELETE /api/sales/[id]", sales.DELETE, "DELETE", undefined, [voidSale as Mock]],
  ["POST /api/sales/[id]/paid", salePaid.POST, "POST", undefined, [markSalePaid as Mock]],
  ["PATCH /api/attendance/events/[id]", attendance.PATCH, "PATCH", { requiresReview: false }, []],
  ["DELETE /api/attendance/events/[id]", attendance.DELETE, "DELETE", undefined, [deleteAttendanceEvent as Mock]],
  ["PATCH /api/products/[id]", products.PATCH, "PATCH", { name: "x" }, [updateProduct as Mock, logActivity as Mock]],
  ["DELETE /api/products/[id]", products.DELETE, "DELETE", undefined, [deleteProduct as Mock, logActivity as Mock]],
  ["PATCH /api/categories/[id]", categories.PATCH, "PATCH", { label: "x" }, [updateCategory as Mock]],
  ["DELETE /api/categories/[id]", categories.DELETE, "DELETE", undefined, [deleteCategory as Mock]],
  ["PATCH /api/brands/[id]", brands.PATCH, "PATCH", { name: "x" }, [updateBrand as Mock]],
  ["DELETE /api/brands/[id]", brands.DELETE, "DELETE", undefined, [deleteBrand as Mock]],
  ["PATCH /api/attributes/[id]", attributes.PATCH, "PATCH", { label: "x" }, [updateAttribute as Mock]],
  ["DELETE /api/attributes/[id]", attributes.DELETE, "DELETE", undefined, [deleteAttribute as Mock]],
  ["PATCH /api/attribute-values/[id]", attributeValues.PATCH, "PATCH", { label: "x" }, [updateAttributeValue as Mock]],
  ["DELETE /api/attribute-values/[id]", attributeValues.DELETE, "DELETE", undefined, [deleteAttributeValue as Mock]],
  ["DELETE /api/expenses/[id]", expenses.DELETE, "DELETE", undefined, [deleteExpense as Mock]],
];

describe("a non-uuid id is 404 NOT_FOUND before any repo call", () => {
  for (const [label, handler, method, body] of routes) {
    it(label, async () => {
      const r = await call(handler, method, C.BAD, body);
      expect(r).toEqual(NOT_FOUND);
      for (const m of allMocks) expect(m).not.toHaveBeenCalled();
    });
  }
});

describe("an unknown uuid is 404 NOT_FOUND and nothing is logged", () => {
  for (const [label, handler, method, body] of routes) {
    if (label.startsWith("DELETE /api/attendance")) continue; // idempotent — pinned below
    it(label, async () => {
      const r = await call(handler, method, C.UNKNOWN, body);
      expect(r).toEqual(NOT_FOUND);
      expect(logActivity).not.toHaveBeenCalled();
    });
  }

  it("DELETE /api/attendance/events/[id] stays idempotent: unknown uuid → 200", async () => {
    const r = await call(attendance.DELETE, "DELETE", C.UNKNOWN);
    expect(r).toEqual({ status: 200, json: { ok: true } });
    expect(deleteAttendanceEvent).toHaveBeenCalledWith(C.TENANT, C.UNKNOWN);
  });
});

describe("a known id still reaches the mutator", () => {
  for (const [label, handler, method, body, mutators] of routes) {
    if (label.startsWith("GET ") || label.startsWith("PATCH /api/attendance")) continue; // shapes pinned below
    it(label, async () => {
      const r = await call(handler, method, C.KNOWN, body);
      expect(r).toEqual({ status: 200, json: { ok: true } });
      const [mutator] = mutators;
      if (body === undefined) expect(mutator).toHaveBeenCalledWith(C.TENANT, C.KNOWN);
      else expect(mutator).toHaveBeenCalledWith(C.TENANT, C.KNOWN, expect.objectContaining(body as object));
    });
  }

  it("PATCH /api/attendance/events/[id]", async () => {
    const r = await call(attendance.PATCH, "PATCH", C.KNOWN, { requiresReview: false });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ event: { id: C.KNOWN, type: "check_in" } });
    expect(updateAttendanceEvent).toHaveBeenCalledWith(
      C.TENANT,
      C.KNOWN,
      expect.objectContaining({ requiresReview: false }),
    );
  });

  it("products/[id] writes its activity row only for a matched product", async () => {
    await call(products.PATCH, "PATCH", C.KNOWN, { name: "x" });
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: "product.update", entityId: C.KNOWN }));
    (logActivity as Mock).mockClear();
    await call(products.DELETE, "DELETE", C.KNOWN);
    expect(logActivity).toHaveBeenCalledWith(expect.objectContaining({ action: "product.delete", entityId: C.KNOWN }));
  });

  it("DELETE /api/categories/[id] still maps a conflict to 409", async () => {
    const r = await call(categories.DELETE, "DELETE", C.CONFLICT);
    expect(r.status).toBe(409);
    expect(String(r.json.error)).toContain("Cannot delete");
  });
});

describe("POST /api/sales/invoice/[id]/paid — invoice ids are free text", () => {
  it("an unknown invoice id is 404 after the UPDATE matched nothing", async () => {
    const r = await call(invoicePaid.POST, "POST", "INV-nope");
    expect(r).toEqual(NOT_FOUND);
    expect(markInvoicePaid).toHaveBeenCalledWith(C.TENANT, "INV-nope");
  });

  it("a known invoice id is 200", async () => {
    const r = await call(invoicePaid.POST, "POST", C.KNOWN_INVOICE);
    expect(r).toEqual({ status: 200, json: { ok: true } });
    expect(markInvoicePaid).toHaveBeenCalledWith(C.TENANT, C.KNOWN_INVOICE);
  });

  it("an over-long id is 404 without a query", async () => {
    const r = await call(invoicePaid.POST, "POST", "x".repeat(81));
    expect(r).toEqual(NOT_FOUND);
    expect(markInvoicePaid).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/attendance/events/[id] with nothing to set", () => {
  for (const body of [{}, { note: null }]) {
    it(`${JSON.stringify(body)} → 400 EMPTY_PATCH, never reaches drizzle`, async () => {
      const r = await call(attendance.PATCH, "PATCH", C.KNOWN, body);
      expect(r).toEqual({ status: 400, json: { error: "EMPTY_PATCH" } });
      expect(updateAttendanceEvent).not.toHaveBeenCalled();
    });
  }
});
