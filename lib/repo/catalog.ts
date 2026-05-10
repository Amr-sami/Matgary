import { and, eq, asc, desc, inArray, sql } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import {
  categories,
  categoryAttributes,
  categoryAttributeValues,
  brands,
  products,
  productAttributeValues,
  productHistory,
  suppliers,
} from "@/lib/db/schema";
import type {
  CategoryDescriptor,
  CategoryAttribute,
  BrandDescriptor,
  Product,
} from "@/lib/types";
import { cacheBustPrefix, cacheRemember, tenantKey } from "@/lib/cache";

// 5 min: catalog moves rarely, and every catalog-admin mutation calls
// bustCatalogCache(tenantId) anyway, so the only stale window is when
// someone edits the schema directly in the DB.
const CATALOG_TTL_SEC = 300;
const CATALOG_PREFIX = "catalog";

const categoriesKey = (tenantId: string, branchId: string | null) =>
  tenantKey(tenantId, CATALOG_PREFIX, "categories", branchId ?? "_all");
const attrsKey = (tenantId: string, categoryId: string) =>
  tenantKey(tenantId, CATALOG_PREFIX, "attrs", categoryId);
const brandsKey = (
  tenantId: string,
  branchId: string | null,
  categoryId?: string,
) =>
  tenantKey(
    tenantId,
    CATALOG_PREFIX,
    "brands",
    branchId ?? "_all",
    categoryId ?? "_all",
  );

/**
 * Drop every cached catalog read for one tenant. Cheap because the prefix is
 * narrow (`…:t:<tenantId>:catalog:`) — SCAN over <100 keys in any realistic
 * tenant. Call from every mutation in lib/repo/catalog-admin.ts.
 */
export async function bustCatalogCache(tenantId: string): Promise<void> {
  await cacheBustPrefix(tenantKey(tenantId, CATALOG_PREFIX));
}

// ─────────────────────────────────────────────────────────────────────────────
// Read paths
// ─────────────────────────────────────────────────────────────────────────────

export async function listCategories(
  tenantId: string,
  branchId?: string | null,
): Promise<CategoryDescriptor[]> {
  return cacheRemember(
    categoriesKey(tenantId, branchId ?? null),
    CATALOG_TTL_SEC,
    () =>
      withTenant(tenantId, async (tx) => {
        const filters = [eq(categories.tenantId, tenantId)];
        if (branchId) filters.push(eq(categories.branchId, branchId));
        const rows = await tx
          .select()
          .from(categories)
          .where(and(...filters))
          .orderBy(asc(categories.position), asc(categories.label));
        return rows.map((r) => ({
          id: r.id,
          key: r.key,
          label: r.label,
          icon: r.icon,
          position: r.position,
          hasAttributes: r.hasAttributes,
        }));
      }),
  );
}

export async function listAttributesForCategory(
  tenantId: string,
  categoryId: string,
): Promise<CategoryAttribute[]> {
  return cacheRemember(attrsKey(tenantId, categoryId), CATALOG_TTL_SEC, () =>
    withTenant(tenantId, async (tx) => {
    const attrs = await tx
      .select()
      .from(categoryAttributes)
      .where(
        and(
          eq(categoryAttributes.tenantId, tenantId),
          eq(categoryAttributes.categoryId, categoryId),
        ),
      )
      .orderBy(asc(categoryAttributes.position), asc(categoryAttributes.label));

    if (attrs.length === 0) return [];

    const values = await tx
      .select()
      .from(categoryAttributeValues)
      .where(
        and(
          eq(categoryAttributeValues.tenantId, tenantId),
          inArray(
            categoryAttributeValues.attributeId,
            attrs.map((a) => a.id),
          ),
        ),
      )
      .orderBy(asc(categoryAttributeValues.position));

    return attrs.map((a) => ({
      id: a.id,
      categoryId: a.categoryId,
      key: a.key,
      label: a.label,
      position: a.position,
      required: a.required,
      values: values
        .filter((v) => v.attributeId === a.id)
        .map((v) => ({
          id: v.id,
          attributeId: v.attributeId,
          key: v.key,
          label: v.label,
          position: v.position,
        })),
    }));
    }),
  );
}

