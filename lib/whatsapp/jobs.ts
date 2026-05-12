// Worker-side job processors. The Worker singleton in queue.ts dispatches
// here based on job.name. Each handler is idempotent: BullMQ may retry a
// job whose previous attempt failed mid-side-effect.

import "server-only";
import type { Job } from "bullmq";
import { logger } from "@/lib/logger";
import {
  type WaJobData,
  type OutboundTextJobData,
  type OutboundDocumentJobData,
  type InboundProcessJobData,
  type QuarantineReplayJobData,
} from "./queue";
import {
  sendTextToMeta,
  sendDocumentToMeta,
  isRetryableSendError,
} from "./outbound-sender";
import { patchOutboundOnSendResult } from "./messages";
import {
  persistEvent,
  processEvent,
  resolveTenant,
} from "./webhook-processor";
import { db } from "@/lib/db";
import { waWebhookEvents } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { extractEvents } from "./webhook-events";
import type { PdfInvoiceData } from "@/lib/pdfReceipt";

export async function routeJob(job: Job<WaJobData>): Promise<void> {
  switch (job.name) {
    case "outbound.text":
      return handleOutboundText(job as Job<OutboundTextJobData>);
    case "outbound.document":
      return handleOutboundDocument(job as Job<OutboundDocumentJobData>);
    case "inbound.process":
      return handleInboundProcess(job as Job<InboundProcessJobData>);
    case "quarantine.replay":
      return handleQuarantineReplay(job as Job<QuarantineReplayJobData>);
    default:
      // Unknown job name — log and ack so it doesn't loop forever.
      logger.warn({
        event: "wa.worker.unknown_job",
        jobName: job.name,
        jobId: job.id ?? null,
      });
      return;
  }
}

// ─── Outbound text ───────────────────────────────────────────────────────

async function handleOutboundText(job: Job<OutboundTextJobData>): Promise<void> {
  const d = job.data;
  const outcome = await sendTextToMeta({
    tenantId: d.tenantId,
    branchId: d.branchId,
    phoneE164NoPlus: d.phone,
    message: d.message,
  });

  // Persist BEFORE deciding whether to retry. If we throw without
  // patching, the row stays 'queued' forever on the final attempt.
  await patchOutboundOnSendResult({
    tenantId: d.tenantId,
    rowId: d.rowId,
    metaMessageId: outcome.metaMessageId ?? null,
    ok: outcome.ok,
    failureReason: outcome.errorMessage ?? null,
    failureCode: outcome.errorCode ?? null,
  });

  if (!outcome.ok && isRetryableSendError(outcome) && job.attemptsMade < (job.opts.attempts ?? 5)) {
    // Throw so BullMQ retries. On the next attempt we'll re-send and
    // re-patch; idempotency on Meta's side is per-recipient + per-body,
    // so a duplicate send is unlikely to result in two delivered
    // messages within seconds.
    throw new Error(
      `meta send failed (status ${outcome.status}, code ${outcome.errorCode ?? "—"}): ${outcome.errorMessage}`,
    );
  }
  logger.info({
    event: "wa.outbound.delivered_to_meta",
    kind: "text",
    tenantId: d.tenantId,
    branchId: d.branchId,
    clientMessageId: d.clientMessageId,
    ok: outcome.ok,
    metaStatus: outcome.status,
  });
}

// ─── Outbound document ───────────────────────────────────────────────────

async function handleOutboundDocument(
  job: Job<OutboundDocumentJobData>,
): Promise<void> {
  const d = job.data;
  const outcome = await sendDocumentToMeta({
    tenantId: d.tenantId,
    branchId: d.branchId,
    phoneE164NoPlus: d.phone,
    caption: d.caption,
    invoice: d.invoice as PdfInvoiceData,
    fileName: d.fileName,
  });

  await patchOutboundOnSendResult({
    tenantId: d.tenantId,
    rowId: d.rowId,
    metaMessageId: outcome.metaMessageId ?? null,
    ok: outcome.ok,
    failureReason: outcome.errorMessage ?? null,
    failureCode: outcome.errorCode ?? null,
  });

  if (!outcome.ok && isRetryableSendError(outcome) && job.attemptsMade < (job.opts.attempts ?? 5)) {
    throw new Error(
      `meta document send failed (status ${outcome.status}, code ${outcome.errorCode ?? "—"}): ${outcome.errorMessage}`,
    );
  }
  logger.info({
    event: "wa.outbound.delivered_to_meta",
    kind: "document",
    tenantId: d.tenantId,
    branchId: d.branchId,
    clientMessageId: d.clientMessageId,
    ok: outcome.ok,
    metaStatus: outcome.status,
  });
}

// ─── Inbound webhook processing ──────────────────────────────────────────

async function handleInboundProcess(
  job: Job<InboundProcessJobData>,
): Promise<void> {
  // processEvent is itself idempotent and walks the state machine. We
  // let it throw on retryable errors and BullMQ schedule the retry.
  await processEvent(job.data.eventId);
}

// ─── Quarantine replay ───────────────────────────────────────────────────

async function handleQuarantineReplay(
  job: Job<QuarantineReplayJobData>,
): Promise<void> {
  const [row] = await db
    .select()
    .from(waWebhookEvents)
    .where(eq(waWebhookEvents.id, job.data.eventId))
    .limit(1);
  if (!row) return;
  if (row.processingStatus !== "quarantined") return; // raced with someone else

  // Re-resolve tenant. If still unknown, leave it; otherwise rewrite the
  // routing columns and flip back to pending, then re-process.
  const resolved = await resolveTenant(row.phoneNumberId, row.wabaId);
  if (!resolved) {
    logger.info({
      event: "wa.webhook.replay.still_unrouted",
      eventId: row.id,
    });
    return;
  }
  await db
    .update(waWebhookEvents)
    .set({
      tenantId: resolved.tenantId,
      branchId: resolved.branchId,
      connectionId: resolved.connection.id,
      processingStatus: "pending",
      errorDetails: null,
      updatedAt: new Date(),
    })
    .where(eq(waWebhookEvents.id, row.id));
  logger.info({
    event: "wa.webhook.replay.routed",
    eventId: row.id,
    tenantId: resolved.tenantId,
    branchId: resolved.branchId,
  });
  // Process inline so the replay endpoint can report final status
  // without needing a second queue hop.
  await processEvent(row.id);
}

// re-export for the worker bootstrap (instrumentation.ts)
export const __ROUTER__ = routeJob;
// Avoid TS "unused" complaints on the import — extractEvents is used by
// future replay-of-batch features; keep the reference live.
void extractEvents;
