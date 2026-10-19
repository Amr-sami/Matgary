import type { ApiClient } from "../http";
import type {
  CollectionProvider,
  CollectionRail,
  CollectionStatus,
  DigitalMethod,
} from "./collections";

/**
 * Digital collections L2 — ingest devices, credits, paste and the owner-only
 * Unrecognised list: the routes of apps/web/app/api/collections/{devices,
 * credits,unrecognised}/** and the device-token ingest route (doc 15 spec 07
 * §4.5 / §4.6 step 16, 03 §B.16 / §B.17).
 *
 * Like 05's collections.ts, this package has no dependency on the domain
 * package, so the 03 §B.1 unions are restated here verbatim.
 *
 * Writes that the server requires a key for (match / ignore / paste) take an
 * Idempotency-Key parameter: mint one when the sheet opens and reuse it for
 * every retry inside it. createDevice's key is optional on the server but the
 * setup wizard always sends one (a replay before first use re-mints the
 * token; after first use it answers token: null).
 */

export type IngestChannel =
  | "ios_notification"
  | "ios_sms"
  | "android_notification"
  | "android_sms"
  | "manual_paste"
  | "statement";
export type IngestPlatform = "ios_shortcut" | "ios_app_intent" | "android_listener" | "android_collector";
export type DeviceHealth = "ok" | "never_seen" | "silent" | "listener_off" | "heartbeat_late" | "revoked";
export type SenderKind = "alphanumeric" | "numeric" | "app";
export type CreditDirection = "credit" | "debit" | "cash_in";
export type CreditState = "unmatched" | "held" | "matched" | "ignored" | "info";
export type HoldReason =
  | "ambiguous"
  | "untrusted_source"
  | "balance_mismatch"
  | "no_balance_baseline"
  | "above_review_limit"
  | "no_account"
  | "unverified_format"
  | "manual_source"
  | "suspicious_link"
  | "too_old"
  | "amount_mismatch"
  | "auto_confirm_off"
  | "matches_rejected"
  | "test";
export type IgnoreReason = "personal" | "not_a_sale" | "duplicate" | "other";
export type ParseStatus = "parsed" | "fallback" | "unknown_format" | "not_credit" | "otp" | "too_old" | "duplicate";
/** Ingest `results[].reason` = ParseStatus ∪ `channel_not_allowed` (07 ARCH CHANGE REQUEST 6). */
export type IngestResultReason = ParseStatus | "channel_not_allowed";
export type DeviceRevokeReason = "owner" | "user_removed" | "security" | "replaced";

// ---- Devices ----------------------------------------------------------------

/** 07 §4.6 DeviceDTO; `health` is server-computed and never recomputed by clients. */
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
  /** A value this build does not know (a newer server) renders no badge. */
  health: DeviceHealth | (string & {});
  revokedAt: string | null;
  revokedReason: DeviceRevokeReason | null;
  createdAt: string;
}

export interface DevicesResponse {
  devices: DeviceDTO[];
  maxDevices: number;
}

export interface CreateDeviceBody {
  label: string;
  platform: IngestPlatform;
  channels: IngestChannel[];
  accountIds: string[];
  branchId: string | null;
  consentVersion: string;
  consentAccepted: true;
  replacesDeviceId?: string;
  appVersion: string | null;
  osVersion: string | null;
}

export interface CreateDeviceResult {
  device: DeviceDTO;
  /** "mgi_" + 43 base64url, shown ONCE; null only on an idempotent replay after first use. */
  token: string | null;
  ingestUrl: string;
  heartbeatUrl: string;
  configUrl: string;
}

/** The `ingest` block of GET /api/collections/config (07 §4.6), null while ingest is off. */
export interface IngestConfigBlock {
  ingestUrl: string;
  heartbeatUrl: string;
  configUrl: string;
  iosShortcutUrl: string | null;
  iosShortcutUrlLegacy: string | null;
  iosIntentShortcutUrl: string | null;
  iosIntentShortcutUrlLegacy: string | null;
  maxDevices: number;
  liveDevices: number;
  platformChannels: Partial<Record<IngestPlatform, IngestChannel[]>>;
}

export interface IngestResult {
  results: Array<{ fp: string; status: "accepted" | "duplicate" | "dropped"; reason?: IngestResultReason }>;
}

