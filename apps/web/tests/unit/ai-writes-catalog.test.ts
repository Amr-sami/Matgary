/**
 * Wave 1 — catalog-authoring preview-tool regression tests.
 *
 * Covers the tool contract (what the agent sees):
 *   • Required fields → ask
 *   • Missing category → offer to create
 *   • Ambiguous category → clarification
 *   • Resolves category by key OR label (AR + EN)
 *   • Short-circuits brand/category already-exists cases
 *   • Successful preview emits a ConfirmationBlock with a HMAC token
 *   • Target product resolution path (product_id + query fallback)
 *
 * Uses vi.mock to stub the repo + pending-action helpers — no DB.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/* ─── mocks ────────────────────────────────────────────────────────────── */

const mockListCategories = vi.fn<
  (
    tenantId: string,
    branchId: string | null,
  ) => Promise<Array<{ id: string; key: string; label: string }>>
>();
const mockListBrands = vi.fn<
  (
    tenantId: string,
    branchId: string | null,
  ) => Promise<Array<{ id: string; name: string; categoryId: string | null }>>
>();
const mockListProducts = vi.fn<
  (tenantId: string, branchId: string | null) => Promise<unknown[]>
>();
const mockResolveProducts = vi.fn<
  (
    args: unknown,
    opts?: { limit?: number },
  ) => Promise<{ candidates: Array<{ id: string; name: string; brand: string | null; score: number }> }>
>();
const mockCreatePending = vi.fn<
  (input: unknown) => Promise<{ token: string; expiresAt: string }>
>();

vi.mock("@/lib/repo/catalog", () => ({
  listCategories: (t: string, b: string | null) => mockListCategories(t, b),
  listBrands: (t: string, b: string | null) => mockListBrands(t, b),
  listProducts: (t: string, b: string | null) => mockListProducts(t, b),
}));
vi.mock("@/lib/db", () => ({
  withTenant: async (_t: string, fn: (tx: unknown) => Promise<unknown>) => {
    // Our preview tools call withTenant only for the branch lookup. A
    // fake tx stubs select.from.where.limit() to return the primary branch.
    const tx = {
      select: () => tx,
      from: () => tx,
      where: () => tx,
      limit: async () => [{ id: "branch-1" }],
    } as unknown;
    return fn(tx);
  },
}));
vi.mock("@/lib/db/schema", () => ({
  branches: {
    tenantId: "tenant_id",
    id: "id",
    isPrimary: "is_primary",
  },
}));
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: (col: unknown, val: unknown) => [col, val],
}));
vi.mock("../../lib/ai/write/pending", () => ({
  createPending: (input: unknown) => mockCreatePending(input),
}));
vi.mock("@/lib/ai/write/pending", () => ({
  createPending: (input: unknown) => mockCreatePending(input),
}));
vi.mock("@/lib/ai/resolve/products", () => ({
  resolveProducts: (args: unknown, opts?: { limit?: number }) =>
    mockResolveProducts(args, opts),
}));

const ctx = {
  tenantId: "t-1",
  userId: "u-1",
  role: "owner" as const,
  permissions: ["manage_inventory"],
  locale: "en" as const,
};

const CATS = [
  { id: "cat-perfume", key: "perfume", label: "Perfumes" },
  { id: "cat-makeup", key: "makeup", label: "Makeup" },
];

beforeEach(() => {
  mockListCategories.mockReset();
  mockListBrands.mockReset();
  mockListProducts.mockReset();
  mockResolveProducts.mockReset();
  mockCreatePending.mockReset();
  mockListCategories.mockResolvedValue(CATS);
  mockListBrands.mockResolvedValue([]);
  mockListProducts.mockResolvedValue([]);
  mockResolveProducts.mockResolvedValue({ candidates: [] });
  mockCreatePending.mockResolvedValue({
    token: "pending-id.hmac",
    expiresAt: "2026-11-09T18:00:00Z",
  });
});

/* ─── import AFTER mocks ───────────────────────────────────────────────── */
const {
  previewCreateProduct,
  previewUpdateProduct,
  previewCreateBrand,
  previewCreateCategory,
} = await import("@/lib/ai/tools/writes-catalog");

