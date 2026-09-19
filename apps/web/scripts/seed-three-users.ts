import "dotenv/config";
import bcrypt from "bcryptjs";
import { drizzle } from "drizzle-orm/postgres-js";
import { sql } from "drizzle-orm";
import postgres from "postgres";
import {
  users,
  tenants,
  tenantMembers,
  branches,
  shopSettings,
  products,
  productHistory,
  categories,
} from "@/lib/db/schema";
import { seedCornerStorePreset } from "@/lib/seeds/cornerstore";
import { DEFAULT_MESSAGE_TEMPLATE } from "@/lib/settings.defaults";

// Wipes the database and creates three independent tenants, each with its
// own owner user, the CornerStore preset, and two sample products in a
// distinct category so you can tell the tenants apart at a glance.
// All three users share the same password for convenience.

const SHARED_PASSWORD = "Test1234!";

interface SeedUser {
  email: string;
  name: string;
  storeName: string;
  storeSlug: string;
  shopPhone: string;
  // Which CornerStore category to stock the sample products in.
  sampleCategoryKey: "watches" | "perfumes" | "sunglasses";
  sampleProducts: Array<{
    name: string;
    brand: string;
    quantity: number;
    price: string;
    costPrice: string;
    lowStockThreshold: number;
  }>;
}

const SEED_USERS: SeedUser[] = [
  {
    email: "amr@matgary.local",
    name: "Amr Owner",
    storeName: "متجر عمرو",
    storeSlug: "amr-store",
    shopPhone: "01000000001",
    sampleCategoryKey: "watches",
    sampleProducts: [
      {
        name: "Casio MTP-1374L",
        brand: "Casio",
        quantity: 12,
        price: "1250.00",
        costPrice: "850.00",
        lowStockThreshold: 3,
      },
      {
        name: "Citizen Eco-Drive AW1236",
        brand: "Citizen",
        quantity: 5,
        price: "3200.00",
        costPrice: "2400.00",
        lowStockThreshold: 2,
      },
    ],
  },
  {
    email: "sara@matgary.local",
    name: "Sara Owner",
    storeName: "متجر سارة",
    storeSlug: "sara-store",
    shopPhone: "01000000002",
    sampleCategoryKey: "perfumes",
    sampleProducts: [
      {
        name: "Chanel No. 5 EDP 100ml",
        brand: "Chanel",
        quantity: 8,
        price: "4800.00",
        costPrice: "3600.00",
        lowStockThreshold: 2,
      },
      {
        name: "Dior Sauvage EDT 60ml",
        brand: "Dior",
        quantity: 15,
        price: "3200.00",
        costPrice: "2300.00",
        lowStockThreshold: 3,
      },
    ],
  },
  {
    email: "omar@matgary.local",
    name: "Omar Owner",
    storeName: "متجر عمر",
    storeSlug: "omar-store",
    shopPhone: "01000000003",
    sampleCategoryKey: "sunglasses",
    sampleProducts: [
      {
        name: "Ray-Ban Aviator RB3025",
        brand: "Ray-Ban",
        quantity: 20,
        price: "1850.00",
        costPrice: "1200.00",
        lowStockThreshold: 5,
      },
      {
        name: "Oakley Holbrook OO9102",
        brand: "Oakley",
        quantity: 7,
        price: "2400.00",
        costPrice: "1700.00",
        lowStockThreshold: 2,
      },
    ],
  },
];

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL not set");
}

const client = postgres(process.env.DATABASE_URL, { max: 1 });
const db = drizzle(client);

async function seedOne(user: SeedUser, passwordHash: string) {
  return db.transaction(async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({ email: user.email, name: user.name, passwordHash })
      .returning({ id: users.id });

    const [t] = await tx
      .insert(tenants)
      .values({ name: user.storeName, slug: user.storeSlug })
      .returning({ id: tenants.id });

    await tx.execute(sql`select set_config('app.tenant_id', ${t.id}, true)`);

    const [b] = await tx
      .insert(branches)
      .values({
        tenantId: t.id,
        slug: "main",
        name: "الفرع الرئيسي",
        isPrimary: true,
      })
      .returning({ id: branches.id });

    await tx.insert(tenantMembers).values({
      tenantId: t.id,
      userId: u.id,
      role: "owner",
      branchId: b.id,
    });

    await tx.insert(shopSettings).values({
      tenantId: t.id,
      branchId: b.id,
      shopName: user.storeName,
      shopPhone: user.shopPhone,
      messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
      onboardingCompletedAt: new Date(),
    });

    await seedCornerStorePreset(tx, t.id, b.id);

    const [cat] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(
        sql`${categories.tenantId} = ${t.id} and ${categories.key} = ${user.sampleCategoryKey}`,
      );
    if (!cat) {
      throw new Error(
        `CornerStore preset did not seed category "${user.sampleCategoryKey}" for ${user.email}`,
      );
    }

    for (const p of user.sampleProducts) {
      const [created] = await tx
        .insert(products)
        .values({
          tenantId: t.id,
          branchId: b.id,
          categoryId: cat.id,
          name: p.name,
          brand: p.brand,
          quantity: p.quantity,
          price: p.price,
          costPrice: p.costPrice,
          lowStockThreshold: p.lowStockThreshold,
        })
        .returning({ id: products.id });

      await tx.insert(productHistory).values({
        tenantId: t.id,
        productId: created.id,
        productName: p.name,
        type: "created",
        delta: p.quantity,
        quantityAfter: p.quantity,
      });
    }

    return { tenantId: t.id, userId: u.id };
  });
}

async function main() {
  console.log("Wiping all tables…");
  await db.execute(sql`
    truncate
      returns, sales, expenses,
      product_attribute_values, product_history, products,
      brands, category_attribute_values, category_attributes, categories,
      shop_settings, tenant_members, branches,
      sessions, accounts, users, tenants
    restart identity cascade
  `);

  console.log("Hashing shared password…");
  const passwordHash = await bcrypt.hash(SHARED_PASSWORD, 12);

  const results: Array<{
    email: string;
    storeName: string;
    storeSlug: string;
    tenantId: string;
    userId: string;
  }> = [];

  for (const user of SEED_USERS) {
    console.log(`Creating ${user.email} (${user.storeName})…`);
    const { tenantId, userId } = await seedOne(user, passwordHash);
    results.push({
      email: user.email,
      storeName: user.storeName,
      storeSlug: user.storeSlug,
      tenantId,
      userId,
    });
  }

  console.log("");
  console.log("✅ Seed complete — 3 users created (shared password)");
  console.log("");
  console.log(`   password: ${SHARED_PASSWORD}`);
  console.log("");
  for (const r of results) {
    console.log(`   ${r.email}`);
    console.log(`     store : ${r.storeName} (${r.storeSlug})`);
    console.log(`     tenant: ${r.tenantId}`);
    console.log("");
  }
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
