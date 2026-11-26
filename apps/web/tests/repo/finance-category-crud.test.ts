// Slice 2b.1 — integration tests for tenant-custom category CRUD.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";

import { db, withTenant } from "@/lib/db";
import {
  branches,
  financialCategories,
  shopSettings,
  tenants,
  tenantMembers,
  users,
} from "@/lib/db/schema";
import {
  CategoryImmutableError,
  CategoryInUseError,
  CategoryNotFoundError,
  CategoryParentInvalidError,
  CategorySlugConflictError,
  archiveCategory,
  createCustomCategory,
  renameCategory,
} from "@/lib/finance/category-mutations";
import { createFinanceExpense } from "@/lib/finance/expense-mutations";

const PEOPLE_GROUP = "00000000-0000-4001-0000-000000000001";
const SALARIES_LEAF = "00000000-0000-4011-0000-000000000001";

let tenantA: { tenantId: string; userId: string };
let tenantB: { tenantId: string; userId: string };

async function freshTenant(suffix: string) {
  return db.transaction(async (tx) => {
    const email = `cat-${suffix}-${Date.now()}@test.local`;
    const [u] = await tx
      .insert(users)
      .values({ email, name: `Cat ${suffix}`, passwordHash: "x" })
      .returning({ id: users.id });
    const [t] = await tx
      .insert(tenants)
      .values({
        name: `Cat ${suffix}`,
        slug: `cat-${suffix}-${Math.random().toString(36).slice(2, 8)}`,
      })
      .returning({ id: tenants.id });
    await tx.execute(sql`select set_config('app.tenant_id', ${t.id}, true)`);
    const [b] = await tx
      .insert(branches)
      .values({
        tenantId: t.id,
        slug: "main",
        name: "Main",
        isPrimary: true,
      })
      .returning({ id: branches.id });
    await tx.insert(tenantMembers).values({
      tenantId: t.id,
      userId: u.id,
      role: "owner",
    });
    await tx.insert(shopSettings).values({
      tenantId: t.id,
      branchId: b.id,
      shopName: `Cat ${suffix}`,
    });
    return { tenantId: t.id, userId: u.id };
  });
}

beforeAll(async () => {
  tenantA = await freshTenant("a");
  tenantB = await freshTenant("b");
});

afterAll(async () => {
  if (tenantA?.tenantId)
    await db.execute(sql`delete from tenants where id = ${tenantA.tenantId}`);
  if (tenantB?.tenantId)
    await db.execute(sql`delete from tenants where id = ${tenantB.tenantId}`);
});