/* ─── preview_create_product ────────────────────────────────────────────── */

describe("preview_create_product", () => {
  it("asks for missing name", async () => {
    const out = await previewCreateProduct.handler(ctx, {});
    expect(out.ok).toBe(true);
    if (!out.ok || !out.blocks) throw new Error("expected blocks");
    expect(out.blocks[0]!.kind).toBe("text");
    expect((out.blocks[0] as { text: string }).text).toContain("name");
  });

  it("asks for missing category when name provided but no category hint", async () => {
    const out = await previewCreateProduct.handler(ctx, {
      name: "Diamond Sakura",
      price: 1800,
      quantity: 10,
    });
    expect(out.ok).toBe(true);
    if (!out.ok || !out.blocks) throw new Error("expected blocks");
    expect((out.blocks[0] as { text: string }).text.toLowerCase()).toContain(
      "category",
    );
  });

  it("resolves category by English label", async () => {
    const out = await previewCreateProduct.handler(ctx, {
      name: "Diamond Sakura",
      category: "Perfumes",
      price: 1800,
      quantity: 10,
    });
    expect(out.ok).toBe(true);
    if (!out.ok || !out.blocks) throw new Error("expected blocks");
    expect(out.blocks[0]!.kind).toBe("confirmation");
    // The pending params carry the resolved categoryId, never "Perfumes".
    expect(mockCreatePending).toHaveBeenCalled();
    const pendingInput = mockCreatePending.mock.calls[0]![0] as {
      params: { categoryId: string };
    };
    expect(pendingInput.params.categoryId).toBe("cat-perfume");
  });

  it("resolves category by Arabic label (برفانات → Perfumes)", async () => {
    mockListCategories.mockResolvedValue([
      { id: "cat-perfume", key: "perfume", label: "برفانات" },
      { id: "cat-makeup", key: "makeup", label: "Makeup" },
    ]);
    const out = await previewCreateProduct.handler(
      { ...ctx, locale: "ar" },
      {
        name: "Diamond Sakura",
        category: "برفانات",
        price: 1800,
        quantity: 10,
      },
    );
    expect(out.ok).toBe(true);
    if (!out.ok || !out.blocks) throw new Error("expected blocks");
    expect(out.blocks[0]!.kind).toBe("confirmation");
    const pendingInput = mockCreatePending.mock.calls[0]![0] as {
      params: { categoryId: string };
    };
    expect(pendingInput.params.categoryId).toBe("cat-perfume");
  });

  it("asks for missing price/quantity once category resolves", async () => {
    const out = await previewCreateProduct.handler(ctx, {
      name: "Diamond Sakura",
      category: "Perfumes",
    });
    expect(out.ok).toBe(true);
    if (!out.ok || !out.blocks) throw new Error("expected blocks");
    expect(out.blocks[0]!.kind).toBe("text");
    const text = (out.blocks[0] as { text: string }).text.toLowerCase();
    expect(text).toContain("price");
    expect(text).toContain("quantity");
  });

  it("offers to create the category when the referenced one doesn't exist", async () => {
    mockListCategories.mockResolvedValue([]); // no categories at all
    const out = await previewCreateProduct.handler(ctx, {
      name: "X",
      category: "DoesNotExist",
      price: 10,
      quantity: 1,
    });
    expect(out.ok).toBe(true);
    if (!out.ok || !out.blocks) throw new Error("expected blocks");
    expect(out.blocks[0]!.kind).toBe("text");
    expect((out.blocks[0] as { text: string }).text.toLowerCase()).toContain("doesn't exist");
  });

  it("emits a ConfirmationBlock with pending token when all fields resolve", async () => {
    const out = await previewCreateProduct.handler(ctx, {
      name: "Diamond Sakura",
      brand: "Assaf",
      category: "Perfumes",
      price: 1800,
      quantity: 10,
      cost_price: 1200,
    });
    expect(out.ok).toBe(true);
    if (!out.ok || !out.blocks) throw new Error("expected blocks");
    expect(out.blocks[0]!.kind).toBe("confirmation");
    const block = out.blocks[0] as {
      token: string;
      expiresAt: string;
      actionLabel: string;
    };
    expect(block.token).toBe("pending-id.hmac");
    expect(block.expiresAt).toBe("2026-11-09T18:00:00Z");
    expect(block.actionLabel).toMatch(/confirm/i);

    // Pending params carry the FULL resolved payload the executor will use.
    const pendingInput = mockCreatePending.mock.calls[0]![0] as {
      action: string;
      params: {
        name: string;
        brand: string | null;
        categoryId: string;
        price: number;
        quantity: number;
        costPrice: number | null;
        lowStockThreshold: number;
      };
    };
    expect(pendingInput.action).toBe("create_product");
    expect(pendingInput.params.name).toBe("Diamond Sakura");
    expect(pendingInput.params.brand).toBe("Assaf");
    expect(pendingInput.params.categoryId).toBe("cat-perfume");
    expect(pendingInput.params.price).toBe(1800);
    expect(pendingInput.params.quantity).toBe(10);
    expect(pendingInput.params.costPrice).toBe(1200);
    expect(pendingInput.params.lowStockThreshold).toBe(3); // default
  });

  it("rejects negative price", async () => {
    const out = await previewCreateProduct.handler(ctx, {
      name: "X",
      category: "Perfumes",
      price: -1,
      quantity: 1,
    });
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("expected error");
    expect((out as { error: string }).error).toBe("INVALID_PRICE");
  });
});

