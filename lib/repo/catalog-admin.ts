import { and, asc, count, eq } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import {
  brands,
  categories,
  categoryAttributes,
  categoryAttributeValues,
  products,
} from "@/lib/db/schema";
import { bustCatalogCache } from "@/lib/repo/catalog";

export class CatalogConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogConflictError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Categories
// ─────────────────────────────────────────────────────────────────────────────

export interface AddCategoryInput {
  key: string;
  label: string;
  icon?: string | null;
  position?: number;
  hasAttributes?: boolean;
}

export async function addCategory(
  tenantId: string,
  input: AddCategoryInput,
): Promise<{ id: string }> {
  const result = await withTenant(tenantId, async (tx) => {
    const [created] = await tx
      .insert(categories)
      .values({
        tenantId,
        key: input.key,
        label: input.label,
        icon: input.icon ?? null,
        position: input.position ?? 0,
        hasAttributes: input.hasAttributes ?? false,
      })
      .returning({ id: categories.id });
    return { id: created.id };
  });
  await bustCatalogCache(tenantId);
  return result;
}

export interface UpdateCategoryInput {
  label?: string;
  icon?: string | null;
  position?: number;
  hasAttributes?: boolean;
}

export async function updateCategory(
  tenantId: string,
  id: string,
  patch: UpdateCategoryInput,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const set: Record<string, unknown> = {};
    if (patch.label !== undefined) set.label = patch.label;
    if (patch.icon !== undefined) set.icon = patch.icon;
    if (patch.position !== undefined) set.position = patch.position;
    if (patch.hasAttributes !== undefined) set.hasAttributes = patch.hasAttributes;
    if (Object.keys(set).length === 0) return;
    await tx
      .update(categories)
      .set(set)
      .where(and(eq(categories.tenantId, tenantId), eq(categories.id, id)));
  });
  await bustCatalogCache(tenantId);
}

export async function deleteCategory(
  tenantId: string,
  id: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [{ value }] = await tx
      .select({ value: count() })
      .from(products)
      .where(and(eq(products.tenantId, tenantId), eq(products.categoryId, id)));
    if (value > 0) {
      throw new CatalogConflictError(
        `Cannot delete: ${value} منتج يستخدم هذا القسم`,
      );
    }
    await tx
      .delete(categories)
      .where(and(eq(categories.tenantId, tenantId), eq(categories.id, id)));
  });
  await bustCatalogCache(tenantId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Category attributes
// ─────────────────────────────────────────────────────────────────────────────

export interface AddAttributeInput {
  categoryId: string;
  key: string;
  label: string;
  position?: number;
  required?: boolean;
}

export async function addAttribute(
  tenantId: string,
  input: AddAttributeInput,
): Promise<{ id: string }> {
  const result = await withTenant(tenantId, async (tx) => {
    const [created] = await tx
      .insert(categoryAttributes)
      .values({
        tenantId,
        categoryId: input.categoryId,
        key: input.key,
        label: input.label,
        position: input.position ?? 0,
        required: input.required ?? true,
      })
      .returning({ id: categoryAttributes.id });

    // Mark the parent category as having attributes (drives wizard behavior).
    await tx
      .update(categories)
      .set({ hasAttributes: true })
      .where(and(eq(categories.tenantId, tenantId), eq(categories.id, input.categoryId)));

    return { id: created.id };
  });
  await bustCatalogCache(tenantId);
  return result;
}

export async function updateAttribute(
  tenantId: string,
  id: string,
  patch: { label?: string; position?: number; required?: boolean },
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const set: Record<string, unknown> = {};
    if (patch.label !== undefined) set.label = patch.label;
    if (patch.position !== undefined) set.position = patch.position;
    if (patch.required !== undefined) set.required = patch.required;
    if (Object.keys(set).length === 0) return;
    await tx
      .update(categoryAttributes)
      .set(set)
      .where(
        and(eq(categoryAttributes.tenantId, tenantId), eq(categoryAttributes.id, id)),
      );
  });
  await bustCatalogCache(tenantId);
}

