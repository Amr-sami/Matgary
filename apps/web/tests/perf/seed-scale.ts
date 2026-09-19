// Synthetic-tenant generator for Phase 6 scale measurement.
//
// Creates a fresh tenant with a chosen product count and (optionally) a
// proportional amount of sales history, so we can measure how endpoint
// latency degrades as tenant data grows.
//
// Usage:
//   PRODUCTS=100   SALES=500    npx tsx tests/perf/seed-scale.ts
//   PRODUCTS=1000  SALES=5000   npx tsx tests/perf/seed-scale.ts
//   PRODUCTS=10000 SALES=50000  npx tsx tests/perf/seed-scale.ts
//
// Each run prints the new tenant id + a snippet of email/password to log
// in with — the measure-tracks.ts rig consumes the printed JSON.

import "dotenv/config";
import bcrypt from "bcryptjs";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import {
  users,
  tenants,
  tenantMembers,
  branches,
  shopSettings,
  categories,
  products,
  sales,
} from "@/lib/db/schema";
import { seedCornerStorePreset } from "@/lib/seeds/cornerstore";
import { DEFAULT_MESSAGE_TEMPLATE } from "@/lib/settings.defaults";

const PRODUCTS = Number(process.env.PRODUCTS ?? 100);
const SALES = Number(process.env.SALES ?? 0);
const PREFIX = process.env.PREFIX ?? `scale${PRODUCTS}`;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
const client = postgres(process.env.DATABASE_URL, { max: 1 });
const db = drizzle(client);

async function main() {
  const email = `${PREFIX}-${Date.now()}@matgary.test`;
  const password = "ScalePass123!";
  const handle = `${PREFIX.toLowerCase()}-${Date.now()}`;
  const shopName = `Scale Shop ${PRODUCTS}`;

  // eslint-disable-next-line no-console
  console.log(`Seeding tenant: ${PRODUCTS} products, ${SALES} sales`);
  // eslint-disable-next-line no-console
  console.log(`  email   : ${email}`);
  // eslint-disable-next-line no-console
  console.log(`  password: ${password}`);

  const passwordHash = await bcrypt.hash(password, 12);

  const { tenantId, branchId, productIds, defaultCategoryId } = await db.transaction(async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({ email, passwordHash, locale: "ar" })
      .returning({ id: users.id });
    const [t] = await tx
      .insert(tenants)
      .values({ name: shopName, slug: handle })
      .returning({ id: tenants.id });
    await tx.execute(sql`select set_config('app.tenant_id', ${t.id}, true)`);
    const [b] = await tx
      .insert(branches)
      .values({
        tenantId: t.id,
        slug: "main",
        name: shopName,
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
      shopName,
      messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
      onboardingCompletedAt: new Date(),
    });
    await seedCornerStorePreset(tx, t.id, b.id);
    // First category seeded by the preset — used by every product AND
    // every sale (sales.category_id is NOT NULL per the schema).
    const [{ id: categoryId }] = await tx
      .select({ id: categories.id })
      .from(categories)
      .where(sql`${categories.tenantId} = ${t.id}`)
      .limit(1);

    // Bulk insert N products. Single multi-VALUES insert per batch.
    const BATCH = 500;
    const productIds: string[] = [];
    for (let i = 0; i < PRODUCTS; i += BATCH) {
      const slice = Array.from({ length: Math.min(BATCH, PRODUCTS - i) }).map(
        (_, j) => ({
          tenantId: t.id,
          branchId: b.id,
          categoryId,
          name: `Product ${i + j + 1}`,
          brand: `Brand ${((i + j) % 20) + 1}`,
          quantity: 1000, // ample stock for POS bursts
          price: String(50 + ((i + j) % 200)),
          costPrice: String(30 + ((i + j) % 100)),
          lowStockThreshold: 5,
        }),
      );
      const rows = await tx
        .insert(products)
        .values(slice)
        .returning({ id: products.id });
      productIds.push(...rows.map((r) => r.id));
    }

    return { tenantId: t.id, branchId: b.id, productIds, defaultCategoryId: categoryId };
  });

  // Sales in their own (set of) transactions — outside the seed tx so
  // we don't bloat a single transaction. Each insert is a real "sale row"
  // (one product per sale) with a random saleDate across the last 90 days.
  if (SALES > 0) {
    // eslint-disable-next-line no-console
    console.log(`  inserting ${SALES} sales…`);
    const now = Date.now();
    const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000;
    const SALES_BATCH = 1000;
    for (let i = 0; i < SALES; i += SALES_BATCH) {
      const batch = Array.from({
        length: Math.min(SALES_BATCH, SALES - i),
      }).map(() => {
        const pid = productIds[Math.floor(Math.random() * productIds.length)]!;
        const saleDate = new Date(now - Math.random() * NINETY_DAYS);
        const qty = 1;
        const price = 100;
        const subtotal = qty * price;
        return {
          tenantId,
          branchId,
          invoiceId: `INV-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
          productId: pid,
          productName: "Product Sale",
          categoryId: defaultCategoryId,
          quantitySold: qty,
          pricePerUnit: String(price),
          subtotal: String(subtotal),
          totalPrice: String(subtotal),
          amountPaid: String(subtotal),
          isPaid: true,
          paidAt: saleDate,
          saleDate,
          paymentMethod: "cash" as const,
        };
      });
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('app.tenant_id', ${tenantId}, true)`,
        );
        await tx.insert(sales).values(batch);
      });
      if (i % 5000 === 0 && i > 0) {
        // eslint-disable-next-line no-console
        console.log(`    ${i}/${SALES}`);
      }
    }
  }

  // eslint-disable-next-line no-console
  console.log(`\nSeeded.`);
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ tenantId, branchId, email, password, productCount: PRODUCTS, saleCount: SALES }, null, 2));
  await client.end();
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