/** GET /api/collections/devices — live + revoked in the last 30 days. */
export const listDevices = (c: ApiClient) => c.request<DevicesResponse>("/api/collections/devices");

/** POST /api/collections/devices — sent only after the consent screen's agree. */
export const createDevice = (c: ApiClient, body: CreateDeviceBody, idempotencyKey: string) =>
  c.request<CreateDeviceResult>("/api/collections/devices", {
    method: "POST",
    body,
    headers: { "Idempotency-Key": idempotencyKey },
  });

/** DELETE /api/collections/devices/[id]; the server default reason is `owner`. */
export const revokeDevice = (c: ApiClient, id: string, opts: { reason?: "owner" | "replaced" } = {}) =>
  c.request<{ ok: true; revokedAt: string }>(`/api/collections/devices/${encodeURIComponent(id)}`, {
    method: "DELETE",
    query: { reason: opts.reason },
  });

/** `ingestUrl` is absolute (07 builds it from appOrigin); the client joins paths onto its own base URL. */
function pathOf(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "") || "/";
}

/**
 * POST <ingestUrl> with the DEVICE token — the setup wizard's "Send test"
 * (09). `auth: false` keeps the user bearer off; no branch header.
 */
export const sendIngestTest = (c: ApiClient, ingestUrl: string, token: string, message: unknown) =>
  c.request<IngestResult>(pathOf(ingestUrl), {
    method: "POST",
    body: message,
    auth: false,
    noBranch: true,
    headers: { Authorization: `Bearer ${token}` },
  });

/** GET /api/v1/collections/ingest/config (03 §B.17) — the device-scoped filter config. */
export interface IngestDeviceConfig {
  configVersion: string;
  /** = 06 FILTER_CONFIG_VERSION. */
  filterVersion: string;
  packages: string[];
  senders: string[];
  keywords: { ar: string[]; en: string[] };
  otpPatterns: string[];
  maxAgeHours: number;
}

/**
 * GET <ingestUrl>/config with the DEVICE token — read by the Android wizard
 * before the listener's `configure()` (09 step 19). Same transport as
 * sendIngestTest: no user bearer, no branch header.
 */
export const getIngestConfig = (c: ApiClient, ingestUrl: string, token: string) =>
  c.request<IngestDeviceConfig>(`${pathOf(ingestUrl).replace(/\/+$/, "")}/config`, {
    auth: false,
    noBranch: true,
    headers: { Authorization: `Bearer ${token}` },
  });

// ---- Credits ----------------------------------------------------------------

export interface AccountRef {
  id: string;
  label: string;
  provider: CollectionProvider;
  rail: CollectionRail;
  mask: string;
}

export interface CollectionCandidate {
  id: string;
  amount: number;
  rungAt: string;
  status: CollectionStatus;
  method: DigitalMethod;
  accountId: string | null;
  invoiceId: string | null;
  recordedBy: { id: string; name: string | null } | null;
  payerPhoneLast4: string | null;
  payerReference: string | null;
  strongSignal: boolean;
  deltaMinutes: number;
  /** Four-eyes hint for the UI: the viewer recorded it. */
  selfRecorded: boolean;
}

export interface CreditDTO {
  id: string;
  amount: number;
  occurredAt: string;
  channels: IngestChannel[];
  templateId: string;
  state: CreditState;
  sender: string | null;
  operatorReference: string | null;
  payerPhoneLast4: string | null;
  payerNameMasked: string | null;
  direction: CreditDirection;
  holdReason: HoldReason | null;
  account: AccountRef | null;
  branchId: string | null;
  templateStatus: "published_sample" | "pilot_verified" | "fallback";
  payerName: string | null;
  balanceAfter: number | null;
  receivingHint: string | null;
  senderKind: SenderKind;
  deviceReceivedAt: string;
  device: { id: string; label: string } | null;
  suggestedCollection: CollectionCandidate | null;
  matchedCollection: CollectionCandidate | null;
  ignoredReason: IgnoreReason | null;
  decidedBy: { id: string; name: string | null } | null;
  decidedAt: string | null;
  seenCount: number;
  createdAt: string;
}