/* ─── preview_update_product ───────────────────────────────────────────── */

describe("preview_update_product", () => {
  it("asks for a target when neither product_id nor query provided", async () => {
    const out = await previewUpdateProduct.handler(ctx, { name: "New Name" });
    expect(out.ok).toBe(true);
    if (!out.ok || !out.blocks) throw new Error("expected blocks");
    expect(out.blocks[0]!.kind).toBe("text");
  });

  it("asks what to change when target resolves but no field changes", async () => {
    mockListProducts.mockResolvedValue([
      { id: "p1", name: "Diamond Sakura", category: "cat-perfume" },
    ]);
    const out = await previewUpdateProduct.handler(ctx, {
      product_id: "p1",
    });
    expect(out.ok).toBe(true);
    if (!out.ok || !out.blocks) throw new Error("expected blocks");
    expect((out.blocks[0] as { text: string }).text.toLowerCase()).toContain(
      "nothing",
    );
  });

  it("stages a pending action with the patch when fields change", async () => {
    mockListProducts.mockResolvedValue([
      { id: "p1", name: "Diamond Sakura", category: "cat-perfume" },
    ]);
    const out = await previewUpdateProduct.handler(ctx, {
      product_id: "p1",
      name: "Diamond Sakura Original",
      sku: "DS-001",
      cost_price: 1200,
    });
    expect(out.ok).toBe(true);
    if (!out.ok || !out.blocks) throw new Error("expected blocks");
    expect(out.blocks[0]!.kind).toBe("confirmation");
    const pendingInput = mockCreatePending.mock.calls[0]![0] as {
      action: string;
      params: { productId: string; patch: Record<string, unknown> };
    };
    expect(pendingInput.action).toBe("update_product");
    expect(pendingInput.params.productId).toBe("p1");
    expect(pendingInput.params.patch).toEqual({
      name: "Diamond Sakura Original",
      sku: "DS-001",
      costPrice: 1200,
    });
  });

  it("resolves a new category string in the patch to a categoryId", async () => {
    mockListProducts.mockResolvedValue([
      { id: "p1", name: "Diamond Sakura", category: "cat-perfume" },
    ]);
    const out = await previewUpdateProduct.handler(ctx, {
      product_id: "p1",
      category: "Makeup",
    });
    expect(out.ok).toBe(true);
    if (!out.ok || !out.blocks) throw new Error("expected blocks");
    expect(out.blocks[0]!.kind).toBe("confirmation");
    const pendingInput = mockCreatePending.mock.calls[0]![0] as {
      params: { patch: { categoryId?: string } };
    };
    expect(pendingInput.params.patch.categoryId).toBe("cat-makeup");
  });

  it("surfaces clarification when query resolves ambiguously", async () => {
    mockResolveProducts.mockResolvedValue({
      candidates: [
        { id: "p1", name: "Diamond Sakura", brand: "Assaf", score: 0.8 },
        { id: "p2", name: "Diamond Blue", brand: "Assaf", score: 0.8 },
      ],
    });
    const out = await previewUpdateProduct.handler(ctx, {
      query: "Diamond",
      name: "New Name",
    });
    expect(out.ok).toBe(true);
    if (!out.ok || !out.blocks) throw new Error("expected blocks");
    expect(out.blocks[0]!.kind).toBe("text");
    const text = (out.blocks[0] as { text: string }).text;
    expect(text).toContain("Diamond Sakura");
    expect(text).toContain("Diamond Blue");
  });
});

