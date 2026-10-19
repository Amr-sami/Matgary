// Digital collections L2 — the per-device ingest token (spec 07 §4.4; 03 §E.1).
//
// `mgi_` + base64url(32 random bytes) = 47 chars, the entropy of
// `mintRefreshToken` (native-token.ts). Stored as the SHA-256 hex of the WHOLE
// string (token_hash) + the 8 chars after `mgi_` (token_prefix); the plaintext
// exists only in the POST collections/devices response.
//
// `requireIngestDevice(req, scope)` is the only way an ingest route learns who
// is calling, in this order (every refusal is JSON {error}):
//   1 per-IP bucket `ingest.ip` BEFORE any parsing or DB work (cheap refusal
//     of token guessing) → 429 RATE_LIMITED
//   2 bearer present and of the token shape → else 401 INGEST_TOKEN_INVALID
//   3 Redis cache globalKey("ingest", hash), 60 s, negative entries included
//   4 miss → plain `db` lookup (collection_ingest_devices has NO RLS by design,
//     03 §B.2.5) joined to tenants; unknown → 401 INGEST_TOKEN_INVALID (cached
//     negative), revoked → 401 INGEST_DEVICE_REVOKED (never cached as valid),
//     suspended → 403 TENANT_SUSPENDED, deletion scheduled → 403 INGEST_DISABLED
//   5 the route's device bucket, then the tenant ceiling `ingest.default`
//   6 admission: COLLECTIONS_INGEST_ENABLED admits the tenant (env, read on
//     every request: SEC14-F6) and features.collectionsIngest holds for the
//     device's branch (any branch for a NULL-branch device; that switch
//     lookup cached 60 s); consent older than
//     COLLECTIONS_CONSENT_MIN_VERSION → 403 INGEST_DISABLED "consent_outdated"
//   7 throttled `last_seen_at` write (≤ once a minute)
//
// A token is never a user credential: `resolveSession` refuses `mgi_` bearers
// (auth-helpers.ts), and these handlers never call requireTenant*.

import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db, withTenant } from "@/lib/db";
import { bearerFromHeader } from "@/lib/api/native-token";
import { clientIp } from "@/lib/request-ip";
import { cacheDel, cacheGet, cacheSet, globalKey, tenantKey } from "@/lib/cache";
import { checkScopedRateLimit, checkTenantRateLimit } from "@/lib/api/tenant-rate-limit";
import {
  COLLECTIONS_CONSENT_MIN_VERSION,
  collectionsTenantAdmitted,
  gateMode,
  ingestPilotTenantIds,
  resolveCollectionsFeatures,
  tenantAdmitted,
} from "@/lib/collections/flags";
import type { IngestChannel, IngestPlatform } from "@matgary/domain/collections/types";

export const INGEST_TOKEN_PREFIX = "mgi_";
export const INGEST_CACHE_TTL_SEC = 60;
const TOKEN_SHAPE_RE = /^mgi_[A-Za-z0-9_-]{43}$/;

export interface MintedIngestToken {
  token: string;
  hash: string;
  prefix: string;
}

/** SHA-256 hex of the whole token string, `mgi_` included. */
export function hashIngestToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function isIngestTokenShape(token: string | null | undefined): token is string {
  return typeof token === "string" && TOKEN_SHAPE_RE.test(token);
}

export function mintIngestToken(): MintedIngestToken {
  const token = INGEST_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { token, hash: hashIngestToken(token), prefix: token.slice(4, 12) };
}

/** `matgary:<env>:v1:g:ingest:<hash>` — never the plaintext token. */
export function ingestCacheKey(hash: string): string {
  return globalKey("ingest", hash);
}

/** Drop the cached lookup of a token (revoke, rotate). Fail-open like every
 *  cache call: a Redis outage leaves a revoked token working ≤ 60 s. */
export async function forgetIngestToken(hash: string): Promise<void> {
  await cacheDel(ingestCacheKey(hash));
}

/** What an ingest handler knows about its caller. */
export interface IngestDeviceContext {
  deviceId: string;
  tenantId: string;
  branchId: string | null;
  platform: IngestPlatform;
  channels: IngestChannel[];
  /** [] = every active account of the tenant. */
  accountIds: string[];
  createdByUserId: string | null;
  consentVersion: string;
  label: string;
}

type CacheEntry = (IngestDeviceContext & { revoked: false }) | { invalid: true };

export type IngestScope = "ingest.device" | "ingest.heartbeat" | "ingest.config";

type Refusal = { ok: false; response: NextResponse };

function refuse(error: string, status: number, detail?: string): Refusal {
  return {
    ok: false,
    response: NextResponse.json(detail ? { error, detail } : { error }, { status }),
  };
}

interface DeviceLookupRow {
  id: string;
  tenant_id: string;
  branch_id: string | null;
  platform: string;
  channels: string[];
  account_ids: string[] | null;
  created_by_user_id: string | null;
  consent_version: string;
  label: string;
  revoked_at: string | null;
  suspended_at: string | null;
  deletion_scheduled_at: string | null;
}

/**
 * The env half of admission (COLLECTIONS_ENABLED and COLLECTIONS_INGEST_ENABLED
 * with its pilot list), read on EVERY request and never cached: the kill
 * switch bites on the first request after the redeploy (SEC14-F6, which
 * measured 56 s while this sat behind the 60 s cache).
 */
export function ingestEnvAdmitted(tenantId: string): boolean {
  return (
    collectionsTenantAdmitted(tenantId) &&
    tenantAdmitted(gateMode(process.env.COLLECTIONS_INGEST_ENABLED), tenantId, ingestPilotTenantIds())
  );
}

