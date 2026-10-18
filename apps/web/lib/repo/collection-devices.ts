// Digital collections L2 — ingest devices: create / list / revoke / heartbeat
// / config / health (spec 07 §4.4, §4.6, §4.8, §4.11; 03 §B.2.5, §E.1).
//
// `collection_ingest_devices` has NO RLS (the token lookup runs before the
// tenant is known, like auth_devices), so EVERY statement here that is not
// the token lookup filters `tenant_id` explicitly. Statements run inside
// `withTenant` anyway so the raw-message purge (RLS) shares the transaction.
//
// The plaintext token exists only in the create (or replay-before-first-use)
// response: never in Redis, logs, activity metadata or the DB.

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import type { TenantTx } from "@/lib/collections/flags";
import { resolveCollectionsFeatures, type CollectionsFeatures } from "@/lib/collections/flags";
import { DomainError } from "@/lib/errors";
import { canonicalJson } from "@/lib/api/idempotency";
import { forgetIngestToken, mintIngestToken, type IngestDeviceContext } from "@/lib/api/ingest-token";
import { appOrigin } from "@/lib/url-safe";
import { CANDIDATE_KEYWORDS, FILTER_CONFIG_VERSION, OTP_PATTERNS } from "@matgary/domain/collections/filter";
import { MATCH_CONSTANTS } from "@matgary/domain/collections/match";
import { packagesForProviders, sendersForProviders } from "@matgary/domain/collections/providers";
import {
  COLLECTION_PROVIDER_VALUES,
  type CollectionProvider,
  type DeviceHealth,
  type IngestChannel,
  type IngestPlatform,
} from "@matgary/domain/collections/types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants (§4.11)
// ─────────────────────────────────────────────────────────────────────────────

/** The channels each platform may post. `manual_paste` / `statement` are never device channels. */
export const PLATFORM_CHANNELS: Readonly<Record<IngestPlatform, readonly IngestChannel[]>> = Object.freeze({
  ios_shortcut: ["ios_sms", "ios_notification"],
  ios_app_intent: ["ios_sms", "ios_notification"],
  android_listener: ["android_notification"],
  android_collector: ["android_sms"],
});

export const MAX_LIVE_DEVICES = 10;
/** Three missed 15-min heartbeats of spec 11. */
export const HEARTBEAT_LATE_MIN = 45;
/** Revoked devices stay in the list this long. */
export const REVOKED_LIST_DAYS = 30;

export type RevokeReason = "owner" | "user_removed" | "security" | "replaced";

// ─────────────────────────────────────────────────────────────────────────────
// DTO (03 §B.17, 07 §4.6)
// ─────────────────────────────────────────────────────────────────────────────

export interface DeviceDTO {
  id: string;
  label: string;
  platform: IngestPlatform;
  channels: IngestChannel[];
  accountIds: string[];
  branchId: string | null;
  tokenPrefix: string;
  createdBy: { id: string; name: string | null } | null;
  consentVersion: string;
  consentAt: string;
  appVersion: string | null;
  osVersion: string | null;
  lastSeenAt: string | null;
  lastMessageAt: string | null;
  lastCreditAt: string | null;
  lastHeartbeat: Record<string, unknown> | null;
  lastTest: { at: string; templateId: string; amount: number } | null;
  health: DeviceHealth;
  revokedAt: string | null;
  revokedReason: RevokeReason | null;
  createdAt: string;
}

export interface IngestUrls {
  ingestUrl: string;
  heartbeatUrl: string;
  configUrl: string;
}

export interface IngestConfigBlock extends IngestUrls {
  iosShortcutUrl: string | null;
  iosShortcutUrlLegacy: string | null;
  iosIntentShortcutUrl: string | null;
  iosIntentShortcutUrlLegacy: string | null;
  maxDevices: number;
  liveDevices: number;
  platformChannels: Record<IngestPlatform, IngestChannel[]>;
}