export async function listBrands(
  tenantId: string,
  branchId?: string | null,
  categoryId?: string,
): Promise<BrandDescriptor[]> {
  return cacheRemember(
    brandsKey(tenantId, branchId ?? null, categoryId),
    CATALOG_TTL_SEC,
    () =>
      withTenant(tenantId, async (tx) => {
        const filters = [eq(brands.tenantId, tenantId)];
        if (branchId) filters.push(eq(brands.branchId, branchId));
        if (categoryId) filters.push(eq(brands.categoryId, categoryId));
        const rows = await tx
          .select()
          .from(brands)
          .where(and(...filters))
          .orderBy(asc(brands.name));
      return rows.map((r) => ({ id: r.id, categoryId: r.categoryId, name: r.name }));
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Products
// ─────────────────────────────────────────────────────────────────────────────

function rowToProduct(
  p: typeof products.$inferSelect,
  pavs: (typeof productAttributeValues.$inferSelect)[],
  attrKeysById: Map<string, string>,
): Product {
  const myValues = pavs.filter((v) => v.productId === p.id);
  const attributes: Record<string, string> = {};
  for (const v of myValues) {
    const key = attrKeysById.get(v.attributeId);
    if (key) attributes[key] = v.valueLabel;
  }
  return {
    id: p.id,
    name: p.name,
    category: p.categoryId,
    gender: attributes.gender ?? "",
    attributes,
    brand: p.brand ?? undefined,
    quantity: p.quantity,
    price: Number(p.price),
    costPrice: p.costPrice ? Number(p.costPrice) : undefined,
    lowStockThreshold: p.lowStockThreshold,
    sku: p.sku ?? undefined,
    tags: p.tags ?? [],
    supplier: p.supplier ?? undefined,
    supplierId: p.supplierId ?? null,
    location: p.location ?? undefined,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}

export async function listProducts(
  tenantId: string,
  /** When set, restricts to products owned by that branch. Null = every
   *  branch in the tenant (owner-only "all branches" view). */
  branchId?: string | null,
): Promise<Product[]> {
  return withTenant(tenantId, async (tx) => {
    const productFilters = [eq(products.tenantId, tenantId)];
    if (branchId) productFilters.push(eq(products.branchId, branchId));
    const ps = await tx
      .select()
      .from(products)
      .where(and(...productFilters))
      .orderBy(desc(products.createdAt));

    if (ps.length === 0) return [];

    const pavs = await tx
      .select()
      .from(productAttributeValues)
      .where(eq(productAttributeValues.tenantId, tenantId));

    // Map attribute_id -> key for value snapshot
    const allAttrIds = Array.from(new Set(pavs.map((v) => v.attributeId)));
    const attrKeysById = new Map<string, string>();
    if (allAttrIds.length > 0) {
      const attrs = await tx
        .select({ id: categoryAttributes.id, key: categoryAttributes.key })
        .from(categoryAttributes)
        .where(
          and(
            eq(categoryAttributes.tenantId, tenantId),
            inArray(categoryAttributes.id, allAttrIds),
          ),
        );
      for (const a of attrs) attrKeysById.set(a.id, a.key);
    }

    // Resolve linked supplier names so the legacy `supplier` text field stays
    // populated for clients that filter/group on it.
    const supplierIds = Array.from(
      new Set(ps.map((p) => p.supplierId).filter((v): v is string => !!v)),
    );
    const supplierNamesById = new Map<string, string>();
    if (supplierIds.length > 0) {
      const rows = await tx
        .select({ id: suppliers.id, name: suppliers.name })
        .from(suppliers)
        .where(
          and(eq(suppliers.tenantId, tenantId), inArray(suppliers.id, supplierIds)),
        );
      for (const r of rows) supplierNamesById.set(r.id, r.name);
    }

    return ps.map((p) => {
      const product = rowToProduct(p, pavs, attrKeysById);
      // Linked supplier name takes precedence over the legacy free-text field.
      if (p.supplierId) {
        const linked = supplierNamesById.get(p.supplierId);
        if (linked) product.supplier = linked;
      }
      return product;
    });
  });
}

export interface AddProductInput {
  name: string;
  categoryId: string;
  brand?: string;
  quantity: number;
  price: number;
  costPrice?: number;
  lowStockThreshold: number;
  sku?: string;
  tags?: string[];
  supplier?: string;
  supplierId?: string | null;
  location?: string;
  /** attribute_value_id list — one per category attribute. */
  attributeValueIds?: string[];
}

export async function addProduct(
  tenantId: string,
  branchId: string,
  input: AddProductInput,
): Promise<{ id: string }> {
  return withTenant(tenantId, async (tx) => {
    // Resolve attribute snapshots up front so we can validate they all belong
    // to this tenant + the chosen category.
    let snapshotRows: { attributeId: string; valueId: string; valueLabel: string }[] = [];
    if (input.attributeValueIds && input.attributeValueIds.length > 0) {
      const valueRows = await tx
        .select({
          id: categoryAttributeValues.id,
          attributeId: categoryAttributeValues.attributeId,
          label: categoryAttributeValues.label,
        })
        .from(categoryAttributeValues)
        .innerJoin(
          categoryAttributes,
          eq(categoryAttributes.id, categoryAttributeValues.attributeId),
        )
        .where(
          and(
            eq(categoryAttributeValues.tenantId, tenantId),
            eq(categoryAttributes.categoryId, input.categoryId),
            inArray(categoryAttributeValues.id, input.attributeValueIds),
          ),
        );

      snapshotRows = valueRows.map((v) => ({
        attributeId: v.attributeId,
        valueId: v.id,
        valueLabel: v.label,
      }));
    }

    const [created] = await tx
      .insert(products)
      .values({
        tenantId,
        branchId,
        categoryId: input.categoryId,
        name: input.name,
        brand: input.brand ?? null,
        quantity: input.quantity,
        price: String(input.price),
        costPrice: input.costPrice != null ? String(input.costPrice) : null,
        lowStockThreshold: input.lowStockThreshold,
        sku: input.sku ?? null,
        tags: input.tags ?? [],
        supplier: input.supplier ?? null,
        supplierId: input.supplierId ?? null,
        location: input.location ?? null,
      })
      .returning({ id: products.id });

    if (snapshotRows.length > 0) {
      await tx.insert(productAttributeValues).values(
        snapshotRows.map((s) => ({
          productId: created.id,
          attributeId: s.attributeId,
          valueId: s.valueId,
          valueLabel: s.valueLabel,
          tenantId,
          branchId,
        })),
      );
    }

    await tx.insert(productHistory).values({
      tenantId,
      productId: created.id,
      productName: input.name,
      type: "created",
      delta: input.quantity,
      quantityAfter: input.quantity,
    });

    return { id: created.id };
  });
}

export async function deleteProduct(tenantId: string, id: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .delete(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.id, id)));
  });
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
  tenantId: string,
  id: string,
  patch: UpdateProductInput,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const set: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.brand !== undefined) set.brand = patch.brand;
    if (patch.quantity !== undefined) set.quantity = patch.quantity;
    if (patch.price !== undefined) set.price = String(patch.price);
    if (patch.costPrice !== undefined)
      set.costPrice = patch.costPrice == null ? null : String(patch.costPrice);
    if (patch.lowStockThreshold !== undefined)
      set.lowStockThreshold = patch.lowStockThreshold;
    if (patch.sku !== undefined) set.sku = patch.sku;
    if (patch.tags !== undefined) set.tags = patch.tags;
    if (patch.supplier !== undefined) set.supplier = patch.supplier;
    if (patch.supplierId !== undefined) set.supplierId = patch.supplierId;
    if (patch.location !== undefined) set.location = patch.location;

    const [before] = await tx
      .select({ name: products.name, quantity: products.quantity })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.id, id)));

    if (!before) return;

    await tx
      .update(products)
      .set(set)
      .where(and(eq(products.tenantId, tenantId), eq(products.id, id)));

    if (patch.quantity !== undefined && patch.quantity !== before.quantity) {
      const delta = patch.quantity - before.quantity;
      await tx.insert(productHistory).values({
        tenantId,
        productId: id,
        productName: before.name,
        type: delta > 0 ? "restocked" : "decreased",
        delta,
        quantityAfter: patch.quantity,
      });
    } else {
      await tx.insert(productHistory).values({
        tenantId,
        productId: id,
        productName: patch.name ?? before.name,
        type: "updated",
      });
    }
  });
}

