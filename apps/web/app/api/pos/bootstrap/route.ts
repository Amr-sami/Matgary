import { NextResponse } from "next/server";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { listProducts, listCategories } from "@/lib/repo/catalog";

// One-shot snapshot for the offline POS. Called on every page load while
// online; the client stashes the result in IndexedDB so a wifi blink
// later in the shift doesn't blank the cart.
//
// Shape kept tiny on purpose:
//   - products: id, name, brand, price, qty, sku, categoryId, attributes
//   - categories: id, key, label, icon
//   - branch: id, name (for the offline header)
//
// What's deliberately NOT here (yet):
//   - customer history (the cart's optional customer-phone autocomplete
//     would explode the payload size for tenants with thousands of past
//     customers — re-introduce as a separate endpoint with pagination).
//   - product cost prices (cashier doesn't need them; profit calc
//     happens server-side at sync time).
//   - low_stock_threshold (only matters for the inventory page, not POS).
//
// Cache: this route is hit on every cashier page open, but the underlying
// catalog reads are already 5-min cached at the repo level, so back-to-
// back hits within a busy shift are cheap.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;

  const [products, categories] = await Promise.all([
    listProducts(r.ctx.tenantId, r.ctx.branchId),
    listCategories(r.ctx.tenantId, r.ctx.branchId),
  ]);

  return NextResponse.json({
    branch: {
      id: r.ctx.branchId,
      name: r.ctx.branchName,
    },
    fetchedAt: Date.now(),
    products: products.map((p) => ({
      id: p.id,
      name: p.name,
      brand: p.brand ?? null,
      price: p.price,
      quantity: p.quantity,
      sku: p.sku ?? null,
      categoryId: p.category, // schema stores categoryId in the `category` field
      attributes: p.attributes,
    })),
    categories: categories.map((c) => ({
      id: c.id,
      key: c.key,
      label: c.label,
      icon: c.icon,
    })),
  });
}
