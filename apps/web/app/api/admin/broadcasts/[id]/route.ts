import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/admin/permissions";
import { BroadcastError, patchBroadcast } from "@/lib/admin/broadcasts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clientIp(req: NextRequest): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip");
}

const schema = z.object({
  // Same as POST: allow empty strings; mirror logic runs pre-Zod.
  titleAr: z.string().max(120).optional(),
  titleEn: z.string().max(120).optional(),
  bodyAr: z.string().max(1000).nullable().optional(),
  bodyEn: z.string().max(1000).nullable().optional(),
  severity: z.enum(["info", "warning", "critical"]).optional(),
  audience: z.enum(["all", "owners", "staff"]).optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().nullable().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const r = await requirePermission("broadcast.manage");
  if (!r.ok) return r.response;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.startsAt !== "string" || !isIsoDatetime(b.startsAt)) {
      delete b.startsAt;
    }
    if (b.endsAt !== undefined && b.endsAt !== null) {
      if (typeof b.endsAt !== "string" || !isIsoDatetime(b.endsAt)) {
        delete b.endsAt;
      }
    }
    // Same mirror logic as POST so PATCH-with-one-language works.
    mirrorLang(b, "titleAr", "titleEn");
    mirrorLang(b, "bodyAr", "bodyEn");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: zodCodeFor(parsed.error.issues[0]) },
      { status: 400 },
    );
  }
  // If both title fields ended up empty after mirroring, that's an explicit
  // wipe — reject it the same way as POST.
  if (
    parsed.data.titleAr !== undefined &&
    parsed.data.titleEn !== undefined &&
    !parsed.data.titleAr.trim() &&
    !parsed.data.titleEn.trim()
  ) {
    return NextResponse.json({ error: "NO_TITLE" }, { status: 400 });
  }
  try {
    await patchBroadcast(
      r.session.adminId,
      id,
      {
        ...parsed.data,
        startsAt: parsed.data.startsAt
          ? new Date(parsed.data.startsAt)
          : undefined,
        endsAt:
          parsed.data.endsAt === undefined
            ? undefined
            : parsed.data.endsAt
              ? new Date(parsed.data.endsAt)
              : null,
      },
      { ip: clientIp(req), userAgent: req.headers.get("user-agent") },
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof BroadcastError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    throw err;
  }
}

function isIsoDatetime(s: string): boolean {
  if (!/Z$|[+-]\d{2}:?\d{2}$/.test(s)) return false;
  return Number.isFinite(Date.parse(s));
}

function mirrorLang(
  obj: Record<string, unknown>,
  a: string,
  b: string,
) {
  const av = typeof obj[a] === "string" ? (obj[a] as string).trim() : "";
  const bv = typeof obj[b] === "string" ? (obj[b] as string).trim() : "";
  if (av && !bv) obj[b] = av;
  if (bv && !av) obj[a] = bv;
}

function zodCodeFor(issue: z.core.$ZodIssue | undefined): string {
  if (!issue) return "INVALID";
  const field = String(issue.path[0] ?? "");
  if (field === "titleAr") return "INVALID_TITLE_AR";
  if (field === "titleEn") return "INVALID_TITLE_EN";
  if (field === "bodyAr" || field === "bodyEn") return "BODY_TOO_LONG";
  if (field === "severity") return "INVALID_SEVERITY";
  if (field === "audience") return "INVALID_AUDIENCE";
  return "INVALID";
}