/**
 * Admission (§4.4 step 6). The env gates are checked first, uncached
 * (`ingestEnvAdmitted`); only the per-branch switch lookup is cached 60 s per
 * (tenant, ingest mode, branch | any). The mode is part of the key, so an
 * off → pilot / on flip never reads an answer cached under the old mode
 * either. A branch switch turned off still takes ≤ 60 s (03 §B.14 reads it
 * per call elsewhere; here the cache bounds the DB cost of a busy phone).
 */
export async function ingestAdmitted(tenantId: string, branchId: string | null): Promise<boolean> {
  if (!ingestEnvAdmitted(tenantId)) return false;
  const mode = gateMode(process.env.COLLECTIONS_INGEST_ENABLED);
  const key = tenantKey(tenantId, "collections-ingest-admit", mode, branchId ?? "any");
  const hit = await cacheGet<{ admitted: boolean }>(key);
  if (hit) return hit.admitted;
  let admitted = false;
  if (branchId) {
    admitted = (await resolveCollectionsFeatures(tenantId, branchId)).collectionsIngest;
  } else {
    // A NULL-branch device: admitted when ANY branch of the tenant is.
    const branchIds = await withTenant(tenantId, async (tx) =>
      (
        (await tx.execute(sql`
          SELECT branch_id FROM shop_settings
           WHERE tenant_id = ${tenantId} AND collections_enabled = true
           ORDER BY branch_id
           LIMIT 20
        `)) as unknown as { branch_id: string }[]
      ).map((r) => r.branch_id),
    );
    for (const b of branchIds) {
      if ((await resolveCollectionsFeatures(tenantId, b)).collectionsIngest) {
        admitted = true;
        break;
      }
    }
  }
  await cacheSet(key, { admitted }, INGEST_CACHE_TTL_SEC);
  return admitted;
}

/** `consent_version` sorts below the server minimum (03 §B.15). */
export function consentOutdated(version: string): boolean {
  return version < COLLECTIONS_CONSENT_MIN_VERSION;
}

export async function requireIngestDevice(
  req: { headers: Headers },
  scope: IngestScope,
): Promise<{ ok: true; dev: IngestDeviceContext } | Refusal> {
  // 1 — before anything else.
  const ip = await checkScopedRateLimit("ingest.ip", clientIp(req));
  if (!ip.ok) return ip;

  // 2
  const bearer = bearerFromHeader(req.headers.get("authorization"));
  if (!isIngestTokenShape(bearer)) return refuse("INGEST_TOKEN_INVALID", 401);
  const hash = hashIngestToken(bearer);
  const key = ingestCacheKey(hash);

  // 3
  let dev: IngestDeviceContext | null = null;
  const cached = await cacheGet<CacheEntry>(key);
  if (cached && "invalid" in cached) return refuse("INGEST_TOKEN_INVALID", 401);
  if (cached && cached.revoked === false) {
    const { revoked: _revoked, ...rest } = cached;
    dev = rest;
  }

  // 4
  if (!dev) {
    const rows = (await db.execute(sql`
      SELECT d.id, d.tenant_id, d.branch_id, d.platform, d.channels, d.account_ids,
             d.created_by_user_id, d.consent_version, d.label, d.revoked_at,
             t.suspended_at, t.deletion_scheduled_at
        FROM collection_ingest_devices d
        JOIN tenants t ON t.id = d.tenant_id
       WHERE d.token_hash = ${hash}
       LIMIT 1
    `)) as unknown as DeviceLookupRow[];
    const row = rows[0];
    if (!row) {
      await cacheSet<CacheEntry>(key, { invalid: true }, INGEST_CACHE_TTL_SEC);
      return refuse("INGEST_TOKEN_INVALID", 401);
    }
    if (row.revoked_at) return refuse("INGEST_DEVICE_REVOKED", 401);
    if (row.suspended_at) return refuse("TENANT_SUSPENDED", 403);
    if (row.deletion_scheduled_at) return refuse("INGEST_DISABLED", 403);
    dev = {
      deviceId: row.id,
      tenantId: row.tenant_id,
      branchId: row.branch_id,
      platform: row.platform as IngestPlatform,
      channels: (row.channels ?? []) as IngestChannel[],
      accountIds: row.account_ids ?? [],
      createdByUserId: row.created_by_user_id,
      consentVersion: row.consent_version,
      label: row.label,
    };
    await cacheSet<CacheEntry>(key, { ...dev, revoked: false }, INGEST_CACHE_TTL_SEC);
  }

  // 5
  const perDevice = await checkScopedRateLimit(scope, dev.deviceId);
  if (!perDevice.ok) return perDevice;
  const perTenant = await checkTenantRateLimit(dev.tenantId, "ingest.default");
  if (!perTenant.ok) return perTenant;

  // 6
  if (!(await ingestAdmitted(dev.tenantId, dev.branchId))) return refuse("INGEST_DISABLED", 403);
  if (consentOutdated(dev.consentVersion)) return refuse("INGEST_DISABLED", 403, "consent_outdated");

  // 7 — throttled; the device table has no RLS, so the plain pool is right.
  await db.execute(sql`
    UPDATE collection_ingest_devices SET last_seen_at = now()
     WHERE id = ${dev.deviceId}
       AND (last_seen_at IS NULL OR last_seen_at < now() - interval '60 seconds')
  `);

  return { ok: true, dev };
}
