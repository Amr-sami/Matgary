/**
 * Doc 15 spec 14 §7 — digital-collections security invariants (source reads).
 *
 * Created by spec 05 step 23b with SI-1a and SI-1b only. Spec 14 at M1 (README
 * §3 order 11) added SI-2, SI-5 and SI-6, the cases that have M1 code to read;
 * SI-3, SI-4 and SI-7 read spec 07's M2 files (ingest repo, raw-text, the v1
 * ingest route) and are written with them (14 steps 6–9, README §3 order 23).
 * Every case is `it.runIf(existsSync(path))` so it activates when the owning
 * spec lands.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { scrubSentryEvent } from "@matgary/domain/observability/scrub";

const WEB = path.resolve(__dirname, "../..");
const EXPORT_ROUTE = path.join(WEB, "app/api/account/export/route.ts");
const MIGRATIONS = path.join(WEB, "lib/db/migrations");
const AUTH_HELPERS = path.join(WEB, "lib/api/auth-helpers.ts");
const MOBILE = path.resolve(WEB, "../mobile");
/** Every screen / component that renders collections data (raw message text from M2). */
const COLLECTIONS_UI = [
  path.join(WEB, "app/collections"),
  path.join(WEB, "components/collections"),
  path.join(WEB, "app/settings/collections"),
  path.join(MOBILE, "src/app/(app)/collections"),
  path.join(MOBILE, "src/app/(app)/collections.tsx"),
  path.join(MOBILE, "src/components/collections"),
  path.join(MOBILE, "src/app/(app)/settings/collections"),
  path.join(MOBILE, "src/app/(app)/settings/collections.tsx"),
];

/** .ts / .tsx files under a file-or-directory root. */
function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  if (statSync(root).isFile()) return /\.tsx?$/.test(root) ? [root] : [];
  return readdirSync(root, { withFileTypes: true }).flatMap((e) =>
    sourceFiles(path.join(root, e.name)),
  );
}

/** String literals of the `const TABLES = [ … ] as const` array. */
function exportTables(src: string): string[] {
  const m = src.match(/const TABLES = \[([\s\S]*?)\] as const/);
  if (!m) throw new Error("TABLES array not found in the export route");
  return [...m[1]!.matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]!);
}

/** Keys of the `EXPLICIT_TENANT_FILTER` map with a `tenant_id` / `id` column. */
function explicitlyFiltered(src: string): Set<string> {
  const m = src.match(/const EXPLICIT_TENANT_FILTER[^=]*=\s*\{([\s\S]*?)\};/);
  if (!m) return new Set();
  return new Set(
    [...m[1]!.matchAll(/([a-z0-9_]+)\s*:\s*"(tenant_id|id)"/g)].map((x) => x[1]!),
  );
}

function tablesWithRlsEnabled(): Set<string> {
  const out = new Set<string>();
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql"))) {
    const sqlText = readFileSync(path.join(MIGRATIONS, f), "utf8");
    for (const m of sqlText.matchAll(
      /ALTER TABLE\s+(?:IF EXISTS\s+)?(?:"?public"?\.)?"?([a-z0-9_]+)"?\s+ENABLE ROW LEVEL SECURITY/gi,
    )) {
      out.add(m[1]!.toLowerCase());
    }
  }
  return out;
}

