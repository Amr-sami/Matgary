/**
 * Category-fallback regression tests.
 *
 * The product import adapter used to fall back to `categories[0]` whenever a
 * row had no explicit category — silently mis-filing every new product in a
 * file without a Category column. These tests lock down the correct
 * behaviour:
 *   • missing category on a CREATE → row is `missing`, with candidate labels
 *     surfaced so the user can pick in the editable preview
 *   • unknown category label → `missing` + `unknown_category` issue with
 *     candidates
 *   • an existing SKU with a valid existing category → row is `update/ready`
 *     reusing the existing categoryId (no explicit category required)
 *   • a selected category label → row flips to `create/ready`
 *   • the executor refuses to write when resolution.categoryId is null, and
 *     NEVER picks `categories[0]`
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AdapterContext } from "@/lib/ai/import/adapters/types";

/* ─── mocks ────────────────────────────────────────────────────────────── */

const CATS = [
  { id: "cat-perfume", key: "perfume", label: "Perfumes" },
  { id: "cat-makeup", key: "makeup", label: "Makeup" },
  { id: "cat-skin", key: "skincare", label: "Skincare" },
];

const mockFindProductBySku = vi.fn<
  (tenantId: string, sku: string) => Promise<unknown[]>
>();
const mockListCategories = vi.fn<
  (
    tenantId: string,
    branchId: string | null,
  ) => Promise<Array<{ id: string; key: string; label: string }>>
>();

vi.mock("@/lib/repo/catalog", () => ({
  findProductBySku: (tenantId: string, sku: string) =>
    mockFindProductBySku(tenantId, sku),
  listCategories: (tenantId: string, branchId: string | null) =>
    mockListCategories(tenantId, branchId),
  listProducts: vi.fn(async () => []),
  addProduct: vi.fn(async () => ({ id: "new-id" })),
  updateProduct: vi.fn(async () => true),
}));

// Import AFTER the mock.
const {
  productImportAdapter,
  _clearCategorySnapshotCache,
} = await import("@/lib/ai/import/adapters/products");

const ctx: AdapterContext = {
  tenantId: "t-1",
  userId: "u-1",
  branchId: null,
  locale: "en",
};

beforeEach(() => {
  mockFindProductBySku.mockReset();
  mockListCategories.mockReset();
  mockListCategories.mockResolvedValue(CATS);
  _clearCategorySnapshotCache();
});

/* ─── validator ───────────────────────────────────────────────────────── */

