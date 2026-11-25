// Agent tools for the Tasks module.
//
// Reads are thin wrappers over lib/repo/tasks.ts's listTasks. Writes go
// through the F5 staged-write pipeline (preview_* → confirm → execute). The
// executor branches live in lib/ai/write/execute.ts and call createTask /
// updateTask / setTaskStatus — NO new task logic is introduced here; the
// tool layer is validation + permission + audit integration only.
//
// Natural-language assignment flow is: resolve_employee → pick HIGH-tier
// userId → preview_create_task / preview_update_task with that userId. If
// the resolver returns NONE / MEDIUM / LOW, the Agent asks the user instead
// of guessing.
//
// Due-date arg accepts either 'YYYY-MM-DD' or a natural phrase ("today",
// "tomorrow", "monday", "next friday", AR equivalents) — parsed by the
// deterministic parseNaturalDate; unparsed inputs fail INVALID_PARAMS so
// the Agent asks the user rather than guessing.

import { and, eq } from "drizzle-orm";

import { withTenant } from "@/lib/db";
import { tasks } from "@/lib/db/schema";
import { listTasks, type TaskStatus, type TaskPriority } from "@/lib/repo/tasks";
import { DEFAULT_REPORTING_TZ } from "@/lib/finance/dates";

import { tr } from "../i18n";
import { createPending } from "../write/pending";
import type { Tool } from "./types";
import type { AiBlock, Locale } from "../responses";
import { parseNaturalDate } from "./_natural-date";

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES: TaskStatus[] = ["open", "in_progress", "done", "cancelled"];
const PRIORITIES: TaskPriority[] = ["low", "normal", "high"];

function isStatus(v: unknown): v is TaskStatus {
  return typeof v === "string" && (STATUSES as readonly string[]).includes(v);
}
function isPriority(v: unknown): v is TaskPriority {
  return typeof v === "string" && (PRIORITIES as readonly string[]).includes(v);
}

/* ─────────────────────────────── list_tasks ────────────────────────────── */

export const listTasksTool: Tool = {
  name: "list_tasks",
  description:
    "List tasks in this tenant. When `mine: true`, returns ONLY the authenticated user's assigned tasks (safe for staff without manage_tasks). When mine is false/unset, returns the full manager board — requires manage_tasks server-side. Supports optional filters: status, due_within_days, overdue_only, assigned_to_user_id. Tenant-scoped.",
  requiredPermission: "view_dashboard",
  parameters: {
    type: "object",
    properties: {
      mine: { type: "boolean", description: "True → only tasks assigned to the caller (no manage_tasks needed)." },
      status: { type: "string", enum: STATUSES as readonly string[] as string[] },
      overdue_only: { type: "boolean" },
      due_within_days: { type: "integer", minimum: 1, maximum: 365 },
      assigned_to_user_id: { type: "string", description: "uuid from resolve_employee." },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const mine = args.mine === true;
    const assigneeId =
      typeof args.assigned_to_user_id === "string" && UUID_SHAPE.test(args.assigned_to_user_id)
        ? args.assigned_to_user_id
        : null;
    // The repo gates manager-view when `onlyForUserId` is undefined. Enforce
    // manage_tasks here before calling that path so an under-permissioned
    // staff caller can't list someone else's tasks.
    if (!mine && !ctx.permissions.includes("manage_tasks") && ctx.role !== "owner") {
      return {
        ok: false,
        error: "FORBIDDEN",
        reason: "Listing team tasks requires manage_tasks. Pass mine: true for your own tasks.",
      };
    }
    const onlyForUserId = mine ? ctx.userId : assigneeId ?? undefined;
    const rows = await listTasks(ctx.tenantId, {
      onlyForUserId,
      branchId: null,
    });

    const limit = typeof args.limit === "number"
      ? Math.min(100, Math.max(1, Math.floor(args.limit)))
      : 30;
    const status = isStatus(args.status) ? args.status : null;
    const overdueOnly = args.overdue_only === true;
    const dueWithin = typeof args.due_within_days === "number" ? Math.floor(args.due_within_days) : null;
    const now = new Date();
    const cutoff = dueWithin !== null ? new Date(now.getTime() + dueWithin * 86_400_000) : null;

    const filtered = rows.filter((t) => {
      if (status && t.status !== status) return false;
      if (overdueOnly) {
        if (!t.dueDate) return false;
        if (t.dueDate >= now) return false;
        if (t.status === "done" || t.status === "cancelled") return false;
      }
      if (cutoff && t.dueDate && t.dueDate > cutoff) return false;
      return true;
    }).slice(0, limit);

    return {
      ok: true,
      data: {
        count: filtered.length,
        tasks: filtered.map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status,
          priority: t.priority,
          dueDate: t.dueDate ? t.dueDate.toISOString() : null,
          assignedToUserId: t.assignedToUserId,
          assignedToName: t.assignedToName,
          createdByUserId: t.createdByUserId,
          createdByName: t.createdByName,
          createdAt: t.createdAt.toISOString(),
        })),
      },
    };
  },
};

