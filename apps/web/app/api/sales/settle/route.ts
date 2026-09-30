import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermissionWithBranch } from "@/lib/api/auth-helpers";
import {
  settleCustomerPayment,
  SettlementError,
} from "@/lib/repo/operations";
import { normalizeEgyptPhone } from "@/lib/validators/egypt";
import { logActivity } from "@/lib/repo/activity";
import {
  IDEMPOTENCY_MISMATCH_BODY,
  lookupIdempotent,
  rememberResponse,
  requestFingerprint,
  validateIdempotencyKey,
} from "@/lib/api/idempotency";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/sales/settle — record a customer settlement against their
// outstanding balance. Applies oldest-first by default; the caller can
// hand-pick invoices via `invoiceIds`. Cash settlements stamp the active
// cash shift so Z-report sees the receipt. See settleCustomerPayment in
// lib/repo/operations.ts for the apply-allocation contract.
//
// Digital collections (05 §4.8): an `instapay` / `wallet` settlement also
// books one pending `settlement` collection (when the feature is on for the
// branch) — the debt still drops immediately; a rejection restores it. The
// route now ACCEPTS an optional Idempotency-Key (Redis fast path only, 24 h;
// there is no durable DB guard for settlements, 05 §8 R6).

const schema = z.object({
  customerPhone: z.string().min(1).max(40),
  amount: z.number().positive().max(10_000_000),
  method: z.enum(["cash", "instapay", "wallet", "card"]),
  invoiceIds: z.array(z.string().max(80)).max(50).optional(),
  collectionAccountId: z.string().uuid().optional(),
  payerPhoneLast4: z.string().regex(/^\d{4}$/).optional(),
  payerReference: z.string().regex(/^[0-9A-Za-z]{4,16}$/).optional(),
});

export async function POST(req: NextRequest) {
  // Same gate as POST /api/sales and /api/sales/cart: taking a customer's
  // debt payment at the till is recording a sale (doc 14 §3.1 C4). Audit
  // mode until PERMISSION_ENFORCE_WRITES=1.
  const r = await requirePermissionWithBranch("record_sales");
  if (!r.ok) return r.response;

  const body = await req.json().catch(() => null);

  // Optional Idempotency-Key: the fingerprint binds the operation so a key
  // reused on another route (the Redis key is (tenant, key)) never replays
  // this route's answer.
  const idemp = validateIdempotencyKey(req.headers.get("Idempotency-Key"));
  const fingerprint = idemp ? requestFingerprint(r.ctx.userId, { op: "sales.settle", body }) : null;
  if (idemp && fingerprint) {
    const hit = await lookupIdempotent(r.ctx.tenantId, idemp, fingerprint);
    if (hit.kind === "mismatch") {
      return NextResponse.json(IDEMPOTENCY_MISMATCH_BODY, { status: 409 });
    }
    if (hit.kind === "replay") {
      return NextResponse.json(hit.cached.body, { status: hit.cached.status });
    }
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "INVALID" },
      { status: 400 },
    );
  }

  // Normalise the phone the same way recordCartSale does so the lookup
  // matches across "0100…" / "+20100…" / "00 20…" entries.
  const phone = normalizeEgyptPhone(parsed.data.customerPhone);
  if (!phone) {
    return NextResponse.json({ error: "INVALID_PHONE" }, { status: 400 });
  }

  try {
    const result = await settleCustomerPayment(r.ctx.tenantId, {
      customerPhone: phone,
      amount: parsed.data.amount,
      method: parsed.data.method,
      invoiceIds: parsed.data.invoiceIds,
      recordedByUserId: r.ctx.userId,
      branchId: r.ctx.branchId,
      collection: {
        accountId: parsed.data.collectionAccountId,
        payerPhoneLast4: parsed.data.payerPhoneLast4,
        payerReference: parsed.data.payerReference,
      },
    });

    logActivity({
      tenantId: r.ctx.tenantId,
      actorUserId: r.ctx.userId,
      action: "sale.customer_settlement",
      category: "sale",
      entityType: "customer",
      entityId: phone,
      metadata: {
        amountApplied: result.appliedAmount,
        method: parsed.data.method,
        fullySettledInvoices: result.fullySettledInvoices,
        newBalance: result.newBalance,
        overpay: result.overpay,
        ...(result.collectionId ? { collectionId: result.collectionId } : {}),
      },
    });

    if (idemp && fingerprint) {
      await rememberResponse(r.ctx.tenantId, idemp, 200, result, fingerprint);
    }
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof SettlementError) {
      return NextResponse.json({ error: err.code }, { status: err.httpStatus });
    }
    // Log + surface the underlying message so the UI can show something
    // useful (rather than a generic "تعذر تسجيل الدفعة" fallback). 500
    // responses with no error body are the hardest class of bugs to
    // chase down in production.
    console.error("[/api/sales/settle] unexpected error:", err);
    return NextResponse.json(
      {
        error: "INTERNAL",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}