export async function bulkUpdateProducts(
  tenantId: string,
  ids: string[],
  patch: UpdateProductInput,
): Promise<void> {
  for (const id of ids) {
    await updateProduct(tenantId, id, patch);
  }
}

export async function bulkDeleteProducts(
  tenantId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  await withTenant(tenantId, async (tx) => {
    await tx
      .delete(products)
      .where(
        and(eq(products.tenantId, tenantId), inArray(products.id, ids)),
      );
  });
}

export async function adjustProductQuantity(
  tenantId: string,
  productId: string,
  delta: number,
): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const [before] = await tx
      .select({ name: products.name, quantity: products.quantity })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.id, productId)));
    if (!before) throw new Error("المنتج غير موجود");

    const next = Math.max(0, before.quantity + delta);
    await tx
      .update(products)
      .set({ quantity: next, updatedAt: new Date() })
      .where(and(eq(products.tenantId, tenantId), eq(products.id, productId)));

    await tx.insert(productHistory).values({
      tenantId,
      productId,
      productName: before.name,
      type: delta >= 0 ? "restocked" : "decreased",
      delta,
      quantityAfter: next,
    });

    return next;
  });
}

/**
 * Move a set of products to a new category (used by inventory bulk action).
 * Drops attribute snapshots since the new category may have a different
 * attribute schema.
 */