/* ────────────────────────────── get_task ───────────────────────────────── */

export const getTaskTool: Tool = {
  name: "get_task",
  description: "Fetch one task by id. Tenant-scoped; cross-tenant ids return not-found.",
  requiredPermission: "view_dashboard",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string" },
    },
    required: ["task_id"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const id = typeof args.task_id === "string" && UUID_SHAPE.test(args.task_id) ? args.task_id : null;
    if (!id) return { ok: false, error: "INVALID_PARAMS", reason: "task_id must be a uuid" };
    const [row] = await withTenant(ctx.tenantId, (tx) =>
      tx.select().from(tasks).where(and(eq(tasks.tenantId, ctx.tenantId), eq(tasks.id, id))).limit(1),
    );
    if (!row) return { ok: false, error: "NOT_FOUND" };
    // Staff without manage_tasks may only read their own tasks.
    if (
      row.assignedToUserId !== ctx.userId &&
      !ctx.permissions.includes("manage_tasks") &&
      ctx.role !== "owner"
    ) {
      return { ok: false, error: "FORBIDDEN", reason: "manage_tasks required to read others' tasks" };
    }
    return {
      ok: true,
      data: {
        id: row.id,
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority,
        dueDate: row.dueDate ? row.dueDate.toISOString() : null,
        assignedToUserId: row.assignedToUserId,
        createdByUserId: row.createdByUserId,
        createdAt: row.createdAt.toISOString(),
      },
    };
  },
};

/* ─────────────────────────── preview_create_task ───────────────────────── */

export const previewCreateTask: Tool = {
  name: "preview_create_task",
  description:
    "PREVIEW the creation of a new task. Requires a non-empty title. Optional: description, priority (low/normal/high), due_date (ISO 'YYYY-MM-DD' OR natural phrase: today/tomorrow/<weekday>/'next <weekday>'/'next week'), assigned_to_user_id (uuid from resolve_employee — NEVER invent). Returns a confirmation block the user taps to execute. The real mutation runs createTask (same path as the web Tasks screen) and automatically notifies the assignee via the existing notification dispatcher.",
  requiredPermission: "manage_tasks",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 200 },
      description: { type: "string", maxLength: 2000 },
      priority: { type: "string", enum: PRIORITIES as readonly string[] as string[] },
      due_date: { type: "string", description: "'YYYY-MM-DD' or natural phrase." },
      assigned_to_user_id: { type: "string" },
    },
    required: ["title"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const title = typeof args.title === "string" ? args.title.trim() : "";
    if (!title) return { ok: false, error: "INVALID_PARAMS", reason: "title is required" };
    const priority = isPriority(args.priority) ? args.priority : "normal";
    const description = typeof args.description === "string" ? args.description.trim() : null;
    const assignedToUserId =
      typeof args.assigned_to_user_id === "string" && UUID_SHAPE.test(args.assigned_to_user_id)
        ? args.assigned_to_user_id
        : null;
    let dueDate: string | null = null;
    let dueLabel: string | null = null;
    if (typeof args.due_date === "string" && args.due_date.trim()) {
      const parsed = parseNaturalDate(args.due_date, new Date(), DEFAULT_REPORTING_TZ);
      if (!parsed) {
        return {
          ok: false,
          error: "INVALID_PARAMS",
          reason:
            "due_date couldn't be parsed. Use 'YYYY-MM-DD' or a natural phrase like 'today', 'tomorrow', 'monday', 'next friday'. Ambiguous input → ask the user.",
        };
      }
      dueDate = parsed.isoDay;
      dueLabel = parsed.label;
    }

    const pending = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "create_task",
      params: {
        title,
        description,
        priority,
        dueDate,
        assignedToUserId,
      },
      preview: { locale: ctx.locale ?? "en", title, dueLabel },
    });

    const locale = (ctx.locale ?? "en") as Locale;
    const summary = [
      title,
      dueDate ? `due ${dueLabel ?? dueDate}` : null,
      assignedToUserId ? `assignee: ${assignedToUserId.slice(0, 8)}…` : "unassigned",
    ].filter(Boolean).join(" · ");
    const block: AiBlock = {
      kind: "confirmation",
      title: tr("write.task.title", locale, { title }),
      summary,
      actionLabel: tr("write.task.actionLabel", locale),
      token: pending.token,
      expiresAt: pending.expiresAt,
    };
    return { ok: true, blocks: [block] };
  },
};

/* ─────────────────────────── preview_update_task ───────────────────────── */

