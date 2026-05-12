// Outbound send facade. Single entry point used by the HTTP send routes
// and (later) by SaleForm. Persists a wa_messages row up-front with
// status='queued', then either enqueues a BullMQ job or runs the send
// inline when the queue is unavailable.
//
// Contract: always returns { clientMessageId, status }. When inline mode
// completes synchronously, status may already be 'sent' or 'failed' and
// metaMessageId is included.

import "server-only";
import { randomUUID } from "node:crypto";
import { normalizePhone } from "@/lib/settings";
import { logger } from "@/lib/logger";
import {
  enqueueOutboundDocument,
  enqueueOutboundTemplate,
  enqueueOutboundText,
  isQueueEnabled,
} from "./queue";
import {
  patchOutboundOnSendResult,
  recordOutboundQueued,
} from "./messages";
import { resolveCloudCredentials } from "./resolve-credentials";
import {
  sendDocumentToMeta,
  sendTemplateToMeta,
  sendTextToMeta,
  type SendOutcome,
  type TemplateComponent,
} from "./outbound-sender";
import { getApprovedTemplate } from "./templates";
import { checkSendWindow, explainClosedWindow } from "./window";
import type { PdfInvoiceData } from "@/lib/pdfReceipt";

export type OutboundStatus = "queued" | "sent" | "failed";

export interface OutboundResult {
  ok: boolean;
  clientMessageId: string;
  status: OutboundStatus;
  // Present only when the inline path completed synchronously.
  metaMessageId?: string;
  // On failure, the human reason. On queued success, undefined.
  error?: string;
  // HTTP status from Meta if inline, or 202 when accepted into queue.
  metaStatus?: number;
  rowId: string;
}

export interface SendTextInput {
  tenantId: string;
  branchId: string;
  phone: string;
  message: string;
  /** When true, refuse to send if the 24h customer-service window is
   *  closed. Default false during the Phase-4 transition so existing
   *  receipts keep working. Phase 5 will flip this to true on the
   *  receipt path (it'll route through a utility template instead). */
  enforceWindow?: boolean;
}

export interface SendDocumentInput {
  tenantId: string;
  branchId: string;
  phone: string;
  caption: string | null;
  invoice: PdfInvoiceData;
  enforceWindow?: boolean;
}

// ─── Text ────────────────────────────────────────────────────────────────

export async function sendOutboundText(
  input: SendTextInput,
): Promise<OutboundResult> {
  const normalised = normalizePhone(input.phone);
  if (!normalised) {
    return failBadInput("Invalid phone number");
  }
  // Pre-flight: refuse early if creds aren't configured, so we don't
  // create a queued row for a tenant that can't send. Don't pass the
  // token further — only the resolution outcome.
  const creds = await resolveCloudCredentials(input.tenantId, input.branchId);
  if (!creds) {
    return failBadInput("WhatsApp Cloud API is not configured for this tenant");
  }

  // Optional 24h window enforcement. Off by default so the existing
  // receipt path continues to work; Phase 5 will gate the receipt path
  // through a utility template and flip this on.
  if (input.enforceWindow) {
    const decision = await checkSendWindow(input.tenantId, input.branchId, normalised);
    if (!decision.allowed) {
      logger.info({
        event: "wa.outbound.window_closed",
        tenantId: input.tenantId,
        branchId: input.branchId,
        reason: decision.reason,
      });
      return failBadInput(explainClosedWindow(decision));
    }
  }

  const clientMessageId = randomUUID();
  const rowId = await recordOutboundQueued({
    tenantId: input.tenantId,
    branchId: input.branchId,
    connectionId: null, // resolved at send time; reserved for Phase 4 link-up
    contactPhoneNumber: normalised,
    messageType: "text",
    textBody: input.message,
    clientMessageId,
  });

  if (isQueueEnabled()) {
    const job = await enqueueOutboundText({
      tenantId: input.tenantId,
      branchId: input.branchId,
      rowId,
      clientMessageId,
      phone: normalised,
      message: input.message,
    });
    if (job) {
      logger.info({
        event: "wa.outbound.enqueued",
        kind: "text",
        tenantId: input.tenantId,
        branchId: input.branchId,
        clientMessageId,
        jobId: job.id ?? null,
      });
      return {
        ok: true,
        clientMessageId,
        status: "queued",
        rowId,
        metaStatus: 202,
      };
    }
  }

  // Inline fallback — Redis unavailable. Same shape as the worker handler.
  const outcome = await sendTextToMeta({
    tenantId: input.tenantId,
    branchId: input.branchId,
    phoneE164NoPlus: normalised,
    message: input.message,
  });
  await patchOutboundOnSendResult({
    tenantId: input.tenantId,
    rowId,
    metaMessageId: outcome.metaMessageId ?? null,
    ok: outcome.ok,
    failureReason: outcome.errorMessage ?? null,
    failureCode: outcome.errorCode ?? null,
  });
  logger.info({
    event: "wa.outbound.inline",
    kind: "text",
    tenantId: input.tenantId,
    branchId: input.branchId,
    clientMessageId,
    ok: outcome.ok,
    metaStatus: outcome.status,
  });
  return resultFromOutcome(rowId, clientMessageId, outcome);
}