/* ─── preview_create_brand ─────────────────────────────────────────────── */

describe("preview_create_brand", () => {
  it("short-circuits when the brand already exists", async () => {
    mockListBrands.mockResolvedValue([
      { id: "b1", name: "Assaf", categoryId: null },
    ]);
    const out = await previewCreateBrand.handler(ctx, { name: "Assaf" });
    expect(out.ok).toBe(true);
    if (!out.ok || !out.blocks) throw new Error("expected blocks");
    expect(out.blocks[0]!.kind).toBe("text");
    expect((out.blocks[0] as { text: string }).text.toLowerCase()).toContain(
      "already exists",
    );
    expect(mockCreatePending).not.toHaveBeenCalled();
  });

  it("stages a pending action for a new brand", async () => {
    mockListBrands.mockResolvedValue([]);
    const out = await previewCreateBrand.handler(ctx, { name: "Assaf" });
    expect(out.ok).toBe(true);
    if (!out.ok || !out.blocks) throw new Error("expected blocks");
    expect(out.blocks[0]!.kind).toBe("confirmation");
    const pendingInput = mockCreatePending.mock.calls[0]![0] as {
      action: string;
      params: { name: string; categoryId: string | null };
    };
    expect(pendingInput.action).toBe("create_brand");
    expect(pendingInput.params.name).toBe("Assaf");
    expect(pendingInput.params.categoryId).toBeNull();
  });
});

/* ─── preview_create_category ──────────────────────────────────────────── */

describe("preview_create_category", () => {
  it("short-circuits when the category already exists", async () => {
    mockListCategories.mockResolvedValue([
      { id: "cat-perfume", key: "perfume", label: "Perfumes" },
    ]);
    const out = await previewCreateCategory.handler(ctx, { label: "Perfumes" });
    expect(out.ok).toBe(true);
    if (!out.ok || !out.blocks) throw new Error("expected blocks");
    expect(out.blocks[0]!.kind).toBe("text");
    expect((out.blocks[0] as { text: string }).text.toLowerCase()).toContain(
      "already exists",
    );
  });

  it("stages a pending action with a derived key when label is new", async () => {
    mockListCategories.mockResolvedValue([]);
    const out = await previewCreateCategory.handler(ctx, { label: "Perfumes" });
    expect(out.ok).toBe(true);
    if (!out.ok || !out.blocks) throw new Error("expected blocks");
    expect(out.blocks[0]!.kind).toBe("confirmation");
    const pendingInput = mockCreatePending.mock.calls[0]![0] as {
      action: string;
      params: { key: string; label: string };
    };
    expect(pendingInput.action).toBe("create_category");
    expect(pendingInput.params.label).toBe("Perfumes");
    expect(pendingInput.params.key).toBe("perfumes"); // lowercased
  });

  it("asks for label when missing", async () => {
    const out = await previewCreateCategory.handler(ctx, {});
    expect(out.ok).toBe(true);
    if (!out.ok || !out.blocks) throw new Error("expected blocks");
    expect(out.blocks[0]!.kind).toBe("text");
  });
});
