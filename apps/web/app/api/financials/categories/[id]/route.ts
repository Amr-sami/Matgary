// PATCH /api/financials/categories/[id]  — rename / re-order a tenant-custom
//   category.
// DELETE /api/financials/categories/[id] — soft-archive. Refused when live
//   expenses still reference the category.
//
// System rows (tenant_id IS NULL) are IMMUTABLE on both verbs.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/api/auth-helpers";
import { auditFinancial } from "@/lib/finance/audit";
import {
  CategoryImmutableError,
  CategoryInUseError,
  CategoryNotFoundError,
  archiveCategory,
  renameCategory,
} from "@/lib/finance/category-mutations";

const idSchema = z.string().uuid();
const patchSchema = z.object({
  nameEn: z.string().min(1).max(80).optional(),
  nameAr: z.string().min(1).max(80).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

interface Params {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await requirePermission("manage_expense_categories");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!idSchema.safeParse(id).success) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid_body" },
      { status: 400 },
    );
  }
  if (Object.keys(parsed.data).length === 0) {
    return NextResponse.json({ error: "empty_patch" }, { status: 400 });
  }

  try {
    await renameCategory(auth.ctx.tenantId, id, parsed.data);
    await auditFinancial({
      tenantId: auth.ctx.tenantId,
      actorUserId: auth.ctx.userId,
      action: "finance.category.update",
      entityType: "financial_category",
      entityId: id,
      metadata: { changed: Object.keys(parsed.data) },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof CategoryNotFoundError)
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    if (err instanceof CategoryImmutableError)
      return NextResponse.json(
        { error: "IMMUTABLE_SYSTEM_CATEGORY" },
        { status: 403 },
      );
    throw err;
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const auth = await requirePermission("manage_expense_categories");
  if (!auth.ok) return auth.response;

  const { id } = await params;
  if (!idSchema.safeParse(id).success) {
    return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  try {
    await archiveCategory(auth.ctx.tenantId, id);
    await auditFinancial({
      tenantId: auth.ctx.tenantId,
      actorUserId: auth.ctx.userId,
      action: "finance.category.archive",
      entityType: "financial_category",
      entityId: id,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof CategoryNotFoundError)
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    if (err instanceof CategoryImmutableError)
      return NextResponse.json(
        { error: "IMMUTABLE_SYSTEM_CATEGORY" },
        { status: 403 },
      );
    if (err instanceof CategoryInUseError)
      return NextResponse.json(
        { error: "CATEGORY_IN_USE", expenseCount: err.count },
        { status: 409 },
      );
    throw err;
  }
}
