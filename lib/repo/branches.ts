import { and, asc, desc, eq, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import {
  branches,
  sales,
  expenses,
  purchaseOrders,
  attendanceEvents,
  storeLocations,
  products,
  shopSettings,
} from "@/lib/db/schema";
import { cacheBustPrefix, globalKey } from "@/lib/cache";

/** Build a stable URL-safe slug from a branch name. Random suffix guarantees
 *  uniqueness within a tenant when two branches happen to share a name. */
function makeBranchSlug(name: string): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/[؀-ۿ]/g, "") // strip Arabic so the slug is ASCII
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "branch";
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

export class BranchPrimaryError extends Error {
  constructor() {
    super("لا يمكن حذف الفرع الرئيسي");
    this.name = "BranchPrimaryError";
  }
}

export class BranchInUseError extends Error {
  constructor(public counts: Record<string, number>) {
    super("لا يمكن حذف فرع به بيانات");
    this.name = "BranchInUseError";
  }
}

export interface BranchDescriptor {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  address: string | null;
  phone: string | null;
  isActive: boolean;
  isPrimary: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function rowToDescriptor(
  row: typeof branches.$inferSelect,
): BranchDescriptor {
  return {
    id: row.id,
    tenantId: row.tenantId,
    slug: row.slug,
    name: row.name,
    address: row.address,
    phone: row.phone,
    isActive: row.isActive,
    isPrimary: row.isPrimary,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** List every branch in a tenant, ordered: primary first, then by createdAt asc. */
export async function listBranches(
  tenantId: string,
): Promise<BranchDescriptor[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(branches)
      .where(eq(branches.tenantId, tenantId))
      .orderBy(desc(branches.isPrimary), asc(branches.createdAt));
    return rows.map(rowToDescriptor);
  });
}

export async function getBranch(
  tenantId: string,
  branchId: string,
): Promise<BranchDescriptor | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(branches)
      .where(
        and(eq(branches.tenantId, tenantId), eq(branches.id, branchId)),
      )
      .limit(1);
    return row ? rowToDescriptor(row) : null;
  });
}

export interface CreateBranchInput {
  name: string;
  address?: string | null;
  phone?: string | null;
}

/**
 * Create a non-primary branch. Primary branches are seeded by the migration
 * and never created via this path — the partial unique index guarantees only
 * one primary per tenant exists, so attempting to add another would fail at
 * the DB level anyway.
 */
export async function createBranch(
  tenantId: string,
  input: CreateBranchInput,
): Promise<{ id: string }> {
  const trimmed = input.name.trim();
  if (!trimmed) throw new Error("اسم الفرع مطلوب");
  const result = await withTenant(tenantId, async (tx) => {
    const [created] = await tx
      .insert(branches)
      .values({
        tenantId,
        slug: makeBranchSlug(trimmed),
        name: trimmed,
        address: input.address?.trim() || null,
        phone: input.phone?.trim() || null,
        isPrimary: false,
        isActive: true,
      })
      .returning({ id: branches.id });

    // Multi-store: a new branch starts completely empty (no products, no
    // categories, no employees). The owner sets it up from scratch. We do
    // need a `shop_settings` row though — every branch has its own
    // header/logo/WhatsApp config, so seed an empty default.
    await tx.insert(shopSettings).values({
      tenantId,
      branchId: created.id,
      shopName: trimmed, // start with the branch name as the receipt header
      messageTemplate: "",
    });
    return { id: created.id };
  });
  // Owners' allow-list (computed on the fly from branches table) needs to be
  // re-evaluated; staff allow-lists don't change automatically when a new
  // branch lands (owner explicitly grants access via the team form).
  await bustAllAllowListCachesForTenant(tenantId);
  return result;
}

export interface UpdateBranchInput {
  name?: string;
  address?: string | null;
  phone?: string | null;
  isActive?: boolean;
}

