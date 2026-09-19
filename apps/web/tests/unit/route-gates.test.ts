/**
 * Doc 14 §3.1 C3–C5 — the permission gate each write (and the two
 * previously open reads) opens with, pinned from SOURCE.
 *
 * Read rather than executed on purpose: these handlers' import chains reach
 * Postgres, Redis, the PDF renderer and the Meta client, and the contract
 * under test is one line per handler — which helper, which permission. A
 * route that moves to another helper or permission has to change this table
 * on purpose; a helper that silently reverts to plain requireTenant() fails
 * here. The behaviour of the helpers themselves (audit vs enforce) lives in
 * lib/api/auth-helpers.ts and is exercised by the DB-backed suites.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const AUDITED = (perm: string) => `requirePermissionAudited("${perm}")`;
const BRANCH = (perm: string) => `requirePermissionWithBranch("${perm}")`;

/** [route path under app/api, handler, every string its body must contain] */
const GATES: Array<[string, string, string[]]> = [
  // C3 — settings: any member reads, secrets masked; manage_whatsapp writes,
  // credential keys dropped for everyone else regardless of the flag.
  ["settings", "GET", ["requireTenantWithBranch()", 'can(r.ctx, "manage_whatsapp")', "stripWhatsAppCredentials(full)"]],
  ["settings", "PATCH", [BRANCH("manage_whatsapp"), 'can(r.ctx, "manage_whatsapp")', "delete parsed.data[k]"]],
  // C4 — settle is cash-in at the till (decision recorded on the doc row).
  ["sales/settle", "POST", [BRANCH("record_sales")]],
  // C5 — sales family: modify_sales, audited.
  ["sales/[id]", "PATCH", [AUDITED("modify_sales")]],
  ["sales/[id]", "DELETE", [AUDITED("modify_sales")]],
  ["sales/[id]/paid", "POST", [AUDITED("modify_sales")]],
  ["sales/invoice/[id]/paid", "POST", [AUDITED("modify_sales")]],
  ["sales/bulk", "DELETE", [AUDITED("modify_sales")]],
  ["customers/by-phone/[phone]/mark-all-paid", "POST", ["requireTenantWithBranch()", 'can(r.ctx, "modify_sales")']],
  // C5 — inventory.
  ["products/[id]", "PATCH", [AUDITED("manage_inventory")]],
  ["products/[id]", "DELETE", [AUDITED("manage_inventory")]],
  ["products/bulk", "PATCH", [BRANCH("manage_inventory")]],
  ["products/bulk", "DELETE", [BRANCH("manage_inventory")]],
  // C5 — catalogue.
  ["categories/[id]", "PATCH", [AUDITED("manage_catalog")]],
  ["categories/[id]", "DELETE", [AUDITED("manage_catalog")]],
  ["brands/[id]", "PATCH", [AUDITED("manage_catalog")]],
  ["brands/[id]", "DELETE", [AUDITED("manage_catalog")]],
  ["attributes/[id]", "PATCH", [AUDITED("manage_catalog")]],
  ["attributes/[id]", "DELETE", [AUDITED("manage_catalog")]],
  ["attribute-values/[id]", "PATCH", [AUDITED("manage_catalog")]],
  ["attribute-values/[id]", "DELETE", [AUDITED("manage_catalog")]],
  // C5 — expenses / returns, reads included.
  ["expenses", "GET", [AUDITED("view_expenses")]],
  ["expenses", "POST", [BRANCH("manage_expenses")]],
  ["expenses/[id]", "DELETE", [AUDITED("manage_expenses")]],
  ["returns", "GET", [AUDITED("view_returns")]],
  ["returns", "POST", [AUDITED("manage_returns")]],
  // C5 — WhatsApp. The send family is record_sales (the till sends the
  // receipt), a deliberate deviation from the row's "manage_whatsapp"; OTP
  // fan-out has no POS caller.
  ["whatsapp/send", "POST", [BRANCH("record_sales")]],
  ["whatsapp/cloud/send", "POST", [BRANCH("record_sales")]],
  ["whatsapp/send-pdf", "POST", [BRANCH("record_sales")]],
  ["whatsapp/cloud/send-pdf", "POST", [BRANCH("record_sales")]],
  ["whatsapp/cloud/send-template", "POST", [BRANCH("record_sales")]],
  ["whatsapp/messages/[clientMessageId]", "GET", [BRANCH("record_sales")]],
  ["whatsapp/otp/send", "POST", [BRANCH("manage_whatsapp")]],
];

const OPEN_GATES = [/\brequireTenant\(\)/, /\brequireTenantWithBranch\(\)/];

function routeSource(route: string): string {
  return readFileSync(fileURLToPath(new URL(`../../app/api/${route}/route.ts`, import.meta.url)), "utf8");
}

/** The text of one exported handler: from its `export async function` to the next top-level export. */
function handlerBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  if (start < 0) throw new Error(`no ${name} handler`);
  const next = src.indexOf("\nexport ", start + 1);
  return src.slice(start, next < 0 ? undefined : next);
}

describe("route handlers open with the doc 14 §3.1 C3–C5 gate", () => {
  for (const [route, handler, expected] of GATES) {
    it(`${handler} /api/${route}`, () => {
      const body = handlerBody(routeSource(route), handler);
      for (const s of expected) expect(body, `expected ${s}`).toContain(s);
      // A permission-gated handler must not ALSO open with a bare tenant
      // check — that is the shape every one of these routes had before C5.
      const permissionGated = expected.some((s) => s.startsWith("requirePermission"));
      if (permissionGated) {
        for (const open of OPEN_GATES) expect(body).not.toMatch(open);
      }
    });
  }
});
