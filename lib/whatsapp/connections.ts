// Repository for wa_connections. Two access patterns:
//
//   1. Tenant-scoped (settings UI, send routes): caller already has a
//      tenantId. Use the *withTenant* variants — they go through RLS.
//
//   2. Tenant-resolution (webhook router): caller has only a phone_number_id
//      from an inbound Meta event and must find the owning tenant before
//      doing anything else. Uses the raw `db` handle. Treat the returned
//      tenantId as untrusted until the calling code re-enters withTenant.

import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import { waConnections } from "@/lib/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

export type WaConnectionStatus =
  | "active"
  | "disconnected"
  | "expired"
  | "revoked"
  | "error";

export type WaConnectionMode = "sandbox" | "live";

export interface WaConnectionPublic {
  id: string;
  tenantId: string;
  branchId: string;
  provider: string;
  wabaId: string;
  phoneNumberId: string;
  businessId: string | null;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  tokenType: string;
  tokenExpiresAt: Date | null;
  scopes: string[];
  status: WaConnectionStatus;
  mode: WaConnectionMode;
  webhookSubscribed: boolean;
  connectedAt: Date;
  disconnectedAt: Date | null;
  lastSyncedAt: Date | null;
  lastError: string | null;
}

function toPublic(
  row: typeof waConnections.$inferSelect,
): WaConnectionPublic {
  return {
    id: row.id,
    tenantId: row.tenantId,
    branchId: row.branchId,
    provider: row.provider,
    wabaId: row.wabaId,
    phoneNumberId: row.phoneNumberId,
    businessId: row.businessId,
    displayPhoneNumber: row.displayPhoneNumber,
    verifiedName: row.verifiedName,
    tokenType: row.tokenType,
    tokenExpiresAt: row.tokenExpiresAt,
    scopes: row.scopes ? row.scopes.split(",").filter(Boolean) : [],
    status: (row.status as WaConnectionStatus) ?? "active",
    mode: (row.mode as WaConnectionMode) ?? "sandbox",
    webhookSubscribed: row.webhookSubscribed,
    connectedAt: row.connectedAt,
    disconnectedAt: row.disconnectedAt,
    lastSyncedAt: row.lastSyncedAt,
    lastError: row.lastError,
  };
}

// ─── Tenant-scoped reads (settings UI + send routes) ────────────────────

/** The single *active* connection for a (tenant, branch), if any. */
export async function getActiveConnection(
  tenantId: string,
  branchId: string,
): Promise<WaConnectionPublic | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(waConnections)
      .where(
        and(
          eq(waConnections.tenantId, tenantId),
          eq(waConnections.branchId, branchId),
          eq(waConnections.status, "active"),
        ),
      )
      .orderBy(desc(waConnections.connectedAt))
      .limit(1);
    return row ? toPublic(row) : null;
  });
}

/** Server-only: decrypt and return the access token for the active
 *  connection. Returns null if there's nothing to send through. */
export async function getActiveConnectionToken(
  tenantId: string,
  branchId: string,
): Promise<{
  conn: WaConnectionPublic;
  token: string;
} | null> {
  return withTenant(tenantId, async (tx) => {
    const [row] = await tx
      .select()
      .from(waConnections)
      .where(
        and(
          eq(waConnections.tenantId, tenantId),
          eq(waConnections.branchId, branchId),
          eq(waConnections.status, "active"),
        ),
      )
      .orderBy(desc(waConnections.connectedAt))
      .limit(1);
    if (!row) return null;
    return { conn: toPublic(row), token: decryptSecret(row.accessToken) };
  });
}

// ─── Mutations (OAuth callback + disconnect) ────────────────────────────

export interface UpsertConnectionInput {
  tenantId: string;
  branchId: string;
  connectedByUserId?: string;
  wabaId: string;
  phoneNumberId: string;
  businessId?: string;
  displayPhoneNumber?: string;
  verifiedName?: string;
  accessToken: string; // plaintext; this fn encrypts before insert
  tokenType?: "user" | "long_lived" | "system_user";
  tokenExpiresAt?: Date | null;
  scopes?: string[];
  mode?: WaConnectionMode;
  webhookSubscribed?: boolean;
  rawMetadata?: Record<string, unknown>;
}

/** Insert or replace the connection for a (tenant, branch, phone_number_id).
 *  The phone_number_id is globally unique on Meta's side — if another
 *  tenant somehow held the same id (number ported, etc.) we mark theirs
 *  disconnected and take it over. The previous active connection for the
 *  *same* (tenant, branch) is likewise marked disconnected so there's
 *  exactly one active row per (tenant, branch). */
