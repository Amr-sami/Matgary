import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/auth-helpers";
import { listLatestEventsToday } from "@/lib/repo/attendance-events";
import { listTeamMembers } from "@/lib/repo/team";

export async function GET() {
  const r = await requirePermission("manage_team");
  if (!r.ok) return r.response;

  const [members, latestByEmployee] = await Promise.all([
    listTeamMembers(r.ctx.tenantId),
    listLatestEventsToday(r.ctx.tenantId),
  ]);

  const roster = members
    .filter((m) => m.role !== "owner")
    .map((m) => {
      const last = latestByEmployee[m.userId] ?? null;
      const status: "checked_in" | "checked_out" | "absent" =
        last?.type === "check_in"
          ? "checked_in"
          : last?.type === "check_out"
            ? "checked_out"
            : "absent";
      return {
        userId: m.userId,
        displayName: m.displayName,
        username: m.username,
        status,
        lastEvent: last,
      };
    });

  return NextResponse.json({ roster });
}