export async function updateBranch(
  tenantId: string,
  branchId: string,
  patch: UpdateBranchInput,
): Promise<void> {
  const set: Record<string, unknown> = { updatedAt: sql`now()` };
  if (patch.name !== undefined) {
    const trimmed = patch.name.trim();
    if (!trimmed) throw new Error("اسم الفرع مطلوب");
    set.name = trimmed;
  }
  if (patch.address !== undefined) set.address = patch.address?.trim() || null;
  if (patch.phone !== undefined) set.phone = patch.phone?.trim() || null;
  if (patch.isActive !== undefined) {
    // Disabling the primary branch would leave a tenant with no default
    // landing spot; refuse rather than corrupt the invariant.
    if (patch.isActive === false) {
      const [b] = await withTenant(tenantId, (tx) =>
        tx
          .select({ isPrimary: branches.isPrimary })
          .from(branches)
          .where(
            and(
              eq(branches.tenantId, tenantId),
              eq(branches.id, branchId),
            ),
          )
          .limit(1),
      );
      if (b?.isPrimary) throw new BranchPrimaryError();
    }
    set.isActive = patch.isActive;
  }
  if (Object.keys(set).length === 1) return; // only updatedAt

  await withTenant(tenantId, async (tx) => {
    await tx
      .update(branches)
      .set(set)
      .where(
        and(eq(branches.tenantId, tenantId), eq(branches.id, branchId)),
      );
  });
  await bustAllAllowListCachesForTenant(tenantId);
}

/**
 * Permanently delete a branch. Refuses if:
 *   - the branch is the primary,
 *   - the branch has any rows referencing it (sales, expenses, POs,
 *     attendance, product_stock, store_locations).
 *
 * The DB-level ON DELETE RESTRICT would also stop the delete, but checking
 * up-front lets us return a structured per-table count so the UI can show
 * "you have 12 sales and 3 attendance events on this branch".
 */
export async function deleteBranch(
  tenantId: string,
  branchId: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [b] = await tx
      .select({ isPrimary: branches.isPrimary })
      .from(branches)
      .where(
        and(eq(branches.tenantId, tenantId), eq(branches.id, branchId)),
      )
      .limit(1);
    if (!b) return; // already gone
    if (b.isPrimary) throw new BranchPrimaryError();

    const counts = await collectReferenceCounts(tx, tenantId, branchId);
    if (Object.values(counts).some((n) => n > 0)) {
      throw new BranchInUseError(counts);
    }

    await tx
      .delete(branches)
      .where(
        and(eq(branches.tenantId, tenantId), eq(branches.id, branchId)),
      );
  });
  await bustAllAllowListCachesForTenant(tenantId);
}

async function collectReferenceCounts(
  tx: Parameters<Parameters<typeof withTenant>[1]>[0],
  _tenantId: string,
  branchId: string,
): Promise<Record<string, number>> {
  // Independent count queries — the branch_id index on each table makes them
  // cheap. Counts every multi-store table that references the branch so the
  // UI can show "you still have 12 products + 3 sales here" before refusing.
  const [salesCount] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(sales)
    .where(eq(sales.branchId, branchId));
  const [expensesCount] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(expenses)
    .where(eq(expenses.branchId, branchId));
  const [poCount] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(purchaseOrders)
    .where(eq(purchaseOrders.branchId, branchId));
  const [attCount] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(attendanceEvents)
    .where(eq(attendanceEvents.branchId, branchId));
  const [productsCount] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(products)
    .where(eq(products.branchId, branchId));
  const [locCount] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(storeLocations)
    .where(eq(storeLocations.branchId, branchId));
  return {
    sales: salesCount?.n ?? 0,
    expenses: expensesCount?.n ?? 0,
    purchase_orders: poCount?.n ?? 0,
    attendance_events: attCount?.n ?? 0,
    products: productsCount?.n ?? 0,
    store_locations: locCount?.n ?? 0,
  };
}

/**
 * Drop every cached branch-access list for the tenant. Cheap because the
 * cache key prefix is tight: `g:branch-allow:<tenantId>:*`.
 */
async function bustAllAllowListCachesForTenant(
  tenantId: string,
): Promise<void> {
  await cacheBustPrefix(globalKey("branch-allow", tenantId));
}
