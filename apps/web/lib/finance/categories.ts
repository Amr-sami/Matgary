// Slice 1 — category tree reader + helpers.
//
// System categories (tenant_id IS NULL) are seeded in migration 0064. Tenant
// custom categories are per-tenant. The tree lookup returns both, with
// system rows first.

import "server-only";

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { financialCategories } from "@/lib/db/schema";

export interface CategoryNode {
  id: string;
  parentId: string | null;
  slug: string;
  nameEn: string;
  nameAr: string;
  kind: "opex" | "other_income" | "other_expense";
  isSystem: boolean;
  sortOrder: number;
  archivedAt: string | null;
  children: CategoryNode[];
}

/** Flat list of all visible (non-archived) categories for this tenant. */
export async function listCategoriesFlat(tenantId: string) {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: financialCategories.id,
        parentId: financialCategories.parentId,
        slug: financialCategories.slug,
        nameEn: financialCategories.nameEn,
        nameAr: financialCategories.nameAr,
        kind: financialCategories.kind,
        isSystem: financialCategories.isSystem,
        sortOrder: financialCategories.sortOrder,
        archivedAt: financialCategories.archivedAt,
        tenantId: financialCategories.tenantId,
      })
      .from(financialCategories)
      .where(
        and(
          // System rows (tenant_id IS NULL) + rows owned by this tenant.
          or(isNull(financialCategories.tenantId), eq(financialCategories.tenantId, tenantId)),
          sql`${financialCategories.archivedAt} is null`,
        ),
      )
      .orderBy(financialCategories.sortOrder, financialCategories.nameEn);
    return rows;
  });
}

/** Build the parent → children tree. System and tenant-custom rows blend. */
export async function listCategoriesTree(tenantId: string): Promise<CategoryNode[]> {
  const flat = await listCategoriesFlat(tenantId);
  const byId = new Map<string, CategoryNode>();
  for (const r of flat) {
    byId.set(r.id, {
      id: r.id,
      parentId: r.parentId,
      slug: r.slug,
      nameEn: r.nameEn,
      nameAr: r.nameAr,
      kind: r.kind as CategoryNode["kind"],
      isSystem: r.isSystem,
      sortOrder: r.sortOrder,
      archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
      children: [],
    });
  }
  const roots: CategoryNode[] = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortNodes = (arr: CategoryNode[]) => {
    arr.sort((a, b) => a.sortOrder - b.sortOrder || a.nameEn.localeCompare(b.nameEn));
    for (const n of arr) sortNodes(n.children);
  };
  sortNodes(roots);
  return roots;
}