// ─── Document ────────────────────────────────────────────────────────────

export async function sendOutboundDocument(
  input: SendDocumentInput,
): Promise<OutboundResult> {
  const normalised = normalizePhone(input.phone);
  if (!normalised) {
    return failBadInput("Invalid phone number");
  }
  const creds = await resolveCloudCredentials(input.tenantId, input.branchId);
  if (!creds) {
    return failBadInput("WhatsApp Cloud API is not configured for this tenant");
  }

  if (input.enforceWindow) {
    const decision = await checkSendWindow(input.tenantId, input.branchId, normalised);
    if (!decision.allowed) {
      logger.info({
        event: "wa.outbound.window_closed",
        tenantId: input.tenantId,
        branchId: input.branchId,
        reason: decision.reason,
      });
      return failBadInput(explainClosedWindow(decision));
    }
  }

  const clientMessageId = randomUUID();
  const fileName = `receipt-${input.invoice.invoiceId.slice(-10).toUpperCase()}.pdf`;
  const rowId = await recordOutboundQueued({
    tenantId: input.tenantId,
    branchId: input.branchId,
    connectionId: null,
    contactPhoneNumber: normalised,
    messageType: "document",
    textBody: input.caption,
    payload: { invoiceId: input.invoice.invoiceId, fileName } as Record<
      string,
      unknown
    >,
    clientMessageId,
  });

  if (isQueueEnabled()) {
    const job = await enqueueOutboundDocument({
      tenantId: input.tenantId,
      branchId: input.branchId,
      rowId,
      clientMessageId,
      phone: normalised,
      caption: input.caption,
      invoice: input.invoice,
      fileName,
    });
    if (job) {
      logger.info({
        event: "wa.outbound.enqueued",
        kind: "document",
        tenantId: input.tenantId,
        branchId: input.branchId,
        clientMessageId,
        jobId: job.id ?? null,
      });
      return {
        ok: true,
        clientMessageId,
        status: "queued",
        rowId,
        metaStatus: 202,
      };
    }
  }

  const outcome = await sendDocumentToMeta({
    tenantId: input.tenantId,
    branchId: input.branchId,
    phoneE164NoPlus: normalised,
    caption: input.caption,
    invoice: input.invoice,
    fileName,
  });
  await patchOutboundOnSendResult({
    tenantId: input.tenantId,
    rowId,
    metaMessageId: outcome.metaMessageId ?? null,
    ok: outcome.ok,
    failureReason: outcome.errorMessage ?? null,
    failureCode: outcome.errorCode ?? null,
  });
  logger.info({
    event: "wa.outbound.inline",
    kind: "document",
    tenantId: input.tenantId,
    branchId: input.branchId,
    clientMessageId,
    ok: outcome.ok,
    metaStatus: outcome.status,
  });
  return resultFromOutcome(rowId, clientMessageId, outcome);
}

// ─── Template ────────────────────────────────────────────────────────────

export interface SendTemplateInput {
  tenantId: string;
  branchId: string;
  phone: string;
  templateName: string;
  language: string;
  /** Cloud API template components — body/header/button parameter
   *  groups. See lib/whatsapp/outbound-sender:TemplateComponent. */
  components: TemplateComponent[];
}

