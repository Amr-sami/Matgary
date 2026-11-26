/**
 * Phase 2 — heartbeat write-throttle contract.
 *
 * `touchHeartbeat()` must not write the DB every time it's called. The
 * throttle is enforced inside the SQL (not in-memory) so correctness holds
 * across multiple Next.js process replicas. We verify the contract by
 * calling touchHeartbeat() twice in rapid succession and asserting the
 * second call left the timestamp unchanged.
 *
 * Fixtures: a disposable tenant + user + auth_devices row. Cleaned up
 * after the suite.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getAdminDb } from "@/lib/admin/db";

const PREFIX = "presence-throttle-" + Math.random().toString(36).slice(2, 8);
let TENANT_ID = "";
let USER_ID = "";
let DEVICE_ID = "";

async function row<T>(q: Promise<unknown>): Promise<T | undefined> {
  const r = (await q) as unknown;
  const arr = Array.isArray(r)
    ? (r as T[])
    : ((r as { rows?: T[] }).rows ?? []);
  return arr[0];
}

beforeAll(async () => {
  const db = getAdminDb();
  const tenant = await row<{ id: string }>(db.execute(sql`
    INSERT INTO tenants (name, slug) VALUES (${"T " + PREFIX}, ${PREFIX + "-s"})
    RETURNING id::text AS id
  `));
  TENANT_ID = tenant!.id;
  const user = await row<{ id: string }>(db.execute(sql`
    INSERT INTO users (email) VALUES (${PREFIX + "@parity.test"})
    RETURNING id::text AS id
  `));
  USER_ID = user!.id;
  // Device row — the UPDATE target. refresh_token_hash is unique-indexed, so
  // generate a deterministic value from the prefix.
  const device = await row<{ id: string }>(db.execute(sql`
    INSERT INTO auth_devices (user_id, tenant_id, refresh_token_hash, platform, app_version, expires_at)
    VALUES (
      ${USER_ID}, ${TENANT_ID}, ${PREFIX + "-hash"}, 'ios', '1.0.0',
      now() + INTERVAL '30 days'
    )
    RETURNING id::text AS id
  `));
  DEVICE_ID = device!.id;
}, 20_000);

afterAll(async () => {
  const db = getAdminDb();
  await db.execute(sql`DELETE FROM tenants WHERE id = ${TENANT_ID}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${USER_ID}`);
}, 10_000);

describe("touchHeartbeat — SQL-level throttle", () => {
  it("writes on first call (last_used_at was NULL)", async () => {
    const { touchHeartbeat } = await import("@/lib/admin/presence");
    await touchHeartbeat(USER_ID, TENANT_ID, {
      kind: "bearer",
      deviceId: DEVICE_ID,
    });
    const db = getAdminDb();
    const r = await row<{ last_used_at: string | null }>(db.execute(sql`
      SELECT last_used_at FROM auth_devices WHERE id = ${DEVICE_ID}
    `));
    expect(r?.last_used_at).not.toBeNull();
  }, 20_000);

  it("skips the second write when called again within 60 s (throttle)", async () => {
    const { touchHeartbeat } = await import("@/lib/admin/presence");
    const db = getAdminDb();
    const before = await row<{ last_used_at: string | null }>(db.execute(sql`
      SELECT last_used_at FROM auth_devices WHERE id = ${DEVICE_ID}
    `));
    // Immediately beat again — the SQL's "AND last_used_at < now() - 60s"
    // predicate should reject the UPDATE.
    await touchHeartbeat(USER_ID, TENANT_ID, {
      kind: "bearer",
      deviceId: DEVICE_ID,
    });
    const after = await row<{ last_used_at: string | null }>(db.execute(sql`
      SELECT last_used_at FROM auth_devices WHERE id = ${DEVICE_ID}
    `));
    expect(after?.last_used_at).toBe(before?.last_used_at);
  }, 20_000);

  it("allows the write once >60 s has passed — simulated by pushing last_used_at back", async () => {
    const { touchHeartbeat } = await import("@/lib/admin/presence");
    const db = getAdminDb();
    await db.execute(sql`
      UPDATE auth_devices SET last_used_at = now() - INTERVAL '120 seconds'
      WHERE id = ${DEVICE_ID}
    `);
    const before = await row<{ last_used_at: string | null }>(db.execute(sql`
      SELECT last_used_at FROM auth_devices WHERE id = ${DEVICE_ID}
    `));
    await touchHeartbeat(USER_ID, TENANT_ID, {
      kind: "bearer",
      deviceId: DEVICE_ID,
    });
    const after = await row<{ last_used_at: string | null }>(db.execute(sql`
      SELECT last_used_at FROM auth_devices WHERE id = ${DEVICE_ID}
    `));
    expect(after?.last_used_at).not.toBe(before?.last_used_at);
  }, 20_000);

  it("never trusts a client-supplied device_id — mismatched user_id is a no-op", async () => {
    const { touchHeartbeat } = await import("@/lib/admin/presence");
    const db = getAdminDb();
    await db.execute(sql`
      UPDATE auth_devices SET last_used_at = now() - INTERVAL '120 seconds'
      WHERE id = ${DEVICE_ID}
    `);
    const before = await row<{ last_used_at: string | null }>(db.execute(sql`
      SELECT last_used_at FROM auth_devices WHERE id = ${DEVICE_ID}
    `));
    // Pass a completely wrong user_id — the WHERE clause filters on BOTH
    // deviceId AND userId so the UPDATE must match zero rows.
    await touchHeartbeat(
      "00000000-0000-0000-0000-000000000000",
      TENANT_ID,
      { kind: "bearer", deviceId: DEVICE_ID },
    );
    const after = await row<{ last_used_at: string | null }>(db.execute(sql`
      SELECT last_used_at FROM auth_devices WHERE id = ${DEVICE_ID}
    `));
    expect(after?.last_used_at).toBe(before?.last_used_at);
  }, 20_000);
});
