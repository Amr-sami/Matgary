// POST /api/whatsapp/cloud/send
//
// Thin wrapper around lib/whatsapp/outbound:sendOutboundText. The facade
// persists wa_messages and either enqueues a BullMQ job (when REDIS_URL
// is set) or runs the Graph call inline. Response shape carries
// clientMessageId so callers can poll /api/whatsapp/messages/[id] for
// the eventual WAMID + status transitions.

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { rateLimit } from "@/lib/ratelimit";
import { sendOutboundText } from "@/lib/whatsapp/outbound";

export const runtime = "nodejs";

const WA_LIMIT = 30;
const WA_WINDOW_SEC = 60;

const schema = z.object({
  phone: z.string().min(1).max(40),
  message: z.string().min(1).max(4000),
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
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, error: parsed.error.issues[0].message },
      { status: 400 },
    );
  }

  const result = await sendOutboundText({
    tenantId: auth.ctx.tenantId,
    branchId: auth.ctx.branchId,
    phone: parsed.data.phone,
    message: parsed.data.message,
  });

  if (!result.ok && result.status === "failed" && !result.metaMessageId) {
    // Inline path failed AND we have a real error (not just queued).
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
    status: result.status, // 'queued' | 'sent'
    // Back-compat field for callers (and tests) that still read idMessage.
    idMessage: result.metaMessageId,
  });
}