export interface CreditDetailDTO extends CreditDTO {
  /** ≤ 10, ranked. */
  candidates: CollectionCandidate[];
  /** Owner + includeRaw only. */
  raw: { title: string | null; subtitle: string | null; body: string } | null;
}

export interface CreditsQuery {
  state?: CreditState[];
  accountId?: string;
  branchId?: string | "all";
  from?: string;
  to?: string;
  cursor?: string | null;
  limit?: number;
}

export interface MatchResult {
  credit: CreditDTO;
  collection: { id: string; status: CollectionStatus };
  warnings: ("amount_differs" | "account_differs")[];
}

export interface IgnoreBody {
  reason: IgnoreReason;
  note?: string | null;
}

export interface PasteBody {
  text: string;
  sender?: string | null;
  accountId?: string | null;
}

export interface PasteResult {
  index: number;
  status: "accepted" | "duplicate" | "dropped";
  reason?: IngestResultReason;
  creditId?: string;
  state?: CreditState;
  holdReason?: HoldReason | null;
  suggestedCollectionId?: string | null;
}

export interface UnrecognisedDTO {
  id: string;
  channel: IngestChannel;
  sourceApp: string | null;
  sender: string | null;
  senderKind: SenderKind;
  title: string | null;
  subtitle: string | null;
  body: string;
  parseStatus: "unknown_format" | "fallback";
  templateId: string | null;
  receivedAt: string;
  device: { id: string; label: string } | null;
  sharedAt: string | null;
  expiresAt: string;
}

/** GET /api/collections/credits — test credits are never listed. */
export const listCredits = (c: ApiClient, query: CreditsQuery = {}) =>
  c.request<{ data: CreditDTO[]; nextCursor: string | null }>("/api/collections/credits", {
    query: {
      state: query.state?.length ? query.state.join(",") : undefined,
      accountId: query.accountId,
      branchId: query.branchId,
      from: query.from,
      to: query.to,
      cursor: query.cursor ?? undefined,
      limit: query.limit,
    },
  });

/** GET /api/collections/credits/[id]; `includeRaw` is honoured for the owner only. */
export const getCredit = (c: ApiClient, id: string, opts: { includeRaw?: boolean } = {}) =>
  c.request<CreditDetailDTO>(`/api/collections/credits/${encodeURIComponent(id)}`, {
    query: { includeRaw: opts.includeRaw ? 1 : undefined },
  });

/** POST /api/collections/credits/[id]/match — Idempotency-Key required. */
export const matchCredit = (c: ApiClient, id: string, collectionId: string, idempotencyKey: string) =>
  c.request<MatchResult>(`/api/collections/credits/${encodeURIComponent(id)}/match`, {
    method: "POST",
    body: { collectionId },
    headers: { "Idempotency-Key": idempotencyKey },
  });

/** POST /api/collections/credits/[id]/ignore — Idempotency-Key required. */
export const ignoreCredit = (c: ApiClient, id: string, body: IgnoreBody, idempotencyKey: string) =>
  c.request<{ credit: CreditDTO }>(`/api/collections/credits/${encodeURIComponent(id)}/ignore`, {
    method: "POST",
    body,
    headers: { "Idempotency-Key": idempotencyKey },
  });

/** POST /api/collections/credits/paste — Idempotency-Key required. */
export const pasteCredits = (c: ApiClient, body: PasteBody, idempotencyKey: string) =>
  c.request<{ results: PasteResult[] }>("/api/collections/credits/paste", {
    method: "POST",
    body,
    headers: { "Idempotency-Key": idempotencyKey },
  });

/** GET /api/collections/unrecognised — owner only; decrypted text. */
export const listUnrecognised = (c: ApiClient, query: { cursor?: string | null; limit?: number } = {}) =>
  c.request<{ data: UnrecognisedDTO[]; nextCursor: string | null }>("/api/collections/unrecognised", {
    query: { cursor: query.cursor ?? undefined, limit: query.limit },
  });

/** POST /api/collections/unrecognised/[id]/share — owner only, idempotent. */
export const shareUnrecognised = (c: ApiClient, id: string) =>
  c.request<{ id: string; sharedAt: string; expiresAt: string }>(
    `/api/collections/unrecognised/${encodeURIComponent(id)}/share`,
    { method: "POST" },
  );
