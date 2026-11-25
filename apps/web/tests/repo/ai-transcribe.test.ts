// /api/ai/transcribe — route-level tests.
//
// Same mock pattern as tests/repo/pnl-permissions.test.ts: the auth helper
// is swapped for a holds-set switcher; the Gemini provider is swapped for a
// fake transcriber so the route path is exercised without a real API key.
//
// What we prove:
//   • 403 without view_insights (and the provider is NOT called)
//   • 200 with view_insights + a valid body → transcript echoed back
//   • 400 on invalid body / missing fields / too-short audio
//   • 413 on oversized audio
//   • 415 on unsupported mime
//   • 422 on empty transcript
//   • 429 on rate-limit (two hits past the per-tenant cap)
//   • telemetry: requestId is set in the response body and header

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";

const holds = new Set<string>();

vi.mock("@/lib/api/auth-helpers", () => ({
  requirePermission: vi.fn(async (perm: string) => {
    if (holds.has(perm)) {
      return {
        ok: true as const,
        ctx: {
          userId: USER,
          tenantId: TENANT,
          role: "staff" as const,
          permissions: Array.from(holds),
          locale: "en" as const,
        },
      };
    }
    return {
      ok: false as const,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    };
  }),
  requirePermissionAudited: vi.fn(),
  requirePermissionWithBranch: vi.fn(),
  requirePermissionWithBranchEnforced: vi.fn(),
  requireTenant: vi.fn(),
  requireTenantWithBranch: vi.fn(),
}));

// In-memory rate-limit counter so a test can cross the cap without hitting
// Redis. Resets between tests.
const rateCounts = new Map<string, number>();
vi.mock("@/lib/ratelimit", () => ({
  rateLimit: vi.fn(async (bucket: string, key: string, { limit }: { limit: number }) => {
    const k = `${bucket}:${key}`;
    const current = (rateCounts.get(k) ?? 0) + 1;
    rateCounts.set(k, current);
    return { ok: current <= limit, remaining: Math.max(0, limit - current) };
  }),
}));
vi.mock("@/lib/request-ip", () => ({
  clientIp: vi.fn(() => "127.0.0.1"),
}));

// Swap the Gemini transcriber for a configurable fake.
const transcribeFake = vi.fn();
vi.mock("@/lib/ai/providers/transcribe", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ai/providers/transcribe")>(
    "@/lib/ai/providers/transcribe",
  );
  return {
    ...actual,
    transcribeAudio: (...args: unknown[]) => transcribeFake(...args),
  };
});

/** 1 KB of zero bytes, base64 — valid shape, just empty audio. */
const SMALL_AUDIO_B64 = Buffer.alloc(1024, 0).toString("base64");
/** 11 MB — over the 10 MB cap. */
const OVERSIZED_AUDIO_B64 = Buffer.alloc(11 * 1024 * 1024, 0).toString("base64");