export async function bulkChangeCategory(
  tenantId: string,
  ids: string[],
  newCategoryId: string,
): Promise<void> {
  if (ids.length === 0) return;
  await withTenant(tenantId, async (tx) => {
    await tx
      .delete(productAttributeValues)
      .where(
        and(
          eq(productAttributeValues.tenantId, tenantId),
          inArray(productAttributeValues.productId, ids),
        ),
      );
    await tx
      .update(products)
      .set({ categoryId: newCategoryId, updatedAt: new Date() })
      .where(and(eq(products.tenantId, tenantId), inArray(products.id, ids)));
  });
}

export async function listProductHistory(
  tenantId: string,
  productId: string,
) {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(productHistory)
      .where(
        and(
          eq(productHistory.tenantId, tenantId),
          eq(productHistory.productId, productId),
        ),
      )
      .orderBy(sql`${productHistory.createdAt} desc`);
    return rows.map((r) => ({
      id: r.id,
      productId: r.productId,
      productName: r.productName,
      type: r.type as
        | "created"
        | "updated"
        | "restocked"
        | "decreased"
        | "sold"
        | "returned",
      delta: r.delta ?? undefined,
      quantityAfter: r.quantityAfter ?? undefined,
      note: r.note ?? undefined,
      createdAt: r.createdAt,
    }));
  });
}

/**
 * Apply a price multiplier to a set of products in a single tx.
 */
export async function bulkScalePrice(
  tenantId: string,
  ids: string[],
  multiplier: number,
): Promise<void> {
  if (ids.length === 0) return;
  await withTenant(tenantId, async (tx) => {
    await tx.execute(sql`
      update products
        set price = round(price * ${multiplier}::numeric, 2),
            updated_at = now()
        where tenant_id = ${tenantId}
          and id = any(${ids}::uuid[])
    `);
  });
}

/**
 * Append a tag to each of the given products (no-op if it's already there).
 */
export async function bulkAddTag(
  tenantId: string,
  ids: string[],
  tag: string,
): Promise<void> {
  if (ids.length === 0 || !tag) return;
  await withTenant(tenantId, async (tx) => {
    await tx.execute(sql`
      update products
        set tags = array(select distinct unnest(tags || array[${tag}])),
            updated_at = now()
        where tenant_id = ${tenantId}
          and id = any(${ids}::uuid[])
    `);
  });
}
