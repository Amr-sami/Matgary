/**
 * Doc 15 spec 04 — the digital-collections data model.
 * schema.ts, migrations 0055/0056 and meta/_journal.json must agree (pattern of
 * idempotency-durable.test.ts "schema + migration 0054 + journal agree"), and every
 * CHECK value list must equal 03-architecture.md §B.1. Source files and Drizzle's
 * table config only — no database.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import * as schema from "@/lib/db/schema";

const abs = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));
const read = (rel: string) => readFileSync(abs(rel), "utf8");
const MIG = "lib/db/migrations";
const M55 = `${MIG}/0055_digital_collections.sql`;
const DOMAIN_TYPES = "../../packages/domain/src/collections/types.ts"; // spec 06 part A

type Entry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
const journal = () => (JSON.parse(read(`${MIG}/meta/_journal.json`)) as { entries: Entry[] }).entries;

/** Body of `CREATE TABLE IF NOT EXISTS "<t>" ( … );` */
function tableBody(src: string, table: string): string {
  const start = src.indexOf(`CREATE TABLE IF NOT EXISTS "${table}" (`);
  expect(start, `CREATE TABLE ${table}`).toBeGreaterThanOrEqual(0);
  return src.slice(start, src.indexOf("\n);", start));
}
/** Column lines start with exactly two spaces and a quoted identifier. */
const sqlColumns = (src: string, table: string) =>
  [...tableBody(src, table).matchAll(/^ {2}"([a-z0-9_]+)"\s/gm)].map((m) => m[1]!);
