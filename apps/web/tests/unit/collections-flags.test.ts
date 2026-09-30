/**
 * Digital collections 05 §4.2 (step 8) — lib/collections/flags.ts.
 *
 * Env gates (off | pilot | on, read on every call), the pilot lists, the
 * 03 §B.14 truth table, the auto-confirm gate that defaults on, the branch
 * switch read (mocked withTenant / tx), and the 403 COLLECTIONS_DISABLED
 * route gate.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantTx } from "@/lib/collections/flags";

const db = vi.hoisted(() => ({
  row: null as null | { collectionsEnabled: boolean; collectionsAutoConfirmEnabled: boolean },
  reads: 0,
  withTenantCalls: [] as string[],
}));

function fakeTx() {
  const b: Record<string, unknown> = {};
  b.select = () => b;
  b.from = () => b;
  b.where = () => b;
  b.limit = () => {
    db.reads++;
    return Promise.resolve(db.row ? [db.row] : []);
  };
  return b;
}

vi.mock("@/lib/db", () => ({
  withTenant: async (tenantId: string, fn: (tx: unknown) => Promise<unknown>) => {
    db.withTenantCalls.push(tenantId);
    return fn(fakeTx());
  },
}));

const {
  COLLECTIONS_CONSENT_MIN_VERSION,
  NO_COLLECTIONS_FEATURES,
  collectionsTenantAdmitted,
  computeCollectionsFeatures,
  gateMode,
  ingestPilotTenantIds,
  pilotTenantIds,
  requireCollectionsTenant,
  resolveCollectionsFeatures,
  tenantAdmitted,
} = await import("@/lib/collections/flags");

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const BR = "33333333-3333-4333-8333-333333333333";

const ENV_KEYS = [
  "COLLECTIONS_ENABLED",
  "COLLECTIONS_PILOT_TENANT_IDS",
  "COLLECTIONS_INGEST_PILOT_TENANT_IDS",
  "COLLECTIONS_AUTO_CONFIRM_ENABLED",
  "COLLECTIONS_INGEST_ENABLED",
  "COLLECTIONS_PROVIDERS_ENABLED",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  db.row = null;
  db.reads = 0;
  db.withTenantCalls = [];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("gateMode", () => {
  it.each([
    ["off", "off"],
    ["pilot", "pilot"],
    ["on", "on"],
    ["ON ", "on"],
    ["  Pilot", "pilot"],
    ["garbage", "off"],
    ["1", "off"],
    ["true", "off"],
    ["", "off"],
  ])("%j → %s", (raw, expected) => {
    expect(gateMode(raw)).toBe(expected);
  });
  it("unset → off", () => {
    expect(gateMode(undefined)).toBe("off");
  });
});

describe("pilot lists", () => {
  it("trims, lower-cases and drops empty entries", () => {
    process.env.COLLECTIONS_PILOT_TENANT_IDS = ` ${T1.toUpperCase()} ,, ${T2}, `;
    expect([...pilotTenantIds()].sort()).toEqual([T1, T2].sort());
  });

  it("tenantAdmitted: on → true, pilot → in the list (case-insensitive), off → false", () => {
    process.env.COLLECTIONS_PILOT_TENANT_IDS = T1;
    expect(tenantAdmitted("on", T2)).toBe(true);
    expect(tenantAdmitted("pilot", T1)).toBe(true);
    expect(tenantAdmitted("pilot", T1.toUpperCase())).toBe(true);
    expect(tenantAdmitted("pilot", T2)).toBe(false);
    expect(tenantAdmitted("off", T1)).toBe(false);
  });

  it("ingest list: its own when set, the shared one when unset or empty", () => {
    process.env.COLLECTIONS_PILOT_TENANT_IDS = `${T1},${T2}`;
    expect([...ingestPilotTenantIds()].sort()).toEqual([T1, T2].sort());
    process.env.COLLECTIONS_INGEST_PILOT_TENANT_IDS = "";
    expect([...ingestPilotTenantIds()].sort()).toEqual([T1, T2].sort());
    process.env.COLLECTIONS_INGEST_PILOT_TENANT_IDS = " , ";
    expect([...ingestPilotTenantIds()].sort()).toEqual([T1, T2].sort());
    process.env.COLLECTIONS_INGEST_PILOT_TENANT_IDS = ` ${T2.toUpperCase()} `;
    expect([...ingestPilotTenantIds()]).toEqual([T2]);
  });

  it("env is read on every call (no module-level caching)", () => {
    expect(collectionsTenantAdmitted(T1)).toBe(false);
    process.env.COLLECTIONS_ENABLED = "on";
    expect(collectionsTenantAdmitted(T1)).toBe(true);
    process.env.COLLECTIONS_ENABLED = "pilot";
    expect(collectionsTenantAdmitted(T1)).toBe(false);
    process.env.COLLECTIONS_PILOT_TENANT_IDS = T1;
    expect(collectionsTenantAdmitted(T1)).toBe(true);
  });
});

describe("truth table (03 §B.14) — 16 combinations", () => {
  const cases: [boolean, boolean, boolean, boolean][] = [];
  for (const admitted of [false, true])
    for (const branchOn of [false, true])
      for (const ingestAdmitted of [false, true])
        for (const autoSwitch of [false, true]) cases.push([admitted, branchOn, ingestAdmitted, autoSwitch]);

  it.each(cases)(
    "COLLECTIONS_ENABLED admits=%s · branch switch=%s · INGEST admits=%s · auto switch=%s",
    (admitted, branchOn, ingestAdmitted, autoSwitch) => {
      process.env.COLLECTIONS_ENABLED = admitted ? "on" : "off";
      process.env.COLLECTIONS_INGEST_ENABLED = ingestAdmitted ? "on" : "off";
      const f = computeCollectionsFeatures(T1, {
        collectionsEnabled: branchOn,
        collectionsAutoConfirmEnabled: autoSwitch,
      });
      const collections = admitted && branchOn;
      const ingest = collections && ingestAdmitted;
      expect(f).toEqual({
        collections,
        collectionsIngest: ingest,
        collectionsAutoConfirm: ingest && autoSwitch, // COLLECTIONS_AUTO_CONFIRM_ENABLED unset → on
        collectionsProviders: false,
        collectionsAvailable: admitted,
      });
    },
  );

  it("a missing settings row reads as both switches off", () => {
    process.env.COLLECTIONS_ENABLED = "on";
    process.env.COLLECTIONS_INGEST_ENABLED = "on";
    expect(computeCollectionsFeatures(T1, null)).toEqual({
      ...NO_COLLECTIONS_FEATURES,
      collectionsAvailable: true,
    });
  });

  it("ingest pilot list set without the tenant → collectionsIngest false even though the tenant is on the shared list", () => {
    process.env.COLLECTIONS_ENABLED = "pilot";
    process.env.COLLECTIONS_INGEST_ENABLED = "pilot";
    process.env.COLLECTIONS_PILOT_TENANT_IDS = `${T1},${T2}`;
    process.env.COLLECTIONS_INGEST_PILOT_TENANT_IDS = T2;
    const on = { collectionsEnabled: true, collectionsAutoConfirmEnabled: true };
    expect(computeCollectionsFeatures(T1, on).collections).toBe(true);
    expect(computeCollectionsFeatures(T1, on).collectionsIngest).toBe(false);
    expect(computeCollectionsFeatures(T2, on).collectionsIngest).toBe(true);
  });

  it("ingest pilot list empty → the shared list is used (same trimming and lower-casing)", () => {
    process.env.COLLECTIONS_ENABLED = "pilot";
    process.env.COLLECTIONS_INGEST_ENABLED = "pilot";
    process.env.COLLECTIONS_PILOT_TENANT_IDS = ` ${T1.toUpperCase()} `;
    process.env.COLLECTIONS_INGEST_PILOT_TENANT_IDS = "";
    const on = { collectionsEnabled: true, collectionsAutoConfirmEnabled: false };
    expect(computeCollectionsFeatures(T1, on).collectionsIngest).toBe(true);
    expect(computeCollectionsFeatures(T2, on).collections).toBe(false);
  });

  it("COLLECTIONS_AUTO_CONFIRM_ENABLED: unset or empty → on; off → collectionsAutoConfirm false; pilot → list", () => {
    process.env.COLLECTIONS_ENABLED = "on";
    process.env.COLLECTIONS_INGEST_ENABLED = "on";
    const on = { collectionsEnabled: true, collectionsAutoConfirmEnabled: true };
    expect(computeCollectionsFeatures(T1, on).collectionsAutoConfirm).toBe(true);
    process.env.COLLECTIONS_AUTO_CONFIRM_ENABLED = "   ";
    expect(computeCollectionsFeatures(T1, on).collectionsAutoConfirm).toBe(true);
    process.env.COLLECTIONS_AUTO_CONFIRM_ENABLED = "off";
    expect(computeCollectionsFeatures(T1, on).collectionsAutoConfirm).toBe(false);
    process.env.COLLECTIONS_AUTO_CONFIRM_ENABLED = "garbage";
    expect(computeCollectionsFeatures(T1, on).collectionsAutoConfirm).toBe(false);
    process.env.COLLECTIONS_AUTO_CONFIRM_ENABLED = "pilot";
    process.env.COLLECTIONS_PILOT_TENANT_IDS = T2;
    expect(computeCollectionsFeatures(T1, on).collectionsAutoConfirm).toBe(false);
  });

  it("collectionsProviders follows its own gate only", () => {
    process.env.COLLECTIONS_PROVIDERS_ENABLED = "on";
    expect(computeCollectionsFeatures(T1, null).collectionsProviders).toBe(true);
    process.env.COLLECTIONS_PROVIDERS_ENABLED = "pilot";
    process.env.COLLECTIONS_PILOT_TENANT_IDS = T1;
    expect(computeCollectionsFeatures(T1, null).collectionsProviders).toBe(true);
    expect(computeCollectionsFeatures(T2, null).collectionsProviders).toBe(false);
  });

  it("collectionsAvailable is true with the branch switch off", () => {
    process.env.COLLECTIONS_ENABLED = "on";
    const f = computeCollectionsFeatures(T1, { collectionsEnabled: false, collectionsAutoConfirmEnabled: false });
    expect(f.collections).toBe(false);
    expect(f.collectionsAvailable).toBe(true);
  });
});

describe("resolveCollectionsFeatures (branch switches read)", () => {
  it("tenant not admitted → no query at all, every flag false", async () => {
    db.row = { collectionsEnabled: true, collectionsAutoConfirmEnabled: true };
    const f = await resolveCollectionsFeatures(T1, BR);
    expect(f).toEqual(NO_COLLECTIONS_FEATURES);
    expect(db.reads).toBe(0);
    expect(db.withTenantCalls).toEqual([]);
  });

  it("admitted → reads the (tenant, branch) row in its own withTenant", async () => {
    process.env.COLLECTIONS_ENABLED = "on";
    db.row = { collectionsEnabled: true, collectionsAutoConfirmEnabled: false };
    const f = await resolveCollectionsFeatures(T1, BR);
    expect(f.collections).toBe(true);
    expect(f.collectionsAvailable).toBe(true);
    expect(db.reads).toBe(1);
    expect(db.withTenantCalls).toEqual([T1]);
  });

  it("inside a caller's tx → reads through that tx, no new withTenant", async () => {
    process.env.COLLECTIONS_ENABLED = "on";
    db.row = { collectionsEnabled: true, collectionsAutoConfirmEnabled: false };
    const f = await resolveCollectionsFeatures(T1, BR, fakeTx() as unknown as TenantTx);
    expect(f.collections).toBe(true);
    expect(db.reads).toBe(1);
    expect(db.withTenantCalls).toEqual([]);
  });

  it("admitted, no settings row → collections false, available true", async () => {
    process.env.COLLECTIONS_ENABLED = "on";
    db.row = null;
    const f = await resolveCollectionsFeatures(T1, BR);
    expect(f).toEqual({ ...NO_COLLECTIONS_FEATURES, collectionsAvailable: true });
  });
});

describe("requireCollectionsTenant", () => {
  it("not admitted → 403 {error:COLLECTIONS_DISABLED}", async () => {
    const res = requireCollectionsTenant(T1);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    expect(await res!.json()).toEqual({ error: "COLLECTIONS_DISABLED" });
  });

  it("pilot without the tenant → 403; with it → null", () => {
    process.env.COLLECTIONS_ENABLED = "pilot";
    process.env.COLLECTIONS_PILOT_TENANT_IDS = T2;
    expect(requireCollectionsTenant(T1)?.status).toBe(403);
    expect(requireCollectionsTenant(T2)).toBeNull();
  });

  it("on → null whatever the branch switch", () => {
    process.env.COLLECTIONS_ENABLED = "on";
    expect(requireCollectionsTenant(T1)).toBeNull();
  });
});

describe("constants", () => {
  it("COLLECTIONS_CONSENT_MIN_VERSION is the pinned date string", () => {
    expect(COLLECTIONS_CONSENT_MIN_VERSION).toBe("2026-10-01");
  });
  it("NO_COLLECTIONS_FEATURES is frozen and all false", () => {
    expect(Object.isFrozen(NO_COLLECTIONS_FEATURES)).toBe(true);
    expect(Object.values(NO_COLLECTIONS_FEATURES).every((v) => v === false)).toBe(true);
  });

  // 05 step 21 (phase B, order 6): GET /api/v1/me answers `features` from
  // the resolver (source-read, like route-gates.test.ts).
  it("GET /api/v1/me source contains `features` from resolveCollectionsFeatures (05 step 21)", () => {
    const src = readFileSync(fileURLToPath(new URL("../../app/api/v1/me/route.ts", import.meta.url)), "utf8");
    expect(src).toContain("resolveCollectionsFeatures(ctx.tenantId, ctx.branchId)");
    expect(src).toMatch(/\n\s+features,\n/);
  });
});
