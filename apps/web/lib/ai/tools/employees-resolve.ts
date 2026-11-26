// Resolve a free-text employee reference (e.g. "Ahmed") to a tenant member
// user id. Tiered match semantics mirror resolve/products.ts:
//
//   HIGH   — exactly one candidate matches at the highest confidence
//   MEDIUM — one candidate with a partial match, but not unique
//   LOW    — multiple partial matches (ambiguous)
//   NONE   — no match
//
// The AI prompt instructs the model to:
//   • call this BEFORE preview_create_task / preview_update_task when the
//     user names an assignee by human name,
//   • require HIGH to proceed; otherwise ask the user to pick.
//
// Direct Drizzle query, tenant-scoped via ctx.tenantId. Never trusts a
// client-supplied name as an identifier; the id in the response is the
// authoritative handle.

import { and, eq, inArray, or, sql } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { tenantMembers, users } from "@/lib/db/schema";

import type { Tool } from "./types";

type Tier = "HIGH" | "MEDIUM" | "LOW" | "NONE";

interface Candidate {
  userId: string;
  name: string | null;
  email: string | null;
  role: string;
  score: number;
}

function tierFor(cands: Candidate[]): Tier {
  if (cands.length === 0) return "NONE";
  const top = cands[0]!.score;
  if (top >= 1 && cands.filter((c) => c.score === top).length === 1) return "HIGH";
  if (cands.length === 1) return "MEDIUM";
  return "LOW";
}

export const resolveEmployee: Tool = {
  name: "resolve_employee",
  description:
    "Resolve a free-text employee reference (name fragment or email) to a tenant member. Returns tiered candidates: HIGH (one exact match → safe to use the id directly), MEDIUM/LOW (ambiguous → ask the user), NONE (no match → do NOT invent). Call this before preview_create_task or preview_update_task when the user names an assignee by human name. The returned userId is the ONLY authoritative handle — never invent one.",
  requiredPermission: "view_dashboard",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        minLength: 2,
        description: "Partial name, email, or display name fragment.",
      },
      limit: { type: "integer", minimum: 1, maximum: 10 },
    },
    required: ["query"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const q = typeof args.query === "string" ? args.query.trim() : "";
    if (!q) return { ok: false, error: "EMPTY_QUERY" };
    const limit = typeof args.limit === "number" ? Math.min(10, Math.max(1, Math.floor(args.limit))) : 5;
    const qLower = q.toLowerCase();
    // Lowercase BOTH sides so the LIKE match is case-insensitive without a
    // collation dependency. `lower(column)` lives in SQL; the pattern is
    // already lowercased here so an "Ahmed Hassan" query matches a stored
    // "Ahmed Hassan" row.
    const pattern = `%${qLower}%`;

    return withTenant(ctx.tenantId, async (tx) => {
      // Pull members of this tenant with their user name + displayName.
      const rows = await tx
        .select({
          userId: users.id,
          name: users.name,
          email: users.email,
          displayName: tenantMembers.displayName,
          role: tenantMembers.role,
        })
        .from(tenantMembers)
        .innerJoin(users, eq(users.id, tenantMembers.userId))
        .where(
          and(
            eq(tenantMembers.tenantId, ctx.tenantId),
            or(
              sql`lower(${users.name}) like ${pattern}`,
              sql`lower(${tenantMembers.displayName}) like ${pattern}`,
              sql`lower(${users.email}) like ${pattern}`,
            ),
          ),
        )
        .limit(limit * 2);

      const candidates: Candidate[] = rows.map((r) => {
        const effective = (r.displayName ?? r.name ?? "").toLowerCase().trim();
        const emailLower = (r.email ?? "").toLowerCase();
        let score: number;
        if (effective === qLower) score = 1.0;
        else if (emailLower === qLower) score = 1.0;
        else if (effective.startsWith(qLower)) score = 0.85;
        else if (effective.split(/\s+/).some((p) => p === qLower)) score = 0.9;
        else score = 0.5;
        return {
          userId: r.userId,
          name: r.displayName ?? r.name ?? null,
          email: r.email ?? null,
          role: r.role,
          score,
        };
      });
      candidates.sort((a, b) => b.score - a.score);
      const topN = candidates.slice(0, limit);
      const tier = tierFor(topN);

      return {
        ok: true,
        data: {
          query: q,
          tier,
          candidates: topN,
        },
      };
    });
  },
};