const sqlIndexes = (src: string, table: string) =>
  [...src.matchAll(new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "([a-z0-9_]+)"\\s+ON "${table}"`, "g"))].map(
    (m) => m[1]!,
  );
/** Values of a named `CONSTRAINT "x" CHECK ("col" IN ('a', 'b'))`. */
function checkList(src: string, name: string): string[] {
  const m = src.match(new RegExp(`CONSTRAINT "${name}"\\s+CHECK \\("[a-z_]+" IN \\(([^)]*)\\)\\)`));
  expect(m, `CHECK ${name}`).not.toBeNull();
  return [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
}
function arrayCheckList(src: string, name: string): string[] {
  const at = src.indexOf(`CONSTRAINT "${name}"`);
  const m = src.slice(at).match(/<@ ARRAY\[([^\]]*)\]::text\[\]/);
  expect(at >= 0 && m, `array CHECK ${name}`).toBeTruthy();
  return [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
}
const sorted = (a: readonly string[]) => [...a].sort();
function agrees(table: PgTable, name: string, src: string) {
  const cfg = getTableConfig(table);
  expect(cfg.name).toBe(name);
  expect(sorted(cfg.columns.map((c) => c.name))).toEqual(sorted(sqlColumns(src, name)));
  expect(sorted(cfg.indexes.map((i) => i.config.name!))).toEqual(sorted(sqlIndexes(src, name)));
}
function hasRls(src: string, t: string) {
  expect(src).toContain(`ALTER TABLE "${t}" ENABLE ROW LEVEL SECURITY`);
  expect(src).toContain(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
  expect(src).toContain(`DROP POLICY IF EXISTS "${t}_tenant_isolation" ON "${t}"`);
  expect(src).toContain(`CREATE POLICY "${t}_tenant_isolation" ON "${t}"`);
}

// 03 §B.1, verbatim. Changing a list here without a new migration fails the suite.
const CHECKS_0055: Record<string, readonly string[]> = {
  collection_accounts_rail_check: ["instapay", "wallet"],
  collections_source_type_check: ["sale", "settlement"],
  collections_method_check: ["instapay", "wallet"],
  collections_status_check: ["pending", "confirmed", "auto_confirmed", "rejected", "void"],
  collections_reject_reason_check: ["not_received", "wrong_amount", "wrong_account", "duplicate", "other"],
  collections_reject_outcome_check: ["debt", "loss"],
  collection_events_kind_check: [
    "created", "matched", "auto_confirmed", "confirmed", "rejected", "reopened", "voided",
    "amount_changed", "account_changed", "evidence_attached", "stale_alerted", "note",
  ],
  sales_collection_status_check: ["pending", "confirmed", "rejected"],
};
const SALE_PAYMENT_METHODS = ["cash", "instapay", "wallet", "card", "initial"];

describe("migration journal", () => {
  it("idx is contiguous and every entry has its .sql file (and vice versa)", () => {
    const entries = journal();
    entries.forEach((e, i) => expect(e.idx).toBe(i));
    const files = readdirSync(abs(MIG)).filter((f) => f.endsWith(".sql")).map((f) => f.slice(0, -4));
    expect(sorted(entries.map((e) => e.tag))).toEqual(sorted(files));
  });

  it("0055 sits at idx 55 with a `when` above every earlier entry (drizzle skips it otherwise)", () => {
    const entries = journal();
    expect(entries[55]).toEqual({
      idx: 55, version: "7", when: 1781901000000, tag: "0055_digital_collections", breakpoints: true,
    });
    // The historic journal is not monotonic, so compare with the max, not the neighbour.
    expect(entries[55]!.when).toBeGreaterThan(Math.max(...entries.slice(0, 55).map((e) => e.when)));
  });
});

describe("0055 ↔ schema.ts", () => {
  const sql = read(M55);

  it("the three new tables agree column-for-column and index-for-index", () => {
    agrees(schema.collectionAccounts, "collection_accounts", sql);
    agrees(schema.collections, "collections", sql);
    agrees(schema.collectionEvents, "collection_events", sql);
  });

  it("sales / sale_payments / shop_settings gained exactly the 03 §B.2.4 columns and indexes", () => {
    const col = (t: PgTable) => getTableConfig(t).columns.map((c) => c.name);
    const idx = (t: PgTable) => getTableConfig(t).indexes.map((i) => i.config.name);
    expect(col(schema.sales)).toContain("collection_status");
    expect(idx(schema.sales)).toContain("sales_tenant_collection_pending_idx");
    expect(col(schema.salePayments)).toEqual(expect.arrayContaining(["collection_id", "voided_at"]));
    expect(idx(schema.salePayments)).toContain("sale_payments_collection_idx");
    const five = [
      "collections_enabled", "collections_require_account", "collections_stale_after_minutes",
      "collections_auto_confirm_enabled", "collections_store_payer_names",
    ];
    expect(col(schema.shopSettings)).toEqual(expect.arrayContaining(five));
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "collections_enabled" boolean NOT NULL DEFAULT false');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "collections_require_account" boolean NOT NULL DEFAULT true');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "collections_stale_after_minutes" integer NOT NULL DEFAULT 120');
    expect(sql).toContain('CHECK ("collections_stale_after_minutes" BETWEEN 15 AND 1440)');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "collections_auto_confirm_enabled" boolean NOT NULL DEFAULT false');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "collections_store_payer_names" boolean NOT NULL DEFAULT false');
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS "sales_tenant_collection_pending_idx"\s+ON "sales" \("tenant_id", "sale_date"\)\s+WHERE "collection_status" = 'pending'/);
  });

  it("every enum CHECK carries exactly the 03 §B.1 values", () => {
    for (const [name, values] of Object.entries(CHECKS_0055)) expect(checkList(sql, name)).toEqual(values);
    const m = sql.match(/ADD CONSTRAINT "sale_payments_method_check"\s+CHECK \("method" IN \(([^)]*)\)\)/);
    expect([...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1])).toEqual(SALE_PAYMENT_METHODS);
  });

  it("the load-bearing unique predicates are the ones spec 05 / 03 name", () => {
    expect(sql).toMatch(/"collections_sale_part_uq"\s+ON "collections" \("tenant_id", "invoice_id", "part_no"\)\s+WHERE "source_type" = 'sale';/);
    expect(sql).toMatch(/"collection_accounts_pos_default_uq"[\s\S]*?COALESCE\("branch_id", '00000000-0000-0000-0000-000000000000'::uuid\), "rail"\)\s+WHERE "is_pos_default" AND "archived_at" IS NULL;/);
    expect(sql).toContain('CONSTRAINT "collection_accounts_identity_chk"');
    expect(sql).toContain("AND pg_get_constraintdef(oid) NOT LIKE '%''wallet''%'"); // guarded replace, re-runnable
  });

  it("RLS on all three tables; no concurrent index build inside the migrator's transaction", () => {
    for (const t of ["collection_accounts", "collections", "collection_events"]) hasRls(sql, t);
    expect(sql).not.toMatch(/INDEX\s+CONCURRENTLY/);
    expect(sql.split("\n").filter((l) => l.startsWith("--") && l.includes("statement-breakpoint"))).toEqual(
      sql.split("\n").filter((l) => l === "--> statement-breakpoint"),
    ); // the marker never hides inside a comment line
  });

  it.skipIf(!existsSync(abs(DOMAIN_TYPES)))("CHECK lists equal spec 06's domain unions", async () => {
    const d = await import("@matgary/domain/collections/types");
    expect(checkList(sql, "collection_accounts_rail_check")).toEqual([...d.COLLECTION_RAIL_VALUES]);
    expect(checkList(sql, "collections_method_check")).toEqual([...d.DIGITAL_METHOD_VALUES]);
    expect(checkList(sql, "collections_status_check")).toEqual([...d.COLLECTION_STATUS_VALUES]);
    expect(checkList(sql, "sales_collection_status_check")).toEqual([...d.SALE_COLLECTION_STATUS_VALUES]);
    expect(checkList(sql, "collections_source_type_check")).toEqual([...d.COLLECTION_SOURCE_TYPE_VALUES]);
    expect(checkList(sql, "collections_reject_reason_check")).toEqual([...d.REJECT_REASON_VALUES]);
    expect(checkList(sql, "collections_reject_outcome_check")).toEqual([...d.REJECT_OUTCOME_VALUES]);
    expect(checkList(sql, "collection_events_kind_check")).toEqual([...d.COLLECTION_EVENT_KIND_VALUES]);
    expect(SALE_PAYMENT_METHODS).toEqual([...d.SALE_PAYMENT_METHOD_VALUES]);
  });
});

describe("demo clone (lib/demo/clone-tenant.ts) knows the new tables", () => {
  const src = read("lib/demo/clone-tenant.ts");
  it("wipes collections before accounts, and accounts before branches (RESTRICT FKs)", () => {
    const at = (needle: string) => src.indexOf(needle);
    expect(at("tx.delete(s.collections)")).toBeGreaterThan(-1);
    expect(at("tx.delete(s.collections)")).toBeLessThan(at("tx.delete(s.collectionAccounts)"));
    expect(at("tx.delete(s.collectionAccounts)")).toBeLessThan(at("tx.delete(s.branches)"));
  });
  it("clones accounts only and never carries a template collection link", () => {
    expect(src).toContain("tx.insert(s.collectionAccounts)");
    expect(src).not.toContain("tx.insert(s.collections)");
    expect(src).toContain("collectionStatus: null");
    expect(src).toContain("collectionId: null");
  });
});
