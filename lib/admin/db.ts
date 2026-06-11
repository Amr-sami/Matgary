// Admin DB pool. Connects as matgary_admin (BYPASSRLS) so a single query can
// SELECT across every tenant. NEVER imported from tenant-facing code — the
// ESLint no-restricted-imports rule guards this. If a tenant route needs
// admin-scoped data, that's a design smell — escalate, don't bypass.

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/lib/db/schema";

const ADMIN_DATABASE_URL = process.env.ADMIN_DATABASE_URL;

declare global {
  // eslint-disable-next-line no-var
  var __matgaryAdminPool: ReturnType<typeof postgres> | undefined;
  // eslint-disable-next-line no-var
  var __matgaryAdminDb: ReturnType<typeof drizzle> | undefined;
}

function getPool() {
  if (!ADMIN_DATABASE_URL) {
    throw new Error(
      "ADMIN_DATABASE_URL is not set. /admin/* routes need a BYPASSRLS pool. " +
        "Set it in .env after running `npm run db:migrate` (which provisions the matgary_admin role).",
    );
  }
  // Single shared client per process. Next dev's hot reload would otherwise
  // leak connections — same pattern as the tenant pool in lib/db/index.ts.
  if (!globalThis.__matgaryAdminPool) {
    globalThis.__matgaryAdminPool = postgres(ADMIN_DATABASE_URL, {
      max: 8,
      idle_timeout: 30,
    });
  }
  return globalThis.__matgaryAdminPool;
}

export function getAdminDb() {
  if (!globalThis.__matgaryAdminDb) {
    globalThis.__matgaryAdminDb = drizzle(getPool(), { schema });
  }
  return globalThis.__matgaryAdminDb;
}

/** True iff the env is wired enough for /admin to function. The proxy uses
 *  this to return a clean 503 page when the operator forgot to populate
 *  ADMIN_DATABASE_URL on a fresh deploy. */
export function isAdminPoolConfigured(): boolean {
  return !!ADMIN_DATABASE_URL;
}
