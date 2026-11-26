// Seeds the "demo store" template tenant — the single source of truth that
// every visitor's clone is built from. Visitors click "تصفح المتجر التجريبي"
// on /login or /signup; the API spins up an ephemeral tenant cloned from
// THIS template; on every full-page refresh the clone is wiped and re-cloned
// so the visitor's edits never persist.
//
// Run AFTER `pnpm db:migrate`. Idempotent — drops any existing clones, wipes
// the template's child rows, re-seeds in place. Safe to re-run anytime the
// seed data changes.
//
//   pnpm tsx scripts/seed-demo-template.ts
//
// RE-SEED CADENCE: every dated row (sales, returns, expenses, tasks…) is
// stamped relative to the moment this script runs, and lib/demo/clone-tenant.ts
// copies those timestamps verbatim into each visitor's clone. Nothing shifts
// them later, so "this month" / "this week" tiles (مرتجعات الشهر, مبيعات
// الأسبوع) decay as the calendar moves on and read 0 after a month boundary.
// Re-run `npm run db:seed:demo` at least monthly — ideally on the 1st — or
// whenever the trial's dashboard starts looking empty.

import "dotenv/config";
import bcrypt from "bcryptjs";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, sql } from "drizzle-orm";
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
  subscriptions,
  returns,
} from "@/lib/db/schema";
import { seedCornerStorePreset } from "@/lib/seeds/cornerstore";
import { DEFAULT_MESSAGE_TEMPLATE } from "@/lib/settings.defaults";
import { addSupplier } from "@/lib/repo/suppliers";
import { createPurchaseOrder } from "@/lib/repo/purchase-orders";
import { createTask } from "@/lib/repo/tasks";
import { addExpense } from "@/lib/repo/expenses";
import { recordReturn, recordSale } from "@/lib/repo/operations";
import { logActivity } from "@/lib/repo/activity";

const TEMPLATE_EMAIL = "demo-template@matgary.local";
const TEMPLATE_PASSWORD = "DemoTemplate!2026"; // never used; clones get their own throwaway pw
const TEMPLATE_STORE_NAME = "متجر التجربة";
const TEMPLATE_STORE_SLUG = "demo-template";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL not set");
}

const client = postgres(process.env.DATABASE_URL, { max: 1 });
const db = drizzle(client);

interface ProductSeed {
  categoryKey: "watches" | "perfumes" | "sunglasses";
  name: string;
  brand: string;
  quantity: number;
  price: string;
  costPrice: string;
  lowStockThreshold: number;
}

