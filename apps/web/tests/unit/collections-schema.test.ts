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

const M56 = `${MIG}/0056_collection_ingest.sql`;
const CHANNELS = ["ios_notification", "ios_sms", "android_notification", "android_sms", "manual_paste", "statement"];
const CHECKS_0056: Record<string, readonly string[]> = {
  collection_ingest_devices_platform_check: ["ios_shortcut", "ios_app_intent", "android_listener", "android_collector"],
  collection_ingest_devices_revoked_reason_check: ["owner", "user_removed", "security", "replaced"],
  collection_raw_messages_channel_check: CHANNELS,
  collection_raw_messages_sender_kind_check: ["alphanumeric", "numeric", "app"],
  collection_raw_messages_parse_status_check: ["parsed", "fallback", "unknown_format", "not_credit", "otp", "too_old", "duplicate"],
  collection_credits_direction_check: ["credit", "debit", "cash_in"],
  collection_credits_sender_kind_check: ["alphanumeric", "numeric", "app"],
  collection_credits_state_check: ["unmatched", "held", "matched", "ignored", "info"],
  collection_credits_hold_reason_check: [
    "ambiguous", "untrusted_source", "balance_mismatch", "no_balance_baseline", "above_review_limit",
    "no_account", "unverified_format", "manual_source", "suspicious_link", "too_old", "amount_mismatch",
    "auto_confirm_off", "matches_rejected", "test",
  ],
  collection_credits_ignored_reason_check: ["personal", "not_a_sale", "duplicate", "other"],
};

describe("0056 ↔ schema.ts", () => {
  const sql = read(M56);

  it("journal idx 56, when above every earlier entry", () => {
    const entries = journal();
    expect(entries[56]).toEqual({
      idx: 56, version: "7", when: 1781901100000, tag: "0056_collection_ingest", breakpoints: true,
    });
    expect(entries[56]!.when).toBeGreaterThan(Math.max(...entries.slice(0, 56).map((e) => e.when)));
  });

  it("the three tables agree with schema.ts; the token hash is a named UNIQUE", () => {
    agrees(schema.collectionIngestDevices, "collection_ingest_devices", sql);
    agrees(schema.collectionRawMessages, "collection_raw_messages", sql);
    agrees(schema.collectionCredits, "collection_credits", sql);
    const dev = getTableConfig(schema.collectionIngestDevices);
    expect(dev.columns.filter((c) => c.isUnique).map((c) => c.uniqueName)).toEqual([
      "collection_ingest_devices_token_hash_uq",
    ]);
    expect(sql).toContain('CONSTRAINT "collection_ingest_devices_token_hash_uq" UNIQUE');
  });

  it("enum CHECKs and channel arrays carry exactly the 03 §B.1 values", () => {
    for (const [name, values] of Object.entries(CHECKS_0056)) expect(checkList(sql, name)).toEqual(values);
    expect(arrayCheckList(sql, "collection_ingest_devices_channels_check")).toEqual(CHANNELS);
    expect(arrayCheckList(sql, "collection_credits_channels_check")).toEqual(CHANNELS);
  });

  it("RLS on raw messages and credits, NEVER on devices; the deferred FKs are added", () => {
    hasRls(sql, "collection_raw_messages");
    hasRls(sql, "collection_credits");
    expect(sql).not.toMatch(/"collection_ingest_devices" (ENABLE|FORCE) ROW LEVEL SECURITY/);
    for (const fk of [
      "collections_matched_credit_id_fkey",
      "collection_events_actor_device_id_fkey",
      "collection_events_credit_id_fkey",
    ]) expect(sql).toContain(`ADD CONSTRAINT "${fk}"`);
    expect(sql).toMatch(/"collection_raw_messages_device_fp_uq"\s+ON "collection_raw_messages" \("tenant_id", "ingest_device_id", "client_fingerprint"\)\s+WHERE "client_fingerprint" IS NOT NULL;/);
    expect(sql).not.toMatch(/INDEX\s+CONCURRENTLY/);
  });

  it("the PDPL export never SELECT *s the NO-RLS devices table (it would leak every tenant)", () => {
    const route = read("app/api/account/export/route.ts");
    expect(route).not.toContain('"collection_ingest_devices"');
    expect(route).not.toContain('"collection_raw_messages"');
  });

  it("the demo wipe deletes credits and devices before accounts", () => {
    const src = read("lib/demo/clone-tenant.ts");
    const at = (n: string) => src.indexOf(n);
    expect(at("tx.delete(s.collectionCredits)")).toBeGreaterThan(-1);
    expect(at("tx.delete(s.collectionCredits)")).toBeLessThan(at("tx.delete(s.collectionAccounts)"));
    // indexOf is -1 when a line is missing, which would pass toBeLessThan on its own.
    expect(at("tx.delete(s.collectionIngestDevices)")).toBeGreaterThan(-1);
    expect(at("tx.delete(s.collectionIngestDevices)")).toBeLessThan(at("tx.delete(s.collectionAccounts)"));
    expect(src).not.toContain("tx.insert(s.collectionIngestDevices)");
  });

  it.skipIf(!existsSync(abs(DOMAIN_TYPES)))("CHECK lists equal spec 06's domain unions", async () => {
    const d = await import("@matgary/domain/collections/types");
    expect(checkList(sql, "collection_raw_messages_channel_check")).toEqual([...d.INGEST_CHANNEL_VALUES]);
    expect(checkList(sql, "collection_ingest_devices_platform_check")).toEqual([...d.INGEST_PLATFORM_VALUES]);
    expect(checkList(sql, "collection_credits_sender_kind_check")).toEqual([...d.SENDER_KIND_VALUES]);
    expect(checkList(sql, "collection_credits_direction_check")).toEqual([...d.CREDIT_DIRECTION_VALUES]);
    expect(checkList(sql, "collection_credits_state_check")).toEqual([...d.CREDIT_STATE_VALUES]);
    expect(checkList(sql, "collection_credits_hold_reason_check")).toEqual([...d.HOLD_REASON_VALUES]);
    expect(checkList(sql, "collection_credits_ignored_reason_check")).toEqual([...d.IGNORE_REASON_VALUES]);
    expect(checkList(sql, "collection_raw_messages_parse_status_check")).toEqual([...d.PARSE_STATUS_VALUES]);
  });
});