/** Send a Meta-approved template. Validates the template exists + is
 *  approved BEFORE creating the queued row, so a paused/rejected
 *  template returns 409 instead of failing in the worker. Templates
 *  bypass the 24h customer-service window — that's the whole point of
 *  them. */
export async function sendOutboundTemplate(
  input: SendTemplateInput,
): Promise<OutboundResult> {
  const normalised = normalizePhone(input.phone);
  if (!normalised) {
    return failBadInput("Invalid phone number");
  }
  const creds = await resolveCloudCredentials(input.tenantId, input.branchId);
  if (!creds) {
    return failBadInput("WhatsApp Cloud API is not configured for this tenant");
  }
  // Approve-or-bust. Send-time lookup filters to status='approved' so
  // paused templates never leave the system.
  const tpl = await getApprovedTemplate(
    input.tenantId,
    input.branchId,
    input.templateName,
    input.language,
  );
  if (!tpl) {
    return failBadInput(
      `Template "${input.templateName}" (${input.language}) is not approved or not synced. Run /api/whatsapp/templates/sync.`,
    );
  }

  const clientMessageId = randomUUID();
  // Preview: first body component's text (where Meta carries it),
  // truncated. Better than blank for the conversation list.
  const bodyComponent = (tpl.components as Array<{ type?: string; text?: string }>).find(
    (c) => (c.type ?? "").toLowerCase() === "body",
  );
  const preview = bodyComponent?.text ?? `[template:${input.templateName}]`;
  const rowId = await recordOutboundQueued({
    tenantId: input.tenantId,
    branchId: input.branchId,
    connectionId: null,
    contactPhoneNumber: normalised,
    messageType: "template",
    textBody: preview,
    payload: {
      templateName: input.templateName,
      language: input.language,
      components: input.components,
    } as Record<string, unknown>,
    clientMessageId,
  });

  if (isQueueEnabled()) {
    const job = await enqueueOutboundTemplate({
      tenantId: input.tenantId,
      branchId: input.branchId,
      rowId,
      clientMessageId,
      phone: normalised,
      templateName: input.templateName,
      language: input.language,
      components: input.components as unknown as Array<Record<string, unknown>>,
    });
    if (job) {
      logger.info({
        event: "wa.outbound.enqueued",
        kind: "template",
        tenantId: input.tenantId,
        branchId: input.branchId,
        clientMessageId,
        jobId: job.id ?? null,
        templateName: input.templateName,
      });
      return {
        ok: true,
        clientMessageId,
        status: "queued",
        rowId,
        metaStatus: 202,
      };
    }
  }

  // Inline fallback.
  const outcome = await sendTemplateToMeta({
    tenantId: input.tenantId,
    branchId: input.branchId,
    phoneE164NoPlus: normalised,
    templateName: input.templateName,
    language: input.language,
    components: input.components,
  });
  await patchOutboundOnSendResult({
    tenantId: input.tenantId,
    rowId,
    metaMessageId: outcome.metaMessageId ?? null,
    ok: outcome.ok,
    failureReason: outcome.errorMessage ?? null,
    failureCode: outcome.errorCode ?? null,
  });
  logger.info({
    event: "wa.outbound.inline",
    kind: "template",
    tenantId: input.tenantId,
    branchId: input.branchId,
    clientMessageId,
    templateName: input.templateName,
    ok: outcome.ok,
    metaStatus: outcome.status,
  });
  return resultFromOutcome(rowId, clientMessageId, outcome);
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function resultFromOutcome(
  rowId: string,
  clientMessageId: string,
  outcome: SendOutcome,
): OutboundResult {
  return {
    ok: outcome.ok,
    clientMessageId,
    rowId,
    status: outcome.ok ? "sent" : "failed",
    metaMessageId: outcome.metaMessageId,
    error: outcome.ok ? undefined : outcome.errorMessage,
    metaStatus: outcome.status,
  };
}

function failBadInput(message: string): OutboundResult {
  return {
    ok: false,
    clientMessageId: "",
    rowId: "",
    status: "failed",
    error: message,
    metaStatus: 400,
  };
}
