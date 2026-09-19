// GET /api/whatsapp/webhook/events?status=quarantined&scope=tenant&limit=50
//
// Admin inspection endpoint over wa_webhook_events. Owner-only. Two
// scopes:
//   - scope=tenant  (default): filter to the caller's tenant_id
//   - scope=quarantine: only the unrouted rows (tenant_id IS NULL). Owners
//                       see them so they can diagnose connection misses.
//
// We never expose another tenant's rows. The 'quarantine' scope is the
// one exception — but those rows have no tenant by definition, so
// listing them isn't a cross-tenant leak.

import { NextResponse, type NextRequest } from "next/server";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import { listEvents, type ProcessingStatus } from "@/lib/whatsapp/webhook-events";

export const runtime = "nodejs";

const ALLOWED_STATUSES: Array<ProcessingStatus | "all"> = [
  "all",
  "pending",
  "processing",
  "processed",
  "failed",
  "quarantined",
  "dead_letter",
];

export async function GET(req: NextRequest) {
  const auth = await requireTenantWithBranch();
  if (!auth.ok) return auth.response;
  if (auth.ctx.role !== "owner") {
    return NextResponse.json(
      { ok: false, error: "Owner role required" },
      { status: 403 },
    );
  }

  const url = new URL(req.url);
  const statusRaw = url.searchParams.get("status") ?? "all";
  const scope = url.searchParams.get("scope") ?? "tenant";
  const limit = Number(url.searchParams.get("limit") ?? "50");

  if (
    !ALLOWED_STATUSES.includes(statusRaw as ProcessingStatus | "all") &&
    statusRaw !== "all"
  ) {
    return NextResponse.json(
      { ok: false, error: `Invalid status. Expected one of: ${ALLOWED_STATUSES.join(", ")}` },
      { status: 400 },
    );
  }
  if (scope !== "tenant" && scope !== "quarantine") {
    return NextResponse.json(
      { ok: false, error: "scope must be 'tenant' or 'quarantine'" },
      { status: 400 },
    );
  }

  const rows = await listEvents({
    status: statusRaw as ProcessingStatus | "all",
    tenantId: scope === "quarantine" ? null : auth.ctx.tenantId,
    limit: Number.isFinite(limit) ? limit : 50,
  });

  // Truncate payloads in the listing so the response doesn't balloon.
  // Inspectors can request a single row later via id (Phase-3 endpoint).
  return NextResponse.json({
    ok: true,
    scope,
    status: statusRaw,
    count: rows.length,
    events: rows.map((r) => ({
      id: r.id,
      providerEventId: r.providerEventId,
      eventType: r.eventType,
      processingStatus: r.processingStatus,
      tenantId: r.tenantId,
      branchId: r.branchId,
      phoneNumberId: r.phoneNumberId,
      wabaId: r.wabaId,
      retryCount: r.retryCount,
      errorDetails: r.errorDetails,
      receivedAt: r.receivedAt,
      processedAt: r.processedAt,
      payloadPreview: truncatePayload(r.payload),
    })),
  });
}

function truncatePayload(p: Record<string, unknown>): Record<string, unknown> {
  // Cap each top-level value to ~1KB stringified so a runaway webhook
  // can't blow up the inspection response. Reading the full payload is
  // out of scope for Phase 2; admins can fall back to DB inspection.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    const s = JSON.stringify(v);
    if (s && s.length > 1024) {
      out[k] = `[truncated ${s.length}B]`;
    } else {
      out[k] = v;
    }
  }
  return out;
}
