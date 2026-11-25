// POST /api/ai/transcribe
//
// Voice input modality for the existing Storo AI Agent.
//
//   mobile mic → audio bytes → base64 JSON → this route → Gemini → text
//                                                                   ↓
//                                      (returned to mobile composer as a draft,
//                                       user edits if needed, user presses Send,
//                                       the EXISTING /api/ai/chat pipeline runs)
//
// This route:
//   • authenticates the caller (`view_insights` — same gate as /api/ai/chat),
//   • validates mime + size + duration,
//   • rate-limits per-tenant to prevent a stuck device from burning tokens,
//   • calls the Gemini multimodal transcriber,
//   • returns a plain `{ text, model, audioBytes, durationMs }`.
//
// It does NOT interpret the transcript. It does NOT route to tools. It does
// NOT touch the DB. Voice is strictly an input modality; the Agent's business
// logic is unchanged.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/api/auth-helpers";
import { rateLimit } from "@/lib/ratelimit";
import { clientIp } from "@/lib/request-ip";
import {
  MAX_AUDIO_BYTES,
  TranscribeError,
  transcribeAudio,
} from "@/lib/ai/providers/transcribe";
import { newRequestId } from "@/lib/ai/telemetry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  /** Base64-encoded audio bytes. Matches the existing /api/ai/import/upload
   *  shape so the mobile HTTP client doesn't need new multipart plumbing. */
  audioBase64: z.string().min(16),
  /** Audio container mime type. Validated again inside the transcriber. */
  mimeType: z.string().min(1).max(60),
  /** Optional — client-measured recording duration in ms. Used only for
   *  telemetry / UI echo; the transcriber doesn't consume it. */
  durationMs: z.number().int().min(100).max(10 * 60 * 1000).optional(),
  /** Optional language hint. Default "ar". */
  languageHint: z.enum(["ar", "en"]).optional(),
});

/** Per-tenant rate limit. A stuck device that re-records every second
 *  shouldn't drain the project's Gemini quota. 20/min is generous for a
 *  human pressing-and-releasing the mic button. */
const RATE_LIMIT = { limit: 20, windowSec: 60 };

export async function POST(req: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  const auth = await requirePermission("view_insights");
  if (!auth.ok) {
    auth.response.headers.set("X-Ai-Request-Id", requestId);
    return auth.response;
  }

  // Rate limit by tenant AND client ip so one owner can't accidentally
  // DoS the whole project from one device left running.
  const h = await req.headers;
  const ipKey = `${auth.ctx.tenantId}:${clientIp(h)}`;
  const rl = await rateLimit("ai.transcribe", ipKey, RATE_LIMIT);
  if (!rl.ok) {
    return NextResponse.json(
      { error: "RATE_LIMITED", requestId },
      { status: 429, headers: { "X-Ai-Request-Id": requestId } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "INVALID_JSON", requestId },
      { status: 400, headers: { "X-Ai-Request-Id": requestId } },
    );
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "INVALID_BODY", issue: parsed.error.issues[0]?.message ?? "invalid", requestId },
      { status: 400, headers: { "X-Ai-Request-Id": requestId } },
    );
  }

  // Decode once, before hitting the provider, so an oversized clip rejects
  // fast with a clear status instead of eating a provider round-trip.
  let audio: Buffer;
  try {
    audio = Buffer.from(parsed.data.audioBase64, "base64");
  } catch {
    return NextResponse.json(
      { error: "INVALID_AUDIO_B64", requestId },
      { status: 400, headers: { "X-Ai-Request-Id": requestId } },
    );
  }
  if (audio.byteLength < 100) {
    return NextResponse.json(
      { error: "AUDIO_TOO_SHORT", requestId },
      { status: 400, headers: { "X-Ai-Request-Id": requestId } },
    );
  }
  if (audio.byteLength > MAX_AUDIO_BYTES) {
    return NextResponse.json(
      { error: "AUDIO_TOO_LARGE", maxBytes: MAX_AUDIO_BYTES, requestId },
      { status: 413, headers: { "X-Ai-Request-Id": requestId } },
    );
  }

  try {
    const result = await transcribeAudio({
      audio: new Uint8Array(audio),
      mimeType: parsed.data.mimeType,
      languageHint: parsed.data.languageHint ?? "ar",
    });
    return NextResponse.json(
      {
        text: result.text,
        model: result.model,
        audioBytes: result.audioBytes,
        durationMs: parsed.data.durationMs ?? null,
        requestId,
      },
      { status: 200, headers: { "X-Ai-Request-Id": requestId } },
    );
  } catch (err) {
    if (err instanceof TranscribeError) {
      const status =
        err.code === "UNSUPPORTED_MIME"
          ? 415
          : err.code === "AUDIO_TOO_LARGE"
            ? 413
            : err.code === "NO_PROVIDER_KEY"
              ? 503
              : err.code === "EMPTY_TRANSCRIPT"
                ? 422
                : 502;
      return NextResponse.json(
        { error: err.code, requestId },
        { status, headers: { "X-Ai-Request-Id": requestId } },
      );
    }
    // Unknown provider error — don't leak details.
    console.error("[ai/transcribe] unexpected error", err);
    return NextResponse.json(
      { error: "INTERNAL", requestId },
      { status: 500, headers: { "X-Ai-Request-Id": requestId } },
    );
  }
}