describe("collections security invariants (spec 14 §7)", () => {
  it.runIf(existsSync(EXPORT_ROUTE))(
    "SI-1a: the owner export never carries collection_ingest_devices, collection_raw_messages or auth_devices",
    () => {
      const tables = exportTables(readFileSync(EXPORT_ROUTE, "utf8"));
      expect(tables.length).toBeGreaterThan(0);
      for (const banned of ["collection_ingest_devices", "collection_raw_messages", "auth_devices"]) {
        expect(tables).not.toContain(banned);
      }
    },
  );

  it.runIf(existsSync(EXPORT_ROUTE))(
    "SI-1b: every exported table has ENABLE ROW LEVEL SECURITY in a migration or an explicit tenant filter (SEC14-F1)",
    () => {
      const src = readFileSync(EXPORT_ROUTE, "utf8");
      const rls = tablesWithRlsEnabled();
      const filtered = explicitlyFiltered(src);
      const unguarded = exportTables(src).filter((t) => !rls.has(t) && !filtered.has(t));
      expect(unguarded).toEqual([]);
      // The filter must be applied as a parameterised WHERE, not merely declared.
      expect(src).toMatch(/WHERE \$\{sql\.identifier\(filterCol\)\} = \$\{r\.ctx\.tenantId\}/);
    },
  );

  it.runIf(existsSync(AUTH_HELPERS))(
    "SI-2: resolveSession refuses an mgi_ ingest bearer before any JWT parse",
    () => {
      const src = readFileSync(AUTH_HELPERS, "utf8");
      const start = src.search(/async function resolveSession\(/);
      expect(start).toBeGreaterThan(-1);
      const body = src.slice(start);
      const refuse = body.search(/startsWith\(\s*["']mgi_["']\s*\)/);
      const verify = body.indexOf("verifyAccessToken(");
      expect(refuse).toBeGreaterThan(-1);
      expect(verify).toBeGreaterThan(-1);
      expect(refuse).toBeLessThan(verify);
    },
  );

  it.runIf(COLLECTIONS_UI.some((p) => existsSync(p)))(
    "SI-5: collections UI never renders HTML or auto-links text (web + mobile)",
    () => {
      const files = COLLECTIONS_UI.flatMap(sourceFiles);
      expect(files.length).toBeGreaterThan(0);
      const offences: string[] = [];
      for (const f of files) {
        const src = readFileSync(f, "utf8");
        const rel = path.relative(path.resolve(WEB, "../.."), f);
        if (src.includes("dangerouslySetInnerHTML")) offences.push(`${rel}: dangerouslySetInnerHTML`);
        if (/(?:from\s+|require\(\s*|import\(\s*)["'][^"']*(?:linkify|autolink)[^"']*["']/i.test(src)) {
          offences.push(`${rel}: linkify/autolink import`);
        }
        for (const m of src.matchAll(/dataDetectorTypes?\s*=\s*(\{[^}]*\}|"[^"]*"|'[^']*')/g)) {
          if (!/^(?:"none"|'none'|\{\s*["']none["']\s*\})$/.test(m[1]!)) offences.push(`${rel}: ${m[0]}`);
        }
      }
      expect(offences).toEqual([]);
    },
  );

  describe("SI-6: the Sentry scrubber drops collections data (14 step 6, SEC14-F2)", () => {
    const ARABIC_CREDIT = "تم استلام مبلغ";

    it("a string JSON body on the ingest URL leaves no message text (14 §6 criterion 6)", () => {
      const event = scrubSentryEvent({
        request: {
          url: "https://thestoro.com/api/v1/collections/ingest",
          data: JSON.stringify({ v: 1, messages: [{ body: ARABIC_CREDIT }] }),
        },
      });
      expect(JSON.stringify(event)).not.toContain(ARABIC_CREDIT);
      expect(event.request?.data).toEqual({ v: 1, messages: "[REDACTED]" });
    });

    it("an object body {messages:[{body}]} is redacted", () => {
      const event = scrubSentryEvent({
        request: { data: { v: 1, messages: [{ sender: "VF-Cash", body: ARABIC_CREDIT }] } },
      });
      expect(JSON.stringify(event)).not.toContain(ARABIC_CREDIT);
      expect(JSON.stringify(event)).not.toContain("VF-Cash");
    });

    it("a body that is not a JSON object is dropped on a collections route, kept elsewhere", () => {
      const onCollections = scrubSentryEvent({
        request: { url: "/api/collections/credits/paste", data: `${ARABIC_CREDIT} 150.00` },
      });
      expect(onCollections.request?.data).toBe("[REDACTED]");
      const elsewhere = scrubSentryEvent({ request: { url: "/api/products", data: "plain" } });
      expect(elsewhere.request?.data).toBe("plain");
      const nested = scrubSentryEvent({
        request: { url: "/api/sales/cart", data: JSON.stringify({ payerName: "AHMED MOHAMED" }) },
      });
      expect(nested.request?.data).toEqual({ payerName: "[REDACTED]" });
    });

    it("receiving-account and payer fields in extra are redacted in any casing", () => {
      const event = scrubSentryEvent({
        extra: {
          account: {
            id: "a1",
            iban: "EG380019000500000000263180002",
            walletMsisdn: "01012345678",
            wallet_msisdn: "01012345678",
            ipaLink: "https://ipn.eg/S/shop/instapay/abc",
            ipaHandle: "shop@instapay",
            accountLast4: "1234",
          },
          credit: { payerName: "AHMED MOHAMED", payer_phone: "01099999999", rawText: ARABIC_CREDIT, text: ARABIC_CREDIT },
        },
      });
      const out = JSON.stringify(event);
      for (const leak of ["EG38", "01012345678", "ipn.eg", "shop@instapay", "AHMED", "01099999999", ARABIC_CREDIT]) {
        expect(out).not.toContain(leak);
      }
      // Minimised fields the product shows anyway keep their value, so triage still works.
      expect((event.extra as { account: { accountLast4: string } }).account.accountLast4).toBe("1234");
    });

    it("an Authorization: Bearer mgi_… header is redacted", () => {
      const token = `mgi_${"A".repeat(43)}`;
      const event = scrubSentryEvent({ request: { headers: { Authorization: `Bearer ${token}` } } });
      expect(JSON.stringify(event)).not.toContain(token);
    });
  });
});
