// Repository for wa_messages.
//
// Two write paths today:
//   - upsertInboundMessage: called by the webhook processor when a
//     'messages' event arrives. Idempotent on meta_message_id.
//   - applyStatusUpdate: called for 'statuses' events. Idempotent on
//     (meta_message_id, status) — we never overwrite a timestamp once
//     set, and 'failed' is terminal.
//
// Outbound queueing (recordOutboundQueued) is here for Phase 3 to use
// when the BullMQ worker takes over sends. Phase 2 doesn't call it yet
// — the SaleForm path still fires fetch and forgets, but once we have
// WAMIDs from successful sends we *do* persist via applyStatusUpdate
// when their 'sent' webhook arrives. Result: an outbound row materialises
// at first status webhook with direction='outbound' so we have a record
// even before the queue rewrite.

import "server-only";
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { waMessages } from "@/lib/db/schema";
import type {
  MetaInboundMessage,
  MetaStatusUpdate,
} from "./webhook-types";
import {
  linkMessageToConversation,
  touchInbound,
  touchOutbound,
} from "./conversations";

export type WaMessageStatus = "queued" | "sent" | "delivered" | "read" | "failed";
export type WaMessageDirection = "inbound" | "outbound";

function tsFromMetaSeconds(s: string | undefined): Date | null {
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000);
}

function classifyType(msg: MetaInboundMessage): {
  messageType: string;
  textBody: string | null;
  mediaId: string | null;
  mediaMimeType: string | null;
  mediaFilename: string | null;
  mediaSha256: string | null;
} {
  const t = msg.type ?? "unknown";
  const empty = {
    messageType: t,
    textBody: null as string | null,
    mediaId: null as string | null,
    mediaMimeType: null as string | null,
    mediaFilename: null as string | null,
    mediaSha256: null as string | null,
  };
  switch (t) {
    case "text":
      return { ...empty, textBody: msg.text?.body ?? null };
    case "button":
      return { ...empty, messageType: "button_reply", textBody: msg.button?.text ?? null };
    case "interactive": {
      const reply =
        msg.interactive?.button_reply?.title ??
        msg.interactive?.list_reply?.title ??
        null;
      return { ...empty, messageType: "interactive_reply", textBody: reply };
    }
    case "reaction":
      return { ...empty, textBody: msg.reaction?.emoji ?? null };
    case "image":
    case "document":
    case "video":
    case "audio":
    case "sticker": {
      const ref =
        (t === "image" && msg.image) ||
        (t === "document" && msg.document) ||
        (t === "video" && msg.video) ||
        (t === "audio" && msg.audio) ||
        (t === "sticker" && msg.sticker) ||
        undefined;
      return {
        ...empty,
        textBody: ref?.caption ?? null,
        mediaId: ref?.id ?? null,
        mediaMimeType: ref?.mime_type ?? null,
        mediaFilename: ref?.filename ?? null,
        mediaSha256: ref?.sha256 ?? null,
      };
    }
    default:
      return empty;
  }
}

export interface UpsertInboundInput {
  tenantId: string;
  branchId: string;
  connectionId: string | null;
  contactPhoneNumber: string;
  contactWaId: string | null;
  /** Optional — comes from Meta's contacts[].profile.name. Used to
   *  populate wa_contacts.display_name. */
  contactDisplayName?: string | null;
  message: MetaInboundMessage;
  rawPayload: Record<string, unknown>;
}

export interface UpsertInboundResult {
  id: string;
  inserted: boolean;
}

