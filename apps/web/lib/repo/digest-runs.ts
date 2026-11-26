// Persistence layer for digest_runs + digest_settings.

import { and, desc, eq, gte } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { digestRuns, digestSettings } from "@/lib/db/schema";
import type { DigestExtraRecipient } from "@/lib/db/schema";
import type { DigestPayload } from "./digest";

export interface DigestSettingsDto {
  tenantId: string;
  enabled: boolean;
  digestHour: number;
  ownerPhone: string | null;
  sendOnEmpty: boolean;
  emailFallback: boolean;
  extraRecipients: DigestExtraRecipient[];
  managersSubscribed: string[];
  updatedAt: Date;
}

export async function getDigestSettings(
  tenantId: string,
): Promise<DigestSettingsDto> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(digestSettings)
      .where(eq(digestSettings.tenantId, tenantId))
      .limit(1);
    if (!row) {
      // Synthesize an off-by-default row. We don't write it eagerly because
      // most tenants will never enable digests; let the toggle persist on
      // first save.
      return {
        tenantId,
        enabled: false,
        digestHour: 0,
        ownerPhone: null,
        sendOnEmpty: false,
        emailFallback: true,
        extraRecipients: [],
        managersSubscribed: [],
        updatedAt: new Date(0),
      };
    }
    return {
      tenantId,
      enabled: row.enabled,
      digestHour: row.digestHour,
      ownerPhone: row.ownerPhone,
      sendOnEmpty: row.sendOnEmpty,
      emailFallback: row.emailFallback,
      extraRecipients: row.extraRecipients ?? [],
      managersSubscribed: row.managersSubscribed,
      updatedAt: row.updatedAt,
    };
  });
}

export interface UpdateDigestSettingsInput {
  enabled?: boolean;
  digestHour?: number;
  ownerPhone?: string | null;
  sendOnEmpty?: boolean;
  emailFallback?: boolean;
  extraRecipients?: DigestExtraRecipient[];
  managersSubscribed?: string[];
}

export async function upsertDigestSettings(
  tenantId: string,
  input: UpdateDigestSettingsInput,
): Promise<DigestSettingsDto> {
  return withTenant(tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(digestSettings)
      .where(eq(digestSettings.tenantId, tenantId))
      .limit(1);

    if (!existing) {
      const [created] = await tx
        .insert(digestSettings)
        .values({
          tenantId,
          enabled: input.enabled ?? false,
          digestHour: input.digestHour ?? 0,
          ownerPhone: input.ownerPhone ?? null,
          sendOnEmpty: input.sendOnEmpty ?? false,
          emailFallback: input.emailFallback ?? true,
          extraRecipients: input.extraRecipients ?? [],
          managersSubscribed: input.managersSubscribed ?? [],
        })
        .returning();
      return rowToDto(created);
    }

    const set: Record<string, unknown> = {};
    if (input.enabled !== undefined) set.enabled = input.enabled;
    if (input.digestHour !== undefined) set.digestHour = input.digestHour;
    if (input.ownerPhone !== undefined) set.ownerPhone = input.ownerPhone;
    if (input.sendOnEmpty !== undefined) set.sendOnEmpty = input.sendOnEmpty;
    if (input.emailFallback !== undefined) set.emailFallback = input.emailFallback;
    if (input.extraRecipients !== undefined)
      set.extraRecipients = input.extraRecipients;
    if (input.managersSubscribed !== undefined)
      set.managersSubscribed = input.managersSubscribed;
    if (Object.keys(set).length === 0) return rowToDto(existing);
    const [updated] = await tx
      .update(digestSettings)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(digestSettings.tenantId, tenantId))
      .returning();
    return rowToDto(updated);
  });
}

function rowToDto(row: typeof digestSettings.$inferSelect): DigestSettingsDto {
  return {
    tenantId: row.tenantId,
    enabled: row.enabled,
    digestHour: row.digestHour,
    ownerPhone: row.ownerPhone,
    sendOnEmpty: row.sendOnEmpty,
    emailFallback: row.emailFallback,
    extraRecipients: row.extraRecipients ?? [],
    managersSubscribed: row.managersSubscribed,
    updatedAt: row.updatedAt,
  };
}

// ── digest_runs ──────────────────────────────────────────────────────────

export interface InsertRunInput {
  tenantId: string;
  branchId: string;
  businessDate: string;
  recipientUserId?: string | null;
  recipientPhone?: string | null;
  recipientEmail?: string | null;
  channel: "whatsapp" | "email" | "email_fallback";
  payload: DigestPayload;
  messageText: string | null;
  status?: "pending" | "sent" | "failed" | "skipped_empty" | "skipped_no_channel";
  error?: string | null;
}

/** Insert a digest_runs row. Returns null when the idempotency unique index
 *  already covers (tenant, branch, day, recipient, channel). */
export async function insertDigestRun(
  input: InsertRunInput,
): Promise<{ id: string } | null> {
  return withTenant(input.tenantId, async (tx) => {
    try {
      const [created] = await tx
        .insert(digestRuns)
        .values({
          tenantId: input.tenantId,
          branchId: input.branchId,
          businessDate: input.businessDate,
          recipientUserId: input.recipientUserId ?? null,
          recipientPhone: input.recipientPhone ?? null,
          recipientEmail: input.recipientEmail ?? null,
          channel: input.channel,
          status: input.status ?? "pending",
          error: input.error ?? null,
          payload: input.payload as unknown as Record<string, unknown>,
          messageText: input.messageText,
        })
        .returning({ id: digestRuns.id });
      return { id: created.id };
    } catch (err) {
      // Unique violation on the idempotency index — already sent / queued.
      if (
        err instanceof Error &&
        /duplicate key|unique/i.test(err.message)
      ) {
        return null;
      }
      throw err;
    }
  });
}

export async function markRunSent(
  tenantId: string,
  id: string,
  whatsappMessageId: string | null,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(digestRuns)
      .set({
        status: "sent",
        sentAt: new Date(),
        whatsappMessageId,
        error: null,
      })
      .where(and(eq(digestRuns.tenantId, tenantId), eq(digestRuns.id, id)));
  });
}

export async function markRunFailed(
  tenantId: string,
  id: string,
  error: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(digestRuns)
      .set({ status: "failed", error })
      .where(and(eq(digestRuns.tenantId, tenantId), eq(digestRuns.id, id)));
  });
}

export async function listRecentRuns(
  tenantId: string,
  branchId: string | null,
  limit = 50,
): Promise<(typeof digestRuns.$inferSelect)[]> {
  return withTenant(tenantId, async (tx) => {
    const conditions = [eq(digestRuns.tenantId, tenantId)];
    if (branchId) conditions.push(eq(digestRuns.branchId, branchId));
    const cutoff = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    conditions.push(gte(digestRuns.enqueuedAt, cutoff));
    return tx
      .select()
      .from(digestRuns)
      .where(and(...conditions))
      .orderBy(desc(digestRuns.enqueuedAt))
      .limit(limit);
  });
}
