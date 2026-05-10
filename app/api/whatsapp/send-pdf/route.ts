import { NextResponse } from "next/server";
import { z } from "zod";
import { normalizePhone } from "@/lib/settings";
import { generateReceiptPdf, type PdfInvoiceData } from "@/lib/pdfReceipt";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { getGreenApiCredentials } from "@/lib/repo/settings";
import { rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

// Same per-tenant cap as /api/whatsapp/send; both share the same Green API
// quota so they share the same scope key.
const WA_LIMIT = 30;
const WA_WINDOW_SEC = 60;

// Loose schema for the invoice payload — pdfReceipt validates the actual shape
// at render time. We just want to refuse missing fields up front.
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

  const creds = await getGreenApiCredentials(auth.ctx.tenantId, auth.ctx.branchId);
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

  const invoice = parsed.data.invoice as PdfInvoiceData;
  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await generateReceiptPdf(invoice);
  } catch (err) {
    console.error("[send-pdf] PDF generation failed", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "PDF generation failed" },
      { status: 500 },
    );
  }

  const base = (creds.url && creds.url.trim()) || "https://api.green-api.com";
  const url = `${base.replace(/\/$/, "")}/waInstance${encodeURIComponent(
    creds.instanceId,
  )}/sendFileByUpload/${encodeURIComponent(creds.token)}`;

  const fileName = `receipt-${invoice.invoiceId.slice(-10).toUpperCase()}.pdf`;
  const chatId = `${normalized}@c.us`;

  const form = new FormData();
  form.append("chatId", chatId);
  if (parsed.data.caption) form.append("caption", parsed.data.caption);
  form.append("fileName", fileName);
  const blob = new Blob([pdfBytes as unknown as BlobPart], { type: "application/pdf" });
  form.append("file", blob, fileName);

  try {
    const upstream = await fetch(url, { method: "POST", body: form, redirect: "follow" });
    const text = await upstream.text();
    let json: { idMessage?: string; message?: string; error?: string } | null = null;
    try {
      json = JSON.parse(text);
    } catch {
      // ignore
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
    console.error("[send-pdf] upstream error", err);
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Network error contacting Green API",
      },
      { status: 502 },
    );
  }
}
