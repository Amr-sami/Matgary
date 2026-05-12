// POST /api/whatsapp/otp/send
//
// Convenience wrapper around sendOutboundTemplate for authentication
// templates. The body component carries the OTP code as a single text
// parameter; we don't construct the code — caller passes it (so the
// caller's signup/login flow controls retention, hashing, and verify
// logic). We just deliver.
//
// Rate limits are tighter than the general send route — OTPs are a
// classic abuse vector. Two scopes:
//   - per-phone:  5 / 15 min (prevents harassment of a single number)
//   - per-tenant: 60 / hour  (caps overall fan-out per shop)
//
// The template must be APPROVED and of category 'authentication' (or
// 'utility'); the facade's approve-check refuses paused/rejected ones.

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { rateLimit } from "@/lib/ratelimit";
import { sendOutboundTemplate } from "@/lib/whatsapp/outbound";
import { normalizePhone } from "@/lib/settings";

export const runtime = "nodejs";

const schema = z.object({
  phone: z.string().min(1).max(40),
  code: z
    .string()
    .regex(/^\d{4,8}$/, "OTP code must be 4 to 8 digits"),
  // Default template name. Operators that approved an authentication
  // template under a different name can override here.
  templateName: z.string().min(1).max(120).default("otp"),
  language: z.string().min(2).max(20).default("en_US"),
});

export async function POST(req: Request) {
  const auth = await requireTenantWithBranch();
  if (!auth.ok) return auth.response;

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

  const normalised = normalizePhone(parsed.data.phone);
  if (!normalised) {
    return NextResponse.json(
      { ok: false, error: "Invalid phone number" },
      { status: 400 },
    );
  }

  // Phone-scoped limit first — tightest. Bound to (tenant, branch,
  // phone) so a malicious account can't tarpit the same number across
  // multiple tenants.
  const perPhone = await rateLimit(
    "wa.otp.phone",
    `${auth.ctx.tenantId}:${auth.ctx.branchId}:${normalised}`,
    { limit: 5, windowSec: 15 * 60 },
  );
  if (!perPhone.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: "Too many OTPs to this number — try again in 15 minutes.",
      },
      { status: 429 },
    );
  }
  // Tenant-wide cap.
  const perTenant = await rateLimit("wa.otp.tenant", auth.ctx.tenantId, {
    limit: 60,
    windowSec: 60 * 60,
  });
  if (!perTenant.ok) {
    return NextResponse.json(
      { ok: false, error: "OTP hourly quota reached for this tenant." },
      { status: 429 },
    );
  }

  // Meta's authentication-template body takes exactly one parameter —
  // the code. Authentication-with-button templates ALSO carry the same
  // code on the button's sub_type='url' or 'copy_code' component; we
  // populate both so the same template works either way.
  const result = await sendOutboundTemplate({
    tenantId: auth.ctx.tenantId,
    branchId: auth.ctx.branchId,
    phone: parsed.data.phone,
    templateName: parsed.data.templateName,
    language: parsed.data.language,
    components: [
      {
        type: "body",
        parameters: [{ type: "text", text: parsed.data.code }],
      },
      // url button variant — most authentication templates Meta auto-
      // creates use this shape. Harmless when the template doesn't
      // include a button.
      {
        type: "button",
        sub_type: "url",
        index: 0,
        parameters: [{ type: "text", text: parsed.data.code }],
      },
    ],
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
