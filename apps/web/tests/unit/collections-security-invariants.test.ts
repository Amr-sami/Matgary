/**
 * Doc 15 spec 14 §7 — digital-collections security invariants (source reads).
 *
 * Created by spec 05 step 23b with SI-1a and SI-1b only (spec 14 step 7 had
 * not landed); spec 14 adds SI-2 … SI-7 to this file. Every case is
 * `it.runIf(existsSync(path))` so it activates when the owning spec lands.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WEB = path.resolve(__dirname, "../..");
const EXPORT_ROUTE = path.join(WEB, "app/api/account/export/route.ts");
const MIGRATIONS = path.join(WEB, "lib/db/migrations");

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
});
