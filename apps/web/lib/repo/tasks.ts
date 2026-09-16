import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { withTenant } from "@/lib/db";
import { tasks, users, tenantMembers } from "@/lib/db/schema";
import { createNotification } from "./notifications";

export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";
export type TaskPriority = "low" | "normal" | "high";

export interface TaskDto {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: Date | null;
  completedAt: Date | null;
  assigneeSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  assignedToUserId: string | null;
  assignedToName: string | null;
  createdByUserId: string;
  createdByName: string | null;
}

export class TaskConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskConflictError";
  }
}

const ASSIGNEE_DISPLAY_NAME = sql<string | null>`coalesce(${tenantMembers.displayName}, ${users.name})`;

/**
 * List tasks. If `onlyForUserId` is provided, results are restricted to tasks
 * assigned to that user — branch filter is intentionally ignored so an
 * assignee sees every task that's actually for them (a manager can assign
 * while browsing a different branch). Manager view (`onlyForUserId` undefined)
 * keeps the branch scope so each branch's board stays self-contained.
 */
export async function listTasks(
  tenantId: string,
  opts: { onlyForUserId?: string; branchId?: string | null },
): Promise<TaskDto[]> {
  return withTenant(tenantId, async (tx) => {
    // Self-join users for assignee + creator names. Drizzle aliasing is
    // verbose; we do two separate selects and then merge by id.
    const filters = [eq(tasks.tenantId, tenantId)];
    if (opts.onlyForUserId) {
      filters.push(eq(tasks.assignedToUserId, opts.onlyForUserId));
    } else if (opts.branchId) {
      filters.push(eq(tasks.branchId, opts.branchId));
    }
    const rows = await tx
      .select({
        task: tasks,
      })
      .from(tasks)
      .where(and(...filters))
      .orderBy(desc(tasks.createdAt));

    if (rows.length === 0) return [];

    // Resolve names in two cheap lookups.
    const userIds = Array.from(
      new Set(
        rows.flatMap((r) => [r.task.assignedToUserId, r.task.createdByUserId])
          .filter((v): v is string => !!v),
      ),
    );
    const nameRows =
      userIds.length === 0
        ? []
        : await tx
            .select({
              userId: users.id,
              name: ASSIGNEE_DISPLAY_NAME,
            })
            .from(users)
            .leftJoin(
              tenantMembers,
              and(
                eq(tenantMembers.userId, users.id),
                eq(tenantMembers.tenantId, tenantId),
              ),
            )
            .where(inArray(users.id, userIds));
    const nameById = new Map(nameRows.map((n) => [n.userId, n.name ?? null]));

    return rows.map((r) => ({
      id: r.task.id,
      title: r.task.title,
      description: r.task.description,
      status: r.task.status as TaskStatus,
      priority: r.task.priority as TaskPriority,
      dueDate: r.task.dueDate,
      completedAt: r.task.completedAt,
      assigneeSeenAt: r.task.assigneeSeenAt,
      createdAt: r.task.createdAt,
      updatedAt: r.task.updatedAt,
      assignedToUserId: r.task.assignedToUserId,
      assignedToName: r.task.assignedToUserId
        ? nameById.get(r.task.assignedToUserId) ?? null
        : null,
      createdByUserId: r.task.createdByUserId,
      createdByName: nameById.get(r.task.createdByUserId) ?? null,
    }));
  });
}

export async function unreadTaskCountForUser(
  tenantId: string,
  userId: string,
): Promise<number> {
  return withTenant(tenantId, async (tx) => {
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(
        and(
          eq(tasks.tenantId, tenantId),
          eq(tasks.assignedToUserId, userId),
          or(eq(tasks.status, "open"), eq(tasks.status, "in_progress"))!,
          isNull(tasks.assigneeSeenAt),
        ),
      );
    return count;
  });
}

export interface CreateTaskInput {
  assignedToUserId: string | null;
  title: string;
  description?: string | null;
  priority?: TaskPriority;
  dueDate?: Date | null;
}

