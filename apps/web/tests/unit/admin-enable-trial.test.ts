/**
 * Phase 3 — enableTrial end-to-end security + persistence test.
 *
 * Verifies against real Postgres:
 *   1. enableTrial on an existing subscription sets status='trialing' and
 *      trialEndsAt = now + N days (fresh — ignores the old end date).
 *   2. enableTrial on a missing subscription creates a fresh trialing row.
 *   3. Status transitions from 'cancelled' back to 'trialing' and clears
 *      cancelled_at.
 *   4. Audit row is written with action='tenant.enable_trial' and before/
 *      after payloads contain no secrets.
 *   5. Invalid day counts throw INVALID_DAYS (400) — upstream route
 *      translates to a 400 response.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { getAdminDb } from "@/lib/admin/db";

vi.mock("@/lib/auth", () => ({
  bustUserContextCache: vi.fn(async () => undefined),
}));

const { enableTrial, TenantActionError } = await import(
  "@/lib/admin/tenant-actions"
);

const PREFIX = "enable-trial-" + Math.random().toString(36).slice(2, 8);
let ADMIN_ID = "";
let TENANT_WITH_SUB = "";
let TENANT_WITHOUT_SUB = "";

async function row<T>(q: Promise<unknown>): Promise<T | undefined> {
  const r = (await q) as unknown;
  const arr = Array.isArray(r)
    ? (r as T[])
    : ((r as { rows?: T[] }).rows ?? []);
  return arr[0];
}

beforeAll(async () => {
  const db = getAdminDb();
  const admin = await row<{ id: string }>(db.execute(sql`
    INSERT INTO admins (email, password_hash, display_name, role, must_rotate)
    VALUES (${PREFIX + "@parity.test"}, 'xx', 'Parity', 'super_admin', false)
    RETURNING id::text AS id
  `));
  ADMIN_ID = admin!.id;

  const t1 = await row<{ id: string }>(db.execute(sql`
    INSERT INTO tenants (name, slug) VALUES (${"T1 " + PREFIX}, ${PREFIX + "-1"})
    RETURNING id::text AS id
  `));
  TENANT_WITH_SUB = t1!.id;
  // Create a "cancelled" subscription to prove the status flip happens.
  const pastEnd = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  await db.execute(sql`
    INSERT INTO subscriptions (tenant_id, plan, status, trial_ends_at, cancelled_at)
    VALUES (${TENANT_WITH_SUB}, 'trial', 'cancelled', ${pastEnd.toISOString()}, now())
  `);

  const t2 = await row<{ id: string }>(db.execute(sql`
    INSERT INTO tenants (name, slug) VALUES (${"T2 " + PREFIX}, ${PREFIX + "-2"})
    RETURNING id::text AS id
  `));
  TENANT_WITHOUT_SUB = t2!.id;
  // Deliberately NO subscription row.
}, 20_000);

afterAll(async () => {
  const db = getAdminDb();
  await db.execute(sql`DELETE FROM tenants WHERE id IN (${TENANT_WITH_SUB}, ${TENANT_WITHOUT_SUB})`);
  await db.execute(sql`DELETE FROM admins WHERE id = ${ADMIN_ID}`);
}, 10_000);

describe("enableTrial", () => {
  it("flips a cancelled subscription back to trialing and clears cancelled_at", async () => {
    const result = await enableTrial(ADMIN_ID, TENANT_WITH_SUB, 14, {
      ip: "127.0.0.1",
      userAgent: "test",
    });
    expect(result.created).toBe(false);

    const db = getAdminDb();
    const r = await row<{
      status: string;
      trial_ends_at: string;
      cancelled_at: string | null;
    }>(db.execute(sql`
      SELECT status, trial_ends_at, cancelled_at
      FROM subscriptions WHERE tenant_id = ${TENANT_WITH_SUB}
    `));
    expect(r!.status).toBe("trialing");
    expect(r!.cancelled_at).toBeNull();
    const endTime = new Date(r!.trial_ends_at).getTime();
    const expected = Date.now() + 14 * 24 * 60 * 60 * 1000;
    // Within 10 seconds of expected.
    expect(Math.abs(endTime - expected)).toBeLessThan(10_000);
  }, 20_000);

  it("creates a fresh trialing subscription when none exists", async () => {
    const result = await enableTrial(ADMIN_ID, TENANT_WITHOUT_SUB, 7, {
      ip: "127.0.0.1",
      userAgent: "test",
    });
    expect(result.created).toBe(true);

    const db = getAdminDb();
    const r = await row<{ status: string; plan: string; trial_ends_at: string }>(
      db.execute(sql`
        SELECT status, plan, trial_ends_at
        FROM subscriptions WHERE tenant_id = ${TENANT_WITHOUT_SUB}
      `),
    );
    expect(r!.status).toBe("trialing");
    expect(r!.plan).toBe("trial");
    const endTime = new Date(r!.trial_ends_at).getTime();
    expect(Math.abs(endTime - (Date.now() + 7 * 86400_000))).toBeLessThan(10_000);
  }, 20_000);

  it("writes an audit row with no secrets", async () => {
    const db = getAdminDb();
    const audit = await row<{
      action: string;
      target_kind: string;
      before_jsonb: Record<string, unknown>;
      after_jsonb: Record<string, unknown>;
    }>(db.execute(sql`
      SELECT action, target_kind, before_jsonb, after_jsonb
      FROM admin_audit_log
      WHERE admin_id = ${ADMIN_ID} AND action = 'tenant.enable_trial'
      ORDER BY occurred_at DESC LIMIT 1
    `));
    expect(audit!.action).toBe("tenant.enable_trial");
    expect(audit!.target_kind).toBe("tenant");
    const asText =
      JSON.stringify(audit!.before_jsonb) + JSON.stringify(audit!.after_jsonb);
    expect(asText).not.toMatch(/password|hash|token|secret/i);
  }, 10_000);

  it("rejects day counts outside 1..90 with INVALID_DAYS", async () => {
    await expect(
      enableTrial(ADMIN_ID, TENANT_WITH_SUB, 0, { ip: null, userAgent: null }),
    ).rejects.toMatchObject({
      code: "INVALID_DAYS",
      status: 400,
    });
    await expect(
      enableTrial(ADMIN_ID, TENANT_WITH_SUB, 91, { ip: null, userAgent: null }),
    ).rejects.toMatchObject({
      code: "INVALID_DAYS",
      status: 400,
    });
    // Sanity — TenantActionError is what we expect, not a raw JS Error.
    try {
      await enableTrial(ADMIN_ID, TENANT_WITH_SUB, 0, {
        ip: null,
        userAgent: null,
      });
    } catch (err) {
      expect(err).toBeInstanceOf(TenantActionError);
    }
  }, 10_000);
});
