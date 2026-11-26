import { NextRequest, NextResponse } from "next/server";
import { requireIngestDevice } from "@/lib/api/ingest-token";
import { INGEST_MAX_BYTES, INGEST_MAX_MESSAGES, ingestBodySchema } from "@/lib/collections/credit-schemas";
import { handleRouteError, invalidRequest } from "@/lib/collections/route-helpers";
import { ingestMessages } from "@/lib/repo/collection-ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/v1/collections/ingest — a registered phone forwards bank / wallet
// messages (doc 15 spec 07 §4.5, §4.7; 03 §B.17, §C.2).
//
// Authorization: Bearer mgi_<43> (an INGEST token, never a user session; no
// requireTenant* here). Body {v:1, messages: 1..50}; ≤ 262,144 bytes (checked
// on content-length AND on the bytes read) and > 50 messages → 413
// INGEST_PAYLOAD_TOO_LARGE. Each body is truncated to 2,000 characters
// server-side. → 200 {results:[{fp, status, reason?}]}.
//
// Phone semantics: 401 → stop and set up again; 403 → keep the queue, retry
// after the next heartbeat; 413 / 400 → drop the batch; 429 / 5xx → back off
// and retry (dedupe makes retries safe).

function tooLarge(detail: string) {
  return NextResponse.json({ error: "INGEST_PAYLOAD_TOO_LARGE", detail }, { status: 413 });
}

export async function POST(req: NextRequest) {
  const auth = await requireIngestDevice(req, "ingest.device");
  if (!auth.ok) return auth.response;

  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > INGEST_MAX_BYTES) return tooLarge("bytes");
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > INGEST_MAX_BYTES) return tooLarge("bytes");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "INVALID_REQUEST", detail: { path: "", message: "not JSON" } }, { status: 400 });
  }
  const count = (json as { messages?: unknown })?.messages;
  if (Array.isArray(count) && count.length > INGEST_MAX_MESSAGES) return tooLarge("messages");
  const parsed = ingestBodySchema.safeParse(json);
  if (!parsed.success) return invalidRequest(parsed.error);

  try {
    const out = await ingestMessages(
      auth.dev,
      parsed.data.messages.map((m) => ({
        fp: m.fp,
        channel: m.channel,
        sourceApp: m.sourceApp,
        sender: m.sender,
        title: m.title,
        subtitle: m.subtitle,
        body: m.body,
        receivedAt: m.receivedAt,
        test: m.test,
      })),
    );
    return NextResponse.json(out);
  } catch (err) {
    return handleRouteError(err, "POST /api/v1/collections/ingest");
  }
}