interface DeviceRow {
  id: string;
  tenant_id: string;
  branch_id: string | null;
  label: string;
  platform: string;
  channels: string[];
  account_ids: string[] | null;
  token_prefix: string;
  created_by_user_id: string | null;
  created_by_name: string | null;
  consent_version: string;
  consent_at: string | Date;
  app_version: string | null;
  os_version: string | null;
  last_seen_at: string | Date | null;
  last_message_at: string | Date | null;
  last_credit_at: string | Date | null;
  last_heartbeat: Record<string, unknown> | null;
  silent_alerted_at: string | Date | null;
  revoked_at: string | Date | null;
  revoked_reason: string | null;
  created_at: string | Date;
  test_at: string | Date | null;
  test_template_id: string | null;
  test_amount: string | null;
}

function toIso(v: string | Date | null | undefined): string | null {
  if (v == null) return null;
  return (v instanceof Date ? v : new Date(v)).toISOString();
}

function ms(v: string | Date | null | undefined): number | null {
  if (v == null) return null;
  const t = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isNaN(t) ? null : t;
}

/** The facts `deviceHealth` reads. */
export interface DeviceHealthInput {
  platform: string;
  revokedAt: string | Date | null;
  lastHeartbeat: Record<string, unknown> | null;
  silentAlertedAt: string | Date | null;
  lastMessageAt: string | Date | null;
  lastSeenAt: string | Date | null;
}

/**
 * The ONLY device-health value (§4.11; 09 and 12 render it as-is). First
 * match wins: revoked → listener_off → silent → heartbeat_late → never_seen → ok.
 */
export function deviceHealth(row: DeviceHealthInput, now: Date): DeviceHealth {
  if (row.revokedAt) return "revoked";
  if (row.platform === "android_listener" && row.lastHeartbeat && row.lastHeartbeat.listenerConnected === false) {
    return "listener_off";
  }
  const silentAt = ms(row.silentAlertedAt);
  const lastMsg = ms(row.lastMessageAt);
  if (silentAt !== null && (lastMsg === null || lastMsg < silentAt)) return "silent";
  const seen = ms(row.lastSeenAt);
  if (row.platform === "android_listener" && seen !== null && seen < now.getTime() - HEARTBEAT_LATE_MIN * 60_000) {
    return "heartbeat_late";
  }
  if (lastMsg === null) return "never_seen";
  return "ok";
}

export function toDeviceDTO(r: DeviceRow, now: Date = new Date()): DeviceDTO {
  return {
    id: r.id,
    label: r.label,
    platform: r.platform as IngestPlatform,
    channels: (r.channels ?? []) as IngestChannel[],
    accountIds: r.account_ids ?? [],
    branchId: r.branch_id,
    tokenPrefix: r.token_prefix,
    createdBy: r.created_by_user_id ? { id: r.created_by_user_id, name: r.created_by_name } : null,
    consentVersion: r.consent_version,
    consentAt: toIso(r.consent_at)!,
    appVersion: r.app_version,
    osVersion: r.os_version,
    lastSeenAt: toIso(r.last_seen_at),
    lastMessageAt: toIso(r.last_message_at),
    lastCreditAt: toIso(r.last_credit_at),
    lastHeartbeat: r.last_heartbeat ?? null,
    lastTest:
      r.test_at && r.test_template_id
        ? { at: toIso(r.test_at)!, templateId: r.test_template_id, amount: Number(r.test_amount ?? 0) }
        : null,
    health: deviceHealth(
      {
        platform: r.platform,
        revokedAt: r.revoked_at,
        lastHeartbeat: r.last_heartbeat,
        silentAlertedAt: r.silent_alerted_at,
        lastMessageAt: r.last_message_at,
        lastSeenAt: r.last_seen_at,
      },
      now,
    ),
    revokedAt: toIso(r.revoked_at),
    revokedReason: (r.revoked_reason as RevokeReason | null) ?? null,
    createdAt: toIso(r.created_at)!,
  };
}

