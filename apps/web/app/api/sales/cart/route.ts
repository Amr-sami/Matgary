import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireTenantWithBranch, requirePermissionWithBranch } from "@/lib/api/auth-helpers";
import { recordCartSale } from "@/lib/repo/operations";
import { logActivity } from "@/lib/repo/activity";
import { normalizeEgyptPhone } from "@/lib/validators/egypt";
import { isDomainError, domainErrorBody } from "@/lib/errors";
import { checkTenantRateLimit } from "@/lib/api/tenant-rate-limit";
import {
  getCachedResponse,
  rememberResponse,
  validateIdempotencyKey,
} from "@/lib/api/idempotency";

const lineSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1),
  pricePerUnit: z.number().min(0),
  lineDiscountType: z.enum(["percentage", "fixed"]).optional(),
  lineDiscountValue: z.number().min(0).optional(),
});

const schema = z.object({
  lines: z.array(lineSchema).min(1),
  options: z
    .object({
      note: z.string().max(500).optional(),
      orderDiscountType: z.enum(["percentage", "fixed"]).optional(),
      orderDiscountValue: z.number().min(0).optional(),
      customDate: z.string().datetime().optional(),
      customerName: z.string().max(120).optional(),
      customerPhone: z.string().max(40).optional(),
      paymentMethod: z.enum(["cash", "instapay", "card", "deferred"]).optional(),
      // Client-supplied invoice id, used by the offline POS so the receipt
      // the cashier already printed matches the eventual server record.
      invoiceId: z
        .string()
        .max(80)
        .regex(/^[A-Za-z0-9_\-:.]+$/)
        .optional(),
      // Loyalty redemption — refused by recordCartSale if customerPhone
      // is missing, the loyalty programme is disabled for the branch, or
      // the wallet balance is short.
      redeemPoints: z.number().int().min(0).max(1_000_000).optional(),
      applyCreditEgp: z.number().min(0).max(1_000_000).optional(),
      // Partial payment: amount the customer paid at the counter on a
      // deferred sale. Distributed proportionally across the lines.
      amountPaidNow: z.number().min(0).max(10_000_000).optional(),
      // S7 (doc 06 §6.5): offline replay of a sale the customer already
      // walked out with. Books the sale even when a line exceeds stock —
      // quantity floors at 0 and a discrepancy row lands in product_history.
      // Interactive sales leave it false and keep the INSUFFICIENT_STOCK 400.
      allowOversell: z.boolean().default(false),
    })
    .optional(),
});

export async function POST(req: NextRequest) {
  const r = await requirePermissionWithBranch("record_sales");
  if (!r.ok) return r.response;

  // Per-tenant rate guard. Cap a runaway POS or leaked-cookie attack to a
  // few hundred carts/min before it can DoS the DB pool. Checked AFTER
  // idempotency so a legitimate retry on the same key doesn't burn a
  // bucket slot.

  // Offline POS: replays of the same outbox row carry the same
  // Idempotency-Key. Short-circuit on a known key so the second POST
  // returns the original response without re-running the sale.
  const idemp = validateIdempotencyKey(req.headers.get("Idempotency-Key"));
  if (idemp) {
    const cached = await getCachedResponse(r.ctx.tenantId, idemp);
    if (cached) {
      return NextResponse.json(cached.body, { status: cached.status });
    }
  }

  const rl = await checkTenantRateLimit(r.ctx.tenantId, "write.default");
  if (!rl.ok) return rl.response;

  // Multi-store sanity check: if the outbox row was rung up at a branch
  // the cashier later switched away from, refuse rather than book the
  // sale at the wrong branch. The header is set by the outbox client.
  const outboxBranch = req.headers.get("X-Outbox-Branch");
  if (outboxBranch && outboxBranch !== r.ctx.branchId) {
    return NextResponse.json(
      {
        error:
          "هذه الفاتورة كانت مُسجَّلة لفرع آخر. بدّل للفرع الصحيح ثم أعد المزامنة.",
      },
      { status: 409 },
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0].message }, { status: 400 });
  }
  // S7 guard (doc 02 S13 "keep the hard 400 for interactive online sales"):
  // the oversell bypass is ONLY for the offline outbox replaying a sale the
  // customer already left with, and every outbox replay carries an
  // Idempotency-Key. A bare interactive/crafted POST with the flag is
  // refused, so `record_sales` alone cannot silently write a stock
  // adjustment by flipping one boolean.
  if (parsed.data.options?.allowOversell && !idemp) {
    return NextResponse.json(
      { error: "OVERSELL_REQUIRES_IDEMPOTENCY_KEY" },
      { status: 400 },
    );
  }
  // Customer phone normalises to canonical +20 form so the customer-history
  // lookup matches across "0100…" and "+20100…" entries. Junk input becomes
  // null rather than rejecting the sale (the cashier shouldn't be blocked
  // from ringing up because of a typo).
  const normalisedCustomerPhone = parsed.data.options?.customerPhone
    ? normalizeEgyptPhone(parsed.data.options.customerPhone) ?? null
    : null;
  try {
    const result = await recordCartSale(r.ctx.tenantId, parsed.data.lines, {
      ...parsed.data.options,
      customerPhone: normalisedCustomerPhone ?? undefined,
      customDate: parsed.data.options?.customDate
        ? new Date(parsed.data.options.customDate)
        : undefined,
      recordedByUserId: r.ctx.userId,
      recordedByRole: r.ctx.role === "owner" ? "owner" : "staff",
      branchId: r.ctx.branchId,
    });
    const totalQty = result.lines.reduce((s, l) => s + l.quantity, 0);
    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "sale.create",
      category: "sale",
      entityType: "sale",
      entityId: result.saleIds[0] ?? null,
      entityLabel: result.invoiceId,
      branchId: r.ctx.branchId,
      metadata: {
        invoiceId: result.invoiceId,
        lineCount: result.lines.length,
        totalQuantity: totalQty,
        total: result.total,
        paymentMethod: result.paymentMethod,
        customerName: result.customerName,
        customerPhone: result.customerPhone,
        note: result.note,
        lines: result.lines,
        // S7: who booked an oversell, and by how much — auditable without
        // joining stock_discrepancies.
        ...(result.oversold.length > 0 ? { oversold: result.oversold } : {}),
      },
    });
    // Cache the response so a replay of the same Idempotency-Key returns
    // the original instead of re-running the sale.
    if (idemp) {
      await rememberResponse(r.ctx.tenantId, idemp, 201, result);
    }
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    // Failures are NOT cached — only a 2xx is. A domain refusal (or a 500)
    // means nothing was booked, so replaying the key cannot double-post,
    // and the offline POS retries a refused sale under the SAME key with
    // corrected options (S7: `allowOversell: true` after the cashier
    // confirms the sell-anyway sheet) — a cached 400 would answer that
    // corrected retry with the stale refusal for 24h.
    if (isDomainError(err)) {
      return NextResponse.json(domainErrorBody(err), { status: err.httpStatus });
    }
    // Truly unexpected — log and 500. Sentry breadcrumb already captured
    // by the global handler.
    const errorBody = { error: "INTERNAL", detail: err instanceof Error ? err.message : String(err) };
    return NextResponse.json(errorBody, { status: 500 });
  }
}
