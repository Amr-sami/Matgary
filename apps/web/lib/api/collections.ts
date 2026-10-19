// Browser fetch wrappers for the digital-collections routes (doc 15 spec 12
// §4.2), in the house style of lib/api/sales.ts. Same-origin cookie session;
// the names are the api-client's pinned names (03 §B.16) and every return type
// is taken TYPE-ONLY from @matgary/api-client/endpoints/collections, so a shape
// change in spec 05 is a web `tsc` error, not a runtime surprise.

import type * as api from "@matgary/api-client/endpoints/collections";
import { NO_FEATURES } from "@/components/collections/rules";
import type {
  CreditDTO,
  CreditDetailDTO,
  DeviceDTO as ApiDeviceDTO,
  PasteResult,
  UnrecognisedDTO,
} from "@matgary/api-client/endpoints/collection-credits";
import type {
  CollectionStatus as CandidateStatus,
  CreditState,
  DeviceHealth,
  IgnoreReason,
} from "@matgary/domain/collections/types";

type Result<F extends (...args: never[]) => Promise<unknown>> = Awaited<ReturnType<F>>;

export type CollectionAccount = api.CollectionAccountDTO;
export type CollectionAccountsResponse = Result<typeof api.listAccounts>;
export type CollectionDTO = Result<typeof api.updateCollection>;
export type CollectionDetail = Result<typeof api.getCollection>;
export type CollectionsPage = Result<typeof api.listCollections>;
export type CollectionsSummary = Result<typeof api.getSummary>;
export type CollectionSettings = Result<typeof api.getSettings>;
export type CollectionsConfig = Result<typeof api.getConfig>;

/** A non-2xx answer: `code` is the server's UPPER_SNAKE `error`. */
export class CollectionsApiError extends Error {
  readonly code: string | null;
  readonly status: number;
  readonly detail: string | undefined;
  constructor(init: { code: string | null; status: number; detail?: string }) {
    super(init.code ?? `HTTP ${init.status}`);
    this.name = "CollectionsApiError";
    this.code = init.code;
    this.status = init.status;
    this.detail = init.detail;
  }
}

type Query = Record<string, string | number | boolean | null | undefined>;

function withQuery(path: string, query?: Query): string {
  if (!query) return path;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "" || v === false) continue;
    qs.set(k, v === true ? "1" : String(v));
  }
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
    throw new CollectionsApiError({ code: body.error ?? null, status: res.status, detail: body.detail });
  }
  return (res.status === 204 ? null : await res.json()) as T;
}

// ---- Config / settings -------------------------------------------------------

/** GET /api/collections/config. A 404 (a server older than spec 05) reads as
 *  "feature off"; a network failure throws (TypeError) so the hook can fall
 *  back to the IndexedDB snapshot. */
export async function getConfig(): Promise<CollectionsConfig> {
  try {
    return await jsonFetch<CollectionsConfig>("/api/collections/config");
  } catch (e) {
    if (e instanceof CollectionsApiError && e.status === 404) {
      return {
        features: { ...NO_FEATURES },
        branchId: "",
        requireAccount: false,
        staleAfterMinutes: 120,
        limits: { maxParts: 4, reopenDays: 7, noteMaxLength: 280 },
        ingest: null,
      };
    }
    throw e;
  }
}

export function getSettings(branchId?: string): Promise<CollectionSettings> {
  return jsonFetch(withQuery("/api/collections/settings", { branchId }));
}

