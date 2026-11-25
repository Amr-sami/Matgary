// PUT    /api/inventory-counts/[id]/lines/[productId]
// DELETE /api/inventory-counts/[id]/lines/[productId]
//
// PUT body: { countedQty: number, source: 'scan'|'manual', force?: boolean }
// - If the line exists: update counted_qty + counted_at (server-set, always).
// - If the product is not in the frozen scope: 409 OUT_OF_SCOPE with
//   `{productId, currentQty}` so the client can prompt "Add anyway?"; the
//   client then re-PUTs with `force=true` which creates an `added_mid_count`
//   line with its own baseline captured at add-time.
//
// Tenant isolation: both helpers run inside `withTenant` and the count_id
// is matched by (tenant_id, id) — no cross-tenant access possible.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/api/auth-helpers";
import {
  deleteLine,
  InventoryCountConflictError,
  upsertLine,
} from "@/lib/repo/inventory-counts";

const putSchema = z.object({
  countedQty: z.number().int().min(0).max(1_000_000),
  source: z.enum(["scan", "manual"]),
  force: z.boolean().optional(),
});

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const r = await requirePermission("manage_inventory_counts");
  if (!r.ok) return r.response;
  const { id, productId } = await params;
  const body = await req.json().catch(() => null);
  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  try {
    const line = await upsertLine(r.ctx.tenantId, id, productId, {
      countedQty: parsed.data.countedQty,
      source: parsed.data.source,
      countedByUserId: r.ctx.userId,
      force: parsed.data.force,
    });
    return NextResponse.json({ line });
  } catch (err) {
    if (err instanceof InventoryCountConflictError) {
      const map: Record<string, number> = {
        COUNT_NOT_FOUND: 404,
        INVALID_STATUS: 409,
        OUT_OF_SCOPE: 409,
        ALREADY_CONFIRMED: 409,
        COUNT_HAS_INVALID_LINES: 409,
      };
      return NextResponse.json(
        { error: err.code, ...(err.details ? { details: err.details } : {}) },
        { status: map[err.code] ?? 409 },
      );
    }
    throw err;
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; productId: string }> },
) {
  const r = await requirePermission("manage_inventory_counts");
  if (!r.ok) return r.response;
  const { id, productId } = await params;
  try {
    await deleteLine(r.ctx.tenantId, id, productId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof InventoryCountConflictError) {
      return NextResponse.json(
        { error: err.code },
        { status: err.code === "COUNT_NOT_FOUND" ? 404 : 409 },
      );
    }
    throw err;
  }
}
