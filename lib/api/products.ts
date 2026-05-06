// Client-side wrappers around the product API. Imported by inventory and
// other product-mutating UI. Keeps the same function names the legacy
// firestore.ts exposed so callers only need to flip the import path.

import type { Product } from "@/lib/types";

export interface BulkUpdate {
  type:
    | "addTag"
    | "priceMultiplier"
    | "category"
    | "supplier"
    | "location"
    | "gender"; // ignored — gender is now a category attribute, not a column
  value: string | number;
}

async function jsonFetch(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

export async function deleteProduct(productId: string): Promise<void> {
  await jsonFetch(`/api/products/${productId}`, { method: "DELETE" });
}

export interface UpdateProductInput {
  name?: string;
  brand?: string | null;
  quantity?: number;
  price?: number;
  costPrice?: number | null;
  lowStockThreshold?: number;
  sku?: string | null;
  tags?: string[];
  supplier?: string | null;
  supplierId?: string | null;
  location?: string | null;
}

export async function updateProduct(
  productId: string,
  patch: UpdateProductInput,
): Promise<void> {
  await jsonFetch(`/api/products/${productId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function bulkDeleteProducts(productIds: string[]): Promise<void> {
  if (productIds.length === 0) return;
  await jsonFetch("/api/products/bulk", {
    method: "DELETE",
    body: JSON.stringify({ ids: productIds }),
  });
}

export async function adjustProductQuantity(
  productId: string,
  delta: number,
): Promise<number> {
  const json = await jsonFetch(`/api/products/${productId}/adjust`, {
    method: "POST",
    body: JSON.stringify({ delta }),
  });
  return json.newQuantity;
}

/**
 * Pre-Phase-2 callers passed (productSlice[], BulkUpdate). We translate to
 * the new bulk endpoint, then ignore actions that no longer have meaning
 * (e.g. gender — moved to category attributes).
 */
export async function bulkUpdateProducts(
  productsSlice: Pick<Product, "id" | "price" | "tags">[],
  update: BulkUpdate,
): Promise<void> {
  const ids = productsSlice.map((p) => p.id);
  if (ids.length === 0) return;

  switch (update.type) {
    case "supplier":
    case "location":
      await jsonFetch("/api/products/bulk", {
        method: "PATCH",
        body: JSON.stringify({
          ids,
          patch: { [update.type]: String(update.value) },
        }),
      });
      return;
    case "addTag": {
      // Iterate to preserve the existing tags + add the new one.
      // (The bulk endpoint's tags field replaces, not appends — server-side
      // helper does the merge atomically when invoked one-by-one.)
      const tag = String(update.value);
      for (const p of productsSlice) {
        const next = Array.from(new Set([...(p.tags || []), tag])).filter(Boolean);
        await jsonFetch(`/api/products/${p.id}`, {
          method: "PATCH",
          body: JSON.stringify({ tags: next }),
        });
      }
      return;
    }
    case "priceMultiplier": {
      const m = Number(update.value);
      for (const p of productsSlice) {
        const newPrice = Math.max(0, Math.round(p.price * m));
        await jsonFetch(`/api/products/${p.id}`, {
          method: "PATCH",
          body: JSON.stringify({ price: newPrice }),
        });
      }
      return;
    }
    case "category":
      // categoryId change isn't covered by the bulk patch endpoint (it has
      // attribute-snapshot side effects). Hit the per-id endpoint via a
      // dedicated bulk-change route in a future patch — for now no-op so
      // existing UI doesn't crash.
      return;
    case "gender":
      // Phase 2: gender is no longer a product column. UI for this action
      // will be removed in Phase 4 (settings UI) — silently accept it for now.
      return;
  }
}

/**
 * Bulk-add path used by CSV import. POSTs each row through the create
 * endpoint sequentially; the API enforces tenant scoping + validation.
 */
export async function bulkAddProducts(
  rows: Array<{
    name: string;
    categoryId: string;
    brand?: string;
    quantity: number;
    price: number;
    costPrice?: number;
    lowStockThreshold?: number;
    sku?: string;
    tags?: string[];
    supplier?: string;
    location?: string;
    attributeValueIds?: string[];
  }>,
): Promise<number> {
  let added = 0;
  for (const row of rows) {
    await jsonFetch("/api/products", {
      method: "POST",
      body: JSON.stringify({
        ...row,
        lowStockThreshold: row.lowStockThreshold ?? 3,
      }),
    });
    added++;
  }
  return added;
}