const PRODUCTS: ProductSeed[] = [
  { categoryKey: "watches", name: "Casio MTP-1374L", brand: "Casio", quantity: 35, price: "1250.00", costPrice: "850.00", lowStockThreshold: 3 },
  { categoryKey: "watches", name: "Casio Edifice EFR-526", brand: "Casio", quantity: 22, price: "3400.00", costPrice: "2500.00", lowStockThreshold: 2 },
  { categoryKey: "watches", name: "Casio G-Shock GA-2100", brand: "Casio", quantity: 18, price: "2800.00", costPrice: "1900.00", lowStockThreshold: 3 },
  { categoryKey: "watches", name: "Citizen Eco-Drive AW1236", brand: "Citizen", quantity: 14, price: "3200.00", costPrice: "2400.00", lowStockThreshold: 2 },
  { categoryKey: "watches", name: "Seiko SKX007 Diver", brand: "Seiko", quantity: 6, price: "6800.00", costPrice: "5100.00", lowStockThreshold: 1 },
  { categoryKey: "watches", name: "Tissot PR 100", brand: "Tissot", quantity: 8, price: "7100.00", costPrice: "5300.00", lowStockThreshold: 2 },
  { categoryKey: "perfumes", name: "Chanel No. 5 EDP 100ml", brand: "Chanel", quantity: 24, price: "4800.00", costPrice: "3600.00", lowStockThreshold: 4 },
  { categoryKey: "perfumes", name: "Dior Sauvage EDT 60ml", brand: "Dior", quantity: 30, price: "3200.00", costPrice: "2300.00", lowStockThreshold: 5 },
  { categoryKey: "perfumes", name: "Tom Ford Black Orchid 50ml", brand: "Tom Ford", quantity: 9, price: "5400.00", costPrice: "4000.00", lowStockThreshold: 2 },
  { categoryKey: "perfumes", name: "Yves Saint Laurent Libre 50ml", brand: "YSL", quantity: 18, price: "3600.00", costPrice: "2700.00", lowStockThreshold: 3 },
  { categoryKey: "perfumes", name: "Versace Eros 100ml", brand: "Versace", quantity: 13, price: "2900.00", costPrice: "2100.00", lowStockThreshold: 3 },
  { categoryKey: "sunglasses", name: "Ray-Ban Aviator RB3025", brand: "Ray-Ban", quantity: 40, price: "1850.00", costPrice: "1200.00", lowStockThreshold: 6 },
  { categoryKey: "sunglasses", name: "Ray-Ban Wayfarer RB2140", brand: "Ray-Ban", quantity: 32, price: "1750.00", costPrice: "1150.00", lowStockThreshold: 5 },
  { categoryKey: "sunglasses", name: "Oakley Holbrook OO9102", brand: "Oakley", quantity: 17, price: "2400.00", costPrice: "1700.00", lowStockThreshold: 3 },
  { categoryKey: "sunglasses", name: "Persol PO3019S", brand: "Persol", quantity: 6, price: "3900.00", costPrice: "2900.00", lowStockThreshold: 2 },
];

const SUPPLIERS = [
  { name: "شركة الإمداد للساعات", phone: "01100000001", address: "القاهرة - وسط البلد" },
  { name: "مؤسسة العطور العربية", phone: "01100000002", address: "الإسكندرية - سموحة" },
  { name: "موزع النظارات العالمية", phone: "01100000003", address: "الجيزة - المهندسين" },
];

const CUSTOMERS = [
  { name: "أحمد محمود", phone: "01001234001" },
  { name: "سارة عبدالله", phone: "01001234002" },
  { name: "محمد علي", phone: "01001234003" },
  { name: "فاطمة حسن", phone: "01001234004" },
  { name: "خالد إبراهيم", phone: "01001234005" },
  { name: "نور الهدى", phone: "01001234006" },
  { name: "ليلى السيد", phone: "01001234007" },
  { name: "عمر النجار", phone: "01001234008" },
];

const TASKS = [
  { title: "متابعة شحنة الساعات الجديدة من المورد", priority: "high" as const, dueOffsetDays: 2 },
  { title: "تحديث أسعار العطور بعد رفع الجمارك", priority: "normal" as const, dueOffsetDays: 5 },
  { title: "مراجعة المخزون قبل قفل الشهر", priority: "high" as const, dueOffsetDays: 7 },
];

const EXPENSES = [
  { title: "إيجار المحل", amount: 8500, category: "rent" as const, daysAgo: 12 },
  { title: "فاتورة الكهرباء", amount: 420, category: "electricity" as const, daysAgo: 8 },
  { title: "اشتراك الإنترنت", amount: 350, category: "internet" as const, daysAgo: 15 },
  { title: "رواتب الموظفين", amount: 12000, category: "salaries" as const, daysAgo: 3 },
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(10 + Math.floor(Math.random() * 10), Math.floor(Math.random() * 60));
  return d;
}

async function dropExistingClones(): Promise<void> {
  const existing = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(sql`${tenants.demoTemplateId} IS NOT NULL`);
  if (existing.length === 0) return;
  console.log(`Removing ${existing.length} existing demo clone(s)…`);
  for (const c of existing) {
    await db.delete(tenants).where(eq(tenants.id, c.id));
  }
}