export async function createTask(
  tenantId: string,
  branchId: string,
  createdByUserId: string,
  input: CreateTaskInput,
): Promise<{ id: string }> {
  if (!input.title.trim()) {
    throw new TaskConflictError("عنوان المهمة مطلوب");
  }
  return withTenant(tenantId, async (tx) => {
    const [created] = await tx
      .insert(tasks)
      .values({
        tenantId,
        branchId,
        createdByUserId,
        assignedToUserId: input.assignedToUserId,
        title: input.title.trim(),
        description: input.description?.trim() || null,
        priority: input.priority ?? "normal",
        dueDate: input.dueDate ?? null,
        status: "open",
        assigneeSeenAt: null,
      })
      .returning({ id: tasks.id });

    if (input.assignedToUserId && input.assignedToUserId !== createdByUserId) {
      await createNotification(tx, tenantId, branchId, {
        userId: input.assignedToUserId,
        kind: "task_assigned",
        title: "مهمة جديدة موكلة إليك",
        body: input.title.trim(),
        link: "/tasks",
      });
    }

    return { id: created.id };
  });
}

export interface UpdateTaskInput {
  title?: string;
  description?: string | null;
  priority?: TaskPriority;
  dueDate?: Date | null;
  assignedToUserId?: string | null;
}

/**
 * Manager-side edit. Touching anything resets `assignee_seen_at` so the new
 * assignee re-acknowledges the changes (gives them an unread badge again).
 */
export async function updateTask(
  tenantId: string,
  id: string,
  patch: UpdateTaskInput,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, id)))
      .limit(1);
    if (!existing) throw new TaskConflictError("المهمة غير موجودة");

    const set: Record<string, unknown> = { updatedAt: sql`now()`, assigneeSeenAt: null };
    if (patch.title !== undefined) set.title = patch.title.trim();
    if (patch.description !== undefined) set.description = patch.description?.trim() || null;
    if (patch.priority !== undefined) set.priority = patch.priority;
    if (patch.dueDate !== undefined) set.dueDate = patch.dueDate;
    if (patch.assignedToUserId !== undefined) set.assignedToUserId = patch.assignedToUserId;

    await tx
      .update(tasks)
      .set(set)
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, id)));

    // Notify the (possibly new) assignee. The notification carries the
    // task's branch context so multi-store users only see notifications for
    // their branch.
    const newAssignee = patch.assignedToUserId ?? existing.assignedToUserId;
    if (newAssignee && newAssignee !== existing.createdByUserId) {
      const becameAssigned =
        patch.assignedToUserId !== undefined &&
        patch.assignedToUserId !== existing.assignedToUserId;
      await createNotification(tx, tenantId, existing.branchId, {
        userId: newAssignee,
        kind: becameAssigned ? "task_assigned" : "task_updated",
        title: becameAssigned ? "مهمة جديدة موكلة إليك" : "تحديث على إحدى مهامك",
        body: (patch.title ?? existing.title).trim(),
        link: "/tasks",
      });
    }
  });
}

export async function setTaskStatus(
  tenantId: string,
  id: string,
  callerUserId: string,
  status: TaskStatus,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    const [existing] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, id)))
      .limit(1);
    if (!existing) throw new TaskConflictError("المهمة غير موجودة");

    const set: Record<string, unknown> = { status, updatedAt: sql`now()` };
    if (status === "done") set.completedAt = sql`now()`;
    else if (existing.status === "done") set.completedAt = null;

    // Whoever changes status acknowledges they've seen it.
    if (callerUserId === existing.assignedToUserId) {
      set.assigneeSeenAt = sql`now()`;
    }

    await tx
      .update(tasks)
      .set(set)
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, id)));

    // Notify the creator that the assignee transitioned the task.
    const creatorIsCaller = existing.createdByUserId === callerUserId;
    if (!creatorIsCaller) {
      if (status === "done" && existing.status !== "done") {
        await createNotification(tx, tenantId, existing.branchId, {
          userId: existing.createdByUserId,
          kind: "task_done",
          title: "اكتملت إحدى المهام",
          body: existing.title,
          link: "/tasks",
        });
      } else if (
        status === "in_progress" &&
        existing.status !== "in_progress"
      ) {
        await createNotification(tx, tenantId, existing.branchId, {
          userId: existing.createdByUserId,
          kind: "task_started",
          title: "بدأ موظف العمل على مهمة",
          body: existing.title,
          link: "/tasks",
        });
      }
    }
  });
}

/** Mark every open/in-progress task assigned to user as seen. */
export async function markAllTasksSeen(
  tenantId: string,
  userId: string,
): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(tasks)
      .set({ assigneeSeenAt: sql`now()` })
      .where(
        and(
          eq(tasks.tenantId, tenantId),
          eq(tasks.assignedToUserId, userId),
          isNull(tasks.assigneeSeenAt),
        ),
      );
  });
}

export async function deleteTask(tenantId: string, id: string): Promise<void> {
  await withTenant(tenantId, async (tx) => {
    await tx.delete(tasks).where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, id)));
  });
}