function deviceQuery(tenantId: string, where: ReturnType<typeof sql>) {
  return sql`
    SELECT d.id, d.tenant_id, d.branch_id, d.label, d.platform, d.channels, d.account_ids,
           d.token_prefix, d.created_by_user_id, u.name AS created_by_name,
           d.consent_version, d.consent_at, d.app_version, d.os_version,
           d.last_seen_at, d.last_message_at, d.last_credit_at, d.last_heartbeat,
           d.silent_alerted_at, d.revoked_at, d.revoked_reason, d.created_at,
           lt.created_at AS test_at, lt.template_id AS test_template_id, lt.amount::text AS test_amount
      FROM collection_ingest_devices d
      LEFT JOIN users u ON u.id = d.created_by_user_id
      LEFT JOIN LATERAL (
        SELECT c.created_at, c.template_id, c.amount
          FROM collection_credits c
         WHERE c.tenant_id = d.tenant_id AND c.ingest_device_id = d.id AND c.is_test = true
           AND c.created_at > now() - interval '1 day'
         ORDER BY c.created_at DESC
         LIMIT 1
      ) lt ON true
     WHERE d.tenant_id = ${tenantId} AND ${where}`;
}

async function readDevice(tx: TenantTx, tenantId: string, id: string): Promise<DeviceDTO | null> {
  const rows = (await tx.execute(deviceQuery(tenantId, sql`d.id = ${id}`))) as unknown as DeviceRow[];
  return rows[0] ? toDeviceDTO(rows[0]) : null;
}

/** Live devices + those revoked in the last 30 days, newest first. */
export async function listIngestDevices(tenantId: string): Promise<DeviceDTO[]> {
  return withTenant(tenantId, async (tx) => {
    const rows = (await tx.execute(sql`
      ${deviceQuery(tenantId, sql`(d.revoked_at IS NULL OR d.revoked_at > now() - make_interval(days => ${REVOKED_LIST_DAYS}))`)}
      ORDER BY d.created_at DESC, d.id DESC
    `)) as unknown as DeviceRow[];
    const now = new Date();
    return rows.map((r) => toDeviceDTO(r, now));
  });
}

export async function getIngestDevice(tenantId: string, id: string): Promise<DeviceDTO | null> {
  return withTenant(tenantId, (tx) => readDevice(tx, tenantId, id));
}

