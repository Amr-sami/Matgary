// Walks the new-tenant flow at the LIB level (server actions can't easily be
// invoked over HTTP without React). This proves the onboarding action +
// preset seeder is idempotent and doesn't 500 on retry — which was the
// actual cause of "ابدا" → 500.
import "dotenv/config";
import bcrypt from "bcryptjs";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import { db, withTenant } from "@/lib/db";
import {
  users,
  tenants,
  tenantMembers,
  shopSettings,
} from "@/lib/db/schema";
import { seedCornerStorePreset } from "@/lib/seeds/cornerstore";

const admin = postgres(process.env.DATABASE_URL, { max: 1 });
const adminDb = drizzle(admin);

function ok(label, cond, extra = "") {
  const m = cond ? "✅" : "❌";
  console.log(`${m} ${label}${extra ? "  " + extra : ""}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  // Wipe via admin so RLS doesn't get in the way.
  await adminDb.execute(sql`
    truncate
      returns, sales, expenses,
      product_attribute_values, product_history, products,
      brands, category_attribute_values, category_attributes, categories,
      shop_settings, tenant_members, sessions, accounts, users, tenants
    restart identity cascade
  `);

  // ── Simulate signupAction ─────────────────────────────────────────────
  const passwordHash = await bcrypt.hash("Hello123", 12);
  const tenantId = await db.transaction(async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({ email: "fresh@matgary.local", passwordHash })
      .returning({ id: users.id });
    const [t] = await tx
      .insert(tenants)
      .values({ name: "Fresh Store", slug: "fresh-store" })
      .returning({ id: tenants.id });
    await tx.insert(tenantMembers).values({
      tenantId: t.id,
      userId: u.id,
      role: "owner",
    });
    await tx.execute(sql`select set_config('app.tenant_id', ${t.id}, true)`);
    await tx.insert(shopSettings).values({
      tenantId: t.id,
      shopName: "",
      messageTemplate: "...",
    });
    return t.id;
  });
  ok("signup created tenant + empty shop_settings", !!tenantId);

  // ── Simulate completeOnboardingAction (first call) ──────────────────
  await withTenant(tenantId, async (tx) => {
    await tx
      .update(shopSettings)
      .set({
        shopName: "Fresh Store",
        onboardingCompletedAt: new Date(),
      })
      .where(sql`${shopSettings.tenantId} = ${tenantId}`);
    await seedCornerStorePreset(tx, tenantId);
  });
  ok("first onboarding call succeeded", true);

  // ── Re-run (this is what 500'd before — unique constraint violation) ──
  let secondCallError = null;
  try {
    await withTenant(tenantId, async (tx) => {
      await tx
        .update(shopSettings)
        .set({ shopName: "Fresh Store", updatedAt: new Date() })
        .where(sql`${shopSettings.tenantId} = ${tenantId}`);
      await seedCornerStorePreset(tx, tenantId);
    });
  } catch (e) {
    secondCallError = e;
  }
  ok("re-running onboarding does NOT throw (idempotent)", secondCallError === null,
    secondCallError ? String(secondCallError.message || secondCallError) : "");

  // ── Verify exactly 3 categories (no duplicates) ──────────────────────
  const cats = await withTenant(tenantId, (tx) =>
    tx.execute(sql`select count(*)::int as n from categories where tenant_id = ${tenantId}`),
  );
  const catCount = Number(cats?.[0]?.n ?? 0);
  ok("exactly 3 categories after 2 onboarding runs", catCount === 3, `got ${catCount}`);

  await admin.end();
  // Close the global pool
  const pg = globalThis.__pg;
  await pg?.end?.();
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
