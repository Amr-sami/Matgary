// Meta's 24-hour customer service window helper.
//
// Meta only permits *freeform* outbound messages while the window is
// open. A window opens when the customer sends a message to the business
// and stays open for 24 hours from that message. Outside the window,
// outbound messages MUST use an approved message template; Meta will
// otherwise reject the send with errors like 131047 / 131051.
//
// This module is the single place the outbound facade asks "can I send
// this freeform?". When templates land in Phase 5, the same check tells
// the UI to flip the send mode to "template".

import "server-only";
import { getWindowState } from "./conversations";

export type WindowDecisionReason =
  | "open"
  | "closed_expired"
  | "closed_never_contacted";

export interface WindowDecision {
  allowed: boolean;
  reason: WindowDecisionReason;
  expiresAt: Date | null;
}

/** Pure check — does NOT enforce. Caller decides what to do with a
 *  closed window (refuse / switch to template / warn). */
export async function checkSendWindow(
  tenantId: string,
  branchId: string,
  phoneNumberE164NoPlus: string,
): Promise<WindowDecision> {
  const state = await getWindowState(tenantId, branchId, phoneNumberE164NoPlus);
  if (state.hasOpenWindow) {
    return { allowed: true, reason: "open", expiresAt: state.expiresAt };
  }
  if (state.neverContacted) {
    return {
      allowed: false,
      reason: "closed_never_contacted",
      expiresAt: null,
    };
  }
  return { allowed: false, reason: "closed_expired", expiresAt: state.expiresAt };
}

/** Human-readable copy for the failure path. Surfaced in API responses
 *  and (later) the inbox UI. */
export function explainClosedWindow(decision: WindowDecision): string {
  if (decision.reason === "closed_never_contacted") {
    return "Customer has never messaged this number. Outbound freeform messages aren't allowed until they message first — use an approved template instead.";
  }
  if (decision.reason === "closed_expired") {
    const ago = decision.expiresAt
      ? Math.max(1, Math.round((Date.now() - decision.expiresAt.getTime()) / 60000))
      : null;
    return ago
      ? `Customer service window closed ${ago} min ago. Use an approved message template instead.`
      : "Customer service window has closed. Use an approved message template instead.";
  }
  return "Window check failed.";
}
