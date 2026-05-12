// Repository for wa_webhook_events. Uses the raw `db` handle because the
// webhook handler runs OUTSIDE any tenant session — the whole point of
// this table is durably recording events before we know whose tenant they
// belong to (or even whether we own the receiving number).

import "server-only";
import { createHash } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { waWebhookEvents } from "@/lib/db/schema";
import type {
  ExtractedEvent,
  MetaWebhookEnvelope,
  WaEventType,
} from "./webhook-types";

export type ProcessingStatus =
  | "pending"
  | "processing"
  | "processed"
  | "failed"
  | "quarantined"
  | "dead_letter";

/** Walk a Meta webhook envelope and yield one ExtractedEvent per message
 *  or status. We do this *before* persistence so the dedup key (provider
 *  + provider_event_id) is one-to-one with wa_webhook_events rows. */
export function extractEvents(envelope: MetaWebhookEnvelope): ExtractedEvent[] {
  const out: ExtractedEvent[] = [];
  for (const entry of envelope.entry ?? []) {
    const wabaId = entry.id ?? null;
    for (const change of entry.changes ?? []) {
      const value = change.value;
      if (!value) continue;
      const phoneNumberId = value.metadata?.phone_number_id ?? null;

      // Inbound messages.
      for (const msg of value.messages ?? []) {
        if (!msg.id) continue;
        out.push({
          providerEventId: `msg:${msg.id}`,
          eventType: "message.received",
          phoneNumberId,
          wabaId,
          payload: {
            message: msg,
            // contacts is the sibling array of `messages` — Meta sends
            // one contact per inbound sender. Keep it co-located so the
            // processor doesn't have to re-walk the batch.
            contacts: value.contacts ?? [],
            metadata: value.metadata ?? {},
          },
        });
      }

      // Outbound status transitions. Each status (sent/delivered/read/
      // failed) for the same WAMID is its own logical event — multiple
      // can arrive out of order and we want each persisted separately.
      for (const st of value.statuses ?? []) {
        if (!st.id || !st.status) continue;
        // Include timestamp in the dedup key so duplicate delivery of the
        // *same* transition collapses but distinct transitions don't.
        out.push({
          providerEventId: `status:${st.id}:${st.status}`,
          eventType: "message.status",
          phoneNumberId,
          wabaId,
          payload: {
            status: st,
            metadata: value.metadata ?? {},
          },
        });
      }

      // Template status updates (field='message_template_status_update').
      // The Meta payload puts event/template_name/language/reason directly
      // on `value` — no nested messages/statuses arrays. One logical
      // event per change. Idempotency key folds in the event verb so a
      // template that bounces PENDING→REJECTED→APPROVED gets distinct
      // rows for each transition.
      if (
        change.field === "message_template_status_update" &&
        (value.event || value.message_template_name)
      ) {
        const ts =
          (value as unknown as { timestamp?: string | number }).timestamp ??
          "0";
        const evVerb = (value.event ?? "unknown").toLowerCase();
        const nameKey = value.message_template_name ?? "unnamed";
        const langKey = value.message_template_language ?? "—";
        out.push({
          providerEventId: `tpl:${nameKey}:${langKey}:${evVerb}:${ts}`,
          eventType: "template.status_update",
          // Template events arrive on the WABA, not a phone number —
          // metadata.phone_number_id is absent. Tenant resolution will
          // fall through to the WABA fallback path.
          phoneNumberId: null,
          wabaId,
          payload: {
            field: change.field,
            value,
          },
        });
        continue;
      }

      // Account-level errors (rare; e.g. WABA-wide rate limit). Persist
      // for forensics but they don't map to a message row.
      for (const err of value.errors ?? []) {
        const hash = createHash("sha1")
          .update(JSON.stringify({ change, err }))
          .digest("hex")
          .slice(0, 16);
        out.push({
          providerEventId: `change:${hash}`,
          eventType: "unknown",
          phoneNumberId,
          wabaId,
          payload: { error: err, field: change.field, value },
        });
      }

      // Field we don't know how to extract from. Still persist as
      // 'unknown' so dashboards surface us when Meta ships a new event
      // type and we haven't added a handler yet.
      if (
        (value.messages?.length ?? 0) === 0 &&
        (value.statuses?.length ?? 0) === 0 &&
        (value.errors?.length ?? 0) === 0
      ) {
        const hash = createHash("sha1")
          .update(JSON.stringify({ change }))
          .digest("hex")
          .slice(0, 16);
        out.push({
          providerEventId: `change:${hash}`,
          eventType: "unknown",
          phoneNumberId,
          wabaId,
          payload: { field: change.field, value },
        });
      }
    }
  }
  return out;
}

export interface InsertEventInput {
  providerEventId: string;
  eventType: WaEventType;
  phoneNumberId: string | null;
  wabaId: string | null;
  tenantId: string | null;
  branchId: string | null;
  connectionId: string | null;
  payload: Record<string, unknown>;
  processingStatus: ProcessingStatus;
  errorDetails?: string | null;
}

