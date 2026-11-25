import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { requirePermission } from "@/lib/api/auth-helpers";
import { ImportError, ingestFile } from "@/lib/ai/import/session";
import { detectLocale } from "@/lib/ai/language";
import { newRequestId, redactError } from "@/lib/ai/telemetry";

/**
 * F10.1 — Import upload endpoint.
 *
 * Accepts a base64-encoded file body so the mobile client can ship small
 * CSV/XLSX workbooks (the iOS Expo client can't reliably stream multipart
 * from the chat screen, and the whole payload is already below the 2 MiB
 * route limit this file enforces).
 *
 * Owner / manage_inventory required — the import ultimately runs writes, so
 * we gate access at upload time too.
 *
 * SECURITY:
 *   • tenantId / userId NEVER accepted from the body.
 *   • File size clamped at 2 MiB.
 *   • MIME + extension revalidated inside `ingestFile`.
 *   • Dedupe: the session-service returns the prior session when the same
 *     file is re-uploaded.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 2 * 1024 * 1024; // 2 MiB

const bodySchema = z.object({
  fileName: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(200),
  /** base64 — not multipart so the mobile client can keep the chat-screen flow. */
  bodyBase64: z.string().min(16).max(Math.floor(MAX_BYTES * 1.5)), // ×1.37 for base64 overhead
  /** F6 — attaches the session to the current chat so undo + follow-up can resolve it. */
  conversationId: z.string().uuid().optional(),
});

export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const r = await requirePermission("manage_inventory");
  if (!r.ok) {
    r.response.headers.set("X-Ai-Request-Id", requestId);
    return r.response;
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "INVALID_JSON", requestId }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "INVALID_BODY", reason: parsed.error.issues[0]?.message ?? "bad body", requestId },
      { status: 400 },
    );
  }

  const buffer = Buffer.from(parsed.data.bodyBase64, "base64");
  if (buffer.length === 0) {
    return NextResponse.json({ error: "EMPTY_BODY", requestId }, { status: 400 });
  }
  if (buffer.length > MAX_BYTES) {
    return NextResponse.json({ error: "FILE_TOO_LARGE", requestId }, { status: 413 });
  }

  const locale = detectLocale([{ role: "user", content: "" }], "en");

  try {
    const result = await ingestFile({
      tenantId: r.ctx.tenantId,
      userId: r.ctx.userId,
      branchId: null,
      conversationId: parsed.data.conversationId ?? null,
      locale,
      fileName: parsed.data.fileName,
      mimeType: parsed.data.mimeType,
      buffer,
    });
    const res = NextResponse.json({ ...result, requestId });
    res.headers.set("X-Ai-Request-Id", requestId);
    return res;
  } catch (err) {
    if (err instanceof ImportError) {
      return NextResponse.json(
        { error: err.code, reason: err.message, requestId },
        { status: 400 },
      );
    }
    console.error("[ai/import/upload] failed", {
      requestId,
      tenantId: r.ctx.tenantId,
      reason: redactError(err),
    });
    return NextResponse.json(
      { error: "INTERNAL", reason: "Could not process upload", requestId },
      { status: 500 },
    );
  }
}