export async function deleteAttribute(
  tenantId: string,
  id: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [attr] = await tx
      .select({ categoryId: categoryAttributes.categoryId })
      .from(categoryAttributes)
      .where(
        and(eq(categoryAttributes.tenantId, tenantId), eq(categoryAttributes.id, id)),
      )
      .limit(1);
    if (!attr) return;

    await tx
      .delete(categoryAttributes)
      .where(
        and(eq(categoryAttributes.tenantId, tenantId), eq(categoryAttributes.id, id)),
      );

    // If the parent category now has no attributes, flip hasAttributes off.
    const remaining = await tx
      .select({ id: categoryAttributes.id })
      .from(categoryAttributes)
      .where(
        and(
          eq(categoryAttributes.tenantId, tenantId),
          eq(categoryAttributes.categoryId, attr.categoryId),
        ),
      )
      .limit(1);
    if (remaining.length === 0) {
      await tx
        .update(categories)
        .set({ hasAttributes: false })
        .where(
          and(eq(categories.tenantId, tenantId), eq(categories.id, attr.categoryId)),
        );
    }
  });
  await bustCatalogCache(tenantId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Attribute values
// ─────────────────────────────────────────────────────────────────────────────

export async function addAttributeValue(
  tenantId: string,
  attributeId: string,
  input: { key: string; label: string; position?: number },
): Promise<{ id: string }> {
  const result = await withTenant(tenantId, async (tx) => {
    const [created] = await tx
      .insert(categoryAttributeValues)
      .values({
        tenantId,
        attributeId,
        key: input.key,
        label: input.label,
        position: input.position ?? 0,
      })
      .returning({ id: categoryAttributeValues.id });
    return { id: created.id };
  });
  await bustCatalogCache(tenantId);
  return result;
}

export async function updateAttributeValue(
  tenantId: string,
  id: string,
  patch: { label?: string; position?: number },
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const set: Record<string, unknown> = {};
    if (patch.label !== undefined) set.label = patch.label;
    if (patch.position !== undefined) set.position = patch.position;
    if (Object.keys(set).length === 0) return;
    await tx
      .update(categoryAttributeValues)
      .set(set)
      .where(
        and(
          eq(categoryAttributeValues.tenantId, tenantId),
          eq(categoryAttributeValues.id, id),
        ),
      );
  });
  await bustCatalogCache(tenantId);
}

export async function deleteAttributeValue(
  tenantId: string,
  id: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .delete(categoryAttributeValues)
      .where(
        and(
          eq(categoryAttributeValues.tenantId, tenantId),
          eq(categoryAttributeValues.id, id),
        ),
      );
  });
  await bustCatalogCache(tenantId);
}

// ─────────────────────────────────────────────────────────────────────────────
// Brands
// ─────────────────────────────────────────────────────────────────────────────

export interface AddBrandInput {
  categoryId: string | null;
  name: string;
}

export async function addBrand(
  tenantId: string,
  input: AddBrandInput,
): Promise<{ id: string }> {
  const result = await withTenant(tenantId, async (tx) => {
    const [created] = await tx
      .insert(brands)
      .values({
        tenantId,
        categoryId: input.categoryId,
        name: input.name,
      })
      .returning({ id: brands.id });
    return { id: created.id };
  });
  await bustCatalogCache(tenantId);
  return result;
}

export async function deleteBrand(tenantId: string, id: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .delete(brands)
      .where(and(eq(brands.tenantId, tenantId), eq(brands.id, id)));
  });
  await bustCatalogCache(tenantId);
}

export async function updateBrand(
  tenantId: string,
  id: string,
  patch: { name?: string; categoryId?: string | null },
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.categoryId !== undefined) set.categoryId = patch.categoryId;
    if (Object.keys(set).length === 0) return;
    await tx
      .update(brands)
      .set(set)
      .where(and(eq(brands.tenantId, tenantId), eq(brands.id, id)));
  });
  await bustCatalogCache(tenantId);
}
