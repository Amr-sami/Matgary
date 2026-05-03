import "dotenv/config";
import bcrypt from "bcryptjs";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  users,
  tenants,
  tenantMembers,
  shopSettings,
  products,
  productHistory,
  categories,
} from "@/lib/db/schema";
import { seedCornerStorePreset } from "@/lib/seeds/cornerstore";
import { DEFAULT_MESSAGE_TEMPLATE } from "@/lib/settings.defaults";

// Wipes the database and creates a known-good tenant + user with the
// CornerStore preset and two sample products. Use this when you need a
// clean slate for manual testing or screenshots.

const TEST_EMAIL = "test@matgary.local";
const TEST_PASSWORD = "Test1234!";
const TEST_STORE = "متجر التجربة";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL not set");
}

const client = postgres(process.env.DATABASE_URL, { max: 1 });
const db = drizzle(client);

async function main() {
  console.log("Wiping all tables…");
  await db.execute(sql`
    truncate
      returns, sales, expenses,
      product_attribute_values, product_history, products,
      brands, category_attribute_values, category_attributes, categories,
      shop_settings, tenant_members, sessions, accounts, users, tenants
    restart identity cascade
  `);

  console.log(`Creating test user ${TEST_EMAIL} …`);
  const passwordHash = await bcrypt.hash(TEST_PASSWORD, 12);

  const { tenantId, userId } = await db.transaction(async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({ email: TEST_EMAIL, name: "Test Owner", passwordHash })
      .returning({ id: users.id });

    const [t] = await tx
      .insert(tenants)
      .values({ name: TEST_STORE, slug: "test-store" })
      .returning({ id: tenants.id });

    await tx.insert(tenantMembers).values({
      tenantId: t.id,
      userId: u.id,
      role: "owner",
    });

    // shop_settings is RLS-protected — set app.tenant_id for the rest of the tx.
    await tx.execute(sql`select set_config('app.tenant_id', ${t.id}, true)`);
    await tx.insert(shopSettings).values({
      tenantId: t.id,
      shopName: TEST_STORE,
      shopPhone: "01000000000",
      messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
      onboardingCompletedAt: new Date(),
    });

    await seedCornerStorePreset(tx, t.id);

    // Two sample products in the watches category so /inventory has content.
    const [watchesCat] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(sql`${categories.tenantId} = ${t.id} and ${categories.key} = 'watches'`);

    if (watchesCat) {
      const [p1] = await tx
        .insert(products)
        .values({
          tenantId: t.id,
          categoryId: watchesCat.id,
          name: "Casio MTP-1374L",
          brand: "Casio",
          quantity: 12,
          price: "1250.00",
          costPrice: "850.00",
          lowStockThreshold: 3,
        })
        .returning({ id: products.id });

      const [p2] = await tx
        .insert(products)
        .values({
          tenantId: t.id,
          categoryId: watchesCat.id,
          name: "Citizen Eco-Drive AW1236",
          brand: "Citizen",
          quantity: 5,
          price: "3200.00",
          costPrice: "2400.00",
          lowStockThreshold: 2,
        })
        .returning({ id: products.id });

      await tx.insert(productHistory).values([
        {
          tenantId: t.id,
          productId: p1.id,
          productName: "Casio MTP-1374L",
          type: "created",
          delta: 12,
          quantityAfter: 12,
        },
        {
          tenantId: t.id,
          productId: p2.id,
          productName: "Citizen Eco-Drive AW1236",
          type: "created",
          delta: 5,
          quantityAfter: 5,
        },
      ]);
    }

    return { tenantId: t.id, userId: u.id };
  });

  console.log("");
  console.log("✅ Seed complete");
  console.log("   email   :", TEST_EMAIL);
  console.log("   password:", TEST_PASSWORD);
  console.log("   tenant  :", tenantId);
  console.log("   user    :", userId);
  console.log("");
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