export async function upsertConnection(
  input: UpsertConnectionInput,
): Promise<WaConnectionPublic> {
  return withTenant(input.tenantId, async (tx) => {
    // 1. Mark any previously-active connection for THIS (tenant, branch)
    //    as disconnected. Keeps the "one active per branch" invariant.
    await tx
      .update(waConnections)
      .set({
        status: "disconnected",
        disconnectedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(waConnections.tenantId, input.tenantId),
          eq(waConnections.branchId, input.branchId),
          eq(waConnections.status, "active"),
        ),
      );

    // 2. If this phone_number_id already belongs to a DIFFERENT
    //    (tenant, branch), we can't see those rows from inside
    //    withTenant (RLS blocks cross-tenant reads). Fall back to the
    //    admin handle for the deletion. This is rare but worth handling.
    //    (No-op when the id is fresh.)
    await db
      .update(waConnections)
      .set({
        status: "disconnected",
        disconnectedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(waConnections.phoneNumberId, input.phoneNumberId));

    // 3. Insert the new active row. Token is encrypted here.
    const [row] = await tx
      .insert(waConnections)
      .values({
        tenantId: input.tenantId,
        branchId: input.branchId,
        connectedByUserId: input.connectedByUserId ?? null,
        wabaId: input.wabaId,
        phoneNumberId: input.phoneNumberId,
        businessId: input.businessId ?? null,
        displayPhoneNumber: input.displayPhoneNumber ?? null,
        verifiedName: input.verifiedName ?? null,
        accessToken: encryptSecret(input.accessToken),
        tokenType: input.tokenType ?? "long_lived",
        tokenExpiresAt: input.tokenExpiresAt ?? null,
        scopes: input.scopes && input.scopes.length ? input.scopes.join(",") : null,
        status: "active",
        mode: input.mode ?? "sandbox",
        webhookSubscribed: input.webhookSubscribed ?? false,
        rawMetadata: input.rawMetadata ?? null,
        connectedAt: new Date(),
        lastSyncedAt: new Date(),
        updatedAt: new Date(),
      })
      .returning();
    return toPublic(row);
  });
}

/** Mark a connection disconnected. Does NOT delete the row — keeps the
 *  audit trail of past connections. */
export async function markDisconnected(
  tenantId: string,
  branchId: string,
  reason?: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(waConnections)
      .set({
        status: "disconnected",
        disconnectedAt: new Date(),
        lastError: reason ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(waConnections.tenantId, tenantId),
          eq(waConnections.branchId, branchId),
          eq(waConnections.status, "active"),
        ),
      );
  });
}

/** Update sync-only fields after a successful Graph refresh (e.g. token
 *  extended, phone metadata changed). Token is re-encrypted only if a
 *  new plaintext value is supplied. */
export async function refreshConnection(
  tenantId: string,
  connectionId: string,
  patch: {
    accessToken?: string;
    tokenType?: string;
    tokenExpiresAt?: Date | null;
    mode?: WaConnectionMode;
    webhookSubscribed?: boolean;
    displayPhoneNumber?: string;
    verifiedName?: string;
    businessId?: string;
    rawMetadata?: Record<string, unknown>;
    lastError?: string | null;
  },
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const set: Record<string, unknown> = {
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    };
    if (patch.accessToken !== undefined)
      set.accessToken = encryptSecret(patch.accessToken);
    if (patch.tokenType !== undefined) set.tokenType = patch.tokenType;
    if (patch.tokenExpiresAt !== undefined)
      set.tokenExpiresAt = patch.tokenExpiresAt;
    if (patch.mode !== undefined) set.mode = patch.mode;
    if (patch.webhookSubscribed !== undefined)
      set.webhookSubscribed = patch.webhookSubscribed;
    if (patch.displayPhoneNumber !== undefined)
      set.displayPhoneNumber = patch.displayPhoneNumber;
    if (patch.verifiedName !== undefined) set.verifiedName = patch.verifiedName;
    if (patch.businessId !== undefined) set.businessId = patch.businessId;
    if (patch.rawMetadata !== undefined) set.rawMetadata = patch.rawMetadata;
    if (patch.lastError !== undefined) set.lastError = patch.lastError;

    await tx
      .update(waConnections)
      .set(set)
      .where(
        and(
          eq(waConnections.tenantId, tenantId),
          eq(waConnections.id, connectionId),
        ),
      );
  });
}

// ─── Webhook-side tenant resolution (raw db) ─────────────────────────────

/** Resolve which tenant owns a given phone_number_id. Used by the webhook
 *  handler in Phase 2 — webhooks arrive *outside* any tenant session, so
 *  we look up the row through the admin handle, then re-enter withTenant
 *  for any follow-up writes. Returns null when the number isn't ours. */
export async function getConnectionByPhoneNumberId(
  phoneNumberId: string,
): Promise<WaConnectionPublic | null> {
  const [row] = await db
    .select()
    .from(waConnections)
    .where(eq(waConnections.phoneNumberId, phoneNumberId))
    .limit(1);
  return row ? toPublic(row) : null;
}
