// GET /api/financials/money-movements — list with filters.
// POST /api/financials/money-movements — create a new movement.
//
// Movements are NEVER folded into P&L — see lib/finance/pnl.ts. They're
// tracked for operator visibility and for audit.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/api/auth-helpers";
import { auditFinancial } from "@/lib/finance/audit";
import {
  MONEY_MOVEMENT_KINDS,
  createMoneyMovement,
  isMoneyMovementKind,
  listMoneyMovements,
} from "@/lib/finance/money-movement-mutations";

const listQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  kind: z.enum(MONEY_MOVEMENT_KINDS).optional(),
  status: z.enum(["active", "voided", "any"]).optional(),
  cursor: z.string().max(100).nullable().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function GET(req: NextRequest) {
  const r = await requirePermission("view_financials");
  if (!r.ok) return r.response;
  const parsed = listQuery.safeParse(
    Object.fromEntries(req.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_query" }, { status: 400 });
  }
  const q = parsed.data;
  const page = await listMoneyMovements(r.ctx.tenantId, {
    from: q.from ? new Date(q.from) : undefined,
    to: q.to ? new Date(q.to) : undefined,
    kind: q.kind,
    status: q.status,
    limit: q.limit,
    cursor: q.cursor ?? null,
  });
  return NextResponse.json(page);
}

const createSchema = z.object({
  kind: z.enum(MONEY_MOVEMENT_KINDS),
  amount: z.number().min(0),
  occurredAt: z
    .string()
    .refine((v) => !Number.isNaN(new Date(v).getTime()), { message: "invalid date" })
    .optional(),
  description: z.string().max(500).optional().nullable(),
  paymentMethod: z.enum(["cash", "instapay", "wallet", "card", "other"]).optional().nullable(),
  relatedEntityType: z.string().max(40).optional().nullable(),
  relatedEntityId: z.string().uuid().optional().nullable(),
});

export async function POST(req: NextRequest) {
  const auth = await requirePermission("manage_money_movements");
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "invalid_body" },
      { status: 400 },
    );
  }

  if (!isMoneyMovementKind(parsed.data.kind)) {
    return NextResponse.json({ error: "INVALID_KIND" }, { status: 400 });
  }

  const { id } = await createMoneyMovement(auth.ctx.tenantId, {
    kind: parsed.data.kind,
    amount: parsed.data.amount,
    occurredAt: parsed.data.occurredAt ? new Date(parsed.data.occurredAt) : undefined,
    description: parsed.data.description ?? null,
    paymentMethod: parsed.data.paymentMethod ?? null,
    relatedEntityType: parsed.data.relatedEntityType ?? null,
    relatedEntityId: parsed.data.relatedEntityId ?? null,
    createdByUserId: auth.ctx.userId,
  });

  await auditFinancial({
    tenantId: auth.ctx.tenantId,
    actorUserId: auth.ctx.userId,
    action: "finance.money_movement.create",
    entityType: "money_movement",
    entityId: id,
    metadata: {
      kind: parsed.data.kind,
      amount: parsed.data.amount,
    },
  });

  return NextResponse.json({ id }, { status: 201 });
}
