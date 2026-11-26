import type { PgTransaction } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";
import {
  categories,
  categoryAttributes,
  categoryAttributeValues,
  brands,
} from "@/lib/db/schema";

// Watch brand list — currently the only category in Corner Store with a
// curated brand picker. Mirrors the hardcoded options that lived in
// app/add-product/page.tsx before Phase 2.
const WATCH_BRANDS = [
  "Casio",
  "Citizen",
  "Seiko",
  "Tissot",
  "Rolex",
  "Other",
];

// Seeds a fresh tenant with the exact catalog the original Corner Store ships:
// three categories (Watches, Perfumes, Sunglasses), gender attribute on
// Watches and Sunglasses, watch brands. After this runs, /add-product looks
// identical to the pre-migration Corner Store wizard.
export async function seedCornerStorePreset(
  tx: PgTransaction<any, any, any>,
  tenantId: string,
  branchId: string,
): Promise<void> {
  // Idempotent: if any categories already exist for this tenant we skip the
  // whole seed. Re-running onboarding (browser back/refresh, network retry)
  // must NOT crash on the (tenant_id, key) unique constraint.
  const existing = await tx
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.tenantId, tenantId))
    .limit(1);
  if (existing.length > 0) return;

  // 1. Categories
  const [watches, perfumes, sunglasses] = await tx
    .insert(categories)
    .values([
      {
        tenantId,
        branchId,
        key: "watches",
        label: "ساعات",
        icon: "Watch",
        position: 0,
        hasAttributes: true,
      },
      {
        tenantId,
        branchId,
        key: "perfumes",
        label: "برفانات",
        icon: "FlaskConical",
        position: 1,
        hasAttributes: false,
      },
      {
        tenantId,
        branchId,
        key: "sunglasses",
        label: "نظارات",
        icon: "Glasses",
        position: 2,
        hasAttributes: true,
      },
    ])
    .returning({ id: categories.id });

  // 2. Gender attribute on Watches + Sunglasses
  const [watchGenderAttr, sunglassesGenderAttr] = await tx
    .insert(categoryAttributes)
    .values([
      {
        tenantId,
        branchId,
        categoryId: watches.id,
        key: "gender",
        label: "النوع",
        position: 0,
        required: true,
      },
      {
        tenantId,
        branchId,
        categoryId: sunglasses.id,
        key: "gender",
        label: "النوع",
        position: 0,
        required: true,
      },
    ])
    .returning({ id: categoryAttributes.id });

  // 3. Gender values for both
  await tx.insert(categoryAttributeValues).values([
    {
      tenantId,
      branchId,
      attributeId: watchGenderAttr.id,
      key: "male",
      label: "رجالي",
      position: 0,
    },
    {
      tenantId,
      branchId,
      attributeId: watchGenderAttr.id,
      key: "female",
      label: "حريمي",
      position: 1,
    },
    {
      tenantId,
      branchId,
      attributeId: sunglassesGenderAttr.id,
      key: "male",
      label: "رجالي",
      position: 0,
    },
    {
      tenantId,
      branchId,
      attributeId: sunglassesGenderAttr.id,
      key: "female",
      label: "حريمي",
      position: 1,
    },
  ]);

  // 4. Watch brands (scoped to the watches category)
  await tx.insert(brands).values(
    WATCH_BRANDS.map((name) => ({
      tenantId,
      branchId,
      categoryId: watches.id,
      name,
    })),
  );
}
