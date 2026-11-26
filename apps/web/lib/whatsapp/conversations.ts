// Repository for wa_conversations. One row per (tenant, branch, contact).
//
// Two write paths:
//   - touchInbound: every inbound message extends the 24h customer
//     service window, increments unread, updates preview.
//   - touchOutbound: outbound activity updates preview + last_message_at,
//     but does NOT reset the window (Meta's rule: only customer
//     messages re-open the window).
//
// Both are idempotent and creation-tolerant — if the conversation
// doesn't exist yet, they create it.

import "server-only";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { waConversations, waContacts, waMessages } from "@/lib/db/schema";
import { upsertContact } from "./contacts";

// Meta's customer service window: 24 hours from the last inbound message.
// Define as a single constant so any code that needs the value uses the
// same number.
export const CUSTOMER_WINDOW_MS = 24 * 60 * 60 * 1000;
const PREVIEW_MAX_LEN = 160;

function preview(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  return trimmed.length > PREVIEW_MAX_LEN
    ? trimmed.slice(0, PREVIEW_MAX_LEN - 1) + "…"
    : trimmed;
}

export interface ConversationRecord {
  id: string;
  tenantId: string;
  branchId: string;
  contactId: string;
  phoneNumber: string;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  lastMessageDirection: "inbound" | "outbound" | null;
  unreadCount: number;
  windowExpiresAt: Date | null;
  lastConversationId: string | null;
  lastConversationCategory: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toRecord(
  row: typeof waConversations.$inferSelect,
): ConversationRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    branchId: row.branchId,
    contactId: row.contactId,
    phoneNumber: row.phoneNumber,
    lastMessageAt: row.lastMessageAt,
    lastMessagePreview: row.lastMessagePreview,
    lastMessageDirection:
      (row.lastMessageDirection as "inbound" | "outbound" | null) ?? null,
    unreadCount: row.unreadCount,
    windowExpiresAt: row.windowExpiresAt,
    lastConversationId: row.lastConversationId,
    lastConversationCategory: row.lastConversationCategory,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ─── Lookup / get-or-create ──────────────────────────────────────────────

/** Ensure a conversation row exists for (tenant, branch, phone). Creates
 *  the contact row first if needed (with the supplied displayName when
 *  available). Returns the conversation id. */
export async function ensureConversation(input: {
  tenantId: string;
  branchId: string;
  phoneNumber: string;
  waId?: string | null;
  displayName?: string | null;
}): Promise<string> {
  const contact = await upsertContact({
    tenantId: input.tenantId,
    branchId: input.branchId,
    phoneNumber: input.phoneNumber,
    waId: input.waId,
    displayName: input.displayName,
  });

  return withTenant(input.tenantId, async (tx) => {
    const [existing] = await tx
      .select({ id: waConversations.id })
      .from(waConversations)
      .where(
        and(
          eq(waConversations.tenantId, input.tenantId),
          eq(waConversations.branchId, input.branchId),
          eq(waConversations.contactId, contact.id),
        ),
      )
      .limit(1);
    if (existing) return existing.id;

    const [row] = await tx
      .insert(waConversations)
      .values({
        tenantId: input.tenantId,
        branchId: input.branchId,
        contactId: contact.id,
        phoneNumber: input.phoneNumber,
      })
      .onConflictDoUpdate({
        target: [
          waConversations.tenantId,
          waConversations.branchId,
          waConversations.contactId,
        ],
        set: { updatedAt: new Date() },
      })
      .returning({ id: waConversations.id });
    return row.id;
  });
}

// ─── Write paths ─────────────────────────────────────────────────────────

export interface TouchInboundInput {
  tenantId: string;
  branchId: string;
  phoneNumber: string;
  waId?: string | null;
  displayName?: string | null;
  messageAt: Date;
  previewText: string | null;
}

/** Called when an inbound message lands. Opens/extends the 24h window,
 *  bumps unread, updates preview + last_message_at. Never throws —
 *  conversation tracking is best-effort. */
export async function touchInbound(
  input: TouchInboundInput,
): Promise<string | null> {
  try {
    const conversationId = await ensureConversation({
      tenantId: input.tenantId,
      branchId: input.branchId,
      phoneNumber: input.phoneNumber,
      waId: input.waId,
      displayName: input.displayName,
    });

    await withTenant(input.tenantId, async (tx) => {
      // Use raw SQL for the unread_count increment so two concurrent
      // inbound writes can't lose increments.
      await tx
        .update(waConversations)
        .set({
          lastMessageAt: input.messageAt,
          lastMessagePreview: preview(input.previewText),
          lastMessageDirection: "inbound",
          windowExpiresAt: new Date(input.messageAt.getTime() + CUSTOMER_WINDOW_MS),
          unreadCount: sql`${waConversations.unreadCount} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(waConversations.tenantId, input.tenantId),
            eq(waConversations.id, conversationId),
          ),
        );
    });
    return conversationId;
  } catch {
    // Swallow — caller (webhook processor) shouldn't fail message
    // ingestion because of conversation maintenance.
    return null;
  }
}

export interface TouchOutboundInput {
  tenantId: string;
  branchId: string;
  phoneNumber: string;
  messageAt: Date;
  previewText: string | null;
}

/** Called when an outbound message is sent (or queued — caller's
 *  choice). Updates preview + last_message_at but does NOT touch the
 *  customer service window (Meta only opens it on inbound). */
export async function touchOutbound(
  input: TouchOutboundInput,
): Promise<string | null> {
  try {
    const conversationId = await ensureConversation({
      tenantId: input.tenantId,
      branchId: input.branchId,
      phoneNumber: input.phoneNumber,
    });

    await withTenant(input.tenantId, async (tx) => {
      await tx
        .update(waConversations)
        .set({
          lastMessageAt: input.messageAt,
          lastMessagePreview: preview(input.previewText),
          lastMessageDirection: "outbound",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(waConversations.tenantId, input.tenantId),
            eq(waConversations.id, conversationId),
          ),
        );
    });
    return conversationId;
  } catch {
    return null;
  }
}

// ─── Window state ────────────────────────────────────────────────────────

export interface WindowState {
  hasOpenWindow: boolean;
  expiresAt: Date | null;
  // True when there's no conversation at all — the customer has never
  // messaged us. Outbound freeform requires a template in this case.
  neverContacted: boolean;
}

export async function getWindowState(
  tenantId: string,
  branchId: string,
  phoneNumber: string,
): Promise<WindowState> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        windowExpiresAt: waConversations.windowExpiresAt,
      })
      .from(waConversations)
      .innerJoin(waContacts, eq(waContacts.id, waConversations.contactId))
      .where(
        and(
          eq(waConversations.tenantId, tenantId),
          eq(waConversations.branchId, branchId),
          eq(waContacts.phoneNumber, phoneNumber),
        ),
      )
      .limit(1);

    if (!row) {
      return { hasOpenWindow: false, expiresAt: null, neverContacted: true };
    }
    if (!row.windowExpiresAt) {
      return { hasOpenWindow: false, expiresAt: null, neverContacted: false };
    }
    return {
      hasOpenWindow: row.windowExpiresAt.getTime() > Date.now(),
      expiresAt: row.windowExpiresAt,
      neverContacted: false,
    };
  });
}

// ─── Read API ────────────────────────────────────────────────────────────

export interface ListConversationsOptions {
  tenantId: string;
  branchId: string;
  /** Show archived too. Default false. */
  includeArchived?: boolean;
  /** Only show with unread > 0. */
  unreadOnly?: boolean;
  /** Cursor: ISO timestamp of last_message_at to page before. */
  before?: Date;
  limit?: number;
}

export interface ConversationListItem extends ConversationRecord {
  displayName: string | null;
  merchantLabel: string | null;
}

export async function listConversations(
  opts: ListConversationsOptions,
): Promise<ConversationListItem[]> {
  return withTenant(opts.tenantId, async (tx) => {
    const where = [
      eq(waConversations.tenantId, opts.tenantId),
      eq(waConversations.branchId, opts.branchId),
    ];
    if (!opts.includeArchived) {
      where.push(isNull(waConversations.archivedAt) as unknown as ReturnType<typeof eq>);
    }
    if (opts.unreadOnly) {
      where.push(
        sql`${waConversations.unreadCount} > 0` as unknown as ReturnType<typeof eq>,
      );
    }
    if (opts.before) {
      where.push(lt(waConversations.lastMessageAt, opts.before));
    }

    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = await tx
      .select({
        c: waConversations,
        displayName: waContacts.displayName,
        merchantLabel: waContacts.merchantLabel,
      })
      .from(waConversations)
      .innerJoin(waContacts, eq(waContacts.id, waConversations.contactId))
      .where(and(...where))
      .orderBy(desc(waConversations.lastMessageAt))
      .limit(limit);

    return rows.map((r) => ({
      ...toRecord(r.c),
      displayName: r.displayName,
      merchantLabel: r.merchantLabel,
    }));
  });
}

export async function getConversationById(
  tenantId: string,
  conversationId: string,
): Promise<ConversationListItem | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select({
        c: waConversations,
        displayName: waContacts.displayName,
        merchantLabel: waContacts.merchantLabel,
      })
      .from(waConversations)
      .innerJoin(waContacts, eq(waContacts.id, waConversations.contactId))
      .where(
        and(
          eq(waConversations.tenantId, tenantId),
          eq(waConversations.id, conversationId),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      ...toRecord(row.c),
      displayName: row.displayName,
      merchantLabel: row.merchantLabel,
    };
  });
}

export interface ListMessagesOptions {
  tenantId: string;
  conversationId: string;
  before?: Date; // cursor on created_at
  limit?: number;
}

export async function listMessages(opts: ListMessagesOptions) {
  return withTenant(opts.tenantId, async (tx) => {
    const where = [
      eq(waMessages.tenantId, opts.tenantId),
      eq(waMessages.conversationRowId, opts.conversationId),
    ];
    if (opts.before) {
      where.push(lt(waMessages.createdAt, opts.before));
    }
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    return tx
      .select()
      .from(waMessages)
      .where(and(...where))
      .orderBy(desc(waMessages.createdAt))
      .limit(limit);
  });
}

export async function markRead(
  tenantId: string,
  conversationId: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(waConversations)
      .set({ unreadCount: 0, updatedAt: new Date() })
      .where(
        and(
          eq(waConversations.tenantId, tenantId),
          eq(waConversations.id, conversationId),
        ),
      );
  });
}

export async function setArchived(
  tenantId: string,
  conversationId: string,
  archived: boolean,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(waConversations)
      .set({
        archivedAt: archived ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(waConversations.tenantId, tenantId),
          eq(waConversations.id, conversationId),
        ),
      );
  });
}

/** Phase-4 helper used by the messages repo to link freshly-inserted
 *  rows to their conversation aggregate. */
export async function linkMessageToConversation(
  tenantId: string,
  messageRowId: string,
  conversationId: string,
): Promise<void> {
  try {
    await withTenant(tenantId, async (tx) => {
      await tx
        .update(waMessages)
        .set({ conversationRowId: conversationId, updatedAt: new Date() })
        .where(
          and(
            eq(waMessages.tenantId, tenantId),
            eq(waMessages.id, messageRowId),
          ),
        );
    });
  } catch {
    // best-effort
  }
}
