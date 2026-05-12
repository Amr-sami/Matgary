// Meta WhatsApp Cloud API webhook receiver.
//
//   GET  — subscription challenge. Meta sends `hub.mode=subscribe&
//          hub.challenge=<n>&hub.verify_token=<t>`; we echo the challenge
//          iff the verify token matches WHATSAPP_WEBHOOK_VERIFY_TOKEN.
//   POST — event delivery. We MUST:
//            1. Read the raw body before parsing (signature is over bytes).
//            2. Verify X-Hub-Signature-256 (HMAC-SHA256, key=app secret).
//            3. Reject invalid signatures with 401 BEFORE parsing.
//            4. Parse, extract one event per message/status, persist each
//               idempotently into wa_webhook_events.
//            5. ACK 200 to Meta as fast as possible.
//            6. Kick off processing asynchronously so the ACK isn't
//               blocked by DB writes for inbound message normalisation.
//
// Phase 2 runs the "kick off processing" step via setImmediate inside the
// same Next.js process. Phase 3 will replace that with a BullMQ enqueue
// — the shape of processEvent(eventId) is queue-friendly already.

import { NextResponse, type NextRequest } from "next/server";
import { verifyWebhookSignature, SIGNATURE_HEADER } from "@/lib/whatsapp/webhook-signature";
import { extractEvents } from "@/lib/whatsapp/webhook-events";
import {
  persistEvent,
  processEvent,
} from "@/lib/whatsapp/webhook-processor";
import type { MetaWebhookEnvelope } from "@/lib/whatsapp/webhook-types";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
// Force dynamic so Next doesn't try to cache anything. Webhooks must
// always hit the handler.
export const dynamic = "force-dynamic";

// ─── GET: subscription challenge ─────────────────────────────────────────

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (!expected) {
    logger.error({
      event: "webhook.verify.misconfigured",
      reason: "WHATSAPP_WEBHOOK_VERIFY_TOKEN is not set",
    });
    return new NextResponse("Server misconfigured", { status: 500 });
  }

  if (mode !== "subscribe" || token !== expected) {
    logger.warn({
      event: "webhook.verify.rejected",
      hasMode: !!mode,
      hasToken: !!token,
      modeMatch: mode === "subscribe",
    });
    return new NextResponse("Forbidden", { status: 403 });
  }

  logger.info({ event: "webhook.verify.ok" });
  // Meta wants the raw challenge string echoed.
  return new NextResponse(challenge ?? "", {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

// ─── POST: event delivery ────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const receivedAt = Date.now();

  // 1. Raw body — MUST come before any JSON parse so the signature
  //    verifies against the exact bytes Meta hashed.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (err) {
    logger.warn({
      event: "webhook.receive.body_read_failed",
      reason: err instanceof Error ? err.message : String(err),
    });
    return new NextResponse("Bad Request", { status: 400 });
  }

  // 2. Signature.
  const sig = req.headers.get(SIGNATURE_HEADER);
  const verify = verifyWebhookSignature(
    rawBody,
    sig,
    process.env.META_APP_SECRET,
  );
  if (!verify.ok) {
    logger.warn({
      event: "webhook.signature.invalid",
      reason: verify.reason,
      hasHeader: !!sig,
      bodyLength: rawBody.length,
    });
    // Return 401 (not 403) so the operator can distinguish signature
    // failures from verify-token failures in their access logs.
    return new NextResponse("Invalid signature", { status: 401 });
  }

  // 3. Parse. Malformed JSON after a valid signature is unusual — but
  //    we still 200 so Meta doesn't keep retrying garbage; the body is
  //    logged once for forensics.
  let envelope: MetaWebhookEnvelope;
  try {
    envelope = JSON.parse(rawBody);
  } catch (err) {
    logger.error({
      event: "webhook.receive.json_parse_failed",
      reason: err instanceof Error ? err.message : String(err),
      bodyLength: rawBody.length,
    });
    return new NextResponse("OK", { status: 200 });
  }

  // 4. Extract — one logical event per message or status.
  const events = extractEvents(envelope);
  logger.info({
    event: "webhook.receive.ok",
    eventCount: events.length,
    object: envelope.object ?? null,
    durationMs: Date.now() - receivedAt,
  });

  // 5. Persist all events synchronously so Meta-side retries dedupe
  //    correctly. The DB writes are small (one upsert per event); on a
  //    typical batch (1-3 events) this is well under 50ms.
  const persisted: Array<{ id: string; ev: typeof events[number] }> = [];
  for (const ev of events) {
    try {
      const r = await persistEvent(ev);
      if (r.id) persisted.push({ id: r.id, ev });
    } catch (err) {
      logger.error({
        event: "webhook.receive.persist_failed",
        providerEventId: ev.providerEventId,
        reason: err instanceof Error ? err.message : String(err),
      });
      // Continue persisting the others — we want as many events durable
      // as possible before ACKing.
    }
  }

  // 6. ACK Meta immediately. Heavy lifting (message normalisation,
  //    inbound classification) runs after the response is sent.
  //    setImmediate keeps the work on the same Node loop without holding
  //    the response open. Phase 3 swaps this for BullMQ enqueue.
  for (const { id } of persisted) {
    setImmediate(() => {
      processEvent(id).catch((err) => {
        logger.error({
          event: "webhook.process.unhandled",
          eventId: id,
          reason: err instanceof Error ? err.message : String(err),
        });
      });
    });
  }

  return new NextResponse(null, { status: 200 });
}
