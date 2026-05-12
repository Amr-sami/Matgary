import { NextResponse } from "next/server";
import { z } from "zod";
import { normalizePhone } from "@/lib/settings";
import { generateReceiptPdf, type PdfInvoiceData } from "@/lib/pdfReceipt";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { getWhatsAppCloudCredentials } from "@/lib/repo/settings";
import { rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

const WA_LIMIT = 30;
const WA_WINDOW_SEC = 60;
const GRAPH_VERSION = "v21.0";

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

  const creds = await getWhatsAppCloudCredentials(auth.ctx.tenantId, auth.ctx.branchId);
  if (!creds.enabled || !creds.phoneId || !creds.token) {
    return NextResponse.json(
      { ok: false, error: "WhatsApp Cloud API is not configured for this tenant" },
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
    console.error("[cloud send-pdf] PDF generation failed", err);
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "PDF generation failed" },
      { status: 500 },
    );
  }

  const fileName = `receipt-${invoice.invoiceId.slice(-10).toUpperCase()}.pdf`;

  // Cloud API is a two-step dance: upload the file to /media to get a media
  // ID, then reference that ID in the document message. Resumable uploads
  // exist but are overkill for sub-MB receipts.
  const uploadUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(
    creds.phoneId,
  )}/media`;

  const uploadForm = new FormData();
  uploadForm.append("messaging_product", "whatsapp");
  uploadForm.append("type", "application/pdf");
  const blob = new Blob([pdfBytes as unknown as BlobPart], { type: "application/pdf" });
  uploadForm.append("file", blob, fileName);

  let mediaId: string;
  try {
    const upRes = await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.token}` },
      body: uploadForm,
    });
    const upText = await upRes.text();
    let upJson: { id?: string; error?: { message?: string } } | null = null;
    try {
      upJson = JSON.parse(upText);
    } catch {
      // fall through to error path
    }
    if (!upRes.ok || !upJson?.id) {
      return NextResponse.json(
        {
          ok: false,
          error: upJson?.error?.message || `Cloud API media upload returned ${upRes.status}`,
          status: upRes.status,
          raw: upJson ?? upText,
        },
        { status: 502 },
      );
    }
    mediaId = upJson.id;
  } catch (err) {
    console.error("[cloud send-pdf] media upload error", err);
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Network error uploading media",
      },
      { status: 502 },
    );
  }

  // Step 2 — send the document message referencing the media ID.
  const sendUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(
    creds.phoneId,
  )}/messages`;
  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: normalized,
    type: "document",
    document: {
      id: mediaId,
      caption: parsed.data.caption || undefined,
      filename: fileName,
    },
  };

  try {
    const upstream = await fetch(sendUrl, {
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
      // ignore parse error — fall through to raw response
    }
    if (!upstream.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: json?.error?.message || `Cloud API returned ${upstream.status}`,
          status: upstream.status,
          raw: json ?? text,
        },
        { status: 502 },
      );
    }
    const idMessage = json?.messages?.[0]?.id;
    return NextResponse.json({ ok: true, idMessage, raw: json });
  } catch (err) {
    console.error("[cloud send-pdf] upstream error", err);
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
