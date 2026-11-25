// Slice 1 — audit log helper for Financials writes. Thin wrapper over
// lib/repo/activity.logActivity so every finance write funnels through one
// place and the action keys stay consistent with activity-labels.ts.

import "server-only";

import { logActivity } from "@/lib/repo/activity";

export type FinanceAction =
  | "finance.category.create"
  | "finance.category.update"
  | "finance.category.archive"
  | "finance.recurring.create"
  | "finance.recurring.update"
  | "finance.recurring.cancel"
  | "finance.money_movement.create"
  | "finance.money_movement.update"
  | "finance.money_movement.void"
  | "finance.expense.create"
  | "finance.expense.update"
  | "finance.expense.void";

export interface FinanceAuditInput {
  tenantId: string;
  actorUserId: string | null;
  action: FinanceAction;
  entityType?: string | null;
  entityId?: string | null;
  entityLabel?: string | null;
  /** Non-secret metadata only. The engine's helpers already filter obviously
   *  sensitive fields; pass only ids + human-readable labels + amounts. */
  metadata?: Record<string, unknown> | null;
}

export async function auditFinancial(input: FinanceAuditInput): Promise<void> {
  // Reuses the "expense" category so admins see the finance writes in the
  // same ledger they already scan. Dedicated category can be added if the
  // volume justifies it; one global list is cheaper to scan for now.
  await logActivity({
    tenantId: input.tenantId,
    actorUserId: input.actorUserId,
    action: input.action,
    category: "expense",
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    entityLabel: input.entityLabel ?? null,
    metadata: input.metadata ?? null,
  });
}