export async function upsertInboundMessage(
  input: UpsertInboundInput,
): Promise<UpsertInboundResult> {
  return withTenant(input.tenantId, async (tx) => {
    const classified = classifyType(input.message);
    const receivedAt = tsFromMetaSeconds(input.message.timestamp) ?? new Date();

    // Idempotency: meta_message_id is unique within (provider). If the
    // row already exists we leave it untouched — inbound bodies don't
    // change on resend.
    const inserted = await tx
      .insert(waMessages)
      .values({
        tenantId: input.tenantId,
        branchId: input.branchId,
        connectionId: input.connectionId,
        provider: "meta_cloud",
        direction: "inbound",
        metaMessageId: input.message.id,
        contactPhoneNumber: input.contactPhoneNumber,
        contactWaId: input.contactWaId,
        messageType: classified.messageType,
        textBody: classified.textBody,
        mediaId: classified.mediaId,
        mediaMimeType: classified.mediaMimeType,
        mediaFilename: classified.mediaFilename,
        mediaSha256: classified.mediaSha256,
        payload: input.rawPayload,
        receivedAt,
      })
      .onConflictDoNothing({
        target: [waMessages.provider, waMessages.metaMessageId],
      })
      .returning({ id: waMessages.id });

    if (inserted.length > 0) {
      return { id: inserted[0].id, inserted: true };
    }

    // Row already exists — return its id for downstream linkage.
    const [existing] = await tx
      .select({ id: waMessages.id })
      .from(waMessages)
      .where(
        and(
          eq(waMessages.provider, "meta_cloud"),
          eq(waMessages.metaMessageId, input.message.id),
        ),
      )
      .limit(1);
    return { id: existing?.id ?? "", inserted: false };
  }).then(async (res) => {
    // Outside the tx: touch the conversation aggregate. Best-effort —
    // touchInbound swallows errors. Runs once even when the underlying
    // row was a dedup-noop, because window/unread state can lag.
    if (res.id) {
      const messageAt = tsFromMetaSeconds(input.message.timestamp) ?? new Date();
      const classified = classifyType(input.message);
      const conversationId = await touchInbound({
        tenantId: input.tenantId,
        branchId: input.branchId,
        phoneNumber: input.contactPhoneNumber,
        waId: input.contactWaId,
        displayName: input.contactDisplayName ?? null,
        messageAt,
        previewText: classified.textBody ?? labelFor(classified.messageType),
      });
      if (conversationId && res.inserted) {
        await linkMessageToConversation(input.tenantId, res.id, conversationId);
      }
    }
    return res;
  });
}

function labelFor(t: string): string {
  switch (t) {
    case "image":
      return "[image]";
    case "document":
      return "[document]";
    case "video":
      return "[video]";
    case "audio":
      return "[audio]";
    case "sticker":
      return "[sticker]";
    case "button_reply":
      return "[button]";
    case "interactive_reply":
      return "[interactive]";
    case "reaction":
      return "[reaction]";
    case "location":
      return "[location]";
    default:
      return "[message]";
  }
}

export interface ApplyStatusInput {
  tenantId: string;
  branchId: string;
  connectionId: string | null;
  status: MetaStatusUpdate;
  rawPayload: Record<string, unknown>;
}

/** Apply a status transition. Creates a placeholder outbound row when
 *  the WAMID isn't known yet (e.g. status arrives before our outbound
 *  send-call returned the WAMID — possible during the Phase-3 transition
 *  to async queues). Idempotent on (WAMID, status). */
export async function applyStatusUpdate(input: ApplyStatusInput): Promise<{
  rowId: string;
  created: boolean;
  updated: boolean;
}> {
  const st = input.status;
  if (!st.id || !st.status) {
    return { rowId: "", created: false, updated: false };
  }
  // Hoist the non-null id into a local so the closures below get a
  // narrowed string type — TS doesn't carry narrowing across the
  // withTenant boundary.
  const wamid: string = st.id;
  const statusValue: string = st.status;
  const ts = tsFromMetaSeconds(st.timestamp) ?? new Date();

  return withTenant(input.tenantId, async (tx) => {
    // Try to update first — the common case is "row exists from our
    // outbound send, status webhook arrives later".
    const set: Record<string, unknown> = {
      status: st.status,
      updatedAt: new Date(),
    };
    if (st.status === "sent") set.sentAt = ts;
    if (st.status === "delivered") set.deliveredAt = ts;
    if (st.status === "read") set.readAt = ts;
    if (st.status === "failed") {
      set.failedAt = ts;
      const err = st.errors?.[0];
      set.failureReason =
        err?.error_data?.details || err?.message || err?.title || null;
      set.failureCode = err?.code ?? null;
    }
    if (st.conversation?.id) set.conversationId = st.conversation.id;
    if (st.conversation?.origin?.type)
      set.conversationOrigin = st.conversation.origin.type;
    if (st.pricing?.category) set.pricingCategory = st.pricing.category;
    if (st.pricing?.pricing_model) set.pricingModel = st.pricing.pricing_model;
    if (typeof st.pricing?.billable === "boolean")
      set.pricingBillable = st.pricing.billable;

    const updated = await tx
      .update(waMessages)
      .set(set)
      .where(
        and(
          eq(waMessages.provider, "meta_cloud"),
          eq(waMessages.metaMessageId, wamid),
          eq(waMessages.tenantId, input.tenantId),
        ),
      )
      .returning({ id: waMessages.id });

    if (updated.length > 0) {
      return { rowId: updated[0].id, created: false, updated: true };
    }

    // No matching outbound row — create a placeholder so the status is
    // not lost. Direction='outbound' because only outbound messages
    // generate sent/delivered/read/failed statuses.
    const inserted = await tx
      .insert(waMessages)
      .values({
        tenantId: input.tenantId,
        branchId: input.branchId,
        connectionId: input.connectionId,
        provider: "meta_cloud",
        direction: "outbound",
        metaMessageId: wamid,
        contactPhoneNumber: st.recipient_id ?? "",
        messageType: "unknown",
        payload: input.rawPayload,
        status: st.status,
        sentAt: st.status === "sent" ? ts : null,
        deliveredAt: st.status === "delivered" ? ts : null,
        readAt: st.status === "read" ? ts : null,
        failedAt: st.status === "failed" ? ts : null,
        failureReason: (set.failureReason as string | undefined) ?? null,
        failureCode: (set.failureCode as number | undefined) ?? null,
        conversationId: st.conversation?.id ?? null,
        conversationOrigin: st.conversation?.origin?.type ?? null,
        pricingCategory: st.pricing?.category ?? null,
        pricingModel: st.pricing?.pricing_model ?? null,
        pricingBillable:
          typeof st.pricing?.billable === "boolean" ? st.pricing.billable : null,
      })
      .onConflictDoNothing({
        target: [waMessages.provider, waMessages.metaMessageId],
      })
      .returning({ id: waMessages.id });

    if (inserted.length > 0) {
      return { rowId: inserted[0].id, created: true, updated: false };
    }
    // Race: someone else just inserted the row. Re-read.
    const [existing] = await tx
      .select({ id: waMessages.id })
      .from(waMessages)
      .where(
        and(
          eq(waMessages.provider, "meta_cloud"),
          eq(waMessages.metaMessageId, wamid),
          eq(waMessages.tenantId, input.tenantId),
        ),
      )
      .limit(1);
    return { rowId: existing?.id ?? "", created: false, updated: false };
  });
}

