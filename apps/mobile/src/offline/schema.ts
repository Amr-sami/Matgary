/**
 * Drizzle table definitions for the on-device store (expo-sqlite).
 *
 * These exist for typed queries only — the tables are created by db.ts with
 * plain `CREATE TABLE IF NOT EXISTS` so no migration tooling runs on device.
 * When you add a column here, add it to the DDL in db.ts too (and to the
 * ALTER list there if the app has already shipped without it).
 */
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Row lifecycle. `done` rows are kept briefly for the receipt state, then swept. */
export type OutboxStatus = "queued" | "sending" | "failed" | "done";

export const outbox = sqliteTable(
  "outbox",
  {
    /** Client-minted, e.g. "sale_01J…". Stable across retries. */
    id: text("id").primaryKey(),
    /** Handler registry key: "sale" | "return" | "attendance" | … */
    kind: text("kind").notNull(),
    /**
     * Owner fence (§6.1 shared-tablet safety). Stamped from the signed-in
     * session at enqueue, never changed. Every read and the drain filter on
     * tenant_id, so another account's rows are never sent under this
     * account's bearer, never shown, never deleted.
     */
    tenantId: text("tenant_id"),
    userId: text("user_id"),
    /** The server-confirmed branch the row was rung at; sent as X-Outbox-Branch (§6.5). */
    branchId: text("branch_id"),
    /** JSON body. Opaque to the engine — the handler owns its shape. */
    payload: text("payload").notNull(),
    /** Sent as `Idempotency-Key`. Minted once at enqueue, never regenerated (§6.6). */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    /** Epoch ms before which the drainer must not touch this row (backoff). */
    nextAttemptAt: integer("next_attempt_at").notNull().default(0),
    /** Set while `sending`; a row whose lease lapsed is reclaimed as `queued`. */
    leaseExpiresAt: integer("lease_expires_at"),
    lastError: text("last_error"),
    /** The server's machine code ("INSUFFICIENT_STOCK") or the ApiError kind. */
    lastErrorCode: text("last_error_code"),
    /** Human-visible detail for the queue screen (the server's Arabic message). */
    lastErrorText: text("last_error_text"),
    /** 1 when the failure is one the cashier can fix (§6.3 isUserActionable). */
    actionable: integer("actionable").notNull().default(0),
    /** JSON of the handler's return value once `done` (invoice id, totals …). */
    response: text("response"),
    status: text("status").$type<OutboxStatus>().notNull().default("queued"),
  },
  (t) => [
    index("outbox_drain_idx").on(t.status, t.nextAttemptAt, t.createdAt),
    index("outbox_kind_idx").on(t.kind, t.status),
    index("outbox_tenant_idx").on(t.tenantId, t.status),
  ],
);

export const snapshots = sqliteTable("snapshots", {
  key: text("key").primaryKey(),
  json: text("json").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const meta = sqliteTable("meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export type OutboxRow = typeof outbox.$inferSelect;
