import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { requirePermission } from "@/lib/api/auth-helpers";
import { db, withTenant } from "@/lib/db";
import { branches, shopSettings } from "@/lib/db/schema";

// Per-branch toggle + threshold for cash reconciliation.

export async function GET() {
  const r = await requirePermission("manage_cash_reconciliation");
  if (!r.ok) return r.response;

  const rows = await withTenant(r.ctx.tenantId, async (tx) => {
    const branchRows = await tx
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(eq(branches.tenantId, r.ctx.tenantId));
    const settingsRows = await tx
      .select()
      .from(shopSettings)
      .where(eq(shopSettings.tenantId, r.ctx.tenantId));
    const byBranch = new Map(settingsRows.map((s) => [s.branchId, s]));
    return branchRows.map((b) => {
      const s = byBranch.get(b.id);
      return {
        branchId: b.id,
        branchName: b.name,
        cashReconciliationEnabled: s?.cashReconciliationEnabled ?? false,
        cashVarianceNoteThreshold: s?.cashVarianceNoteThreshold ?? "50",
      };
    });
  });
  return NextResponse.json({ data: rows });
}

const schema = z.object({
  cashReconciliationEnabled: z.boolean().optional(),
  cashVarianceNoteThreshold: z.union([z.string(), z.number()]).optional(),
});

export async function PATCH(req: NextRequest) {
  const r = await requirePermission("manage_cash_reconciliation");
  if (!r.ok) return r.response;
  const branchId = req.nextUrl.searchParams.get("branchId");
  if (!branchId) {
    return NextResponse.json({ error: "branchId required" }, { status: 400 });
  }
  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }

  await withTenant(r.ctx.tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(shopSettings)
      .where(
        and(
          eq(shopSettings.tenantId, r.ctx.tenantId),
          eq(shopSettings.branchId, branchId),
        ),
      )
      .limit(1);
    if (!existing) {
      await tx.insert(shopSettings).values({
        tenantId: r.ctx.tenantId,
        branchId,
        cashReconciliationEnabled:
          parsed.data.cashReconciliationEnabled ?? false,
        cashVarianceNoteThreshold: String(
          parsed.data.cashVarianceNoteThreshold ?? "50",
        ),
      });
      return;
    }
    const patch: Record<string, unknown> = {};
    if (parsed.data.cashReconciliationEnabled !== undefined)
      patch.cashReconciliationEnabled = parsed.data.cashReconciliationEnabled;
    if (parsed.data.cashVarianceNoteThreshold !== undefined)
      patch.cashVarianceNoteThreshold = String(
        parsed.data.cashVarianceNoteThreshold,
      );
    if (Object.keys(patch).length === 0) return;
    patch.updatedAt = new Date();
    await tx
      .update(shopSettings)
      .set(patch)
      .where(
        and(
          eq(shopSettings.tenantId, r.ctx.tenantId),
          eq(shopSettings.branchId, branchId),
        ),
      );
  });

  return NextResponse.json({ ok: true });
}
