import { NextResponse } from "next/server";
import { z } from "zod";
import { normalizePhone } from "@/lib/settings";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { resolveCloudCredentials } from "@/lib/whatsapp/resolve-credentials";
import { rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

// Mirror the Green API limits — Meta's own quotas are much higher, but
// the POS use case is the same so the application cap stays identical.
const WA_LIMIT = 30;
const WA_WINDOW_SEC = 60;

// Pinning the Graph version keeps the contract stable; bump deliberately
// when Meta deprecates older versions (they publish a 2-year horizon).
const GRAPH_VERSION = "v21.0";

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

  // OAuth connection wins; manual columns are the fallback until the
  // tenant goes through Embedded Signup.
  const creds = await resolveCloudCredentials(auth.ctx.tenantId, auth.ctx.branchId);
  if (!creds) {
    return NextResponse.json(
      { ok: false, error: "WhatsApp Cloud API is not configured for this tenant" },
      { status: 409 },
    );
  }

  const normalized = normalizePhone(parsed.data.phone);
  if (!normalized) {
    return NextResponse.json({ ok: false, error: "Invalid phone number" }, { status: 400 });
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(
    creds.phoneNumberId,
  )}/messages`;

  // Freeform text. Note: Cloud API only allows freeform messages inside the
  // 24-hour customer service window — for cold sends you need a pre-approved
  // template. The UI warns operators about this.
  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalized,
    type: "text",
    text: { preview_url: false, body: parsed.data.message },
  };

  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      redirect: "follow",
    });
    const text = await upstream.text();
    let json:
      | {
          messages?: Array<{ id?: string }>;
          error?: { message?: string; code?: number };
        }
      | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Meta normally returns JSON; surface raw on parse failure.
    }

    if (!upstream.ok) {
      return NextResponse.json(
        {
          ok: false,
          error:
            json?.error?.message || `WhatsApp Cloud API returned ${upstream.status}`,
          status: upstream.status,
          raw: json ?? text,
        },
        { status: 502 },
      );
    }

    const idMessage = json?.messages?.[0]?.id;
    return NextResponse.json({ ok: true, idMessage, raw: json });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error:
          err instanceof Error
            ? err.message
            : "Network error contacting WhatsApp Cloud API",
      },
      { status: 502 },
    );
  }
}
