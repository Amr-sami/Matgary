import { auth, resolveTenantContext } from "@/lib/auth";
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import type { Permission } from "@/lib/permissions";
import { can } from "@/lib/permissions";
import { logger } from "@/lib/logger";
import {
  ACCESS_TTL_SEC,
  bearerFromHeader,
  verifyAccessToken,
} from "@/lib/api/native-token";
import { cacheGet, cacheSet, globalKey } from "@/lib/cache";
import {
  enterRequestContext,
  getRequestContext,
  setRequestContext,
} from "@/lib/request-context";
import {
  resolveActiveBranchResult,
  type BranchContext,
} from "./branch-context";

/**
 * Ensure the in-flight request has an AsyncLocalStorage context. The
 * middleware stamps `x-request-id` on the request headers; if no context
 * is already active for this async-boundary, we open one with `enterWith`
 * so every downstream await in the same handler sees the same request id.
 *
 * Idempotent — `requireTenant` (called by every route) invokes this, and
 * `requireTenantWithBranch` / `requirePermission` re-call without re-entry.
 */
async function ensureRequestContext(
  patch?: Partial<{ tenantId: string; userId: string }>,
): Promise<void> {
  const existing = getRequestContext();
  if (existing) {
    if (patch) setRequestContext(patch);
    return;
  }
  let reqId: string | null = null;
  try {
    const h = await headers();
    reqId = h.get("x-request-id");
  } catch {
    reqId = null;
  }
  enterRequestContext({
    requestId: reqId || crypto.randomUUID(),
    ...(patch ?? {}),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Instant revocation (doc 14 §10 H4)
//
// Access tokens are verified statelessly, so a device the user revoked kept
// working for the remaining life of its token (≤ ACCESS_TTL_SEC). This is the
// small stateful supplement: every revocation path (sign out this device,
// sign out everywhere, password change, 2FA toggle) drops a marker in Redis
// keyed by the device row id (`did` claim) or the user id, with the access
// TTL as its lifetime — by the time it expires, no token minted before the
// revocation can still be valid. The bearer path consults both markers after
// the signature check and answers 401 REVOKED.
//
// Fail-open, on purpose: lib/cache already swallows every Redis error into a
// miss/no-op, so an outage degrades to the pre-H4 behaviour (revocation lands
// at the next refresh) rather than locking every native client out.
// ─────────────────────────────────────────────────────────────────────────────

/** `revoked:did:<deviceId>` — the auth_devices row an access token names. */
export function revokedDeviceKey(deviceId: string): string {
  return globalKey("revoked", "did", deviceId);
}

/** `revoked:uid:<userId>` — every device of the user, set on a token_version
 *  bump. */
export function revokedUserKey(userId: string): string {
  return globalKey("revoked", "uid", userId);
}

/** Marker value: when (ms since epoch) the revocation happened. */
interface RevokedMark {
  at: number;
}

/** Mark auth_devices rows as revoked for the access-token lifetime. Empty
 *  ids (a token minted without a device row) are skipped. Never throws. */
export async function markDevicesRevoked(deviceIds: readonly string[]): Promise<void> {
  const ids = deviceIds.filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length === 0) return;
  const mark: RevokedMark = { at: Date.now() };
  try {
    await Promise.all(ids.map((id) => cacheSet(revokedDeviceKey(id), mark, ACCESS_TTL_SEC)));
  } catch (err) {
    logger.warn({ event: "auth.revocation_mark_failed", scope: "device", err: String(err) });
  }
}

/** Mark every access token of a user minted up to NOW as revoked, for the
 *  access-token lifetime — the companion of a users.token_version bump. A
 *  token the user mints afterwards (logging back in within the 15 minutes)
 *  carries a later `iat` and passes. Never throws. */
export async function markUserRevoked(userId: string): Promise<void> {
  if (!userId) return;
  const mark: RevokedMark = { at: Date.now() };
  try {
    await cacheSet(revokedUserKey(userId), mark, ACCESS_TTL_SEC);
  } catch (err) {
    logger.warn({ event: "auth.revocation_mark_failed", scope: "user", err: String(err) });
  }
}

/** Pure verdict for the user-level marker: a token is revoked when it was
 *  issued in a second EARLIER than the mark. `iat` is unix SECONDS (JWT), the
 *  mark is ms, so both are compared at second precision: a token minted in the
 *  same second as the revocation passes — the only session that can be is the
 *  one the user is minting right now (sign-out-everywhere followed by an
 *  immediate sign-in, or 2FA enable in the app, which bumps token_version and
 *  is followed by the re-login the app forces); refusing it locked that user
 *  out for the whole 15-minute window. A token with no readable iat (0) is old
 *  by definition. A marker without a timestamp (never written by this code,
 *  kept for robustness) revokes unconditionally. */
export function issuedBeforeMark(iatSec: number | undefined, mark: unknown): boolean {
  const at = (mark as RevokedMark | null | undefined)?.at;
  if (typeof at !== "number") return true;
  return (iatSec ?? 0) < Math.floor(at / 1000);
}

/** True when the device marker is present, or the user marker is present
 *  and the token predates it. A Redis error reads as "not revoked" (cacheGet
 *  returns null on failure) — see the fail-open note above. */
export async function isRevoked(
  userId: string,
  deviceId: string,
  iatSec?: number,
): Promise<boolean> {
  try {
    const [byUser, byDevice] = await Promise.all([
      cacheGet<unknown>(revokedUserKey(userId)),
      deviceId ? cacheGet<unknown>(revokedDeviceKey(deviceId)) : Promise.resolve(null),
    ]);
    if (byDevice != null) return true;
    return byUser != null && issuedBeforeMark(iatSec, byUser);
  } catch (err) {
    logger.warn({ event: "auth.revocation_check_failed", err: String(err) });
    return false;
  }
}

/**
 * A gate that WOULD have blocked this request, had the route not opted out of
 * it via `ResolveOptions`. Only /api/v1/me (and the routes the walls point at)
 * opt out, so they can tell the client which wall it is standing behind.
 */
export type BypassedWall = "PASSWORD_CHANGE_REQUIRED" | "SUBSCRIPTION_REQUIRED";

export type AuthedContext = {
  userId: string;
  tenantId: string;
  role: string | null;
  permissions: Permission[];
  /** Gates skipped for this request — see BypassedWall. Empty for a cookie
   *  session (middleware.ts already enforced them) and for any route that did
   *  not opt out. Optional so hand-built contexts (tests, jobs) stay valid. */
  walls?: readonly BypassedWall[];
};

export type AuthedBranchContext = AuthedContext & {
  branchId: string;
  branchName: string;
  isPrimaryBranch: boolean;
  /** Every branch this user can switch to right now. Useful for sending the
   *  current allow-list back to the client without an extra round-trip. */
  allowedBranchIds: string[];
};

/** Resolve session and require an authenticated user with a tenant. */
/**
 * Resolve the caller from EITHER transport.
 *
 * `Authorization: Bearer <jwt>` is checked first — that is the native client.
 * Anything else falls through to the Auth.js cookie session, so the web app's
 * behaviour is bit-for-bit unchanged: no header means the original code path.
 *
 * This is the single place the two planes meet. Every one of the 165 route
 * handlers inherits bearer support from here without being touched, because
 * they all go through requireTenant / requirePermission / requireTenantWithBranch.
 */
type SessionResult =
  | { kind: "none" }
  /** A correctly signed access token whose device or user was revoked since
   *  it was minted (H4). 401, distinct from "none" so the client signs out
   *  instead of retrying the refresh. */
  | { kind: "revoked" }
  | { kind: "ok"; ctx: AuthedContext }
  /** A valid token whose tenant/account state blocks the request. Mirrors the
   *  bodies middleware returns for cookie sessions, so a client handles one
   *  contract regardless of transport. */
  | {
      kind: "blocked";
      code: "TENANT_SUSPENDED" | "PASSWORD_CHANGE_REQUIRED" | "SUBSCRIPTION_REQUIRED";
      status: 402 | 403;
      /** Human text for the client to show verbatim. Today only the
       *  suspension reason the platform admin typed (Spec 03). */
      detail?: string | null;
    };

export type ResolveOptions = {
  /** Let a caller with the `mcp` (must-change-password) claim through. The
   *  change-password route sets this — it is the one request such a user must
   *  be able to make, exactly as middleware.ts exempts /api/account/password
   *  for cookie sessions — and so does /api/v1/me, which has to answer so the
   *  native app can seed a session and route to the change-password screen
   *  instead of stranding the user on login. */
  allowPasswordChangeRequired?: boolean;
  /** Let a caller whose subscription has lapsed (`sub_ok: false`) through.
   *  /api/v1/me and /api/billing/me set this: the web still renders the
   *  billing page under a lapsed subscription (only API writes 402), and the
   *  native billing screen needs the same two reads to render at all. */
  allowSubscriptionRequired?: boolean;
};

async function resolveSession(opts: ResolveOptions = {}): Promise<SessionResult> {
  const h = await headers();
  const bearer = bearerFromHeader(h.get("authorization"));
  if (bearer) {
    const claims = await verifyAccessToken(bearer);
    // A present-but-invalid bearer is NOT silently downgraded to the cookie
    // path: that would let an expired native token borrow a browser session
    // that happened to be attached to the same request.
    if (!claims) return { kind: "none" };

    // H4 — instant revocation. Consulted right after the signature check so
    // a revoked device cannot even learn which wall it stands behind.
    if (await isRevoked(claims.sub, claims.did, claims.iat)) {
      logger.info({
        event: "native_auth.access_revoked",
        userId: claims.sub,
        deviceId: claims.did || null,
      });
      return { kind: "revoked" };
    }

    // middleware.ts applies these three gates to cookie sessions and skips
    // them for bearer requests, because the edge runtime cannot verify the
    // token. They are enforced here instead, in the same order, so the two
    // transports are behaviourally identical.
    if (claims.susp) {
      // The web shows `tenantSuspendedReason` off the NextAuth session; a
      // bearer has no session, so the reason rides on the 403 body instead.
      // Cached ~60s in resolveTenantContext and only ever hit on the
      // suspended path, so it costs nothing on the hot path. Best-effort: a
      // failed lookup still answers 403 TENANT_SUSPENDED, just without text.
      let detail: string | null = null;
      try {
        detail = (await resolveTenantContext(claims.sub)).tenantSuspendedReason;
      } catch {
        detail = null;
      }
      return { kind: "blocked", code: "TENANT_SUSPENDED", status: 403, detail };
    }
    const walls: BypassedWall[] = [];
    if (claims.mcp) {
      if (!opts.allowPasswordChangeRequired) {
        return { kind: "blocked", code: "PASSWORD_CHANGE_REQUIRED", status: 403 };
      }
      walls.push("PASSWORD_CHANGE_REQUIRED");
    }
    if (!claims.sub_ok) {
      if (!opts.allowSubscriptionRequired) {
        return { kind: "blocked", code: "SUBSCRIPTION_REQUIRED", status: 402 };
      }
      walls.push("SUBSCRIPTION_REQUIRED");
    }

    return {
      kind: "ok",
      ctx: {
        userId: claims.sub,
        tenantId: claims.tenantId,
        role: claims.role,
        permissions: claims.permissions,
        walls,
      },
    };
  }

  const session = await auth();
  if (!session?.user?.id || !session.user.tenantId) return { kind: "none" };
  return {
    kind: "ok",
    ctx: {
      userId: session.user.id,
      tenantId: session.user.tenantId,
      role: session.user.role,
      permissions: (session.user.permissions ?? []) as Permission[],
      walls: [],
    },
  };
}

export async function requireTenant(opts: ResolveOptions = {}): Promise<
  | { ok: true; ctx: AuthedContext }
  | { ok: false; response: NextResponse }
> {
  // Open the per-request ALS scope so every downstream log line carries
  // the request id (+ tenantId/userId once we know them).
  await ensureRequestContext();
  const r = await resolveSession(opts);
  if (r.kind === "none") {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  if (r.kind === "revoked") {
    return { ok: false, response: NextResponse.json({ error: "REVOKED" }, { status: 401 }) };
  }
  if (r.kind === "blocked") {
    return {
      ok: false,
      response: NextResponse.json(
        r.detail ? { error: r.code, detail: r.detail } : { error: r.code },
        { status: r.status },
      ),
    };
  }
  setRequestContext({ tenantId: r.ctx.tenantId, userId: r.ctx.userId });
  return { ok: true, ctx: r.ctx };
}

/**
 * Require a logged-in user with at least one of the given permissions.
 * Owner role bypasses the check (owns everything in their tenant).
 */
export async function requirePermission(perm: Permission): Promise<
  | { ok: true; ctx: AuthedContext }
  | { ok: false; response: NextResponse }
> {
  const auth = await requireTenant();
  if (!auth.ok) return auth;
  if (!can(auth.ctx, perm)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }
  return auth;
}

/**
 * Like `requireTenant`, but also resolves the active branch from the
 * `mg.branch` cookie (with primary-branch fallback). Use this for any
 * route that records or reads branch-scoped data — sales, expenses,
 * attendance, per-branch inventory.
 *
 * Returns 403 NO_BRANCH_ACCESS only when the user genuinely has zero
 * accessible branches (a misconfigured staff row); the migration guarantees
 * every tenant has a primary branch, so owners never hit this. A native
 * caller whose X-Branch-Id names a branch it cannot use (unknown, foreign,
 * deactivated) gets 400 INVALID_BRANCH instead of a silent primary swap —
 * see resolveActiveBranchResult.
 */
export async function requireTenantWithBranch(opts: ResolveOptions = {}): Promise<
  | { ok: true; ctx: AuthedBranchContext }
  | { ok: false; response: NextResponse }
> {
  const r = await requireTenant(opts);
  if (!r.ok) return r;
  const res = await resolveActiveBranchResult(r.ctx);
  if (!res.ok) {
    return {
      ok: false,
      response: NextResponse.json({ error: res.error }, { status: res.status }),
    };
  }
  const branch = res.branch;
  return {
    ok: true,
    ctx: {
      ...r.ctx,
      branchId: branch.branchId,
      branchName: branch.branchName,
      isPrimaryBranch: branch.isPrimary,
      allowedBranchIds: branch.allowedBranchIds,
    },
  };
}

export type { BranchContext };

/**
 * `requirePermission`, for routes that also need the active branch.
 *
 * Every branch-scoped WRITE — sales, products, expenses, returns, catalogue —
 * went through requireTenantWithBranch() with no permission check at all,
 * because the only permission helper was built on plain requireTenant() and
 * cannot resolve a branch. The web UI was the sole gate. A native client is not
 * the UI, so a staff member without `record_sales` could POST a sale by hand.
 *
 * AUDIT MODE FIRST (doc 01 §9 step 10). Enforcing on day one would lock out
 * any staff row whose permissions array was never curated because nothing ever
 * read it. So until PERMISSION_ENFORCE_WRITES=1, a denial is logged with
 * enough context to find the row and the request proceeds. Run it for a week,
 * grep the logs, fix the rows, then flip the flag.
 */
export async function requirePermissionWithBranch(perm: Permission): Promise<
  | { ok: true; ctx: AuthedBranchContext }
  | { ok: false; response: NextResponse }
> {
  const auth = await requireTenantWithBranch();
  if (!auth.ok) return auth;
  if (can(auth.ctx, perm)) return auth;

  const enforce = process.env.PERMISSION_ENFORCE_WRITES === "1";
  logger.warn({
    event: enforce ? "permission.denied" : "permission.would_deny",
    permission: perm,
    userId: auth.ctx.userId,
    tenantId: auth.ctx.tenantId,
    branchId: auth.ctx.branchId,
    role: auth.ctx.role,
    enforced: enforce,
  });
  if (!enforce) return auth;

  return {
    ok: false,
    response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
  };
}

/** requirePermission with the same audit-mode switch, for routes without a branch. */
export async function requirePermissionAudited(perm: Permission): Promise<
  | { ok: true; ctx: AuthedContext }
  | { ok: false; response: NextResponse }
> {
  const auth = await requireTenant();
  if (!auth.ok) return auth;
  if (can(auth.ctx, perm)) return auth;

  const enforce = process.env.PERMISSION_ENFORCE_WRITES === "1";
  logger.warn({
    event: enforce ? "permission.denied" : "permission.would_deny",
    permission: perm,
    userId: auth.ctx.userId,
    tenantId: auth.ctx.tenantId,
    role: auth.ctx.role,
    enforced: enforce,
  });
  if (!enforce) return auth;
  return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
}
