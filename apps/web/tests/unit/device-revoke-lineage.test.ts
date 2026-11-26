/**
 * HANDOFF §8 #2 — per-device revocation must reach the LIVE row.
 *
 * A device row's id rotates on every refresh (the old row is burnt with
 * revoked_reason='rotated' and a successor inserted under a new id, with
 * replaced_by_id pointing forward). The devices screen therefore very often
 * holds an id that is already dead by the time the user taps "sign out".
 * DELETE /api/v1/auth/devices?id= used to tombstone only that id — a 200 for
 * a row that was already revoked, while the successor kept refreshing.
 *
 * `revokeDeviceLineage` is the route's core. These run against the live test
 * DB (same harness as find-product-by-sku.test.ts): the lineage walk and the
 * install_id short-cut are SQL, and only a database can prove them.
 *
 * Needs DATABASE_URL to name a "test" database (skipped otherwise).
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { db } from "@/lib/db";
import { revokeDeviceLineage } from "@/lib/api/native-devices";
import { tenants, users } from "@/lib/db/schema";

const url = process.env.DATABASE_URL ?? "";
const hasTestDb = /test/i.test(url);

let userId: string;
let otherUserId: string;
let tenantId: string;

interface RowSpec {
  installId?: string | null;
  /** revoked_reason; null = live. */
  revoked?: string | null;
  replacedById?: string | null;
  owner?: string;
}

/** Insert one auth_devices row. Successors must exist before predecessors
 *  (replaced_by_id is a real FK), so lineages are built head-first. */
async function row(spec: RowSpec = {}): Promise<string> {
  const [r] = (await db.execute(sql`
    INSERT INTO auth_devices
      (user_id, tenant_id, refresh_token_hash, install_id, expires_at,
       revoked_at, revoked_reason, replaced_by_id)
    VALUES
      (${spec.owner ?? userId}, ${tenantId}, ${randomUUID()}, ${spec.installId ?? null},
       now() + interval '30 days',
       CASE WHEN ${spec.revoked ?? null}::text IS NULL THEN NULL ELSE now() END,
       ${spec.revoked ?? null}, ${spec.replacedById ?? null})
    RETURNING id
  `)) as unknown as Array<{ id: string }>;
  return r!.id;
}

async function state(id: string) {
  const [r] = (await db.execute(sql`
    SELECT revoked_at IS NOT NULL AS revoked, revoked_reason
      FROM auth_devices WHERE id = ${id}
  `)) as unknown as Array<{ revoked: boolean; revoked_reason: string | null }>;
  return [r!.revoked, r!.revoked_reason] as const;
}

beforeAll(async () => {
  if (!hasTestDb) return;
  const [u] = await db
    .insert(users)
    .values({ email: `dev-${Date.now()}@iso.test`, name: "Dev", passwordHash: "x" })
    .returning({ id: users.id });
  const [o] = await db
    .insert(users)
    .values({ email: `dev-o-${Date.now()}@iso.test`, name: "Other", passwordHash: "x" })
    .returning({ id: users.id });
  const [t] = await db
    .insert(tenants)
    .values({ name: "Dev", slug: `dev-${Math.random().toString(36).slice(2, 8)}` })
    .returning({ id: tenants.id });
  userId = u!.id;
  otherUserId = o!.id;
  tenantId = t!.id;
});

describe.skipIf(!hasTestDb)("revokeDeviceLineage", () => {
  it("rotated row + live successor: revoking the OLD id revokes the successor", async () => {
    const live = await row({ installId: "inst-a" });
    const old = await row({ installId: "inst-a", revoked: "rotated", replacedById: live });

    const res = await revokeDeviceLineage(userId, old);
    expect(res).toEqual({ kind: "revoked", ids: [live] });
    expect(await state(live)).toEqual([true, "user_revoked"]);
    // The rotated row keeps its own history.
    expect(await state(old)).toEqual([true, "rotated"]);
  });

  it("no install_id: walks replaced_by_id to the head of a multi-hop lineage", async () => {
    const head = await row();
    const mid = await row({ revoked: "rotated", replacedById: head });
    const first = await row({ revoked: "rotated", replacedById: mid });

    expect(await revokeDeviceLineage(userId, first)).toEqual({ kind: "revoked", ids: [head] });
    expect(await state(head)).toEqual([true, "user_revoked"]);
    expect(await state(mid)).toEqual([true, "rotated"]);
  });

  it("re-login on the same install (fresh lineage, no pointer) is still reached via install_id", async () => {
    const fresh = await row({ installId: "inst-b" });
    const stale = await row({ installId: "inst-b", revoked: "reinstall" });

    expect(await revokeDeviceLineage(userId, stale)).toEqual({ kind: "revoked", ids: [fresh] });
    expect(await state(fresh)).toEqual([true, "user_revoked"]);
  });

  it("a live id revokes itself; revoking it again is idempotent success", async () => {
    const id = await row({ installId: "inst-c" });
    expect(await revokeDeviceLineage(userId, id)).toEqual({ kind: "revoked", ids: [id] });
    expect(await state(id)).toEqual([true, "user_revoked"]);
    expect(await revokeDeviceLineage(userId, id)).toEqual({ kind: "already_revoked" });
    expect(await state(id)).toEqual([true, "user_revoked"]);
  });

  it("a rotated id whose whole lineage is dead is 'rotated' — re-list, do not trust the row", async () => {
    const head = await row({ installId: "inst-d", revoked: "user_revoked" });
    const old = await row({ installId: "inst-d", revoked: "rotated", replacedById: head });
    expect(await revokeDeviceLineage(userId, old)).toEqual({ kind: "rotated" });
  });

  it("never touches another user's lineage, even with a matching install_id", async () => {
    const theirs = await row({ installId: "inst-a", owner: otherUserId });
    const theirOld = await row({ installId: "inst-a", owner: otherUserId, revoked: "rotated", replacedById: theirs });

    expect(await revokeDeviceLineage(userId, theirOld)).toEqual({ kind: "not_found" });
    expect(await revokeDeviceLineage(userId, randomUUID())).toEqual({ kind: "not_found" });
    expect(await state(theirs)).toEqual([false, null]);
  });
});
