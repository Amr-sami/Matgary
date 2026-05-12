// POST /api/whatsapp/webhook/events/[id]/replay
//
// Owner-only. Re-runs tenant resolution on a quarantined webhook event
// after the operator has fixed the underlying mis-routing (typically by
// completing OAuth on the right branch). Either:
//   - enqueues a quarantine.replay job (preferred — worker re-resolves
//     + re-processes), or
//   - runs inline when Redis is off.
//
// We don't expose this for *any* event status because re-processing a
// row that already succeeded is a footgun. Replay is quarantine-only.

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { waWebhookEvents } from "@/lib/db/schema";
import { requireTenantWithBranch } from "@/lib/api/auth-helpers";
import {
  enqueueQuarantineReplay,
  isQueueEnabled,
} from "@/lib/whatsapp/queue";
import {
  processEvent,
  resolveTenant,
} from "@/lib/whatsapp/webhook-processor";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireTenantWithBranch();
  if (!auth.ok) return auth.response;
  if (auth.ctx.role !== "owner") {
    return NextResponse.json(
      { ok: false, error: "Owner role required" },
      { status: 403 },
    );
  }

  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ ok: false, error: "Missing id" }, { status: 400 });
  }

  const [row] = await db
    .select()
    .from(waWebhookEvents)
    .where(eq(waWebhookEvents.id, id))
    .limit(1);
  if (!row) {
    return NextResponse.json({ ok: false, error: "Not found" }, { status: 404 });
  }
  if (row.processingStatus !== "quarantined") {
    return NextResponse.json(
      { ok: false, error: `Cannot replay a ${row.processingStatus} event` },
      { status: 400 },
    );
  }

  logger.info({
    event: "wa.webhook.replay.requested",
    eventId: row.id,
    requestedByUserId: auth.ctx.userId,
    requestedByTenantId: auth.ctx.tenantId,
  });

  if (isQueueEnabled()) {
    const job = await enqueueQuarantineReplay({ eventId: row.id });
    return NextResponse.json({
      ok: true,
      mode: "queued",
      jobId: job?.id ?? null,
    });
  }

  // Inline path mirrors the worker handler in lib/whatsapp/jobs.ts.
  const resolved = await resolveTenant(row.phoneNumberId, row.wabaId);
  if (!resolved) {
    return NextResponse.json({
      ok: false,
      mode: "inline",
      error: "Still unrouted — no connection matches phone_number_id / waba_id",
    });
  }
  await db
    .update(waWebhookEvents)
    .set({
      tenantId: resolved.tenantId,
      branchId: resolved.branchId,
      connectionId: resolved.connection.id,
      processingStatus: "pending",
      errorDetails: null,
      updatedAt: new Date(),
    })
    .where(eq(waWebhookEvents.id, row.id));
  await processEvent(row.id);

  return NextResponse.json({
    ok: true,
    mode: "inline",
    tenantId: resolved.tenantId,
    branchId: resolved.branchId,
  });
}
