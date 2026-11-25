import type { Permission } from "@/lib/permissions";

import type { Locale } from "./responses";

/**
 * Everything a tool handler needs to answer safely.
 *
 * Resolved ONCE at the top of a chat request. Passed by reference into every
 * tool invocation so a tool cannot accidentally widen scope (change tenant,
 * forge a user id). The runner holds no mutable state on this object; tools
 * must treat it as read-only.
 *
 * ARCHITECTURE: Storo has no branch functionality. Tenant is the primary
 * data-isolation boundary. There is no `branchId` on this type and no AI
 * code path reads a per-user branch — the DB may still carry a legacy
 * `branch_id` column on a handful of tables (customer_wallets,
 * ai_pending_actions, ai_operations, ai_import_sessions) as data residue,
 * but it is never used as a security or scoping boundary by the agent.
 */
export interface AgentContext {
  tenantId: string;
  userId: string;
  role: string | null;
  permissions: Permission[];
  /** Locked locale for this round's user-visible output. */
  locale: Locale;
  /** F10.0 — threaded from runAgent so operation recording + undo resolution
   *  scope to the same chat. Null in one-shot / stateless calls. */
  conversationId?: string | null;
}

/**
 * Narrower view a tool sees. Permissions are checked by the orchestrator before
 * dispatch; locale is included so preview/render tools can localise the
 * confirmation strings that live inside their ToolResult (F5).
 */
export interface ToolContext {
  tenantId: string;
  userId: string;
  role: string | null;
  permissions: Permission[];
  locale: Locale;
  /** F10.0 — same semantics as AgentContext.conversationId. */
  conversationId?: string | null;
}

export function toToolContext(ctx: AgentContext): ToolContext {
  return {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    role: ctx.role,
    permissions: ctx.permissions,
    locale: ctx.locale,
    conversationId: ctx.conversationId ?? null,
  };
}
