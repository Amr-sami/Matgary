// Token registration — the write half of POST /api/v1/devices/push-token,
// kept out of the route so the cross-tenant re-own path has a unit test.
//
// Path 1 (the norm): an RLS-respecting upsert. Covers "same user again"
// (bump last_seen_at, un-disable) and "same tenant, different user" (re-own).
// Path 2 (rare): the token's current row belongs to a DIFFERENT tenant — same
// phone, another shop — which RLS hides from us, so the upsert raises on the
// unique index. Re-own it through the one SECURITY DEFINER function the
// migration ships for exactly this. Either way `deviceName` is COALESCEd: a
// re-register that omits it (token rotation, app update — §8.5) keeps the
// stored label instead of wiping it.

import { sql } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { pushTokens } from "@/lib/db/schema";
import { logger } from "@/lib/logger";

export interface RegisterPushTokenInput {
  token: string;
  platform: "ios" | "android";
  deviceName?: string | null;
}

/** Returns whether the cross-tenant re-own path was taken. */
export async function registerPushToken(
  tenantId: string,
  userId: string,
  input: RegisterPushTokenInput,
): Promise<{ reowned: boolean }> {
  const { token, platform } = input;
  const deviceName = input.deviceName ?? null;
  let reowned = false;
  try {
    await withTenant(tenantId, async (tx) => {
      await tx
        .insert(pushTokens)
        .values({
          tenantId,
          userId,
          expoToken: token,
          platform,
          deviceName,
          lastSeenAt: new Date(),
          disabledAt: null,
        })
        .onConflictDoUpdate({
          target: pushTokens.expoToken,
          set: {
            tenantId,
            userId,
            platform,
            deviceName: sql`coalesce(excluded.device_name, ${pushTokens.deviceName})`,
            lastSeenAt: new Date(),
            disabledAt: null,
          },
        });
    });
  } catch (err) {
    if (!isCrossTenantConflict(err)) throw err;
    await withTenant(tenantId, async (tx) => {
      await tx.execute(
        sql`select push_token_reown(${token}, ${tenantId}::uuid, ${userId}::uuid, ${platform}, ${deviceName})`,
      );
    });
    reowned = true;
  }
  logger.info({ event: "push.token_registered", tenantId, userId, platform, reowned });
  return { reowned };
}

/** Postgres surfaces the hidden-row conflict either as a unique violation
 *  (23505 — the index sees the row, the policy does not) or as an RLS
 *  violation (42501) when ON CONFLICT reaches the update path. */
export function isCrossTenantConflict(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  const code = e?.code ?? e?.cause?.code;
  return code === "23505" || code === "42501";
}
