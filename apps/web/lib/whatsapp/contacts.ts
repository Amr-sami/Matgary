// Repository for wa_contacts. Tenant-scoped; reads + writes go through
// withTenant so RLS gates everything.
//
// Contact rows are created lazily — every inbound webhook upserts one
// (with display_name from Meta's contacts[].profile.name), and outbound
// sends ensure one exists so a conversation row can point at it. We
// never overwrite a merchant-set label.

import "server-only";
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { waContacts } from "@/lib/db/schema";

export interface UpsertContactInput {
  tenantId: string;
  branchId: string;
  phoneNumber: string; // normalised, no '+'
  waId?: string | null;
  displayName?: string | null;
}

export interface ContactRecord {
  id: string;
  tenantId: string;
  branchId: string;
  phoneNumber: string;
  waId: string | null;
  displayName: string | null;
  merchantLabel: string | null;
  tags: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Idempotent insert-or-update. Will *not* overwrite an existing
 *  merchant_label or tags (those are owner-managed). display_name only
 *  updates when the Meta profile actually carries a name — keeps stale
 *  webhooks from clearing a known good label. */
export async function upsertContact(
  input: UpsertContactInput,
): Promise<ContactRecord> {
  return withTenant(input.tenantId, async (tx) => {
    // Try update first — covers the common case where the contact
    // already exists.
    const existing = await tx
      .select()
      .from(waContacts)
      .where(
        and(
          eq(waContacts.tenantId, input.tenantId),
          eq(waContacts.branchId, input.branchId),
          eq(waContacts.phoneNumber, input.phoneNumber),
        ),
      )
      .limit(1);

    if (existing[0]) {
      const cur = existing[0];
      const set: Record<string, unknown> = {};
      // Only patch fields that have a non-empty incoming value AND the
      // current value is null/empty. Merchant edits stick.
      if (
        input.displayName &&
        input.displayName.trim() &&
        !cur.displayName
      ) {
        set.displayName = input.displayName.trim();
      }
      if (input.waId && !cur.waId) set.waId = input.waId;
      if (Object.keys(set).length > 0) {
        set.updatedAt = new Date();
        const [updated] = await tx
          .update(waContacts)
          .set(set)
          .where(eq(waContacts.id, cur.id))
          .returning();
        return toRecord(updated);
      }
      return toRecord(cur);
    }

    // Insert. ON CONFLICT covers the race where two concurrent webhooks
    // for the same contact arrive simultaneously (rare but cheap to
    // guard).
    const [row] = await tx
      .insert(waContacts)
      .values({
        tenantId: input.tenantId,
        branchId: input.branchId,
        phoneNumber: input.phoneNumber,
        waId: input.waId ?? null,
        displayName: input.displayName?.trim() ?? null,
      })
      .onConflictDoUpdate({
        target: [waContacts.tenantId, waContacts.branchId, waContacts.phoneNumber],
        set: { updatedAt: new Date() },
      })
      .returning();
    return toRecord(row);
  });
}

function toRecord(row: typeof waContacts.$inferSelect): ContactRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    branchId: row.branchId,
    phoneNumber: row.phoneNumber,
    waId: row.waId,
    displayName: row.displayName,
    merchantLabel: row.merchantLabel,
    tags: row.tags,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getContactByPhone(
  tenantId: string,
  branchId: string,
  phoneNumber: string,
): Promise<ContactRecord | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(waContacts)
      .where(
        and(
          eq(waContacts.tenantId, tenantId),
          eq(waContacts.branchId, branchId),
          eq(waContacts.phoneNumber, phoneNumber),
        ),
      )
      .limit(1);
    return row ? toRecord(row) : null;
  });
}
