import { NextResponse } from "next/server";
import { normalizePhone } from "@/lib/settings";
import { generateReceiptPdf, type PdfInvoiceData } from "@/lib/pdfReceipt";

export const runtime = "nodejs";

interface SendPdfBody {
  phone: string;
  caption: string;
  instanceId: string;
  token: string;
  apiUrl?: string;
  invoice: PdfInvoiceData;
}

export async function POST(req: Request) {
  let body: SendPdfBody;
  try {
    body = (await req.json()) as SendPdfBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const { phone, caption, instanceId, token, apiUrl, invoice } = body;
  if (!phone || !instanceId || !token || !invoice) {
    return NextResponse.json(
      { ok: false, error: "Missing required fields" },
      { status: 400 }
    );
  }

  const normalized = normalizePhone(phone);
  if (!normalized) {
    return NextResponse.json(
      { ok: false, error: "Invalid phone number" },
      { status: 400 }
    );
  }

  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await generateReceiptPdf(invoice);
  } catch (err: any) {
    console.error("[send-pdf] PDF generation failed", err);
    return NextResponse.json(
      { ok: false, error: err?.message || "PDF generation failed" },
      { status: 500 }
    );
  }

  const base = (apiUrl && apiUrl.trim()) || "https://api.green-api.com";
  const url = `${base.replace(/\/$/, "")}/waInstance${encodeURIComponent(
    instanceId
  )}/sendFileByUpload/${encodeURIComponent(token)}`;

  const fileName = `receipt-${invoice.invoiceId.slice(-10).toUpperCase()}.pdf`;
  const chatId = `${normalized}@c.us`;

  // Build multipart/form-data body manually since Vercel's Node fetch
  // accepts FormData natively in modern runtimes.
  const form = new FormData();
  form.append("chatId", chatId);
  if (caption) form.append("caption", caption);
  form.append("fileName", fileName);
  // Convert Uint8Array → Blob for FormData
  const blob = new Blob([pdfBytes as any], { type: "application/pdf" });
  form.append("file", blob, fileName);

  try {
    const upstream = await fetch(url, {
      method: "POST",
      body: form,
      redirect: "follow",
    });
    const text = await upstream.text();
    let json: any = null;
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
        { status: 502 }
      );
    }
    return NextResponse.json({
      ok: true,
      idMessage: json?.idMessage,
      raw: json,
    });
  } catch (err: any) {
    console.error("[send-pdf] upstream error", err);
    return NextResponse.json(
      {
        ok: false,
        error: err?.message || "Network error contacting Green API",
      },
      { status: 502 }
    );
  }
}
