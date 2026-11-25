// POST /api/inventory-counts
//   Body: { scope: { kind: 'all'|'category'|'brand', value: string|null } }
//   Returns: { id, scopeProductCount }
//
// GET /api/inventory-counts?status=active|draft|in_progress|review|completed|cancelled
//   Returns: { data: Array<{ count, summary }> }
//
// Permission: manage_inventory_counts (write), view_inventory_counts (read).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/api/auth-helpers";
import { logActivity } from "@/lib/repo/activity";
import {
  createCount,
  listCounts,
  type CountScope,
  type CountStatus,
} from "@/lib/repo/inventory-counts";

const createSchema = z.object({
  scope: z.object({
    kind: z.enum(["all", "category", "brand"]),
    value: z.string().nullable().optional(),
  }),
});

export async function POST(req: NextRequest) {
  const r = await requirePermission("manage_inventory_counts");
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  const scope: CountScope = {
    kind: parsed.data.scope.kind,
    value: parsed.data.scope.value ?? null,
  };
  if ((scope.kind === "category" || scope.kind === "brand") && !scope.value) {
    return NextResponse.json({ error: "SCOPE_VALUE_REQUIRED" }, { status: 400 });
  }

  const result = await createCount(r.ctx.tenantId, {
    scope,
    createdByUserId: r.ctx.userId,
  });

  logActivity({
    tenantId: r.ctx.tenantId,
    actorUserId: r.ctx.userId,
    action: "inventory_count.create",
    category: "product",
    entityType: "inventory_count",
    entityId: result.countId,
    metadata: { scope, scopeProductCount: result.scopeProductCount },
  });

  return NextResponse.json(result, { status: 201 });
}

export async function GET(req: NextRequest) {
  const r = await requirePermission("view_inventory_counts");
  if (!r.ok) return r.response;
  const status = req.nextUrl.searchParams.get("status") as CountStatus | "active" | null;
  const data = await listCounts(r.ctx.tenantId, status ? { status } : {});
  return NextResponse.json({ data });
}