export async function countLiveDevices(tx: TenantTx, tenantId: string): Promise<number> {
  const [r] = (await tx.execute(sql`
    SELECT count(*)::int AS n FROM collection_ingest_devices WHERE tenant_id = ${tenantId} AND revoked_at IS NULL
  `)) as unknown as { n: number }[];
  return Number(r?.n ?? 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Create (§4.11)
// ─────────────────────────────────────────────────────────────────────────────

export interface DeviceActor {
  tenantId: string;
  userId: string;
  isOwner: boolean;
  /** null = every branch (owner). */
  accessibleBranchIds: string[] | null;
}

export interface CreateDeviceInput {
  label: string;
  platform: IngestPlatform;
  channels: IngestChannel[];
  accountIds?: string[];
  branchId?: string | null;
  consentVersion: string;
  appVersion?: string | null;
  osVersion?: string | null;
  replacesDeviceId?: string | null;
}

export interface CreatedDevice {
  device: DeviceDTO;
  token: string;
  /** The device revoked as `replaced` in the same transaction, if any. */
  replacedDeviceId: string | null;
}

/** 400 INVALID_REQUEST when a channel is not allowed for the platform. */
export function assertChannelsAllowed(platform: IngestPlatform, channels: readonly IngestChannel[]): void {
  const allowed = PLATFORM_CHANNELS[platform];
  if (channels.length === 0) {
    throw new DomainError("INVALID_REQUEST", 400, { path: "channels", message: "at least one channel" });
  }
  for (const c of channels) {
    if (!allowed.includes(c)) {
      throw new DomainError("INVALID_REQUEST", 400, { path: "channels", message: `${c} is not a ${platform} channel` });
    }
  }
}

async function deleteRawOfDevices(tx: TenantTx, tenantId: string, ids: readonly string[]): Promise<void> {
  for (const id of ids) {
    await tx.execute(sql`
      DELETE FROM collection_raw_messages WHERE tenant_id = ${tenantId} AND ingest_device_id = ${id}
    `);
  }
}

export async function createIngestDevice(actor: DeviceActor, input: CreateDeviceInput): Promise<CreatedDevice> {
  assertChannelsAllowed(input.platform, input.channels);
  const tenantId = actor.tenantId;
  const branchId = input.branchId ?? null;
  if (branchId && actor.accessibleBranchIds !== null && !actor.accessibleBranchIds.includes(branchId)) {
    throw new DomainError("FORBIDDEN_BRANCH", 403);
  }
  const accountIds = [...new Set(input.accountIds ?? [])].sort();
  const minted = mintIngestToken();

  const result = await withTenant(tenantId, async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${tenantId}::text || ':devices'))`);

    if (branchId) {
      const [b] = (await tx.execute(sql`
        SELECT 1 AS ok FROM branches WHERE tenant_id = ${tenantId} AND id = ${branchId}
      `)) as unknown as { ok: number }[];
      if (!b) throw new DomainError("FORBIDDEN_BRANCH", 403);
    }

    let replacedId: string | null = null;
    let replacedHash: string | null = null;
    if (input.replacesDeviceId) {
      const [old] = (await tx.execute(sql`
        SELECT id, revoked_at FROM collection_ingest_devices
         WHERE tenant_id = ${tenantId} AND id = ${input.replacesDeviceId}
         FOR UPDATE
      `)) as unknown as { id: string; revoked_at: string | null }[];
      if (!old) throw new DomainError("DEVICE_NOT_FOUND", 404);
      if (!old.revoked_at) {
        const [rv] = (await tx.execute(sql`
          UPDATE collection_ingest_devices
             SET revoked_at = now(), revoked_by_user_id = ${actor.userId}, revoked_reason = 'replaced', updated_at = now()
           WHERE tenant_id = ${tenantId} AND id = ${old.id} AND revoked_at IS NULL
           RETURNING id, token_hash
        `)) as unknown as { id: string; token_hash: string }[];
        if (rv) {
          replacedId = rv.id;
          replacedHash = rv.token_hash;
          await deleteRawOfDevices(tx, tenantId, [rv.id]);
        }
      }
    }

    if ((await countLiveDevices(tx, tenantId)) >= MAX_LIVE_DEVICES) {
      throw new DomainError("DEVICE_LIMIT_REACHED", 409, { maxDevices: MAX_LIVE_DEVICES });
    }

    if (accountIds.length > 0) {
      const found = (await tx.execute(sql`
        SELECT id FROM collection_accounts
         WHERE tenant_id = ${tenantId} AND archived_at IS NULL
           AND id IN (${sql.join(accountIds.map((id) => sql`${id}::uuid`), sql`, `)})
           ${branchId ? sql`AND (branch_id IS NULL OR branch_id = ${branchId})` : sql``}
      `)) as unknown as { id: string }[];
      if (found.length !== accountIds.length) throw new DomainError("COLLECTION_ACCOUNT_NOT_FOUND", 404);
    }

    const [ins] = (await tx.execute(sql`
      INSERT INTO collection_ingest_devices
        (tenant_id, branch_id, created_by_user_id, label, platform, channels, account_ids,
         token_hash, token_prefix, consent_version, consent_at, consent_user_id, app_version, os_version)
      VALUES (${tenantId}, ${branchId}, ${actor.userId}, ${input.label.trim()}, ${input.platform},
              ARRAY[${sql.join(input.channels.map((c) => sql`${c}`), sql`, `)}]::text[],
              ${accountIds.length > 0 ? sql`ARRAY[${sql.join(accountIds.map((id) => sql`${id}`), sql`, `)}]::uuid[]` : sql`'{}'::uuid[]`},
              ${minted.hash}, ${minted.prefix}, ${input.consentVersion}, now(), ${actor.userId},
              ${input.appVersion ?? null}, ${input.osVersion ?? null})
      RETURNING id
    `)) as unknown as { id: string }[];
    const device = await readDevice(tx, tenantId, ins!.id);
    return { device: device!, replacedId, replacedHash };
  });

  if (result.replacedHash) await forgetIngestToken(result.replacedHash);
  return { device: result.device, token: minted.token, replacedDeviceId: result.replacedId };
}

/**
 * The idempotent-replay half of create (§4.11): the replay entry never holds
 * the token, so a replay BEFORE the device was ever used re-mints the token
 * for the same row (new hash + prefix, old cache key dropped); after first use
 * it answers `token: null` (the client evidently stored it). null = the device
 * is gone or revoked (the caller answers the cached body as-is).
 */
export async function replayCreatedDevice(
  tenantId: string,
  deviceId: string,
): Promise<{ device: DeviceDTO; token: string | null } | null> {
  const minted = mintIngestToken();
  const out = await withTenant(tenantId, async (tx) => {
    const [row] = (await tx.execute(sql`
      SELECT id, token_hash, revoked_at, last_seen_at FROM collection_ingest_devices
       WHERE tenant_id = ${tenantId} AND id = ${deviceId}
       FOR UPDATE
    `)) as unknown as { id: string; token_hash: string; revoked_at: string | null; last_seen_at: string | null }[];
    if (!row || row.revoked_at) return null;
    if (row.last_seen_at) return { device: (await readDevice(tx, tenantId, deviceId))!, token: null, oldHash: null };
    await tx.execute(sql`
      UPDATE collection_ingest_devices
         SET token_hash = ${minted.hash}, token_prefix = ${minted.prefix}, updated_at = now()
       WHERE tenant_id = ${tenantId} AND id = ${deviceId}
    `);
    return { device: (await readDevice(tx, tenantId, deviceId))!, token: minted.token, oldHash: row.token_hash };
  });
  if (!out) return null;
  if (out.oldHash) await forgetIngestToken(out.oldHash);
  return { device: out.device, token: out.token };
}

// ─────────────────────────────────────────────────────────────────────────────
// Revoke (§4.4, §4.11)
// ─────────────────────────────────────────────────────────────────────────────

export interface RevokeResult {
  device: DeviceDTO;
  revokedAt: string;
  /** Already revoked before this call (the stored reason is kept). */
  already: boolean;
}

/**
 * `owner` (default) or `replaced` from a request; `security` is operator-only
 * and `user_removed` belongs to `revokeDevicesCreatedBy`. Deletes the
 * device's raw rows in the same transaction (03 §E.4); credits keep their
 * fields (`raw_message_id` goes NULL by FK).
 */
export async function revokeIngestDevice(
  actor: DeviceActor,
  id: string,
  reason: "owner" | "replaced" = "owner",
): Promise<RevokeResult> {
  const tenantId = actor.tenantId;
  const out = await withTenant(tenantId, async (tx) => {
    const [rv] = (await tx.execute(sql`
      UPDATE collection_ingest_devices
         SET revoked_at = now(), revoked_by_user_id = ${actor.userId}, revoked_reason = ${reason}, updated_at = now()
       WHERE tenant_id = ${tenantId} AND id = ${id} AND revoked_at IS NULL
       RETURNING token_hash
    `)) as unknown as { token_hash: string }[];
    if (rv) await deleteRawOfDevices(tx, tenantId, [id]);
    const device = await readDevice(tx, tenantId, id);
    if (!device) throw new DomainError("DEVICE_NOT_FOUND", 404);
    return { device, hash: rv?.token_hash ?? null };
  });
  if (out.hash) await forgetIngestToken(out.hash);
  return { device: out.device, revokedAt: out.device.revokedAt!, already: out.hash === null };
}

/**
 * Inside `removeTeamMember`'s transaction, BEFORE the user row is deleted
 * (§4.11): every live device the user created → revoked `user_removed`.
 * Returns what `finishDeviceRevocations` needs after the commit.
 */
export async function revokeDevicesCreatedBy(
  tx: TenantTx,
  tenantId: string,
  userId: string,
): Promise<{ id: string; tokenHash: string }[]> {
  const rows = (await tx.execute(sql`
    UPDATE collection_ingest_devices
       SET revoked_at = now(), revoked_reason = 'user_removed', updated_at = now()
     WHERE tenant_id = ${tenantId} AND created_by_user_id = ${userId} AND revoked_at IS NULL
     RETURNING id, token_hash
  `)) as unknown as { id: string; token_hash: string }[];
  return rows.map((r) => ({ id: r.id, tokenHash: r.token_hash }));
}

/** After the removal commits: drop the cached tokens and purge the raw rows. */
export async function finishDeviceRevocations(
  tenantId: string,
  revoked: readonly { id: string; tokenHash: string }[],
): Promise<void> {
  if (revoked.length === 0) return;
  for (const r of revoked) await forgetIngestToken(r.tokenHash);
  await withTenant(tenantId, (tx) => deleteRawOfDevices(tx, tenantId, revoked.map((r) => r.id)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Heartbeat + config (§4.8)
// ─────────────────────────────────────────────────────────────────────────────

export interface IngestConfig {
  configVersion: string;
  filterVersion: string;
  packages: string[];
  senders: string[];
  keywords: { ar: string[]; en: string[] };
  otpPatterns: string[];
  maxAgeHours: number;
}

/** First 16 hex of SHA-256 over the canonical JSON of the config body. */
export function configVersionOf(config: Omit<IngestConfig, "configVersion">): string {
  return createHash("sha256").update(canonicalJson(config)).digest("hex").slice(0, 16);
}

/** The pure half: the config for a set of providers. */
export function ingestConfigForProviders(providers: readonly CollectionProvider[]): IngestConfig {
  const body: Omit<IngestConfig, "configVersion"> = {
    filterVersion: FILTER_CONFIG_VERSION,
    packages: packagesForProviders(providers),
    senders: sendersForProviders(providers),
    keywords: { ar: [...CANDIDATE_KEYWORDS.ar], en: [...CANDIDATE_KEYWORDS.en] },
    otpPatterns: [...OTP_PATTERNS],
    maxAgeHours: MATCH_CONSTANTS.MAX_AGE_H,
  };
  return { configVersion: configVersionOf(body), ...body };
}

/** Scope = the tenant's active accounts, narrowed to the device's
 *  `account_ids` when non-empty; every provider when the tenant has none. */
export async function ingestConfigFor(dev: Pick<IngestDeviceContext, "tenantId" | "accountIds">): Promise<IngestConfig> {
  const providers = await withTenant(dev.tenantId, async (tx) => {
    const rows = (await tx.execute(sql`
      SELECT id, provider FROM collection_accounts
       WHERE tenant_id = ${dev.tenantId} AND archived_at IS NULL
    `)) as unknown as { id: string; provider: string }[];
    if (rows.length === 0) return [...COLLECTION_PROVIDER_VALUES];
    const scoped = dev.accountIds.length > 0 ? rows.filter((r) => dev.accountIds.includes(r.id)) : rows;
    return [...new Set(scoped.map((r) => r.provider))].sort() as CollectionProvider[];
  });
  return ingestConfigForProviders(providers);
}

export interface HeartbeatBody {
  platform: IngestPlatform;
  appVersion?: string | null;
  osVersion?: string | null;
  listenerConnected?: boolean;
  lastNotificationAt?: string | null;
  lastUploadAt?: string | null;
  queued?: number;
  packagesInstalled?: string[];
}

/** last_seen_at = now(), last_heartbeat = body + serverAt; never touches last_message_at. */
export async function recordHeartbeat(dev: IngestDeviceContext, body: HeartbeatBody): Promise<{ configVersion: string }> {
  const serverAt = new Date().toISOString();
  const beat: Record<string, unknown> = { ...body, serverAt };
  await db.execute(sql`
    UPDATE collection_ingest_devices
       SET last_seen_at = now(),
           last_heartbeat = ${JSON.stringify(beat)}::jsonb,
           app_version = COALESCE(${body.appVersion ?? null}, app_version),
           os_version = COALESCE(${body.osVersion ?? null}, os_version),
           updated_at = now()
     WHERE tenant_id = ${dev.tenantId} AND id = ${dev.deviceId}
  `);
  const config = await ingestConfigFor(dev);
  return { configVersion: config.configVersion };
}

/** Device bookkeeping after an ingest batch (§4.7 step 9; 13's silent sweep contract). */
export async function touchDeviceAfterBatch(dev: IngestDeviceContext, anyRealCredit: boolean): Promise<void> {
  await db.execute(sql`
    UPDATE collection_ingest_devices
       SET last_message_at = now(), silent_alerted_at = NULL,
           ${anyRealCredit ? sql`last_credit_at = now(),` : sql``}
           updated_at = now()
     WHERE tenant_id = ${dev.tenantId} AND id = ${dev.deviceId}
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// The `ingest` block of GET /api/collections/config (§4.6)
// ─────────────────────────────────────────────────────────────────────────────

export function ingestUrls(origin: string): IngestUrls {
  const base = origin.replace(/\/+$/, "");
  return {
    ingestUrl: `${base}/api/v1/collections/ingest`,
    heartbeatUrl: `${base}/api/v1/collections/ingest/heartbeat`,
    configUrl: `${base}/api/v1/collections/ingest/config`,
  };
}

function envUrl(name: string): string | null {
  const v = (process.env[name] ?? "").trim();
  return v === "" ? null : v;
}

/** The four COLLECTIONS_IOS_*SHORTCUT_URL* values, empty / unset → null. */
export function shortcutUrls(): Pick<
  IngestConfigBlock,
  "iosShortcutUrl" | "iosShortcutUrlLegacy" | "iosIntentShortcutUrl" | "iosIntentShortcutUrlLegacy"
> {
  return {
    iosShortcutUrl: envUrl("COLLECTIONS_IOS_SHORTCUT_URL"),
    iosShortcutUrlLegacy: envUrl("COLLECTIONS_IOS_SHORTCUT_URL_LEGACY"),
    iosIntentShortcutUrl: envUrl("COLLECTIONS_IOS_INTENT_SHORTCUT_URL"),
    iosIntentShortcutUrlLegacy: envUrl("COLLECTIONS_IOS_INTENT_SHORTCUT_URL_LEGACY"),
  };
}

/** null when !features.collectionsIngest (05's config route spreads this). */
export async function collectionsIngestConfigFields(
  ctx: { tenantId: string; branchId: string },
  req: { headers: Headers; url: string },
  features?: CollectionsFeatures,
): Promise<IngestConfigBlock | null> {
  const f = features ?? (await resolveCollectionsFeatures(ctx.tenantId, ctx.branchId));
  if (!f.collectionsIngest) return null;
  const liveDevices = await withTenant(ctx.tenantId, (tx) => countLiveDevices(tx, ctx.tenantId));
  const platformChannels = Object.fromEntries(
    Object.entries(PLATFORM_CHANNELS).map(([k, v]) => [k, [...v]]),
  ) as Record<IngestPlatform, IngestChannel[]>;
  return {
    ...ingestUrls(appOrigin(req)),
    ...shortcutUrls(),
    maxDevices: MAX_LIVE_DEVICES,
    liveDevices,
    platformChannels,
  };
}
