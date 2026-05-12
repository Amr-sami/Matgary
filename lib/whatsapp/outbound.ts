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
  sendTextToMeta,
  type SendOutcome,
} from "./outbound-sender";
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
}

export interface SendDocumentInput {
  tenantId: string;
  branchId: string;
  phone: string;
  caption: string | null;
  invoice: PdfInvoiceData;
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
