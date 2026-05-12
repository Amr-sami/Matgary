// POST /api/whatsapp/cloud/send-pdf
//
// Wraps lib/whatsapp/outbound:sendOutboundDocument. Same async-by-default
// contract as /send: API persists wa_messages, enqueues a BullMQ job
// when Redis is available, falls back to inline media-upload + send when
// not.

import { NextResponse } from "next/server";
import { z } from "zod";
import { type PdfInvoiceData } from "@/lib/pdfReceipt";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { rateLimit } from "@/lib/ratelimit";
import { sendOutboundDocument } from "@/lib/whatsapp/outbound";

export const runtime = "nodejs";

const WA_LIMIT = 30;
const WA_WINDOW_SEC = 60;

const schema = z.object({
  phone: z.string().min(1).max(40),
  caption: z.string().max(2000).optional().default(""),
  invoice: z.unknown(),
});

export async function POST(req: Request) {
  const auth = await requireTenantWithBranch();
  if (!auth.ok) return auth.response;

  const limit = await rateLimit("wa.send", auth.ctx.tenantId, {
    limit: WA_LIMIT,
    windowSec: WA_WINDOW_SEC,
  });
  if (!limit.ok) {
    return NextResponse.json(
      { ok: false, error: "حاول بعد دقيقة — تم تجاوز حد الإرسال." },
      { status: 429 },
    );
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success || !parsed.data.invoice) {
    return NextResponse.json(
      { ok: false, error: parsed.success ? "Missing invoice" : parsed.error.issues[0].message },
      { status: 400 },
    );
  }

  const result = await sendOutboundDocument({
    tenantId: auth.ctx.tenantId,
    branchId: auth.ctx.branchId,
    phone: parsed.data.phone,
    caption: parsed.data.caption || null,
    invoice: parsed.data.invoice as PdfInvoiceData,
  });

  if (!result.ok && result.status === "failed" && !result.metaMessageId) {
    const status =
      result.metaStatus === 409
        ? 409
        : result.metaStatus === 400
          ? 400
          : 502;
    return NextResponse.json(
      {
        ok: false,
        error: result.error,
        clientMessageId: result.clientMessageId || undefined,
        status: result.status,
      },
      { status },
    );
  }

  return NextResponse.json({
    ok: true,
    clientMessageId: result.clientMessageId,
    status: result.status,
    idMessage: result.metaMessageId,
  });
}