export interface InsertEventResult {
  id: string | null; // null when ON CONFLICT swallowed the insert
  inserted: boolean;
}

/** Insert one event row idempotently. Concurrent duplicate deliveries
 *  from Meta race on the unique constraint; the loser sees no inserted
 *  row and skips processing. */
export async function insertEvent(
  input: InsertEventInput,
): Promise<InsertEventResult> {
  const rows = await db
    .insert(waWebhookEvents)
    .values({
      provider: "meta_cloud",
      providerEventId: input.providerEventId,
      eventType: input.eventType,
      tenantId: input.tenantId,
      branchId: input.branchId,
      connectionId: input.connectionId,
      phoneNumberId: input.phoneNumberId,
      wabaId: input.wabaId,
      payload: input.payload,
      processingStatus: input.processingStatus,
      errorDetails: input.errorDetails ?? null,
      receivedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [waWebhookEvents.provider, waWebhookEvents.providerEventId],
    })
    .returning({ id: waWebhookEvents.id });

  if (rows.length === 0) return { id: null, inserted: false };
  return { id: rows[0].id, inserted: true };
}

export async function markProcessing(eventId: string): Promise<void> {
  await db
    .update(waWebhookEvents)
    .set({
      processingStatus: "processing",
      lastAttemptAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(waWebhookEvents.id, eventId));
}

export async function markProcessed(eventId: string): Promise<void> {
  await db
    .update(waWebhookEvents)
    .set({
      processingStatus: "processed",
      processedAt: new Date(),
      errorDetails: null,
      nextAttemptAt: null,
      updatedAt: new Date(),
    })
    .where(eq(waWebhookEvents.id, eventId));
}

export async function markFailed(
  eventId: string,
  error: string,
  retryCount: number,
): Promise<void> {
  // Exponential backoff capped at 1h — Phase 3 BullMQ will read
  // next_attempt_at to schedule retries. For Phase 2 the column is
  // advisory.
  const delayMs = Math.min(60_000 * Math.pow(2, Math.min(retryCount, 6)), 3_600_000);
  await db
    .update(waWebhookEvents)
    .set({
      processingStatus: "failed",
      retryCount,
      errorDetails: error.slice(0, 2000),
      lastAttemptAt: new Date(),
      nextAttemptAt: new Date(Date.now() + delayMs),
      updatedAt: new Date(),
    })
    .where(eq(waWebhookEvents.id, eventId));
}

export async function markDeadLetter(
  eventId: string,
  error: string,
): Promise<void> {
  await db
    .update(waWebhookEvents)
    .set({
      processingStatus: "dead_letter",
      errorDetails: error.slice(0, 2000),
      lastAttemptAt: new Date(),
      nextAttemptAt: null,
      updatedAt: new Date(),
    })
    .where(eq(waWebhookEvents.id, eventId));
}

export interface ListEventsFilters {
  status?: ProcessingStatus | "all";
  tenantId?: string | null; // null = only quarantine rows
  limit?: number;
}

/** Admin inspection listing. Caller must enforce permission gating —
 *  this function returns rows across tenants when tenantId is omitted. */
export async function listEvents(
  filters: ListEventsFilters = {},
): Promise<
  Array<{
    id: string;
    providerEventId: string;
    eventType: string;
    processingStatus: string;
    tenantId: string | null;
    branchId: string | null;
    phoneNumberId: string | null;
    wabaId: string | null;
    retryCount: number;
    errorDetails: string | null;
    receivedAt: Date;
    processedAt: Date | null;
    payload: Record<string, unknown>;
  }>
> {
  const where: Array<ReturnType<typeof eq>> = [];
  if (filters.status && filters.status !== "all") {
    where.push(eq(waWebhookEvents.processingStatus, filters.status));
  }
  if (filters.tenantId === null) {
    where.push(
      isNull(waWebhookEvents.tenantId) as unknown as ReturnType<typeof eq>,
    );
  } else if (typeof filters.tenantId === "string") {
    where.push(eq(waWebhookEvents.tenantId, filters.tenantId));
  }

  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const rows = await db
    .select({
      id: waWebhookEvents.id,
      providerEventId: waWebhookEvents.providerEventId,
      eventType: waWebhookEvents.eventType,
      processingStatus: waWebhookEvents.processingStatus,
      tenantId: waWebhookEvents.tenantId,
      branchId: waWebhookEvents.branchId,
      phoneNumberId: waWebhookEvents.phoneNumberId,
      wabaId: waWebhookEvents.wabaId,
      retryCount: waWebhookEvents.retryCount,
      errorDetails: waWebhookEvents.errorDetails,
      receivedAt: waWebhookEvents.receivedAt,
      processedAt: waWebhookEvents.processedAt,
      payload: waWebhookEvents.payload,
    })
    .from(waWebhookEvents)
    .where(where.length ? (and(...where) as unknown as ReturnType<typeof eq>) : sql`true`)
    .orderBy(desc(waWebhookEvents.receivedAt))
    .limit(limit);

  return rows.map((r) => ({
    ...r,
    payload: (r.payload ?? {}) as Record<string, unknown>,
  }));
}
