import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/api/auth-helpers";
import { getActiveProvider, getFallbackProvider, NoProviderKeyError } from "@/lib/ai/providers";

/**
 * AI provider liveness check. Owner-only (view_insights permission).
 *
 * Returns the configured primary provider, the model it would use, and the
 * result of a cheap round-trip to the provider's API. F8 adds fallback
 * availability + latency breakdown for operational visibility.
 *
 * Burns at most ~1 output token on Gemini; zero on Groq (lists models
 * instead of generating). Does NOT expose the API key or any part of it.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const r = await requirePermission("view_insights");
  if (!r.ok) return r.response;

  let primary;
  try {
    primary = getActiveProvider();
  } catch (e) {
    if (e instanceof NoProviderKeyError) {
      return NextResponse.json(
        {
          ok: false,
          provider: e.provider,
          reason: "missing_key",
          detail: `${e.envVar} not set on the server.`,
          fallback: null,
          lastCheckAt: new Date().toISOString(),
        },
        { status: 503 },
      );
    }
    throw e;
  }

  const fallback = getFallbackProvider(primary.name);

  const primaryStart = Date.now();
  const primaryResult = await primary.healthCheck();
  const primaryElapsedMs = Date.now() - primaryStart;

  let fallbackStatus: {
    provider: string;
    model: string;
    ok: boolean;
    elapsedMs: number;
    reason?: string;
  } | null = null;
  if (fallback) {
    const fStart = Date.now();
    const fResult = await fallback.healthCheck();
    const fElapsed = Date.now() - fStart;
    fallbackStatus = fResult.ok
      ? {
          provider: fallback.name,
          model: fResult.model,
          ok: true,
          elapsedMs: fElapsed,
        }
      : {
          provider: fallback.name,
          model: fallback.defaultModel,
          ok: false,
          elapsedMs: fElapsed,
          reason: fResult.reason,
        };
  }

  const lastCheckAt = new Date().toISOString();

  if (primaryResult.ok) {
    return NextResponse.json({
      ok: true,
      provider: primary.name,
      model: primaryResult.model,
      elapsedMs: primaryElapsedMs,
      lastCheckAt,
      fallback: fallbackStatus,
    });
  }
  return NextResponse.json(
    {
      ok: false,
      provider: primary.name,
      model: primary.defaultModel,
      elapsedMs: primaryElapsedMs,
      reason: "unreachable",
      detail: primaryResult.reason,
      lastCheckAt,
      // A healthy fallback mitigates a dead primary — surface that signal so
      // ops can tell "AI is degraded but serving" from "AI is fully down".
      fallback: fallbackStatus,
    },
    { status: fallbackStatus?.ok ? 200 : 503 },
  );
}
