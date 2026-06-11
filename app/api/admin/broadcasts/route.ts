import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requirePermission } from "@/lib/admin/permissions";
import {
  BroadcastError,
  createBroadcast,
  listAllBroadcasts,
} from "@/lib/admin/broadcasts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function clientIp(req: NextRequest): string | null {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip");
}

export async function GET() {
  const r = await requirePermission("broadcast.read");
  if (!r.ok) return r.response;
  const data = await listAllBroadcasts();
  return NextResponse.json({ data });
}

const createSchema = z.object({
  // Allow empty strings here — the pre-Zod step below mirrors a single
  // filled language to the other so operators can publish in just AR or
  // just EN. We still enforce "at least one non-empty" before Zod runs.
  titleAr: z.string().max(120),
  titleEn: z.string().max(120),
  bodyAr: z.string().max(1000).nullable().optional(),
  bodyEn: z.string().max(1000).nullable().optional(),
  severity: z.enum(["info", "warning", "critical"]),
  audience: z.enum(["all", "owners", "staff"]),
  // Both optional — defaults to "live immediately, no end" so the simple
  // flow (publish, end manually via End-now) doesn't require dates.
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().nullable().optional(),
});

export async function POST(req: NextRequest) {
  const r = await requirePermission("broadcast.manage");
  if (!r.ok) return r.response;
  const body = await req.json().catch(() => null);
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    // Defensive: tolerate clients that send empty / local-time values for
    // the optional date fields. Anything other than a valid ISO datetime
    // gets stripped so the schema treats it as "no value".
    if (typeof b.startsAt !== "string" || !isIsoDatetime(b.startsAt)) {
      delete b.startsAt;
    }
    if (typeof b.endsAt !== "string" || !isIsoDatetime(b.endsAt)) {
      b.endsAt = null;
    }
    // Mirror language fields: if the operator filled only AR (or only EN),
    // copy that text into the other language so both columns are populated.
    // Saves them from having to translate twice for short ops messages.
    mirrorLang(b, "titleAr", "titleEn");
    mirrorLang(b, "bodyAr", "bodyEn");
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: zodCodeFor(parsed.error.issues[0]) },
      { status: 400 },
    );
  }
  // After mirroring, at least one title must be non-empty.
  if (!parsed.data.titleAr.trim() && !parsed.data.titleEn.trim()) {
    return NextResponse.json({ error: "NO_TITLE" }, { status: 400 });
  }
  // Final mirror after Zod normalisation (zod may have replaced empties
  // with undefined for optionals — we still want both columns filled).
  const titleAr = parsed.data.titleAr.trim() || parsed.data.titleEn.trim();
  const titleEn = parsed.data.titleEn.trim() || parsed.data.titleAr.trim();
  const bodyAr =
    (parsed.data.bodyAr ?? "").trim() || (parsed.data.bodyEn ?? "").trim() || null;
  const bodyEn =
    (parsed.data.bodyEn ?? "").trim() || (parsed.data.bodyAr ?? "").trim() || null;
  try {
    const created = await createBroadcast(
      r.session.adminId,
      {
        titleAr,
        titleEn,
        bodyAr,
        bodyEn,
        severity: parsed.data.severity,
        audience: parsed.data.audience,
        startsAt: parsed.data.startsAt
          ? new Date(parsed.data.startsAt)
          : new Date(),
        endsAt: parsed.data.endsAt ? new Date(parsed.data.endsAt) : null,
      },
      { ip: clientIp(req), userAgent: req.headers.get("user-agent") },
    );
    return NextResponse.json({ id: created.id }, { status: 201 });
  } catch (err) {
    if (err instanceof BroadcastError) {
      return NextResponse.json({ error: err.code }, { status: err.status });
    }
    throw err;
  }
}

/** Strict ISO-8601 instant check (matches what zod's `.datetime()` accepts
 *  but uses Date.parse so cached browsers that emit local-time strings
 *  fail this gate and get stripped above instead of bubbling a 400). */
function isIsoDatetime(s: string): boolean {
  if (!/Z$|[+-]\d{2}:?\d{2}$/.test(s)) return false;
  const ms = Date.parse(s);
  return Number.isFinite(ms);
}

/** If `dst` is empty/missing and `src` has content, copy `src` → `dst`. Works
 *  in both directions so the caller can fill just one language and we mirror
 *  it to the other column. */
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

/** Map a Zod issue to one of our localized error codes so the client can
 *  show a meaningful message instead of falling back to "Action failed". */
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
