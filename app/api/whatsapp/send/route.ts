import { NextResponse } from "next/server";
import { z } from "zod";
import { normalizePhone } from "@/lib/settings";
import { requireTenant } from "@/lib/api/auth-helpers";
import { getGreenApiCredentials } from "@/lib/repo/settings";
import { rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

// Per-tenant: 30 messages / minute. Plenty for a busy POS, far below any
// realistic Green API rate that would hurt the quota.
const WA_LIMIT = 30;
const WA_WINDOW_SEC = 60;

const schema = z.object({
  phone: z.string().min(1).max(40),
  message: z.string().min(1).max(4000),
});

export async function POST(req: Request) {
  const auth = await requireTenant();
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

  // Server-side credential lookup — never trust the client to provide them.
  const creds = await getGreenApiCredentials(auth.ctx.tenantId);
  if (!creds.enabled || !creds.instanceId || !creds.token) {
    return NextResponse.json(
      { ok: false, error: "Green API is not configured for this tenant" },
      { status: 409 },
    );
  }

  const normalized = normalizePhone(parsed.data.phone);
  if (!normalized) {
    return NextResponse.json({ ok: false, error: "Invalid phone number" }, { status: 400 });
  }

  const base = (creds.url && creds.url.trim()) || "https://api.green-api.com";
  const url = `${base.replace(/\/$/, "")}/waInstance${encodeURIComponent(
    creds.instanceId,
  )}/sendMessage/${encodeURIComponent(creds.token)}`;
  const chatId = `${normalized}@c.us`;

  const bodyString = JSON.stringify({ chatId, message: parsed.data.message });
  const bodyBytes = new TextEncoder().encode(bodyString);

  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Accept: "application/json",
      },
      body: bodyBytes,
      redirect: "follow",
    });
    const text = await upstream.text();
    let json: { idMessage?: string; message?: string; error?: string } | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Green API normally returns JSON; if not, surface raw text
    }

    if (!upstream.ok) {
      return NextResponse.json(
        {
          ok: false,
          error:
            (json && (json.message || json.error)) ||
            `Green API returned ${upstream.status}`,
          status: upstream.status,
          raw: json ?? text,
        },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true, idMessage: json?.idMessage, raw: json });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Network error contacting Green API",
      },
      { status: 502 },
    );
  }
}
