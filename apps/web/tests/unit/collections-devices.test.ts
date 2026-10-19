/**
 * Doc 15 spec 07 §7 — lib/repo/collection-devices.ts (+ the user-removal hook
 * in lib/repo/team.ts). DB-backed parts skip unless DATABASE_URL names a
 * `test` database; `deviceHealth` and the config-field env mapping are pure.
 *
 * Covers acceptance 19 (revoke deletes raw rows; staff removal revokes
 * `user_removed`), 20 (10 live max; replay before first use rotates the
 * token; no plaintext token in the replay entry), 28 (revoke reasons) and 29
 * (health order), plus create validation and the config version.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isDomainError } from "@/lib/errors";
import { hashIngestToken } from "@/lib/api/ingest-token";
import { revokeReasonSchema } from "@/lib/collections/credit-schemas";
import {
  collectionsIngestConfigFields,
  createIngestDevice,
  deviceHealth,
  HEARTBEAT_LATE_MIN,
  ingestConfigFor,
  listIngestDevices,
  MAX_LIVE_DEVICES,
  PLATFORM_CHANNELS,
  replayCreatedDevice,
  revokeIngestDevice,
  shortcutUrls,
  type DeviceHealthInput,
} from "@/lib/repo/collection-devices";
import { ingestMessages } from "@/lib/repo/collection-ingest";
import { removeTeamMember } from "@/lib/repo/team";
import {
  device,
  hasTestDb,
  msg,
  ownerDeviceActor,
  q,
  setupL2Tenant,
  walletAccount,
  type L2Fixture,
} from "./helpers/collections-l2-fixture";

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return isDomainError(err) ? `${err.httpStatus}:${err.code}` : String(err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure: deviceHealth (§4.11, acceptance 29)
// ─────────────────────────────────────────────────────────────────────────────

describe("deviceHealth(row, now) — the only health value, first match wins", () => {
  const now = new Date("2026-10-19T12:00:00.000Z");
  const minsAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
  const base = (o: Partial<DeviceHealthInput> = {}): DeviceHealthInput => ({
    platform: "android_listener",
    revokedAt: null,
    lastHeartbeat: { listenerConnected: true },
    silentAlertedAt: null,
    lastMessageAt: minsAgo(5),
    lastSeenAt: minsAgo(5),
    ...o,
  });

  it("returns each of the six states", () => {
    expect(deviceHealth(base({ revokedAt: minsAgo(1) }), now)).toBe("revoked");
    expect(deviceHealth(base({ lastHeartbeat: { listenerConnected: false } }), now)).toBe("listener_off");
    expect(deviceHealth(base({ silentAlertedAt: minsAgo(1), lastMessageAt: minsAgo(600) }), now)).toBe("silent");
    expect(deviceHealth(base({ lastSeenAt: minsAgo(HEARTBEAT_LATE_MIN + 1) }), now)).toBe("heartbeat_late");
    expect(deviceHealth(base({ lastMessageAt: null }), now)).toBe("never_seen");
    expect(deviceHealth(base(), now)).toBe("ok");
  });

  it("honours the order: revoked › listener_off › silent › heartbeat_late › never_seen", () => {
    expect(deviceHealth(base({ revokedAt: minsAgo(1), lastHeartbeat: { listenerConnected: false } }), now)).toBe("revoked");
    // listener off beats silent and heartbeat_late
    expect(
      deviceHealth(
        base({ lastHeartbeat: { listenerConnected: false }, silentAlertedAt: minsAgo(1), lastMessageAt: null, lastSeenAt: minsAgo(120) }),
        now,
      ),
    ).toBe("listener_off");
    // silent beats a late heartbeat
    expect(deviceHealth(base({ silentAlertedAt: minsAgo(1), lastMessageAt: minsAgo(600), lastSeenAt: minsAgo(120) }), now)).toBe("silent");
    // heartbeat_late beats never_seen
    expect(deviceHealth(base({ lastMessageAt: null, lastSeenAt: minsAgo(46) }), now)).toBe("heartbeat_late");
  });

  it("a heartbeat without any message is never_seen; a NULL last_seen_at is not heartbeat_late", () => {
    expect(deviceHealth(base({ lastMessageAt: null, lastSeenAt: minsAgo(2) }), now)).toBe("never_seen");
    expect(deviceHealth(base({ lastMessageAt: null, lastSeenAt: null }), now)).toBe("never_seen");
    expect(deviceHealth(base({ lastSeenAt: null }), now)).toBe("ok");
  });

  it("heartbeat_late and listener_off are android_listener only", () => {
    expect(deviceHealth(base({ platform: "ios_shortcut", lastSeenAt: minsAgo(600) }), now)).toBe("ok");
    expect(deviceHealth(base({ platform: "ios_shortcut", lastHeartbeat: { listenerConnected: false } }), now)).toBe("ok");
  });

  it("silent clears once a message arrives after the alert", () => {
    expect(deviceHealth(base({ silentAlertedAt: minsAgo(10), lastMessageAt: minsAgo(1) }), now)).toBe("ok");
  });
});

describe("shortcutUrls — the four COLLECTIONS_IOS_*SHORTCUT_URL* (acceptance 22)", () => {
  const names = [
    "COLLECTIONS_IOS_SHORTCUT_URL",
    "COLLECTIONS_IOS_SHORTCUT_URL_LEGACY",
    "COLLECTIONS_IOS_INTENT_SHORTCUT_URL",
    "COLLECTIONS_IOS_INTENT_SHORTCUT_URL_LEGACY",
  ] as const;
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  afterAll(() => {
    for (const n of names) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  });

  it("set → value, empty / blank / unset → null", () => {
    process.env.COLLECTIONS_IOS_SHORTCUT_URL = "https://www.icloud.com/shortcuts/aaa";
    process.env.COLLECTIONS_IOS_SHORTCUT_URL_LEGACY = "";
    process.env.COLLECTIONS_IOS_INTENT_SHORTCUT_URL = "https://www.icloud.com/shortcuts/devtest";
    process.env.COLLECTIONS_IOS_INTENT_SHORTCUT_URL_LEGACY = "   ";
    expect(shortcutUrls()).toEqual({
      iosShortcutUrl: "https://www.icloud.com/shortcuts/aaa",
      iosShortcutUrlLegacy: null,
      iosIntentShortcutUrl: "https://www.icloud.com/shortcuts/devtest",
      iosIntentShortcutUrlLegacy: null,
    });
    for (const n of names) delete process.env[n];
    expect(Object.values(shortcutUrls())).toEqual([null, null, null, null]);
  });
});

describe("revoke reasons from a request (acceptance 28)", () => {
  it("owner and replaced pass; security / user_removed / anything else are refused", () => {
    expect(revokeReasonSchema.safeParse("owner").success).toBe(true);
    expect(revokeReasonSchema.safeParse("replaced").success).toBe(true);
    for (const r of ["security", "user_removed", "", "OWNER"]) expect(revokeReasonSchema.safeParse(r).success).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DB
// ─────────────────────────────────────────────────────────────────────────────

let f: L2Fixture;
const savedEnv = { e: process.env.COLLECTIONS_ENABLED, i: process.env.COLLECTIONS_INGEST_ENABLED };

beforeAll(async () => {
  if (!hasTestDb) return;
  process.env.COLLECTIONS_ENABLED = "on";
  process.env.COLLECTIONS_INGEST_ENABLED = "on";
  f = await setupL2Tenant("dev");
});

afterAll(() => {
  if (savedEnv.e === undefined) delete process.env.COLLECTIONS_ENABLED;
  else process.env.COLLECTIONS_ENABLED = savedEnv.e;
  if (savedEnv.i === undefined) delete process.env.COLLECTIONS_INGEST_ENABLED;
  else process.env.COLLECTIONS_INGEST_ENABLED = savedEnv.i;
});

async function liveCount(): Promise<number> {
  const [r] = await q<{ n: number }>(f, sql`SELECT count(*)::int AS n FROM collection_ingest_devices WHERE tenant_id = ${f.tenantId} AND revoked_at IS NULL`);
  return Number(r!.n);
}

async function revokeAll(): Promise<void> {
  await q(f, sql`UPDATE collection_ingest_devices SET revoked_at = now(), revoked_reason = 'owner' WHERE tenant_id = ${f.tenantId} AND revoked_at IS NULL`);
}

describe.skipIf(!hasTestDb)("createIngestDevice — validation (§4.11)", () => {
  it("platform ↔ channels: an iOS shortcut cannot post android_notification; no channel at all is refused", async () => {
    expect(
      await codeOf(
        createIngestDevice(ownerDeviceActor(f), {
          label: "x",
          platform: "ios_shortcut",
          channels: ["android_notification"],
          consentVersion: "2026-10-01",
        }),
      ),
    ).toBe("400:INVALID_REQUEST");
    expect(
      await codeOf(createIngestDevice(ownerDeviceActor(f), { label: "x", platform: "android_listener", channels: [], consentVersion: "2026-10-01" })),
    ).toBe("400:INVALID_REQUEST");
    for (const [platform, chans] of Object.entries(PLATFORM_CHANNELS)) expect(chans.length, platform).toBeGreaterThan(0);
  });

  it("accounts must be the tenant's active ones → else 404 COLLECTION_ACCOUNT_NOT_FOUND", async () => {
    const acc = await walletAccount(f);
    const ok = await device(f, { accountIds: [acc.id] });
    expect(ok.ctx.accountIds).toEqual([acc.id]);
    expect(
      await codeOf(
        createIngestDevice(ownerDeviceActor(f), {
          label: "x",
          platform: "ios_shortcut",
          channels: ["ios_sms"],
          accountIds: ["99999999-9999-4999-8999-999999999999"],
          consentVersion: "2026-10-01",
        }),
      ),
    ).toBe("404:COLLECTION_ACCOUNT_NOT_FOUND");
    await revokeIngestDevice(ownerDeviceActor(f), ok.id);
  });

  it("a staff actor cannot pin a branch outside their allow-list → 403 FORBIDDEN_BRANCH", async () => {
    expect(
      await codeOf(
        createIngestDevice(
          { tenantId: f.tenantId, userId: f.managerId, isOwner: false, accessibleBranchIds: [f.branchId] },
          { label: "x", platform: "ios_shortcut", channels: ["ios_sms"], branchId: "99999999-9999-4999-8999-999999999999", consentVersion: "2026-10-01" },
        ),
      ),
    ).toBe("403:FORBIDDEN_BRANCH");
  });

  it("records the consent version / time / user; the DTO starts never_seen with the token prefix", async () => {
    const d = await device(f, { label: "Owner iPhone" });
    const [r] = await q<{ consent_version: string; consent_user_id: string; consent_at: string | null; token_hash: string; token_prefix: string }>(
      f,
      sql`SELECT consent_version, consent_user_id, consent_at, token_hash, token_prefix FROM collection_ingest_devices WHERE id = ${d.id}`,
    );
    expect(r).toMatchObject({ consent_version: "2026-10-01", consent_user_id: f.ownerId });
    expect(r!.consent_at).not.toBeNull();
    expect(r!.token_hash).toBe(hashIngestToken(d.token));
    expect(r!.token_prefix).toBe(d.token.slice(4, 12));
    const list = await listIngestDevices(f.tenantId);
    const dto = list.find((x) => x.id === d.id)!;
    expect(dto.health).toBe("never_seen");
    expect(dto.tokenPrefix).toBe(d.token.slice(4, 12));
    expect(JSON.stringify(list)).not.toContain(d.token);
    await revokeIngestDevice(ownerDeviceActor(f), d.id);
  });
});

describe.skipIf(!hasTestDb)("live-device limit and replacement (acceptance 20)", () => {
  it("the 11th live device → 409 DEVICE_LIMIT_REACHED; replacesDeviceId revokes with `replaced` and frees a slot", async () => {
    await revokeAll();
    const made: string[] = [];
    for (let i = 0; i < MAX_LIVE_DEVICES; i++) made.push((await device(f, { label: `d${i}` })).id);
    expect(await liveCount()).toBe(MAX_LIVE_DEVICES);
    expect(await codeOf(device(f, { label: "eleventh" }))).toBe("409:DEVICE_LIMIT_REACHED");

    const repl = await createIngestDevice(ownerDeviceActor(f), {
      label: "replacement",
      platform: "ios_shortcut",
      channels: ["ios_sms"],
      consentVersion: "2026-10-01",
      replacesDeviceId: made[0],
    });
    expect(repl.replacedDeviceId).toBe(made[0]);
    const [old] = await q<{ revoked_reason: string; revoked_at: string | null }>(
      f,
      sql`SELECT revoked_reason, revoked_at FROM collection_ingest_devices WHERE id = ${made[0]}`,
    );
    expect(old).toMatchObject({ revoked_reason: "replaced" });
    expect(await liveCount()).toBe(MAX_LIVE_DEVICES);
    await revokeAll();
  });
});

describe.skipIf(!hasTestDb)("idempotent create replay (§4.11, acceptance 20)", () => {
  it("before first use: re-mints the token for the same row (old hash refused); after use: token null", async () => {
    const d = await device(f, { label: "replay" });
    const oldHash = hashIngestToken(d.token);
    const again = await replayCreatedDevice(f.tenantId, d.id);
    expect(again?.device.id).toBe(d.id);
    expect(again?.token).toMatch(/^mgi_[A-Za-z0-9_-]{43}$/);
    expect(again?.token).not.toBe(d.token);
    const [r] = await q<{ token_hash: string }>(f, sql`SELECT token_hash FROM collection_ingest_devices WHERE id = ${d.id}`);
    expect(r!.token_hash).toBe(hashIngestToken(again!.token!));
    expect(r!.token_hash).not.toBe(oldHash);
    const [gone] = await q<{ n: number }>(f, sql`SELECT count(*)::int AS n FROM collection_ingest_devices WHERE token_hash = ${oldHash}`);
    expect(Number(gone!.n)).toBe(0);

    await q(f, sql`UPDATE collection_ingest_devices SET last_seen_at = now() WHERE id = ${d.id}`);
    const used = await replayCreatedDevice(f.tenantId, d.id);
    expect(used?.token).toBeNull();
    expect(used?.device.id).toBe(d.id);

    await revokeIngestDevice(ownerDeviceActor(f), d.id);
    expect(await replayCreatedDevice(f.tenantId, d.id)).toBeNull();
  });
});

describe.skipIf(!hasTestDb)("revoke (§4.4, acceptance 19, 28)", () => {
  it("deletes the device's raw rows in the same call; default reason owner; a second revoke keeps the reason", async () => {
    const d = await device(f, { label: "to revoke" });
    const out = await ingestMessages(d.ctx, [msg("رسالة غير معروفة تم استلام مبلغ ما بدون تفاصيل")]);
    expect(out.results[0]!.status).not.toBe("dropped");
    const [before] = await q<{ n: number }>(f, sql`SELECT count(*)::int AS n FROM collection_raw_messages WHERE ingest_device_id = ${d.id}`);
    expect(Number(before!.n)).toBeGreaterThan(0);

    const rv = await revokeIngestDevice(ownerDeviceActor(f), d.id);
    expect(rv.already).toBe(false);
    expect(rv.device.revokedReason).toBe("owner");
    expect(rv.device.health).toBe("revoked");
    const [after] = await q<{ n: number }>(f, sql`SELECT count(*)::int AS n FROM collection_raw_messages WHERE ingest_device_id = ${d.id}`);
    expect(Number(after!.n)).toBe(0);

    const twice = await revokeIngestDevice(ownerDeviceActor(f), d.id, "replaced");
    expect(twice.already).toBe(true);
    expect(twice.device.revokedReason).toBe("owner");
    expect(twice.revokedAt).toBe(rv.revokedAt);
  });

  it("`replaced` is stored when asked; an unknown device → 404 DEVICE_NOT_FOUND", async () => {
    const d = await device(f, { label: "replace me" });
    const rv = await revokeIngestDevice(ownerDeviceActor(f), d.id, "replaced");
    expect(rv.device.revokedReason).toBe("replaced");
    expect(await codeOf(revokeIngestDevice(ownerDeviceActor(f), "99999999-9999-4999-8999-999999999999"))).toBe("404:DEVICE_NOT_FOUND");
  });
});

describe.skipIf(!hasTestDb)("user removal (§4.11, acceptance 19)", () => {
  it("removeTeamMember revokes every live device the member created with user_removed and purges their raw rows", async () => {
    // A throw-away staff member registers a device.
    const [u] = await q<{ id: string }>(
      f,
      sql`INSERT INTO users (email, name, password_hash) VALUES (${`dc07-rm-${Date.now()}@iso.test`}, 'DC07 rm', 'x') RETURNING id`,
    );
    await q(
      f,
      sql`INSERT INTO tenant_members (tenant_id, user_id, role, permissions, branch_ids)
          VALUES (${f.tenantId}, ${u!.id}, 'staff', ARRAY['manage_collection_accounts']::text[], ARRAY[${f.branchId}]::uuid[])`,
    );
    const created = await createIngestDevice(
      { tenantId: f.tenantId, userId: u!.id, isOwner: false, accessibleBranchIds: [f.branchId] },
      { label: "staff phone", platform: "ios_shortcut", channels: ["ios_sms"], consentVersion: "2026-10-01" },
    );
    const ctx = {
      deviceId: created.device.id,
      tenantId: f.tenantId,
      branchId: null,
      platform: "ios_shortcut" as const,
      channels: ["ios_sms" as const],
      accountIds: [],
      createdByUserId: u!.id,
      consentVersion: "2026-10-01",
      label: "staff phone",
    };
    await ingestMessages(ctx, [msg("رسالة غير معروفة تم استلام مبلغ ما")]);

    await removeTeamMember(f.tenantId, u!.id);
    const [r] = await q<{ revoked_reason: string | null; revoked_at: string | null }>(
      f,
      sql`SELECT revoked_reason, revoked_at FROM collection_ingest_devices WHERE id = ${created.device.id}`,
    );
    expect(r!.revoked_reason).toBe("user_removed");
    expect(r!.revoked_at).not.toBeNull();
    const [raw] = await q<{ n: number }>(f, sql`SELECT count(*)::int AS n FROM collection_raw_messages WHERE ingest_device_id = ${created.device.id}`);
    expect(Number(raw!.n)).toBe(0);
  });
});

describe.skipIf(!hasTestDb)("config (§4.8)", () => {
  it("configVersion is stable across calls and changes when an account of a new provider is added", async () => {
    const d = await device(f, { label: "config" });
    const a = await ingestConfigFor(d.ctx);
    const b = await ingestConfigFor(d.ctx);
    expect(a.configVersion).toMatch(/^[0-9a-f]{16}$/);
    expect(b.configVersion).toBe(a.configVersion);
    expect(a.maxAgeHours).toBe(48);
    expect(a.keywords.ar.length).toBeGreaterThan(0);
    expect(a.otpPatterns.every((p) => typeof p === "string")).toBe(true);

    const { createCollectionAccount } = await import("@/lib/repo/collection-accounts");
    await createCollectionAccount(
      f.tenantId,
      { userId: f.ownerId, isOwner: true, activeBranchId: f.branchId, accessibleBranchIds: null },
      { rail: "wallet", provider: "orange_cash", label: "Orange", walletMsisdn: "012" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0"), branchId: null } as never,
    );
    const c = await ingestConfigFor(d.ctx);
    expect(c.configVersion).not.toBe(a.configVersion);
    expect(c.packages.length).toBeGreaterThanOrEqual(a.packages.length);
    await revokeIngestDevice(ownerDeviceActor(f), d.id);
  });

  it("collectionsIngestConfigFields: absolute URLs from the request origin; null when ingest is off", async () => {
    const req = { headers: new Headers({ host: "127.0.0.1:3003" }), url: "http://127.0.0.1:3003/api/collections/config" };
    const block = await collectionsIngestConfigFields({ tenantId: f.tenantId, branchId: f.branchId }, req);
    expect(block).not.toBeNull();
    expect(block!.ingestUrl).toMatch(/^https?:\/\/[^/]+\/api\/v1\/collections\/ingest$/);
    expect(block!.heartbeatUrl.endsWith("/api/v1/collections/ingest/heartbeat")).toBe(true);
    expect(block!.configUrl.endsWith("/api/v1/collections/ingest/config")).toBe(true);
    expect(block!.maxDevices).toBe(10);
    expect(block!.platformChannels.android_listener).toEqual(["android_notification"]);
    process.env.COLLECTIONS_INGEST_ENABLED = "off";
    expect(await collectionsIngestConfigFields({ tenantId: f.tenantId, branchId: f.branchId }, req)).toBeNull();
    process.env.COLLECTIONS_INGEST_ENABLED = "on";
  });
});
