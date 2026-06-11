import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireTenant,
  requireTenantWithBranch,
} from "@/lib/api/auth-helpers";
import { resolveBranchFilter } from "@/lib/api/branch-context";
import { listSales, listSalesPage, recordSale } from "@/lib/repo/operations";
import { logActivity } from "@/lib/repo/activity";
import { isDomainError, domainErrorBody } from "@/lib/errors";
import { checkTenantRateLimit } from "@/lib/api/tenant-rate-limit";

export async function GET(req: NextRequest) {
  const r = await requireTenant();
  if (!r.ok) return r.response;
  const filter = await resolveBranchFilter(
    r.ctx,
    req.nextUrl.searchParams.get("branchId"),
  );
  if (!filter.ok) {
    return NextResponse.json({ error: filter.error }, { status: filter.status });
  }
  // Cursor mode: opt-in via `?paginated=1`. Returns { data, nextCursor }.
  // Default (no param) keeps the legacy unpaginated shape so existing
  // clients work unchanged. New UIs should call with paginated=1.
  if (req.nextUrl.searchParams.get("paginated") === "1") {
    const cursor = req.nextUrl.searchParams.get("cursor");
    const limitRaw = req.nextUrl.searchParams.get("limit");
    const limit = limitRaw ? Math.min(200, Math.max(1, Number(limitRaw))) : 50;
    const page = await listSalesPage(r.ctx.tenantId, {
      branchId: filter.branchId,
      cursor,
      limit,
    });
    return NextResponse.json({
      data: page.data,
      nextCursor: page.nextCursor,
      branchId: filter.branchId,
    });
  }
  const data = await listSales(r.ctx.tenantId, filter.branchId);
  return NextResponse.json({ data, branchId: filter.branchId });
}

const recordSchema = z.object({
  productId: z.string().uuid(),
  quantitySold: z.number().int().min(1),
  pricePerUnit: z.number().min(0),
  note: z.string().max(500).optional(),
  discountType: z.enum(["percentage", "fixed"]).optional(),
  discountValue: z.number().min(0).optional(),
  customDate: z.string().datetime().optional(),
  invoiceId: z.string().max(40).optional(),
  customerName: z.string().max(120).optional(),
  customerPhone: z.string().max(40).optional(),
  paymentMethod: z.enum(["cash", "instapay", "card", "deferred"]).optional(),
});

export async function POST(req: NextRequest) {
  const r = await requireTenantWithBranch();
  if (!r.ok) return r.response;
  const rl = await checkTenantRateLimit(r.ctx.tenantId, "write.default");
  if (!rl.ok) return rl.response;
  const body = await req.json().catch(() => null);
  const parsed = recordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  try {
    const result = await recordSale(r.ctx.tenantId, {
      ...parsed.data,
      customDate: parsed.data.customDate ? new Date(parsed.data.customDate) : undefined,
      recordedByUserId: r.ctx.userId,
      branchId: r.ctx.branchId,
    });
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "sale.create",
      category: "sale",
      entityType: "sale",
      entityId: (result as { id?: string }).id ?? null,
      branchId: r.ctx.branchId,
      metadata: {
        productId: parsed.data.productId,
        quantitySold: parsed.data.quantitySold,
        pricePerUnit: parsed.data.pricePerUnit,
        paymentMethod: parsed.data.paymentMethod ?? null,
      },
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (isDomainError(err)) {
      return NextResponse.json(domainErrorBody(err), { status: err.httpStatus });
    }
    return NextResponse.json(
      { error: "INTERNAL", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
