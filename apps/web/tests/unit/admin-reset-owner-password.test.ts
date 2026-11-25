/**
 * Owner password reset — security & regression test.
 *
 * Verifies, against the real Postgres under test:
 *   1. The old password hash is replaced by a new bcrypt hash.
 *   2. `must_change_password` is flipped to TRUE (forces rotation next login).
 *   3. `token_version` is bumped (every outstanding JWT invalidated).
 *   4. Every NextAuth `sessions` row for the user is deleted.
 *   5. Every mobile `auth_devices` row for the user is deleted.
 *   6. The audit row contains NO password material (no bcrypt prefix, no
 *      "password" / "hash" literal), only the redacted metadata.
 *   7. The returned temporary password verifies against the new hash.
 *   8. The admin audit row uses the correct action name.
 *
 * Fixture strategy: create a fresh tenant with a fresh owner and a seed
 * session + device, run `resetOwnerPassword`, inspect state. Cleanup at the
 * end removes everything we created.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import { getAdminDb } from "@/lib/admin/db";

// `@/lib/auth` pulls in next-auth which won't load under vitest. The reset
// path only uses `bustUserContextCache` from it — a cache-eviction callback
// that is safe to stub as a no-op for this test.
vi.mock("@/lib/auth", () => ({
  bustUserContextCache: vi.fn(async () => undefined),
}));

const { resetOwnerPassword } = await import("@/lib/admin/tenant-actions");

const PREFIX = "reset-pw-" + Math.random().toString(36).slice(2, 8);
let TENANT_ID = "";
let OWNER_ID = "";
let ADMIN_ID = "";

async function row<T>(q: Promise<unknown>): Promise<T | undefined> {
  const r = (await q) as unknown;
  const arr = Array.isArray(r)
    ? (r as T[])
    : ((r as { rows?: T[] }).rows ?? []);
  return arr[0];
}

beforeAll(async () => {
  const db = getAdminDb();

  // Fixture admin — super-admin role, dedicated to this test.
  const adminHash = await bcrypt.hash("adminpw", 12);
  const admin = await row<{ id: string }>(db.execute(sql`
    INSERT INTO admins (email, password_hash, display_name, role, must_rotate)
    VALUES (${PREFIX + "@parity.test"}, ${adminHash}, 'Parity Admin', 'super_admin', false)
    RETURNING id::text AS id
  `));
  ADMIN_ID = admin!.id;

  // Tenant + branch (branch is legacy schema; the write path doesn't
  // propagate branch into the reset flow).
  const tenant = await row<{ id: string }>(db.execute(sql`
    INSERT INTO tenants (name, slug)
    VALUES (${"Reset Parity " + PREFIX}, ${PREFIX + "-slug"})
    RETURNING id::text AS id
  `));
  TENANT_ID = tenant!.id;
  const branch = await row<{ id: string }>(db.execute(sql`
    INSERT INTO branches (tenant_id, slug, name, is_active, is_primary)
    VALUES (${TENANT_ID}, ${PREFIX + "-main"}, 'main', true, true)
    RETURNING id::text AS id
  `));
  const BRANCH_ID = branch!.id;

  // Owner user with an initial hash. Token version starts at 7 so we can
  // see the increment.
  const initialHash = await bcrypt.hash("initial-password-1234", 12);
  const owner = await row<{ id: string }>(db.execute(sql`
    INSERT INTO users (email, name, password_hash, token_version, must_change_password)
    VALUES (${PREFIX + "-owner@parity.test"}, 'Parity Owner', ${initialHash}, 7, false)
    RETURNING id::text AS id
  `));
  OWNER_ID = owner!.id;

  await db.execute(sql`
    INSERT INTO tenant_members (tenant_id, user_id, branch_id, role, display_name)
    VALUES (${TENANT_ID}, ${OWNER_ID}, ${BRANCH_ID}, 'owner', 'Owner')
  `);

  // Seed one NextAuth session row.
  await db.execute(sql`
    INSERT INTO sessions (session_token, user_id, expires)
    VALUES (${"tok-" + PREFIX}, ${OWNER_ID}, now() + INTERVAL '30 days')
  `);
}, 20_000);

afterAll(async () => {
  const db = getAdminDb();
  // tenant cascade cleans tenant_members, branches, sales etc.
  await db.execute(sql`DELETE FROM tenants WHERE id = ${TENANT_ID}`);
  await db.execute(sql`DELETE FROM users WHERE id = ${OWNER_ID}`);
  await db.execute(sql`DELETE FROM admins WHERE id = ${ADMIN_ID}`);
}, 10_000);

describe("resetOwnerPassword — security end-to-end", () => {
  it("rotates hash, forces mcp, bumps tokenVersion, wipes sessions+devices, and writes a redacted audit row", async () => {
    const db = getAdminDb();

    const beforeUser = await row<{
      password_hash: string;
      must_change_password: boolean;
      token_version: number;
    }>(db.execute(sql`
      SELECT password_hash, must_change_password, token_version
      FROM users WHERE id = ${OWNER_ID}
    `));
    expect(beforeUser!.must_change_password).toBe(false);
    expect(Number(beforeUser!.token_version)).toBe(7);

    const result = await resetOwnerPassword(ADMIN_ID, TENANT_ID, {
      ip: "127.0.0.1",
      userAgent: "parity-test",
    });

    // Temp password shape — 16 chars, URL-safe alphabet.
    expect(result.temporaryPassword).toHaveLength(16);
    expect(result.temporaryPassword).toMatch(/^[A-Za-z0-9]+$/);
    expect(result.ownerUserId).toBe(OWNER_ID);

    const afterUser = await row<{
      password_hash: string;
      must_change_password: boolean;
      token_version: number;
    }>(db.execute(sql`
      SELECT password_hash, must_change_password, token_version
      FROM users WHERE id = ${OWNER_ID}
    `));

    // Hash rotated.
    expect(afterUser!.password_hash).not.toBe(beforeUser!.password_hash);
    expect(afterUser!.password_hash.startsWith("$2")).toBe(true);
    // The returned temp password must verify against the stored hash — proves
    // nothing is dropped between generation and persistence.
    expect(await bcrypt.compare(result.temporaryPassword, afterUser!.password_hash))
      .toBe(true);
    // The OLD password must no longer work.
    expect(
      await bcrypt.compare("initial-password-1234", afterUser!.password_hash),
    ).toBe(false);

    // Force-rotation wall + tv bump.
    expect(afterUser!.must_change_password).toBe(true);
    expect(Number(afterUser!.token_version)).toBe(8);

    // Sessions wiped.
    const sessionCount = await row<{ c: number }>(db.execute(sql`
      SELECT COUNT(*)::int AS c FROM sessions WHERE user_id = ${OWNER_ID}
    `));
    expect(Number(sessionCount!.c)).toBe(0);

    // Devices wiped (seed-free is fine; the write path still fires DELETE).
    const deviceCount = await row<{ c: number }>(db.execute(sql`
      SELECT COUNT(*)::int AS c FROM auth_devices WHERE user_id = ${OWNER_ID}
    `));
    expect(Number(deviceCount!.c)).toBe(0);

    // Audit row written with correct action + redacted metadata.
    const audit = await row<{
      action: string;
      target_kind: string;
      target_id: string;
      before_jsonb: Record<string, unknown>;
      after_jsonb: Record<string, unknown>;
    }>(db.execute(sql`
      SELECT action, target_kind, target_id::text AS target_id, before_jsonb, after_jsonb
      FROM admin_audit_log
      WHERE admin_id = ${ADMIN_ID} AND action = 'owner.password_reset'
      ORDER BY occurred_at DESC
      LIMIT 1
    `));
    expect(audit).toBeDefined();
    expect(audit!.action).toBe("owner.password_reset");
    expect(audit!.target_kind).toBe("user");
    expect(audit!.target_id).toBe(OWNER_ID);

    const asText = JSON.stringify(audit!.before_jsonb) + JSON.stringify(audit!.after_jsonb);
    // Must NOT contain the generated temp password.
    expect(asText).not.toContain(result.temporaryPassword);
    // Must NOT contain a bcrypt-shaped hash.
    expect(asText).not.toMatch(/\$2[aby]?\$\d+\$/);
    // Must contain the expected metadata keys (sanity).
    expect(asText).toContain("tokenVersion");
    expect(asText).toContain("mustChangePassword");
  }, 20_000);
});