async function findOrCreateTemplate(): Promise<{
  tenantId: string;
  branchId: string;
  userId: string;
}> {
  // Re-use the template tenant row if it already exists so any clones that
  // were FK-referencing it via demo_template_id stay valid across re-seeds.
  const [existing] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(
      sql`${tenants.isDemo} = true AND ${tenants.demoTemplateId} IS NULL`,
    )
    .limit(1);

  if (existing) {
    console.log(`Found existing template tenant ${existing.id} — wiping its data…`);
    // Cascade-delete all tenant-scoped child rows. We can't drop & recreate
    // the tenant row because demo clones FK to it; wipe each child table
    // explicitly instead. postgres-js prepares every statement, so each
    // DELETE needs its own .execute() call.
    const wipeTables = [
      "activity_logs",
      "returns",
      "sale_payments",
      "sales",
      "purchase_order_payments",
      "purchase_order_items",
      "purchase_orders",
      "expenses",
      "tasks",
      "customer_wallet_events",
      "customer_wallets",
      "cash_movements",
      "cash_shifts",
      "shop_settings",
      "product_history",
      "product_attribute_values",
      "products",
      "suppliers",
      "brands",
      "category_attribute_values",
      "category_attributes",
      "categories",
      "tenant_members",
      "branches",
      "subscriptions",
    ];
    for (const table of wipeTables) {
      await db.execute(sql.raw(`DELETE FROM ${table} WHERE tenant_id = '${existing.id}'`));
    }
    // Re-attach the owner + primary branch fresh below.
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, TEMPLATE_EMAIL))
      .limit(1);
    let userId = u?.id;
    if (!userId) {
      const passwordHash = await bcrypt.hash(TEMPLATE_PASSWORD, 12);
      const [created] = await db
        .insert(users)
        .values({ email: TEMPLATE_EMAIL, name: "Demo Owner", passwordHash })
        .returning({ id: users.id });
      userId = created.id;
    }
    const [b] = await db
      .insert(branches)
      .values({
        tenantId: existing.id,
        slug: "main",
        name: "الفرع الرئيسي",
        isPrimary: true,
      })
      .returning({ id: branches.id });
    await db.insert(tenantMembers).values({
      tenantId: existing.id,
      userId,
      role: "owner",
      branchId: b.id,
    });
    return { tenantId: existing.id, branchId: b.id, userId };
  }

  console.log("Creating template tenant from scratch…");
  const passwordHash = await bcrypt.hash(TEMPLATE_PASSWORD, 12);
  return await db.transaction(async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({ email: TEMPLATE_EMAIL, name: "Demo Owner", passwordHash })
      .onConflictDoUpdate({
        target: users.email,
        set: { name: "Demo Owner" },
      })
      .returning({ id: users.id });
    const [t] = await tx
      .insert(tenants)
      .values({
        name: TEMPLATE_STORE_NAME,
        slug: TEMPLATE_STORE_SLUG,
        isDemo: true,
      })
      .returning({ id: tenants.id });
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
    return { tenantId: t.id, branchId: b.id, userId: u.id };
  });
}

