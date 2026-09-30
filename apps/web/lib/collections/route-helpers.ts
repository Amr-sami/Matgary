// Digital collections — small HTTP helpers shared by the /api/collections/*
// handlers (05 §4.3). Kept out of the handler bodies only where the logic is
// identical everywhere; every gate string route-gates.test.ts pins stays
// inside the handler itself.

import { NextResponse } from "next/server";
import type { ZodError } from "zod";
import { domainErrorBody, isDomainError } from "@/lib/errors";
import { isUniqueViolation } from "@/lib/api/idempotency";
import { logger } from "@/lib/logger";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A route `[id]` that is not a uuid answers the same 404 as a missing row
 *  (05 §4.3: ids cannot be probed). */
export function isUuid(v: string | null | undefined): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** Zod failure on the new routes: 400 {error:"INVALID_REQUEST", detail:{path, message}}
 *  (UPPER_SNAKE, not the raw zod message the older routes return). */
export function invalidRequest(err: ZodError): NextResponse {
  const issue = err.issues[0];
  return NextResponse.json(
    {
      error: "INVALID_REQUEST",
      detail: { path: issue ? issue.path.map(String).join(".") : "", message: issue?.message ?? "invalid" },
    },
    { status: 400 },
  );
}

/** A plain `{error}` answer (403 COLLECTIONS_DISABLED style). */
export function errorResponse(code: string, status: number, detail?: unknown): NextResponse {
  return NextResponse.json(detail === undefined ? { error: code } : { error: code, detail }, { status });
}

/**
 * The catch block every collections handler shares: DomainError → its code
 * and status; the account unique indexes → 409 COLLECTION_ACCOUNT_DUPLICATE
 * (a race past the repo's own check); anything else → 500 INTERNAL, logged.
 */
export function handleRouteError(err: unknown, route: string): NextResponse {
  if (isDomainError(err)) {
    return NextResponse.json(domainErrorBody(err), { status: err.httpStatus });
  }
  if (
    isUniqueViolation(err, "collection_accounts_tenant_msisdn_uq") ||
    isUniqueViolation(err, "collection_accounts_tenant_provider_last4_uq")
  ) {
    return NextResponse.json({ error: "COLLECTION_ACCOUNT_DUPLICATE" }, { status: 409 });
  }
  logger.error({
    event: "collections.route_failed",
    route,
    err: err instanceof Error ? err.message : String(err),
  });
  return NextResponse.json(
    { error: "INTERNAL", detail: err instanceof Error ? err.message : String(err) },
    { status: 500 },
  );
}

/** The branches a caller may see collections / accounts of: null = every
 *  branch of the tenant (owners), else the staff allow-list. */
export function accessibleBranches(ctx: {
  role: string | null;
  allowedBranchIds: string[];
}): string[] | null {
  return ctx.role === "owner" ? null : ctx.allowedBranchIds;
}