describe("Financials category CRUD — integration", () => {
  it("creates a tenant-custom subcategory under a system group, inheriting its kind", async () => {
    const { id } = await createCustomCategory(tenantA.tenantId, {
      parentId: PEOPLE_GROUP,
      nameEn: "Senior bonuses",
      nameAr: "مكافآت الموظفين الكبار",
      createdByUserId: tenantA.userId,
    });
    const [row] = await withTenant(tenantA.tenantId, (tx) =>
      tx
        .select({
          id: financialCategories.id,
          tenantId: financialCategories.tenantId,
          parentId: financialCategories.parentId,
          slug: financialCategories.slug,
          isSystem: financialCategories.isSystem,
          kind: financialCategories.kind,
        })
        .from(financialCategories)
        .where(eq(financialCategories.id, id)),
    );
    expect(row?.tenantId).toBe(tenantA.tenantId);
    expect(row?.parentId).toBe(PEOPLE_GROUP);
    expect(row?.isSystem).toBe(false);
    expect(row?.kind).toBe("opex");
    expect(row?.slug).toMatch(/^senior_bonuses$/);
  });

  it("refuses create when the parent is a leaf (not a group) — the tree is two levels", async () => {
    await expect(
      createCustomCategory(tenantA.tenantId, {
        parentId: SALARIES_LEAF,
        nameEn: "Illegal nested",
        nameAr: "غير مسموح",
        createdByUserId: tenantA.userId,
      }),
    ).rejects.toBeInstanceOf(CategoryParentInvalidError);
  });

  it("refuses create when the slug collides with an existing tenant-custom category", async () => {
    await createCustomCategory(tenantA.tenantId, {
      parentId: PEOPLE_GROUP,
      nameEn: "Training fund",
      nameAr: "صندوق تدريب",
      createdByUserId: tenantA.userId,
    });
    await expect(
      createCustomCategory(tenantA.tenantId, {
        parentId: PEOPLE_GROUP,
        nameEn: "Training fund",
        nameAr: "صندوق تدريب دف",
        createdByUserId: tenantA.userId,
      }),
    ).rejects.toBeInstanceOf(CategorySlugConflictError);
  });

  it("renames a tenant-custom category", async () => {
    const { id } = await createCustomCategory(tenantA.tenantId, {
      parentId: PEOPLE_GROUP,
      nameEn: "Perks",
      nameAr: "مزايا",
      createdByUserId: tenantA.userId,
    });
    await renameCategory(tenantA.tenantId, id, {
      nameEn: "Team perks",
      nameAr: "مزايا الفريق",
    });
    const [row] = await withTenant(tenantA.tenantId, (tx) =>
      tx
        .select({
          nameEn: financialCategories.nameEn,
          nameAr: financialCategories.nameAr,
        })
        .from(financialCategories)
        .where(eq(financialCategories.id, id)),
    );
    expect(row?.nameEn).toBe("Team perks");
    expect(row?.nameAr).toBe("مزايا الفريق");
  });

  it("system categories are immutable (rename + archive both refused)", async () => {
    await expect(
      renameCategory(tenantA.tenantId, SALARIES_LEAF, { nameEn: "Hacked" }),
    ).rejects.toBeInstanceOf(CategoryImmutableError);
    await expect(
      archiveCategory(tenantA.tenantId, SALARIES_LEAF),
    ).rejects.toBeInstanceOf(CategoryImmutableError);
  });

  it("archives a tenant-custom category that has no live expenses", async () => {
    const { id } = await createCustomCategory(tenantA.tenantId, {
      parentId: PEOPLE_GROUP,
      nameEn: "Retention",
      nameAr: "الاحتفاظ",
      createdByUserId: tenantA.userId,
    });
    await archiveCategory(tenantA.tenantId, id);
    const [row] = await withTenant(tenantA.tenantId, (tx) =>
      tx
        .select({ archivedAt: financialCategories.archivedAt })
        .from(financialCategories)
        .where(eq(financialCategories.id, id)),
    );
    expect(row?.archivedAt).toBeTruthy();
  });

  it("archive is idempotent (second call is a no-op, doesn't throw)", async () => {
    const { id } = await createCustomCategory(tenantA.tenantId, {
      parentId: PEOPLE_GROUP,
      nameEn: "Onboarding pool",
      nameAr: "صندوق الالتحاق",
      createdByUserId: tenantA.userId,
    });
    await archiveCategory(tenantA.tenantId, id);
    await expect(archiveCategory(tenantA.tenantId, id)).resolves.toBeUndefined();
  });

  it("archive refuses when live expenses still reference the category", async () => {
    const { id } = await createCustomCategory(tenantA.tenantId, {
      parentId: PEOPLE_GROUP,
      nameEn: "Field agents",
      nameAr: "الممثلون",
      createdByUserId: tenantA.userId,
    });
    await createFinanceExpense(tenantA.tenantId, {
      title: "Agent commission",
      amount: 500,
      date: new Date(),
      categoryId: id,
      createdByUserId: tenantA.userId,
    });
    await expect(archiveCategory(tenantA.tenantId, id)).rejects.toBeInstanceOf(
      CategoryInUseError,
    );
  });

  it("tenant isolation: tenant B cannot rename or archive tenant A's category", async () => {
    const { id } = await createCustomCategory(tenantA.tenantId, {
      parentId: PEOPLE_GROUP,
      nameEn: "A-only category",
      nameAr: "تصنيف ألف",
      createdByUserId: tenantA.userId,
    });
    await expect(
      renameCategory(tenantB.tenantId, id, { nameEn: "Hijacked" }),
    ).rejects.toBeInstanceOf(CategoryNotFoundError);
    await expect(archiveCategory(tenantB.tenantId, id)).rejects.toBeInstanceOf(
      CategoryNotFoundError,
    );
  });
});