async function invoke(body: unknown) {
  const { POST } = await import("@/app/api/ai/transcribe/route");
  return POST(
    new NextRequest("http://test/api/ai/transcribe", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

beforeEach(() => {
  holds.clear();
  rateCounts.clear();
  transcribeFake.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/ai/transcribe — auth", () => {
  it("denies without view_insights (403) and does NOT call the provider", async () => {
    const res = await invoke({ audioBase64: SMALL_AUDIO_B64, mimeType: "audio/m4a" });
    expect(res.status).toBe(403);
    expect(transcribeFake).not.toHaveBeenCalled();
  });
});

describe("POST /api/ai/transcribe — body validation", () => {
  beforeEach(() => holds.add("view_insights"));

  it("rejects an invalid JSON body (400)", async () => {
    const { POST } = await import("@/app/api/ai/transcribe/route");
    const req = new NextRequest("http://test/api/ai/transcribe", {
      method: "POST",
      body: "not json",
      headers: { "content-type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_JSON");
  });

  it("rejects a missing mimeType (400 INVALID_BODY)", async () => {
    const res = await invoke({ audioBase64: SMALL_AUDIO_B64 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("INVALID_BODY");
  });

  it("rejects audio that decodes to < 100 bytes (400 AUDIO_TOO_SHORT)", async () => {
    const res = await invoke({
      audioBase64: Buffer.alloc(16, 0).toString("base64"),
      mimeType: "audio/m4a",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("AUDIO_TOO_SHORT");
  });

  it("rejects audio larger than the MAX_AUDIO_BYTES cap (413)", async () => {
    const res = await invoke({
      audioBase64: OVERSIZED_AUDIO_B64,
      mimeType: "audio/m4a",
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe("AUDIO_TOO_LARGE");
    expect(typeof body.maxBytes).toBe("number");
  });
});

describe("POST /api/ai/transcribe — happy path", () => {
  beforeEach(() => holds.add("view_insights"));

  it("returns the Gemini transcript and request id on success", async () => {
    transcribeFake.mockResolvedValueOnce({
      text: "اعمللي مبيعات النهارده",
      model: "gemini-2.5-flash",
      audioBytes: 1024,
    });
    const res = await invoke({
      audioBase64: SMALL_AUDIO_B64,
      mimeType: "audio/m4a",
      durationMs: 1800,
      languageHint: "ar",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.text).toBe("اعمللي مبيعات النهارده");
    expect(body.model).toBe("gemini-2.5-flash");
    expect(body.durationMs).toBe(1800);
    expect(body.audioBytes).toBe(1024);
    expect(typeof body.requestId).toBe("string");
    expect(res.headers.get("X-Ai-Request-Id")).toBeTruthy();
    expect(transcribeFake).toHaveBeenCalledOnce();
    const args = transcribeFake.mock.calls[0]?.[0];
    expect(args?.mimeType).toBe("audio/m4a");
    expect(args?.languageHint).toBe("ar");
  });

  it("defaults languageHint to 'ar' when omitted", async () => {
    transcribeFake.mockResolvedValueOnce({
      text: "hello",
      model: "gemini-2.5-flash",
      audioBytes: 1024,
    });
    await invoke({ audioBase64: SMALL_AUDIO_B64, mimeType: "audio/m4a" });
    const args = transcribeFake.mock.calls[0]?.[0];
    expect(args?.languageHint).toBe("ar");
  });
});

describe("POST /api/ai/transcribe — provider errors", () => {
  beforeEach(() => holds.add("view_insights"));

  it("maps TranscribeError(NO_PROVIDER_KEY) to 503", async () => {
    const { TranscribeError } = await import("@/lib/ai/providers/transcribe");
    transcribeFake.mockRejectedValueOnce(
      new TranscribeError("missing key", "NO_PROVIDER_KEY"),
    );
    const res = await invoke({ audioBase64: SMALL_AUDIO_B64, mimeType: "audio/m4a" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe("NO_PROVIDER_KEY");
  });

  it("maps TranscribeError(UNSUPPORTED_MIME) to 415", async () => {
    const { TranscribeError } = await import("@/lib/ai/providers/transcribe");
    transcribeFake.mockRejectedValueOnce(
      new TranscribeError("bad mime", "UNSUPPORTED_MIME"),
    );
    const res = await invoke({ audioBase64: SMALL_AUDIO_B64, mimeType: "audio/xyz" });
    expect(res.status).toBe(415);
  });

  it("maps TranscribeError(EMPTY_TRANSCRIPT) to 422", async () => {
    const { TranscribeError } = await import("@/lib/ai/providers/transcribe");
    transcribeFake.mockRejectedValueOnce(
      new TranscribeError("empty", "EMPTY_TRANSCRIPT"),
    );
    const res = await invoke({ audioBase64: SMALL_AUDIO_B64, mimeType: "audio/m4a" });
    expect(res.status).toBe(422);
  });

  it("maps TranscribeError(PROVIDER_ERROR) to 502 and does not leak details", async () => {
    const { TranscribeError } = await import("@/lib/ai/providers/transcribe");
    transcribeFake.mockRejectedValueOnce(
      new TranscribeError("Gemini 500 happened: secret stuff", "PROVIDER_ERROR"),
    );
    const res = await invoke({ audioBase64: SMALL_AUDIO_B64, mimeType: "audio/m4a" });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("PROVIDER_ERROR");
    expect(JSON.stringify(body)).not.toContain("secret stuff");
  });

  it("maps unknown errors to 500 without leaking the message", async () => {
    transcribeFake.mockRejectedValueOnce(new Error("internal boom DO-NOT-SHOW"));
    const res = await invoke({ audioBase64: SMALL_AUDIO_B64, mimeType: "audio/m4a" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("INTERNAL");
    expect(JSON.stringify(body)).not.toContain("DO-NOT-SHOW");
  });
});

describe("POST /api/ai/transcribe — rate limiting", () => {
  beforeEach(() => holds.add("view_insights"));

  it("returns 429 past the per-tenant cap (20/min); provider not called on the throttled call", async () => {
    transcribeFake.mockResolvedValue({ text: "ok", model: "x", audioBytes: 1024 });
    // Burn the quota: 20 successes.
    for (let i = 0; i < 20; i++) {
      const res = await invoke({ audioBase64: SMALL_AUDIO_B64, mimeType: "audio/m4a" });
      expect(res.status).toBe(200);
    }
    // 21st call → throttled.
    const throttled = await invoke({ audioBase64: SMALL_AUDIO_B64, mimeType: "audio/m4a" });
    expect(throttled.status).toBe(429);
    const body = await throttled.json();
    expect(body.error).toBe("RATE_LIMITED");
    expect(transcribeFake).toHaveBeenCalledTimes(20); // not 21
  });
});

/**
 * Prompt audit — lightweight invariants on the transcription prompt itself.
 * We don't test Gemini's output (that needs real audio), but we CAN verify
 * the prompt we send doesn't regress to Egyptian-only or single-language
 * instructions. Catches drift of this file over time.
 */
describe("transcription prompt is dialect-agnostic", () => {
  it("names every major Arabic dialect family (not Egyptian-only)", async () => {
    // Re-import to get the actual (un-mocked) module for the constant check.
    vi.resetModules();
    const actual = await vi.importActual<typeof import("@/lib/ai/providers/transcribe")>(
      "@/lib/ai/providers/transcribe",
    );
    // The constant isn't exported; verify via the module source text so
    // this test catches a developer who shortens the prompt back to one
    // dialect. Read the file via require.resolve'd path.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "lib/ai/providers/transcribe.ts"),
      "utf8",
    );
    // Every one of these dialect families must appear SOMEWHERE in the
    // transcription prompt so Gemini doesn't default to MSA on non-Egyptian speakers.
    for (const dialect of ["Egyptian", "Saudi", "Gulf", "Levantine", "Modern Standard"]) {
      expect(src).toContain(dialect);
    }
    // The old Egyptian-only sentence must be gone.
    expect(src).not.toMatch(/Egyptian Arabic.*output Egyptian Arabic/);
    // Code-switching must be explicitly named.
    expect(src).toMatch(/[Mm]ixed Arabic.*English/);
    // Product-code preservation must be explicit.
    expect(src).toMatch(/[Pp]roduct codes|SKUs|barcodes/);
    void actual;
  });
});
