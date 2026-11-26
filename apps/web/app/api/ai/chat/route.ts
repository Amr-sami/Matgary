import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/api/auth-helpers";
import { isTransientlyBusy, runAgent } from "@/lib/ai/agent";
import type { AgentContext } from "@/lib/ai/context";
import { tr } from "@/lib/ai/i18n";
import { detectLocale } from "@/lib/ai/language";
import { getActiveProvider, NoProviderKeyError } from "@/lib/ai/providers";
import { newRequestId, redactError } from "@/lib/ai/telemetry";
import { rateLimit } from "@/lib/ratelimit";

/**
 * AI agent entrypoint ("اسأل عمرو").
 *
 * Thin handler: auth → body validation → locale detection → delegate to
 * `runAgent`. The agent runner owns the tool-call loop, locale lock, block
 * composition, provider selection and error-shape normalisation.
 *
 * F8 — every request gets a server-generated correlation id surfaced as the
 * `X-Ai-Request-Id` response header. Clients may read it to cross-reference
 * server logs; we never TRUST a client-supplied value.
 *
 * The mobile client NEVER holds the LLM provider key.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const messageSchema = z.object({
  // "model" is accepted for backward compat with the first mobile build.
  role: z.enum(["user", "model", "assistant"]),
  content: z.string().min(1).max(16_000),
});

const bodySchema = z.object({
  messages: z.array(messageSchema).min(1).max(40),
  model: z.string().min(1).max(64).optional(),
  // F6 — per-chat conversation id. A missing/invalid id means "no persisted
  // context"; the agent still works but follow-up resolution ("the second
  // one") won't have anything to refer to.
  conversationId: z.string().uuid().optional(),
});

/** Total wall-clock budget per AI request. The reliability layer clamps its
 *  per-call timeouts against the remaining budget so we never run longer. */
const REQUEST_BUDGET_MS = 85_000;

/** Per-(tenant, user) rate limit. Chat is interactive so a human never sends
 *  more than one turn per few seconds; 60/min is generous while still
 *  stopping a looped mobile client from draining the project Gemini quota
 *  faster than a human reviewer can notice. Matches the shape of
 *  `/api/ai/transcribe`'s limit. Fails open on a Redis outage. */
const CHAT_RATE_LIMIT = { limit: 60, windowSec: 60 };

export async function POST(req: NextRequest) {
  // F8 — always server-generated. Client-provided ids are never trusted.
  const requestId = newRequestId();

  const r = await requirePermission("view_insights");
  if (!r.ok) return attachRequestId(r.response, requestId);

  // Per-(tenant, user) rate limit. Auth already keeps anonymous traffic out;
  // this guards against a stuck mobile client / rogue session draining the
  // project's Gemini quota by posting turns in a loop. Uses the same
  // sliding-window limiter as /api/ai/transcribe. Fails open on Redis outage.
  const rlKey = `${r.ctx.tenantId}:${r.ctx.userId}`;
  const rl = await rateLimit("ai.chat", rlKey, CHAT_RATE_LIMIT);
  if (!rl.ok) {
    return attachRequestId(
      NextResponse.json(
        { error: "RATE_LIMITED", reason: "Too many requests — please slow down.", requestId },
        { status: 429 },
      ),
      requestId,
    );
  }

  // Resolve the provider once — if its env key is missing we surface a stable
  // AI_DISABLED to the mobile client so the UI can fall back cleanly.
  let provider;
  try {
    provider = getActiveProvider();
  } catch (e) {
    if (e instanceof NoProviderKeyError) {
      return attachRequestId(
        NextResponse.json(
          {
            error: "AI_DISABLED",
            reason: tr("error.aiDisabled", "en"),
            requestId,
          },
          { status: 503 },
        ),
        requestId,
      );
    }
    throw e;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return attachRequestId(
      NextResponse.json({ error: "INVALID_JSON", requestId }, { status: 400 }),
      requestId,
    );
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return attachRequestId(
      NextResponse.json(
        {
          error: parsed.error.issues[0]?.message ?? "invalid body",
          requestId,
        },
        { status: 400 },
      ),
      requestId,
    );
  }
  const { messages, model, conversationId } = parsed.data;

  // Locale detection: dominant language of the latest user turn (F7).
  const locale = detectLocale(messages);

  const ctx: AgentContext = {
    tenantId: r.ctx.tenantId,
    userId: r.ctx.userId,
    role: r.ctx.role,
    permissions: r.ctx.permissions,
    locale,
  };

  try {
    const { response } = await runAgent({
      ctx,
      messages,
      model,
      provider,
      conversationId,
      requestId,
      deadlineAt: Date.now() + REQUEST_BUDGET_MS,
    });
    return attachRequestId(NextResponse.json(response), requestId);
  } catch (err) {
    // runAgent already emitted a structured [ai/run] record with the full
    // details. We log a short redacted summary for the HTTP layer.
    console.error("[ai/chat] agent failed", {
      requestId,
      tenantId: ctx.tenantId,
      reason: redactError(err),
    });
    const busy = isTransientlyBusy(err);
    return attachRequestId(
      NextResponse.json(
        {
          error: busy ? "AI_BUSY" : "AI_REQUEST_FAILED",
          reason: busy ? tr("error.aiBusy", locale) : tr("error.aiUnavailable", locale),
          requestId,
        },
        { status: busy ? 503 : 502 },
      ),
      requestId,
    );
  }
}

function attachRequestId(res: NextResponse, requestId: string): NextResponse {
  res.headers.set("X-Ai-Request-Id", requestId);
  return res;
}
