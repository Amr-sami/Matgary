import { listProducts } from "@/lib/repo/catalog";

import type { Tool } from "./types";
import { parseLimit } from "./_shared";

export const getLowStock: Tool = {
  name: "get_low_stock",
  description:
    "Products that are out of stock OR at/below their low-stock threshold. Returns the most urgent (lowest quantity) first. Use for 'what's low in stock', 'needs restocking'.",
  requiredPermission: "view_inventory",
  parameters: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: "Max items to return (default 15).",
      },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const limit = parseLimit(args.limit, 15, 50);
    const products = await listProducts(ctx.tenantId, null);
    const outOfStock = products.filter((p) => p.quantity === 0);
    const lowStock = products.filter(
      (p) => p.quantity > 0 && p.quantity <= p.lowStockThreshold,
    );
    const trim = (p: (typeof products)[number]) => ({
      id: p.id,
      name: p.name,
      brand: p.brand ?? null,
      quantity: p.quantity,
      threshold: p.lowStockThreshold,
    });
    const items = [
      ...outOfStock.map(trim),
      ...lowStock
        .slice()
        .sort((a, b) => a.quantity - b.quantity)
        .map(trim),
    ].slice(0, limit);
    return {
      ok: true,
      data: {
        outOfStockCount: outOfStock.length,
        lowStockCount: lowStock.length,
        items,
      },
    };
  },
};