export function updateSettings(patch: api.CollectionSettingsPatch, branchId?: string): Promise<CollectionSettings> {
  return jsonFetch(withQuery("/api/collections/settings", { branchId }), {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

// ---- Accounts ----------------------------------------------------------------

export function listAccounts(params: api.ListAccountsParams = {}): Promise<CollectionAccountsResponse> {
  return jsonFetch(
    withQuery("/api/collections/accounts", { scope: params.scope, includeArchived: params.includeArchived }),
  );
}

export function createAccount(body: api.AccountCreateBody, key: string): Promise<CollectionAccount> {
  return jsonFetch("/api/collections/accounts", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Idempotency-Key": key },
  });
}

export function updateAccount(id: string, patch: api.AccountPatchBody): Promise<CollectionAccount> {
  return jsonFetch(`/api/collections/accounts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function archiveAccount(id: string): Promise<Result<typeof api.archiveAccount>> {
  return jsonFetch(`/api/collections/accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// ---- Collections -------------------------------------------------------------

export function listCollections(q: api.ListCollectionsParams = {}): Promise<CollectionsPage> {
  return jsonFetch(
    withQuery("/api/collections", {
      status: q.status,
      accountId: q.accountId,
      sourceType: q.sourceType,
      branchId: q.branchId,
      from: q.from,
      to: q.to,
      stale: q.stale,
      invoiceId: q.invoiceId,
      order: q.order,
      cursor: q.cursor,
      limit: q.limit,
    }),
  );
}

export function getCollection(id: string): Promise<CollectionDetail> {
  return jsonFetch(`/api/collections/${encodeURIComponent(id)}`);
}

export function updateCollection(id: string, body: api.UpdateCollectionBody): Promise<CollectionDTO> {
  return jsonFetch(`/api/collections/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) });
}

export function confirmCollection(id: string, body: api.ConfirmCollectionBody, key: string): Promise<CollectionDTO> {
  return jsonFetch(`/api/collections/${encodeURIComponent(id)}/confirm`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Idempotency-Key": key },
  });
}

export function rejectCollection(id: string, body: api.RejectCollectionBody, key: string): Promise<CollectionDTO> {
  return jsonFetch(`/api/collections/${encodeURIComponent(id)}/reject`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Idempotency-Key": key },
  });
}

export function reopenCollection(id: string, body: api.ReopenCollectionBody, key: string): Promise<CollectionDTO> {
  return jsonFetch(`/api/collections/${encodeURIComponent(id)}/reopen`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Idempotency-Key": key },
  });
}

export function getSummary(params: { date?: string; branchId?: string | "all" } = {}): Promise<CollectionsSummary> {
  return jsonFetch(withQuery("/api/collections/summary", { date: params.date, branchId: params.branchId }));
}

// ---- M2: credits, paste, unrecognised, devices (07 §4.5) ---------------------
//
// Types: 12 §4.2 — type-only from @matgary/api-client/endpoints/collection-credits
// (07 step 16), the wire shapes of 07 §4.6, so the web cannot drift from the
// phone clients. (Until order 19 finished they came from 07's server repos.)

export type {
  AccountRef as CreditAccountRef,
  CollectionCandidate,
  CreditDTO,
  CreditDetailDTO,
  PasteResult,
  UnrecognisedDTO,
} from "@matgary/api-client/endpoints/collection-credits";

/** The api-client widens `health` for phone builds older than the server; the
 *  web ships with its server, so it knows every value (03 §B.1). */
export type DeviceDTO = Omit<ApiDeviceDTO, "health"> & { health: DeviceHealth };

export interface CreditsPage {
  data: CreditDTO[];
  nextCursor: string | null;
}

export interface ListCreditsParams {
  /** Comma list of CreditState, e.g. "unmatched,held" (ARCH CR 3). */
  state?: string | CreditState[];
  accountId?: string;
  branchId?: string | "all";
  from?: string;
  to?: string;
  cursor?: string | null;
  limit?: number;
}

export interface MatchCreditResult {
  credit: CreditDTO;
  collection: { id: string; status: CandidateStatus };
  warnings: ("amount_differs" | "account_differs")[];
}

export interface UnrecognisedPage {
  data: UnrecognisedDTO[];
  nextCursor: string | null;
}

export function listCredits(q: ListCreditsParams = {}): Promise<CreditsPage> {
  return jsonFetch(
    withQuery("/api/collections/credits", {
      state: Array.isArray(q.state) ? q.state.join(",") : q.state,
      accountId: q.accountId,
      branchId: q.branchId,
      from: q.from,
      to: q.to,
      cursor: q.cursor,
      limit: q.limit,
    }),
  );
}

export function getCredit(id: string, opts: { includeRaw?: boolean } = {}): Promise<CreditDetailDTO> {
  return jsonFetch(withQuery(`/api/collections/credits/${encodeURIComponent(id)}`, { includeRaw: opts.includeRaw }));
}

export function matchCredit(id: string, body: { collectionId: string }, key: string): Promise<MatchCreditResult> {
  return jsonFetch(`/api/collections/credits/${encodeURIComponent(id)}/match`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Idempotency-Key": key },
  });
}

export function ignoreCredit(
  id: string,
  body: { reason: IgnoreReason; note?: string },
  key: string,
): Promise<{ credit: CreditDTO }> {
  return jsonFetch(`/api/collections/credits/${encodeURIComponent(id)}/ignore`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Idempotency-Key": key },
  });
}

export function pasteCredits(
  body: { text: string; sender?: string; accountId?: string },
  key: string,
): Promise<{ results: PasteResult[] }> {
  return jsonFetch("/api/collections/credits/paste", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Idempotency-Key": key },
  });
}

export function listUnrecognised(q: { cursor?: string | null; limit?: number } = {}): Promise<UnrecognisedPage> {
  return jsonFetch(withQuery("/api/collections/unrecognised", { cursor: q.cursor, limit: q.limit }));
}

export function shareUnrecognised(id: string): Promise<{ id: string; sharedAt: string; expiresAt: string }> {
  return jsonFetch(`/api/collections/unrecognised/${encodeURIComponent(id)}/share`, { method: "POST" });
}

export function listDevices(): Promise<{ devices: DeviceDTO[]; maxDevices: number }> {
  return jsonFetch("/api/collections/devices");
}

/** DELETE /api/collections/devices/[id] — the web lists and revokes, never creates (Q8). */
export function revokeDevice(id: string): Promise<{ ok: true; revokedAt: string }> {
  return jsonFetch(`/api/collections/devices/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** A fresh key for one dialog / modal session (03 §C.8 rule 12). */
export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}