describe("productImportAdapter.validateAndResolve — category gating", () => {
  it("CREATE row with no category → MISSING, not categories[0]", async () => {
    mockFindProductBySku.mockResolvedValue([]);
    const out = await productImportAdapter.validateAndResolve({
      rowIndex: 1,
      raw: { name: "New Perfume", price: "100", quantity: "10" },
      normalised: { name: "New Perfume", price: 100, quantity: 10 },
      ctx,
      seenSkus: new Set(),
    });
    expect(out.status).toBe("missing");
    expect(out.action).toBe("none");
    // No silent categoryId injection.
    const resolution = out.resolution as { categoryId?: string | null };
    expect(resolution.categoryId).toBeNull();
    // Missing-category issue with candidate labels for the preview picker.
    const issue = out.issues.find((i) => i.field === "category");
    expect(issue).toBeTruthy();
    expect(issue?.kind).toBe("missing_field");
    expect(issue?.candidates).toEqual([
      { label: "Perfumes" },
      { label: "Makeup" },
      { label: "Skincare" },
    ]);
  });

  it("CREATE row with UNKNOWN category label → MISSING, unknown_category issue", async () => {
    mockFindProductBySku.mockResolvedValue([]);
    const out = await productImportAdapter.validateAndResolve({
      rowIndex: 2,
      raw: { name: "X", price: "50", quantity: "5", category: "Furniture" },
      normalised: { name: "X", price: 50, quantity: 5, category: "Furniture" },
      ctx,
      seenSkus: new Set(),
    });
    expect(out.status).toBe("missing");
    expect(out.action).toBe("none");
    const issue = out.issues.find((i) => i.field === "category");
    expect(issue?.kind).toBe("unknown_category");
    expect(issue?.candidates).toEqual([
      { label: "Perfumes" },
      { label: "Makeup" },
      { label: "Skincare" },
    ]);
  });

  it("CREATE row with VALID category → READY/create", async () => {
    mockFindProductBySku.mockResolvedValue([]);
    const out = await productImportAdapter.validateAndResolve({
      rowIndex: 3,
      raw: { name: "P", price: "80", quantity: "3", category: "Perfumes" },
      normalised: { name: "P", price: 80, quantity: 3, category: "Perfumes" },
      ctx,
      seenSkus: new Set(),
    });
    expect(out.status).toBe("ready");
    expect(out.action).toBe("create");
    const resolution = out.resolution as { categoryId?: string | null };
    expect(resolution.categoryId).toBe("cat-perfume");
  });

  it("CREATE row — case-insensitive label match", async () => {
    mockFindProductBySku.mockResolvedValue([]);
    const out = await productImportAdapter.validateAndResolve({
      rowIndex: 4,
      raw: { name: "P", price: "80", quantity: "3", category: "MAKEUP" },
      normalised: { name: "P", price: 80, quantity: 3, category: "MAKEUP" },
      ctx,
      seenSkus: new Set(),
    });
    expect(out.status).toBe("ready");
    const resolution = out.resolution as { categoryId?: string | null };
    expect(resolution.categoryId).toBe("cat-makeup");
  });

  it("UPDATE path with no explicit category REUSES the existing product's category", async () => {
    mockFindProductBySku.mockResolvedValue([
      {
        product: {
          id: "prod-99",
          name: "Existing",
          price: 120,
          quantity: 7,
          category: "cat-skin",
        },
        branchId: "b1",
        branchName: "main",
      },
    ]);
    const out = await productImportAdapter.validateAndResolve({
      rowIndex: 5,
      raw: { name: "Existing", sku: "SKU-X", price: "150", quantity: "9" },
      normalised: { name: "Existing", sku: "SKU-X", price: 150, quantity: 9 },
      ctx,
      seenSkus: new Set(),
    });
    expect(out.status).toBe("ready");
    expect(out.action).toBe("update");
    const resolution = out.resolution as { categoryId?: string | null };
    expect(resolution.categoryId).toBe("cat-skin");
  });

  it("Tenant with NO categories configured → INVALID + NO_CATEGORIES_CONFIGURED", async () => {
    mockListCategories.mockResolvedValue([]);
    mockFindProductBySku.mockResolvedValue([]);
    const out = await productImportAdapter.validateAndResolve({
      rowIndex: 6,
      raw: { name: "N", price: "100", quantity: "2" },
      normalised: { name: "N", price: 100, quantity: 2 },
      ctx,
      seenSkus: new Set(),
    });
    expect(out.status).toBe("invalid");
    const err = out.errors.find((e) => e.field === "category");
    expect(err?.code).toBe("NO_CATEGORIES_CONFIGURED");
  });

  it("User-selected category (via edit) → row flips to READY with that categoryId", async () => {
    // First pass: no category → missing.
    mockFindProductBySku.mockResolvedValue([]);
    const first = await productImportAdapter.validateAndResolve({
      rowIndex: 7,
      raw: { name: "N", price: "100", quantity: "2" },
      normalised: { name: "N", price: 100, quantity: 2 },
      ctx,
      seenSkus: new Set(),
    });
    expect(first.status).toBe("missing");

    // Second pass after the user selected "Makeup" in the preview.
    const second = await productImportAdapter.validateAndResolve({
      rowIndex: 7,
      raw: { name: "N", price: "100", quantity: "2" },
      normalised: {
        name: "N",
        price: 100,
        quantity: 2,
        category: "Makeup",
      },
      ctx,
      seenSkus: new Set(),
    });
    expect(second.status).toBe("ready");
    expect(second.action).toBe("create");
    const resolution = second.resolution as { categoryId?: string | null };
    expect(resolution.categoryId).toBe("cat-makeup");
  });
});

/* ─── executor refuses to fall back ───────────────────────────────────── */

describe("productImportAdapter.executeRow — no silent categories[0] fallback", () => {
  it("refuses to execute a CREATE row with resolution.categoryId=null", async () => {
    const out = await productImportAdapter.executeRow({
      row: {
        rowIndex: 1,
        status: "ready", // pretend it slipped through
        action: "create",
        raw: {},
        normalised: { name: "X", price: 100, quantity: 5 },
        // Simulate a bogus pending row that forgot the category — the
        // executor must NOT make one up.
        resolution: { kind: "new", categoryId: null },
        errors: [],
        issues: [],
      },
      ctx,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("category_unresolved");
  });

  it("refuses when category resolved at validate time no longer exists", async () => {
    // Pretend the row was validated against a cat that has since been
    // deleted (admin removed it between validate and confirm).
    mockListCategories.mockResolvedValue([CATS[0]!, CATS[1]!]); // "cat-skin" gone
    const out = await productImportAdapter.executeRow({
      row: {
        rowIndex: 2,
        status: "ready",
        action: "create",
        raw: {},
        normalised: { name: "X", price: 100, quantity: 5 },
        resolution: { kind: "new", categoryId: "cat-skin" },
        errors: [],
        issues: [],
      },
      ctx,
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("category_no_longer_exists");
  });
});
