// Graph-side send implementation, shared by the inline and worker paths.
//
// Both /api/whatsapp/cloud/send (when running inline because the queue
// is unavailable) and the BullMQ worker call into here. The function is
// idempotent at the *call* level — it doesn't write to wa_messages
// itself; the caller persists results via patchOutboundOnSendResult.

import "server-only";
import { resolveCloudCredentials } from "./resolve-credentials";
import { generateReceiptPdf, type PdfInvoiceData } from "@/lib/pdfReceipt";
import { logger } from "@/lib/logger";

const GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v21.0";

export interface SendOutcome {
  ok: boolean;
  metaMessageId?: string;
  errorMessage?: string;
  errorCode?: number;
  // HTTP status from Meta (or 0 for network errors). Lets callers
  // classify retryable (5xx, 429) vs terminal (4xx).
  status: number;
}

// Components match Meta's send-time schema:
// https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-message-templates
//
// We don't validate parameter counts against the cached template
// components here — Meta will reject mismatches with a clear error and
// the worker will surface that in failureReason. Keeping the API shape
// permissive lets callers compose dynamic parameter lists.
export interface TemplateComponent {
  type: "header" | "body" | "footer" | "button";
  // For body/header: parameters list. For button: sub_type + index.
  parameters?: Array<Record<string, unknown>>;
  sub_type?: "quick_reply" | "url" | "copy_code" | "flow";
  index?: number;
}

export async function sendTemplateToMeta(args: {
  tenantId: string;
  branchId: string;
  phoneE164NoPlus: string;
  templateName: string;
  language: string;
  components: TemplateComponent[];
}): Promise<SendOutcome> {
  const creds = await resolveCloudCredentials(args.tenantId, args.branchId);
  if (!creds) {
    return {
      ok: false,
      status: 409,
      errorMessage: "WhatsApp Cloud API is not configured for this tenant",
    };
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(
    creds.phoneNumberId,
  )}/messages`;
  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: args.phoneE164NoPlus,
    type: "template",
    template: {
      name: args.templateName,
      language: { code: args.language },
      components: args.components,
    },
  };

  return graphPost(url, creds.token, body);
}

export async function sendTextToMeta(args: {
  tenantId: string;
  branchId: string;
  phoneE164NoPlus: string; // already normalised by normalizePhone
  message: string;
}): Promise<SendOutcome> {
  const creds = await resolveCloudCredentials(args.tenantId, args.branchId);
  if (!creds) {
    return {
      ok: false,
      status: 409,
      errorMessage: "WhatsApp Cloud API is not configured for this tenant",
    };
  }

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(
    creds.phoneNumberId,
  )}/messages`;
  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: args.phoneE164NoPlus,
    type: "text",
    text: { preview_url: false, body: args.message },
  };

  return graphPost(url, creds.token, body);
}

export async function sendDocumentToMeta(args: {
  tenantId: string;
  branchId: string;
  phoneE164NoPlus: string;
  caption: string | null;
  invoice: PdfInvoiceData;
  fileName: string;
}): Promise<SendOutcome> {
  const creds = await resolveCloudCredentials(args.tenantId, args.branchId);
  if (!creds) {
    return {
      ok: false,
      status: 409,
      errorMessage: "WhatsApp Cloud API is not configured for this tenant",
    };
  }

  // Step 1: render PDF.
  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await generateReceiptPdf(args.invoice);
  } catch (err) {
    logger.error({
      event: "wa.outbound.pdf_render_failed",
      tenantId: args.tenantId,
      reason: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      status: 500,
      errorMessage: err instanceof Error ? err.message : "PDF generation failed",
    };
  }

  // Step 2: upload media → media_id.
  const uploadUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(
    creds.phoneNumberId,
  )}/media`;
  const uploadForm = new FormData();
  uploadForm.append("messaging_product", "whatsapp");
  uploadForm.append("type", "application/pdf");
  const blob = new Blob([pdfBytes as unknown as BlobPart], {
    type: "application/pdf",
  });
  uploadForm.append("file", blob, args.fileName);

  let mediaId: string;
  try {
    const upRes = await fetch(uploadUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${creds.token}` },
      body: uploadForm,
    });
    const upText = await upRes.text();
    let upJson: { id?: string; error?: { message?: string; code?: number } } | null = null;
    try {
      upJson = JSON.parse(upText);
    } catch {
      // fall through
    }
    if (!upRes.ok || !upJson?.id) {
      logger.warn({
        event: "wa.outbound.media_upload_failed",
        tenantId: args.tenantId,
        status: upRes.status,
        metaCode: upJson?.error?.code ?? null,
      });
      return {
        ok: false,
        status: upRes.status,
        errorMessage:
          upJson?.error?.message || `Media upload returned ${upRes.status}`,
        errorCode: upJson?.error?.code,
      };
    }
    mediaId = upJson.id;
  } catch (err) {
    logger.warn({
      event: "wa.outbound.media_upload_network",
      tenantId: args.tenantId,
      reason: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      status: 0,
      errorMessage: err instanceof Error ? err.message : "Network error",
    };
  }

  // Step 3: send document message.
  const sendUrl = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(
    creds.phoneNumberId,
  )}/messages`;
  const body = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: args.phoneE164NoPlus,
    type: "document",
    document: {
      id: mediaId,
      caption: args.caption || undefined,
      filename: args.fileName,
    },
  };
  return graphPost(sendUrl, creds.token, body);
}

async function graphPost(
  url: string,
  token: string,
  body: Record<string, unknown>,
): Promise<SendOutcome> {
  try {
    const upstream = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
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
      // ignore
    }
    if (!upstream.ok) {
      return {
        ok: false,
        status: upstream.status,
        errorMessage:
          json?.error?.message || `Cloud API returned ${upstream.status}`,
        errorCode: json?.error?.code,
      };
    }
    return {
      ok: true,
      status: upstream.status,
      metaMessageId: json?.messages?.[0]?.id,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      errorMessage:
        err instanceof Error ? err.message : "Network error contacting Graph",
    };
  }
}

/** Classify a SendOutcome status into retryable vs terminal so the
 *  caller (worker) can decide whether to throw and let BullMQ retry. */
export function isRetryableSendError(outcome: SendOutcome): boolean {
  if (outcome.ok) return false;
  // 5xx, 429, network errors (status=0) → retry.
  if (outcome.status === 0) return true;
  if (outcome.status === 429) return true;
  if (outcome.status >= 500) return true;
  // Specific Meta error codes worth retrying — 1, 2, 4 are transient
  // application errors per Graph docs.
  if (outcome.errorCode === 1 || outcome.errorCode === 2 || outcome.errorCode === 4) {
    return true;
  }
  return false;
}
