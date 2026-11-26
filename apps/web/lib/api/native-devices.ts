import "server-only";

import { sql } from "drizzle-orm";

import { db } from "@/lib/db";

// Per-device revocation (HANDOFF §8 #2) — the core of
// DELETE /api/v1/auth/devices. Its own module, with no Auth.js import, so
// tests/unit/device-revoke-lineage.test.ts can load it under vitest the way
// native-token.ts already is.

export type RevokeDeviceResult =
  /** At least one live row of the lineage was tombstoned just now. */
  | { kind: "revoked"; ids: string[] }
  /** The tapped row was already revoked by something other than rotation
   *  (the user, a logout, a reinstall). Nothing to do; idempotent success. */
  | { kind: "already_revoked" }
  /** The tapped row had rotated and its whole lineage is already dead — the
   *  caller's list is stale and should be refreshed. */
  | { kind: "rotated" }
  /** No row with that id belongs to this user. */
  | { kind: "not_found" };

/**
 * Revoke a device by the id the user tapped — and, crucially, the LIVE row
 * of that device's lineage, which is rarely the same row.
 *
 * A device row's id is not stable: every refresh (≤15-min cadence) burns the
 * row with revoked_reason='rotated' and inserts a successor under a new id.
 * Tombstoning only the tapped id therefore raced the device's own refresh:
 * the UPDATE matched the already-rotated row, reported success, and the live
 * successor kept refreshing — the lost-handset case this endpoint exists for.
 *
 * Two ways to reach the live head, both in one statement:
 *   - `install_id`: auth_devices_user_install_live_idx (0046) guarantees one
 *     live row per (user_id, install_id), so a match on the tapped row's
 *     install_id IS the head — and also covers a re-login on the same
 *     install, which starts a fresh lineage with no replaced_by_id link.
 *   - `replaced_by_id`: for rows with no install_id (older clients), walk the
 *     rotation pointers to the newest row. UNION (not UNION ALL) so a cycle,
 *     which the writer never creates, would still terminate.
 *
 * Scoped by user_id throughout, so an id belonging to anyone else matches
 * nothing and reads as not found — the same answer a made-up id gets.
 */
export async function revokeDeviceLineage(
  userId: string,
  deviceId: string,
): Promise<RevokeDeviceResult> {
  const revoked = (await db.execute(sql`
    WITH RECURSIVE tapped AS (
      SELECT id, install_id
        FROM auth_devices
       WHERE id = ${deviceId} AND user_id = ${userId}
    ),
    lineage AS (
      SELECT id, replaced_by_id FROM auth_devices
       WHERE id = ${deviceId} AND user_id = ${userId}
      UNION
      SELECT d.id, d.replaced_by_id
        FROM auth_devices d
        JOIN lineage l ON d.id = l.replaced_by_id
       WHERE d.user_id = ${userId}
    )
    UPDATE auth_devices
       SET revoked_at     = now(),
           revoked_reason = 'user_revoked'
     WHERE user_id = ${userId}
       AND revoked_at IS NULL
       AND (
             id = ${deviceId}
          OR install_id = (SELECT install_id FROM tapped WHERE install_id IS NOT NULL)
          OR id IN (SELECT id FROM lineage)
       )
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  if (revoked.length > 0) return { kind: "revoked", ids: revoked.map((r) => r.id) };

  const [row] = (await db.execute(sql`
    SELECT revoked_reason
      FROM auth_devices
     WHERE id = ${deviceId} AND user_id = ${userId}
  `)) as unknown as Array<{ revoked_reason: string | null }>;
  if (!row) return { kind: "not_found" };
  return row.revoked_reason === "rotated" ? { kind: "rotated" } : { kind: "already_revoked" };
}
