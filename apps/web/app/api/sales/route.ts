import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  requireTenant,
  requireTenantWithBranch,
} from "@/lib/api/auth-helpers";
import { requirePermissionWithBranch } from "@/lib/api/auth-helpers";
import { resolveBranchFilter } from "@/lib/api/branch-context";
import { resolveSinceWindow } from "@/lib/api/list-window";
import { listSales, listSalesPage, recordSale } from "@/lib/repo/operations";
import { parseAlertOrigin } from "@/lib/notifications/sale-alerts";
import { logActivity } from "@/lib/repo/activity";
import { normalizeEgyptPhone } from "@/lib/validators/egypt";
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
    // Digital collections (05 §4.13): pending | confirmed | rejected | any.
    const statusRaw = req.nextUrl.searchParams.get("collectionStatus");
    if (statusRaw && !(COLLECTION_STATUS_FILTERS as readonly string[]).includes(statusRaw)) {
      return NextResponse.json(
        { error: "INVALID_REQUEST", detail: { path: "collectionStatus", message: "invalid value" } },
        { status: 400 },
      );
    }
    const page = await listSalesPage(r.ctx.tenantId, {
      branchId: filter.branchId,
      cursor,
      limit,
      collectionStatus: (statusRaw as CollectionStatusFilter | null) ?? null,
    });
    return NextResponse.json({
      data: page.data,
      nextCursor: page.nextCursor,
      branchId: filter.branchId,
    });
  }
  // Default: last 60 days. Covers every dashboard widget + the
  // inventory dead-stock window (60 days). Callers that need true full
  // history (reports, audits) opt in via `?all=1`.
  const since = resolveSinceWindow(req, { defaultDays: 60 });
  const data = await listSales(r.ctx.tenantId, filter.branchId, since);
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
  paymentMethod: z.enum(["cash", "instapay", "wallet", "card", "deferred"]).optional(),
  // Digital collections (05 §4.7): one accumulating part per invoice, no splits.
  collectionAccountId: z.string().uuid().optional(),
  payerPhoneLast4: z.string().regex(/^\d{4}$/).optional(),
  payerReference: z.string().regex(/^[0-9A-Za-z]{4,16}$/).optional(),
});

const COLLECTION_STATUS_FILTERS = ["pending", "confirmed", "rejected", "any"] as const;
type CollectionStatusFilter = (typeof COLLECTION_STATUS_FILTERS)[number];

export async function POST(req: NextRequest) {
  const r = await requirePermissionWithBranch("record_sales");
  if (!r.ok) return r.response;
  const rl = await checkTenantRateLimit(r.ctx.tenantId, "write.default");
  if (!rl.ok) return rl.response;
  const body = await req.json().catch(() => null);
  const parsed = recordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  // Customer phone normalises to canonical +20 form, exactly as
  // /api/sales/cart does, so every reader keyed on customer_phone (the
  // customer ledger, the v1 customers aggregation, /api/sales/settle) sees
  // one row per person regardless of which endpoint wrote the sale. Junk
  // input becomes null rather than rejecting the sale.
  const normalisedCustomerPhone = parsed.data.customerPhone
    ? normalizeEgyptPhone(parsed.data.customerPhone) ?? null
    : null;
  try {
    const result = await recordSale(r.ctx.tenantId, {
      ...parsed.data,
      customerPhone: normalisedCustomerPhone ?? undefined,
      customDate: parsed.data.customDate ? new Date(parsed.data.customDate) : undefined,
      recordedByUserId: r.ctx.userId,
      branchId: r.ctx.branchId,
      // Sale alerts (doc 16 §2): the recording device stays silent.
      alertOrigin: parseAlertOrigin(req.headers.get("X-Alert-Origin")),
      outboxReplay: req.headers.get("X-Outbox-Replay") === "1",
    });
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "sale.create",
      category: "sale",
      entityType: "sale",
      entityId: result.saleId,
      branchId: r.ctx.branchId,
      metadata: {
        productId: parsed.data.productId,
        quantitySold: parsed.data.quantitySold,
        pricePerUnit: parsed.data.pricePerUnit,
        paymentMethod: parsed.data.paymentMethod ?? null,
        ...(result.collectionIds?.length ? { collectionIds: result.collectionIds } : {}),
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
