import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import * as schema from "./schema";

// Application traffic uses the NOSUPERUSER role so RLS is enforced.
// Migrations (lib/db/migrate.ts) use the admin DATABASE_URL.
const RUNTIME_URL = process.env.APP_DATABASE_URL || process.env.DATABASE_URL;
if (!RUNTIME_URL) {
  throw new Error("APP_DATABASE_URL (or DATABASE_URL) is not set");
}

// Single global pool. In Next dev, this module hot-reloads — keep one instance
// on globalThis to avoid leaking connections.
const globalForPostgres = globalThis as unknown as {
  __pg?: ReturnType<typeof postgres>;
};

const client =
  globalForPostgres.__pg ??
  postgres(RUNTIME_URL, {
    max: 10,
    idle_timeout: 20,
  });

if (process.env.NODE_ENV !== "production") {
  globalForPostgres.__pg = client;
}

export const db = drizzle(client, { schema });
export { schema };
export type Db = typeof db;

// ─────────────────────────────────────────────────────────────────────────────
// Tenant scoping helper.
//
// Opens a transaction, sets `app.tenant_id` for the duration of the tx so that
// any RLS policy reading `current_setting('app.tenant_id', true)` sees it,
// then runs the caller's work inside that tx.
//
// Use this for any data access that should be scoped to one tenant. Application
// code is still expected to filter by tenant_id explicitly — RLS is the safety
// net, not the primary mechanism.
// ─────────────────────────────────────────────────────────────────────────────
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