async function main() {
  console.log("Demo template seed starting…");

  await dropExistingClones();
  const { tenantId, branchId, userId } = await findOrCreateTemplate();

  // shop_settings — needs onboardingCompletedAt so the visitor lands on the
  // dashboard, not the onboarding modal.
  await db.insert(shopSettings).values({
    tenantId,
    branchId,
    shopName: TEMPLATE_STORE_NAME,
    shopPhone: "01000000001",
    messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
    onboardingCompletedAt: new Date(),
  });

  // Category preset (watches / perfumes / sunglasses).
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    await seedCornerStorePreset(tx, tenantId, branchId);
  });

  // Products.
  console.log(`Adding ${PRODUCTS.length} products…`);
  const productIds: Array<{ id: string; categoryKey: string; price: number }> = [];
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    const cats = await tx
      .select({ id: categories.id, key: categories.key })
      .from(categories)
      .where(sql`${categories.tenantId} = ${tenantId}`);
    const catByKey = new Map(cats.map((c) => [c.key, c.id]));
    for (const p of PRODUCTS) {
      const catId = catByKey.get(p.categoryKey);
      if (!catId) continue;
      const [created] = await tx
        .insert(products)
        .values({
          tenantId,
          branchId,
          categoryId: catId,
          name: p.name,
          brand: p.brand,
          quantity: p.quantity,
          price: p.price,
          costPrice: p.costPrice,
          lowStockThreshold: p.lowStockThreshold,
        })
        .returning({ id: products.id });
      await tx.insert(productHistory).values({
        tenantId,
        productId: created.id,
        productName: p.name,
        type: "created",
        delta: p.quantity,
        quantityAfter: p.quantity,
      });
      productIds.push({
        id: created.id,
        categoryKey: p.categoryKey,
        price: Number(p.price),
      });
    }
  });

  // Suppliers.
  console.log(`Adding ${SUPPLIERS.length} suppliers…`);
  const supplierIds: string[] = [];
  for (const sup of SUPPLIERS) {
    const r = await addSupplier(tenantId, branchId, {
      name: sup.name,
      phone: sup.phone,
      address: sup.address,
    });
    supplierIds.push(r.id);
  }

  // Sales — keep counts modest (visitor's clone gets re-copied on every
  // refresh; bigger seeds = slower refresh).
  const SALE_COUNT = 45;
  console.log(`Recording ${SALE_COUNT} sales across the past 30 days…`);
  const PAYMENT_METHODS = ["cash", "cash", "cash", "instapay", "card", "deferred"] as const;
  // Sales worth returning later — recent, non-deferred, qty >= 1. The demo
  // must show مرتجعات الشهر > 0 and a populated /returns (HANDOFF §8 item 11).
  const returnable: Array<{ saleId: string; productId: string; qty: number; soldAt: Date }> = [];
  for (let i = 0; i < SALE_COUNT; i++) {
    const product = pick(productIds);
    const qty = Math.random() < 0.7 ? 1 : 2;
    const customer = Math.random() < 0.8 ? pick(CUSTOMERS) : null;
    const paymentMethod = pick(PAYMENT_METHODS);
    const discountPct = Math.random() < 0.3 ? Math.floor(Math.random() * 15) + 5 : 0;
    const offsetDays = i < SALE_COUNT * 0.25 ? 0 : Math.floor(Math.random() * 30);
    const soldAt = daysAgo(offsetDays);
    try {
      const { saleId } = await recordSale(tenantId, {
        productId: product.id,
        quantitySold: qty,
        pricePerUnit: product.price,
        customerName: customer?.name,
        customerPhone: customer?.phone,
        paymentMethod,
        customDate: soldAt,
        recordedByUserId: userId,
        branchId,
        ...(discountPct > 0
          ? { discountType: "percentage" as const, discountValue: discountPct }
          : {}),
        ...(paymentMethod === "deferred" ? { amountPaidNow: 0 } : {}),
      });
      if (paymentMethod !== "deferred" && offsetDays <= 7) {
        returnable.push({ saleId, productId: product.id, qty, soldAt });
      }
    } catch (err) {
      console.warn(`  skipped sale #${i}: ${(err as Error).message ?? String(err)}`);
    }
  }

  // Returns — two of this week's sales come back, so the dashboard's
  // مرتجعات الشهر tile and /returns aren't empty in the trial. recordReturn
  // re-credits stock and flags the sale, exactly like the POS return flow.
  const RETURN_REASONS = ["عيب في المنتج", "المقاس مش مناسب", "العميل غيّر رأيه"];
  const RETURN_COUNT = Math.min(2, returnable.length);
  console.log(`Recording ${RETURN_COUNT} returns…`);
  for (let i = 0; i < RETURN_COUNT; i++) {
    const r = returnable[i];
    try {
      const { returnId } = await recordReturn(tenantId, {
        saleId: r.saleId,
        productId: r.productId,
        returnedQuantity: r.qty,
        reason: RETURN_REASONS[i % RETURN_REASONS.length],
      });
      // recordReturn stamps return_date = now(). Back-date it to the day
      // after the sale (never in the future) so the row reads as a real
      // return — and, for a sale from earlier today, so the return isn't
      // filed at the exact second the seed ran. Still inside the current
      // month at seed time; see RE-SEED CADENCE in the header.
      const returnDate = new Date(
        Math.min(Date.now(), r.soldAt.getTime() + 24 * 60 * 60 * 1000),
      );
      await db.update(returns).set({ returnDate }).where(eq(returns.id, returnId));
    } catch (err) {
      console.warn(`  skipped return #${i}: ${(err as Error).message ?? String(err)}`);
    }
  }

  // Purchase orders.
  console.log("Creating purchase orders…");
  for (let i = 0; i < 2; i++) {
    const supplier = supplierIds[i % supplierIds.length];
    const lineCount = 2 + Math.floor(Math.random() * 2);
    const items = Array.from({ length: lineCount }, () => {
      const p = pick(productIds);
      return {
        productId: p.id,
        productName: PRODUCTS.find((_, idx) => productIds[idx]?.id === p.id)?.name ?? "منتج",
        quantity: 5 + Math.floor(Math.random() * 8),
        unitCost: Math.floor(p.price * 0.7),
      };
    });
    try {
      await createPurchaseOrder(tenantId, {
        supplierId: supplier,
        notes: `أمر شراء تجريبي رقم ${i + 1}`,
        items,
      });
    } catch (err) {
      console.warn(`  skipped PO #${i}: ${(err as Error).message}`);
    }
  }

  // Tasks.
  console.log(`Creating ${TASKS.length} tasks…`);
  for (const task of TASKS) {
    const due = new Date();
    due.setDate(due.getDate() + task.dueOffsetDays);
    await createTask(tenantId, branchId, userId, {
      assignedToUserId: userId,
      title: task.title,
      priority: task.priority,
      dueDate: due,
    });
  }

  // Expenses.
  console.log(`Adding ${EXPENSES.length} expenses…`);
  for (const e of EXPENSES) {
    await addExpense(tenantId, {
      title: e.title,
      amount: e.amount,
      category: e.category,
      date: daysAgo(e.daysAgo),
      branchId,
    });
  }

  // Activity log (a few representative events).
  console.log("Seeding activity log entries…");
  const ACT_EVENTS = [
    { action: "product.created", category: "product" as const, label: PRODUCTS[0].name, mins: 60 * 24 * 7 },
    { action: "supplier.created", category: "supplier" as const, label: SUPPLIERS[0].name, mins: 60 * 24 * 5 },
    { action: "purchase.created", category: "purchase" as const, label: "أمر شراء #1", mins: 60 * 24 * 4 },
    { action: "sale.recorded", category: "sale" as const, label: "بيع — Casio Edifice", mins: 60 * 8 },
    { action: "auth.login", category: "auth" as const, label: null, mins: 5 },
  ] satisfies Array<{
    action: string;
    category: "auth" | "team" | "settings" | "leave" | "task" | "product" | "sale" | "expense" | "supplier" | "purchase" | "attendance";
    label: string | null;
    mins: number;
  }>;
  for (const evt of ACT_EVENTS) {
    await logActivity({
      tenantId,
      actorUserId: userId,
      actorName: "Demo Owner",
      action: evt.action,
      category: evt.category,
      entityLabel: evt.label,
      branchId,
    });
  }

  // Subscription — active forever so the billing gate passes for the template.
  const farFuture = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365 * 50);
  await db.insert(subscriptions).values({
    tenantId,
    plan: "professional",
    status: "active",
    trialEndsAt: new Date(),
    currentPeriodStart: new Date(),
    currentPeriodEndsAt: farFuture,
    amountEgp: "0",
  });

  console.log("");
  console.log("✅ Demo template seeded");
  console.log(`   tenant id : ${tenantId}`);
  console.log(`   owner id  : ${userId}`);
  console.log(`   slug      : ${TEMPLATE_STORE_SLUG}`);
  console.log("");
  console.log("Visitors will get an ephemeral CLONE of this tenant when they");
  console.log("click 'تصفح المتجر التجريبي' on the login/signup page.");
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
