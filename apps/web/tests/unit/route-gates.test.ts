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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const AUDITED = (perm: string) => `requirePermissionAudited("${perm}")`;
const BRANCH = (perm: string) => `requirePermissionWithBranch("${perm}")`;
/** Digital collections (doc 15 spec 05 §4.3): always enforced, whatever
 *  PERMISSION_ENFORCE_WRITES says. */
const ENFORCED = (perm: string) => `requirePermissionWithBranchEnforced("${perm}")`;
const COLL = "requireCollectionsTenant(";

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
  // Digital collections (doc 15 spec 05 §4.3 / §7). The two mixed reads
  // decide with the enforced `can()` (never the audited helper); every
  // handler but `config` answers 403 COLLECTIONS_DISABLED when the env gate
  // does not admit the tenant.
  ["collections", "GET", ["requireTenantWithBranch()", 'can(r.ctx, "view_collections")', 'can(r.ctx, "record_sales")', COLL]],
  ["collections/summary", "GET", [ENFORCED("view_collections"), COLL]],
  ["collections/[id]", "GET", ["requireTenantWithBranch()", 'can(r.ctx, "view_collections")', 'can(r.ctx, "record_sales")', COLL]],
  ["collections/[id]", "PATCH", ["requireTenantWithBranch()", 'can(r.ctx, "confirm_collections")', 'can(r.ctx, "record_sales")', COLL]],
  ["collections/[id]/confirm", "POST", [ENFORCED("confirm_collections"), "IDEMPOTENCY_KEY_REQUIRED", COLL]],
  ["collections/[id]/reject", "POST", [ENFORCED("confirm_collections"), "IDEMPOTENCY_KEY_REQUIRED", COLL]],
  ["collections/[id]/reopen", "POST", ["requireTenantWithBranch()", "isOwner(r.ctx)", "IDEMPOTENCY_KEY_REQUIRED", COLL]],
  ["collections/accounts", "GET", ["requireTenantWithBranch()", 'can(r.ctx, "manage_collection_accounts")', COLL]],
  ["collections/accounts", "POST", [ENFORCED("manage_collection_accounts"), COLL]],
  ["collections/accounts/[id]", "PATCH", [ENFORCED("manage_collection_accounts"), COLL]],
  ["collections/accounts/[id]", "DELETE", [ENFORCED("manage_collection_accounts"), COLL]],
  ["collections/settings", "GET", ["requireTenantWithBranch()", COLL]],
  ["collections/settings", "PATCH", [ENFORCED("manage_collection_accounts"), COLL]],
  ["collections/config", "GET", ["requireTenantWithBranch()", "resolveCollectionsFeatures("]],
  // Doc 15 spec 13 §7 T7 — the collections tick is a bearer-guarded cron.
  ["cron/collections-tick", "POST", ['guardCronRequest(req, { bucket: "collections-tick" })']],
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

/** Every `route.ts` under a directory of app/api, as its route path. */
function routeFilesUnder(dir: string): string[] {
  const apiRoot = fileURLToPath(new URL("../../app/api/", import.meta.url));
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs)) {
      const p = join(abs, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === "route.ts") out.push(relative(apiRoot, abs).split("\\").join("/"));
    }
  };
  walk(join(apiRoot, dir));
  return out.sort();
}

describe("every digital-collections handler is pinned (doc 15 spec 05 §6 criterion 14)", () => {
  const pinned = new Set(GATES.map(([route, handler]) => `${handler} ${route}`));
  const routes = routeFilesUnder("collections");

  it("finds the collections route files", () => {
    expect(routes.length).toBeGreaterThanOrEqual(8);
  });

  for (const route of routes) {
    it(`/api/${route}: each exported handler has a GATES row`, () => {
      const src = routeSource(route);
      const handlers = [...src.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\(/g)].map((m) => m[1]);
      expect(handlers.length).toBeGreaterThan(0);
      for (const h of handlers) expect(pinned.has(`${h} ${route}`), `${h} /api/${route} has no GATES row`).toBe(true);
    });
  }
});
