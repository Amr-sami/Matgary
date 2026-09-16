// POST /api/whatsapp/cloud/send-template
//
// Sends a Meta-approved message template. Bypasses the 24h customer
// service window — that's the whole point of templates. Caller supplies:
//   { phone, templateName, language, components[] }
// components[] is the Cloud-API shape: array of { type:'header'|'body'|
// 'footer'|'button', parameters?[], sub_type?, index? }. We don't
// validate parameter counts against the cached template — Meta will
// reject mismatches with a clear error which surfaces in failureReason.

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { rateLimit } from "@/lib/ratelimit";
import { sendOutboundTemplate } from "@/lib/whatsapp/outbound";

export const runtime = "nodejs";

const WA_LIMIT = 30;
const WA_WINDOW_SEC = 60;

const componentSchema = z.object({
  type: z.enum(["header", "body", "footer", "button"]),
  sub_type: z.enum(["quick_reply", "url", "copy_code", "flow"]).optional(),
  index: z.number().int().min(0).max(9).optional(),
  parameters: z.array(z.record(z.string(), z.unknown())).optional(),
});

const schema = z.object({
  phone: z.string().min(1).max(40),
  templateName: z.string().min(1).max(120),
  language: z.string().min(2).max(20),
  components: z.array(componentSchema).max(20).default([]),
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

  const result = await sendOutboundTemplate({
    tenantId: auth.ctx.tenantId,
    branchId: auth.ctx.branchId,
    phone: parsed.data.phone,
    templateName: parsed.data.templateName,
    language: parsed.data.language,
    components: parsed.data.components,
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
