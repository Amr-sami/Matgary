import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { leaveRequests, users, tenantMembers } from "@/lib/db/schema";
import { createNotification } from "./notifications";
import { fanoutEvent } from "@/lib/notifications/dispatch";

export type LeaveStatus = "pending" | "approved" | "rejected";

export interface LeaveRequestDto {
  id: string;
  userId: string;
  userName: string | null;
  startDate: Date;
  endDate: Date;
  reason: string | null;
  status: LeaveStatus;
  decidedByUserId: string | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  createdAt: Date;
}

export class LeaveConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaveConflictError";
  }
}

const NAME_EXPR = sql<string | null>`coalesce(${tenantMembers.displayName}, ${users.name})`;

export async function listLeaveRequests(
  tenantId: string,
  opts: { onlyForUserId?: string; branchId?: string | null },
): Promise<LeaveRequestDto[]> {
  return withTenant(tenantId, async (tx) => {
    const filters = [eq(leaveRequests.tenantId, tenantId)];
    if (opts.onlyForUserId) filters.push(eq(leaveRequests.userId, opts.onlyForUserId));
    if (opts.branchId) filters.push(eq(leaveRequests.branchId, opts.branchId));
    const rows = await tx
      .select({
        request: leaveRequests,
        userName: NAME_EXPR,
      })
      .from(leaveRequests)
      .leftJoin(
        tenantMembers,
        and(
          eq(tenantMembers.userId, leaveRequests.userId),
          eq(tenantMembers.tenantId, tenantId),
        ),
      )
      .leftJoin(users, eq(users.id, leaveRequests.userId))
      .where(and(...filters))
      .orderBy(desc(leaveRequests.createdAt));

    if (rows.length === 0) return [];

    const deciderIds = Array.from(
      new Set(
        rows.map((r) => r.request.decidedByUserId).filter((v): v is string => !!v),
      ),
    );
    const deciderRows =
      deciderIds.length === 0
        ? []
        : await tx
            .select({ id: users.id, name: NAME_EXPR })
            .from(users)
            .leftJoin(
              tenantMembers,
              and(
                eq(tenantMembers.userId, users.id),
                eq(tenantMembers.tenantId, tenantId),
              ),
            )
            .where(inArray(users.id, deciderIds));
    const deciderById = new Map(deciderRows.map((r) => [r.id, r.name]));

    return rows.map((r) => ({
      id: r.request.id,
      userId: r.request.userId,
      userName: r.userName,
      startDate: r.request.startDate,
      endDate: r.request.endDate,
      reason: r.request.reason,
      status: r.request.status as LeaveStatus,
      decidedByUserId: r.request.decidedByUserId,
      decidedByName: r.request.decidedByUserId
        ? deciderById.get(r.request.decidedByUserId) ?? null
        : null,
      decidedAt: r.request.decidedAt,
      decisionNote: r.request.decisionNote,
      createdAt: r.request.createdAt,
    }));
  });
}

export interface CreateLeaveInput {
  startDate: Date;
  endDate: Date;
  reason?: string | null;
}

export async function submitLeaveRequest(
  tenantId: string,
  branchId: string,
  userId: string,
  input: CreateLeaveInput,
): Promise<{ id: string }> {
  if (input.startDate > input.endDate) {
    throw new LeaveConflictError("تاريخ الانتهاء قبل تاريخ البداية");
  }
  const result = await withTenant(tenantId, async (tx) => {
    const [created] = await tx
      .insert(leaveRequests)
      .values({
        tenantId,
        branchId,
        userId,
        startDate: input.startDate,
        endDate: input.endDate,
        reason: input.reason?.trim() || null,
        status: "pending",
      })
      .returning({ id: leaveRequests.id });

    const [reqUser] = await tx
      .select({ name: NAME_EXPR })
      .from(users)
      .leftJoin(
        tenantMembers,
        and(
          eq(tenantMembers.userId, users.id),
          eq(tenantMembers.tenantId, tenantId),
        ),
      )
      .where(eq(users.id, userId))
      .limit(1);

    return { id: created.id, requesterName: reqUser?.name ?? null };
  });

  // Fanout after commit — dispatcher handles owner-role filtering, per-user
  // preferences (in-app vs email vs digest), and locale-specific copy. The
  // requester is excluded via `actorUserId`.
  const dayCount = Math.max(
    1,
    Math.ceil(
      (input.endDate.getTime() - input.startDate.getTime()) /
        (24 * 60 * 60 * 1000),
    ) + 1,
  );
  void fanoutEvent(tenantId, branchId, "leave.requested", {
    requesterName: result.requesterName ?? "—",
    dayCount,
    link: "/leave",
    actorUserId: userId,
  });

  return { id: result.id };
}

export async function decideLeaveRequest(
  tenantId: string,
  decidedByUserId: string,
  id: string,
  status: "approved" | "rejected",
  note: string | null,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(leaveRequests)
      .where(and(eq(leaveRequests.tenantId, tenantId), eq(leaveRequests.id, id)))
      .limit(1);
    if (!existing) throw new LeaveConflictError("الطلب غير موجود");
    if (existing.status !== "pending") {
      throw new LeaveConflictError("هذا الطلب تم البتّ فيه بالفعل");
    }

    await tx
      .update(leaveRequests)
      .set({
        status,
        decidedByUserId,
        decidedAt: sql`now()`,
        decisionNote: note?.trim() || null,
      })
      .where(and(eq(leaveRequests.tenantId, tenantId), eq(leaveRequests.id, id)));

    if (existing.userId !== decidedByUserId) {
      await createNotification(tx, tenantId, existing.branchId, {
        userId: existing.userId,
        kind: "leave_decided",
        title:
          status === "approved" ? "تمت الموافقة على إجازتك" : "تم رفض طلب إجازتك",
        body: note?.trim() || null,
        link: "/leave", // employee view
      });
    }
  });
}

export async function deleteLeaveRequest(
  tenantId: string,
  callerUserId: string,
  callerCanManage: boolean,
  id: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [existing] = await tx
      .select({ userId: leaveRequests.userId, status: leaveRequests.status })
      .from(leaveRequests)
      .where(and(eq(leaveRequests.tenantId, tenantId), eq(leaveRequests.id, id)))
      .limit(1);
    if (!existing) return;
    // Staff can only cancel their own pending requests.
    if (!callerCanManage) {
      if (existing.userId !== callerUserId) {
        throw new LeaveConflictError("غير مسموح");
      }
      if (existing.status !== "pending") {
        throw new LeaveConflictError("لا يمكن حذف طلب تم البتّ فيه");
      }
    }
    await tx
      .delete(leaveRequests)
      .where(and(eq(leaveRequests.tenantId, tenantId), eq(leaveRequests.id, id)));
  });
}
