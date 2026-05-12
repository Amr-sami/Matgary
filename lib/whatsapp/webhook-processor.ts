// Webhook event processor.
//
// Phase 2 model:
//   1. webhook route persists each extracted event into wa_webhook_events
//      (idempotent on provider_event_id) and acks 200 to Meta immediately.
//   2. processEvent(id) is called in the background (Phase 2: setImmediate;
//      Phase 3: BullMQ) and walks the state machine for that one row.
//
// Tenant resolution chain (first hit wins):
//   a. wa_connections by phone_number_id (canonical — globally unique)
//   b. wa_connections by waba_id, status='active' (fallback)
// If neither resolves, the event row is left as 'quarantined' for admin
// inspection. We never silently drop.
//
// Error classification:
//   - RetryableError → markFailed with backoff; the worker will revisit.
//   - TerminalError  → markDeadLetter.
//   - Anything else (incl. DB errors) is treated as retryable.

import "server-only";
import {
  getConnectionByPhoneNumberId,
  getActiveConnectionByWabaId,
  type WaConnectionPublic,
} from "./connections";
import {
  markDeadLetter,
  markFailed,
  markProcessed,
  markProcessing,
  insertEvent,
  type ProcessingStatus,
} from "./webhook-events";
import { applyStatusUpdate, upsertInboundMessage } from "./messages";
import { logger } from "@/lib/logger";
import type {
  ExtractedEvent,
  MetaInboundMessage,
  MetaStatusUpdate,
} from "./webhook-types";
import { db } from "@/lib/db";
import { waWebhookEvents } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

export class RetryableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "RetryableError";
  }
}

export class TerminalError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = "TerminalError";
  }
}

export interface ResolvedTenant {
  tenantId: string;
  branchId: string;
  connection: WaConnectionPublic;
}

export async function resolveTenant(
  phoneNumberId: string | null,
  wabaId: string | null,
): Promise<ResolvedTenant | null> {
  if (phoneNumberId) {
    const c = await getConnectionByPhoneNumberId(phoneNumberId);
    if (c) {
      return { tenantId: c.tenantId, branchId: c.branchId, connection: c };
    }
  }
  if (wabaId) {
    const c = await getActiveConnectionByWabaId(wabaId);
    if (c) {
      return { tenantId: c.tenantId, branchId: c.branchId, connection: c };
    }
  }
  return null;
}

/** Persist one extracted event row. Resolves tenant up-front so the row
 *  carries it (or is quarantined). Returns the row id if newly inserted,
 *  null if it was a duplicate (deduped by provider_event_id). */
export async function persistEvent(
  ev: ExtractedEvent,
): Promise<{ id: string | null; resolved: ResolvedTenant | null }> {
  const resolved = await resolveTenant(ev.phoneNumberId, ev.wabaId);
  const status: ProcessingStatus = resolved ? "pending" : "quarantined";
  const errorDetails = resolved
    ? null
    : `Could not route: phone_number_id=${ev.phoneNumberId ?? "—"} waba_id=${ev.wabaId ?? "—"}`;

  const ins = await insertEvent({
    providerEventId: ev.providerEventId,
    eventType: ev.eventType,
    phoneNumberId: ev.phoneNumberId,
    wabaId: ev.wabaId,
    tenantId: resolved?.tenantId ?? null,
    branchId: resolved?.branchId ?? null,
    connectionId: resolved?.connection.id ?? null,
    payload: ev.payload,
    processingStatus: status,
    errorDetails,
  });

  if (!ins.inserted) {
    logger.debug({
      event: "wa.webhook.dedup",
      providerEventId: ev.providerEventId,
    });
    return { id: null, resolved };
  }

  if (!resolved) {
    logger.warn({
      event: "wa.webhook.quarantined",
      eventId: ins.id,
      providerEventId: ev.providerEventId,
      phoneNumberId: ev.phoneNumberId,
      wabaId: ev.wabaId,
    });
  } else {
    logger.info({
      event: "wa.webhook.routed",
      eventId: ins.id,
      providerEventId: ev.providerEventId,
      tenantId: resolved.tenantId,
      branchId: resolved.branchId,
      connectionId: resolved.connection.id,
      eventType: ev.eventType,
    });
  }
  return { id: ins.id, resolved };
}

/** Process a single persisted event. Idempotent: safe to call multiple
 *  times for the same row. */
export async function processEvent(eventId: string): Promise<void> {
  // Re-fetch the row so we work from the canonical state (the caller
  // might be a future BullMQ worker that only has the id).
  const [row] = await db
    .select()
    .from(waWebhookEvents)
    .where(eq(waWebhookEvents.id, eventId))
    .limit(1);

  if (!row) {
    logger.warn({ event: "wa.webhook.process.missing_row", eventId });
    return;
  }
  if (
    row.processingStatus === "processed" ||
    row.processingStatus === "dead_letter"
  ) {
    return; // nothing to do
  }
  if (!row.tenantId || !row.branchId) {
    // Still quarantined — admin intervention required.
    return;
  }

  await markProcessing(row.id);
  try {
    if (row.eventType === "message.received") {
      await handleInbound(row);
    } else if (row.eventType === "message.status") {
      await handleStatus(row);
    } else {
      // 'unknown' events are stored for forensics but not actionable. We
      // mark them processed so they don't keep retrying.
      logger.info({
        event: "wa.webhook.process.noop",
        eventId: row.id,
        eventType: row.eventType,
      });
    }
    await markProcessed(row.id);
    logger.info({
      event: "wa.webhook.process.ok",
      eventId: row.id,
      eventType: row.eventType,
      tenantId: row.tenantId,
    });
  } catch (err) {
    if (err instanceof TerminalError) {
      await markDeadLetter(row.id, err.message);
      logger.error({
        event: "wa.webhook.deadletter",
        eventId: row.id,
        reason: err.message,
      });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    await markFailed(row.id, msg, row.retryCount + 1);
    logger.warn({
      event: "wa.webhook.retry_scheduled",
      eventId: row.id,
      retryCount: row.retryCount + 1,
      reason: msg,
    });
  }
}

async function handleInbound(
  row: typeof waWebhookEvents.$inferSelect,
): Promise<void> {
  const payload = row.payload as {
    message?: MetaInboundMessage;
    contacts?: Array<{ wa_id?: string; profile?: { name?: string } }>;
  };
  const msg = payload.message;
  if (!msg || !msg.id || !msg.from) {
    throw new TerminalError("Inbound payload missing message id/from");
  }
  const contact = payload.contacts?.[0];
  const contactWaId = contact?.wa_id ?? null;
  const contactDisplayName = contact?.profile?.name ?? null;

  await upsertInboundMessage({
    tenantId: row.tenantId!,
    branchId: row.branchId!,
    connectionId: row.connectionId,
    contactPhoneNumber: msg.from,
    contactWaId,
    contactDisplayName,
    message: msg,
    rawPayload: payload as Record<string, unknown>,
  });
}

async function handleStatus(
  row: typeof waWebhookEvents.$inferSelect,
): Promise<void> {
  const payload = row.payload as { status?: MetaStatusUpdate };
  const st = payload.status;
  if (!st || !st.id || !st.status) {
    throw new TerminalError("Status payload missing id/status");
  }
  await applyStatusUpdate({
    tenantId: row.tenantId!,
    branchId: row.branchId!,
    connectionId: row.connectionId,
    status: st,
    rawPayload: payload as Record<string, unknown>,
  });
}