export const previewUpdateTask: Tool = {
  name: "preview_update_task",
  description:
    "PREVIEW editing an existing task. Supply task_id (uuid) + any subset of {title, description, priority, due_date, assigned_to_user_id}. Resets the assignee's unread badge on execute (matches the Tasks page behaviour). NEVER invent an assignee id — use resolve_employee first.",
  requiredPermission: "manage_tasks",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string" },
      title: { type: "string", minLength: 1, maxLength: 200 },
      description: { type: "string", maxLength: 2000 },
      priority: { type: "string", enum: PRIORITIES as readonly string[] as string[] },
      due_date: { type: "string", description: "'YYYY-MM-DD' or natural phrase; empty string clears the date." },
      assigned_to_user_id: { type: "string", description: "uuid from resolve_employee, or empty string to unassign." },
    },
    required: ["task_id"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const id = typeof args.task_id === "string" && UUID_SHAPE.test(args.task_id) ? args.task_id : null;
    if (!id) return { ok: false, error: "INVALID_PARAMS", reason: "task_id must be a uuid" };

    const patch: Record<string, unknown> = {};
    if (typeof args.title === "string") patch.title = args.title.trim();
    if (typeof args.description === "string") patch.description = args.description.trim() || null;
    if (isPriority(args.priority)) patch.priority = args.priority;
    if (typeof args.due_date === "string") {
      if (args.due_date.trim() === "") {
        patch.dueDate = null;
      } else {
        const parsed = parseNaturalDate(args.due_date, new Date(), DEFAULT_REPORTING_TZ);
        if (!parsed) {
          return { ok: false, error: "INVALID_PARAMS", reason: "due_date couldn't be parsed. Use 'YYYY-MM-DD' or a natural phrase, or '' to clear." };
        }
        patch.dueDate = parsed.isoDay;
      }
    }
    if (typeof args.assigned_to_user_id === "string") {
      patch.assignedToUserId =
        args.assigned_to_user_id === ""
          ? null
          : UUID_SHAPE.test(args.assigned_to_user_id)
            ? args.assigned_to_user_id
            : null;
      if (patch.assignedToUserId === null && args.assigned_to_user_id !== "") {
        return { ok: false, error: "INVALID_PARAMS", reason: "assigned_to_user_id must be a uuid (from resolve_employee) or ''" };
      }
    }
    if (Object.keys(patch).length === 0) {
      return { ok: false, error: "INVALID_PARAMS", reason: "Pass at least one field to change." };
    }

    const pending = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "update_task",
      params: { id, patch },
      preview: { locale: ctx.locale ?? "en", id, changed: Object.keys(patch) },
    });

    const locale = (ctx.locale ?? "en") as Locale;
    const block: AiBlock = {
      kind: "confirmation",
      title: tr("write.taskUpdate.title", locale),
      summary: tr("write.taskUpdate.summary", locale, { id: id.slice(0, 8), fields: Object.keys(patch).join(", ") }),
      actionLabel: tr("write.taskUpdate.actionLabel", locale),
      token: pending.token,
      expiresAt: pending.expiresAt,
    };
    return { ok: true, blocks: [block] };
  },
};

/* ──────────────────────── preview_set_task_status ──────────────────────── */

export const previewSetTaskStatus: Tool = {
  name: "preview_set_task_status",
  description:
    "PREVIEW transitioning a task's status (open → in_progress / done / cancelled, or reopen done). Sends task_started / task_done notifications via the existing dispatcher. Requires manage_tasks; the assignee's own status transitions via the web app don't need this tool.",
  requiredPermission: "manage_tasks",
  parameters: {
    type: "object",
    properties: {
      task_id: { type: "string" },
      status: { type: "string", enum: STATUSES as readonly string[] as string[] },
    },
    required: ["task_id", "status"],
    additionalProperties: false,
  },
  async handler(ctx, args) {
    const id = typeof args.task_id === "string" && UUID_SHAPE.test(args.task_id) ? args.task_id : null;
    const status = isStatus(args.status) ? args.status : null;
    if (!id || !status) {
      return { ok: false, error: "INVALID_PARAMS", reason: "task_id must be a uuid and status must be a valid enum value" };
    }

    const pending = await createPending({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      branchId: null,
      action: "set_task_status",
      params: { id, status },
      preview: { locale: ctx.locale ?? "en", id, status },
    });

    const locale = (ctx.locale ?? "en") as Locale;
    const block: AiBlock = {
      kind: "confirmation",
      title: tr("write.taskStatus.title", locale),
      summary: tr("write.taskStatus.summary", locale, { id: id.slice(0, 8), status }),
      actionLabel: tr("write.taskStatus.actionLabel", locale),
      token: pending.token,
      expiresAt: pending.expiresAt,
    };
    return { ok: true, blocks: [block] };
  },
};
