// Slice 2b.1 — tenant-custom category CRUD.
//
// System categories (tenant_id IS NULL, is_system=true) are seeded in
// migration 0064 and are IMMUTABLE — they cannot be renamed, re-parented,
// or archived through this surface. Tenant-custom categories live alongside
// them and can be:
//
//   • created as subcategories under a system group
//   • renamed
//   • soft-archived (archived_at set)
//
// Archive is rejected when live, posted expenses still reference the row —
// otherwise existing financial history would lose its classification.

import "server-only";

import { and, count, eq, isNull, isNotNull, or, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { expenses as expensesTable, financialCategories } from "@/lib/db/schema";

export class CategoryParentInvalidError extends Error {
  constructor() {
    super("PARENT_INVALID");
    this.name = "CategoryParentInvalidError";
  }
}

export class CategorySlugConflictError extends Error {
  constructor() {
    super("SLUG_CONFLICT");
    this.name = "CategorySlugConflictError";
  }
}

export class CategoryImmutableError extends Error {
  constructor() {
    super("IMMUTABLE_SYSTEM_CATEGORY");
    this.name = "CategoryImmutableError";
  }
}

export class CategoryInUseError extends Error {
  constructor(public count: number) {
    super("CATEGORY_IN_USE");
    this.name = "CategoryInUseError";
  }
}

export class CategoryNotFoundError extends Error {
  constructor() {
    super("CATEGORY_NOT_FOUND");
    this.name = "CategoryNotFoundError";
  }
}

export interface CreateCategoryInput {
  parentId: string;
  nameEn: string;
  nameAr: string;
  sortOrder?: number;
  createdByUserId: string;
}

/**
 * Create a tenant-custom category under a system (or tenant-custom) parent.
 * The new row's `kind` is inherited from the parent — a subcategory under
 * "People" is always opex, etc.
 *
 * Slug is derived from `nameEn` and uniqued against (tenant_id, slug) via
 * the migration's partial index. If a collision happens, the caller should
 * pick a different name (we surface `SLUG_CONFLICT` rather than silently
 * dedupe).
 */
export async function createCustomCategory(
  tenantId: string,
  input: CreateCategoryInput,
): Promise<{ id: string }> {
  const slug = slugify(input.nameEn);
  if (!slug) throw new CategoryParentInvalidError();

  return withTenant(tenantId, async (tx) => {
    // Parent must exist, be visible to this tenant, not archived, and must
    // itself be a GROUP (parent_id IS NULL) — the tree is intentionally two
    // levels deep.
    const [parent] = await tx
      .select({
        id: financialCategories.id,
        kind: financialCategories.kind,
        parentId: financialCategories.parentId,
      })
      .from(financialCategories)
      .where(
        and(
          eq(financialCategories.id, input.parentId),
          sql`${financialCategories.archivedAt} is null`,
          or(
            isNull(financialCategories.tenantId),
            eq(financialCategories.tenantId, tenantId),
          )!,
        ),
      )
      .limit(1);
    if (!parent || parent.parentId !== null) {
      throw new CategoryParentInvalidError();
    }

    // Check slug uniqueness within this tenant (tenant-custom).
    const [existing] = await tx
      .select({ id: financialCategories.id })
      .from(financialCategories)
      .where(
        and(
          eq(financialCategories.tenantId, tenantId),
          eq(financialCategories.slug, slug),
        ),
      )
      .limit(1);
    if (existing) throw new CategorySlugConflictError();

    const [created] = await tx
      .insert(financialCategories)
      .values({
        tenantId,
        parentId: input.parentId,
        slug,
        nameEn: input.nameEn,
        nameAr: input.nameAr,
        kind: parent.kind,
        isSystem: false,
        sortOrder: input.sortOrder ?? 100,
        createdByUserId: input.createdByUserId,
      })
      .returning({ id: financialCategories.id });

    return { id: created.id };
  });
}

/**
 * Rename a tenant-custom category. System rows (tenant_id IS NULL) are
 * immutable — attempting to patch one returns IMMUTABLE_SYSTEM_CATEGORY.
 */
export async function renameCategory(
  tenantId: string,
  id: string,
  patch: { nameEn?: string; nameAr?: string; sortOrder?: number },
): Promise<void> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: financialCategories.id,
        tenantId: financialCategories.tenantId,
        isSystem: financialCategories.isSystem,
      })
      .from(financialCategories)
      .where(eq(financialCategories.id, id))
      .limit(1);
    if (!row) throw new CategoryNotFoundError();
    if (row.isSystem || row.tenantId === null) throw new CategoryImmutableError();
    if (row.tenantId !== tenantId) throw new CategoryNotFoundError();

    const updates: Record<string, unknown> = {
      updatedAt: new Date(),
    };
    if (patch.nameEn !== undefined) updates.nameEn = patch.nameEn;
    if (patch.nameAr !== undefined) updates.nameAr = patch.nameAr;
    if (patch.sortOrder !== undefined) updates.sortOrder = patch.sortOrder;
    if (Object.keys(updates).length === 1) return; // nothing to change

    await tx
      .update(financialCategories)
      .set(updates)
      .where(eq(financialCategories.id, id));
  });
}

/**
 * Soft-archive a tenant-custom category. Refuses when at least one live
 * (status='posted') expense still points at it — the owner must re-classify
 * those rows first, otherwise historical reporting silently loses them from
 * their group.
 *
 * System categories cannot be archived.
 */
export async function archiveCategory(tenantId: string, id: string): Promise<void> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: financialCategories.id,
        tenantId: financialCategories.tenantId,
        isSystem: financialCategories.isSystem,
        archivedAt: financialCategories.archivedAt,
      })
      .from(financialCategories)
      .where(eq(financialCategories.id, id))
      .limit(1);
    if (!row) throw new CategoryNotFoundError();
    if (row.isSystem || row.tenantId === null) throw new CategoryImmutableError();
    if (row.tenantId !== tenantId) throw new CategoryNotFoundError();
    if (row.archivedAt) return; // already archived — idempotent.

    const [{ n }] = await tx
      .select({ n: count() })
      .from(expensesTable)
      .where(
        and(
          eq(expensesTable.tenantId, tenantId),
          eq(expensesTable.categoryId, id),
          eq(expensesTable.status, "posted"),
        ),
      );
    if (Number(n) > 0) throw new CategoryInUseError(Number(n));

    await tx
      .update(financialCategories)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(financialCategories.id, id));
  });
}

// Lowercase + strip non-[a-z0-9_] runs. Collisions surface as SLUG_CONFLICT
// rather than silent dedupe so the caller picks a distinct name.
function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\w]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
}

// isNotNull imported for future filters (list only tenant-owned, etc.).
void isNotNull;