/** Records an outbound message at queue time with a client UUID. Once
 *  the send actually goes out, patchOutboundOnSendResult fills in the
 *  meta_message_id and flips status. */
export async function recordOutboundQueued(input: {
  tenantId: string;
  branchId: string;
  connectionId: string | null;
  contactPhoneNumber: string;
  messageType: string;
  textBody?: string | null;
  payload?: Record<string, unknown>;
  clientMessageId: string;
}): Promise<string> {
  const rowId = await withTenant(input.tenantId, async (tx) => {
    const [row] = await tx
      .insert(waMessages)
      .values({
        tenantId: input.tenantId,
        branchId: input.branchId,
        connectionId: input.connectionId,
        provider: "meta_cloud",
        direction: "outbound",
        clientMessageId: input.clientMessageId,
        contactPhoneNumber: input.contactPhoneNumber,
        messageType: input.messageType,
        textBody: input.textBody ?? null,
        payload: input.payload ?? null,
        status: "queued",
      })
      .returning({ id: waMessages.id });
    return row.id;
  });

  // Best-effort conversation maintenance — never throws.
  const conversationId = await touchOutbound({
    tenantId: input.tenantId,
    branchId: input.branchId,
    phoneNumber: input.contactPhoneNumber,
    messageAt: new Date(),
    previewText: input.textBody ?? labelFor(input.messageType),
  });
  if (conversationId) {
    await linkMessageToConversation(input.tenantId, rowId, conversationId);
  }
  return rowId;
}

/** Patch the outbound row with the Graph send result. Called from the
 *  worker after the Graph call returns. Pre-status webhook arrival means
 *  status='sent' here; later 'sent'/'delivered'/'read' webhooks refine
 *  it via applyStatusUpdate without overwriting these initial values. */
export async function patchOutboundOnSendResult(input: {
  tenantId: string;
  rowId: string;
  metaMessageId: string | null;
  ok: boolean;
  failureReason?: string | null;
  failureCode?: number | null;
}): Promise<void> {
  await withTenant(input.tenantId, async (tx) => {
    const set: Record<string, unknown> = {
      updatedAt: new Date(),
    };
    if (input.ok) {
      set.status = "sent";
      set.sentAt = new Date();
      if (input.metaMessageId) set.metaMessageId = input.metaMessageId;
    } else {
      set.status = "failed";
      set.failedAt = new Date();
      set.failureReason = input.failureReason ?? "send failed";
      if (input.failureCode != null) set.failureCode = input.failureCode;
    }
    await tx
      .update(waMessages)
      .set(set)
      .where(
        and(
          eq(waMessages.tenantId, input.tenantId),
          eq(waMessages.id, input.rowId),
        ),
      );
  });
}

/** Lookup by clientMessageId for the status-polling endpoint. */
export async function getMessageByClientId(
  tenantId: string,
  clientMessageId: string,
): Promise<typeof waMessages.$inferSelect | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(waMessages)
      .where(
        and(
          eq(waMessages.tenantId, tenantId),
          eq(waMessages.clientMessageId, clientMessageId),
        ),
      )
      .limit(1);
    return row ?? null;
  });
}
