// Seeds ONE tenant with enough realistic data that every section of the app
// looks alive in the onboarding-tour screenshots: products, sales spread
// across the past 30 days (so reports / dashboard render real curves),
// customers, suppliers, purchase orders, tasks, expenses.
//
// Run AFTER `pnpm db:migrate`. Idempotent in spirit — it wipes first.
//
//   pnpm tsx scripts/seed-rich-data.ts
//
// Login: amr@matgary.local / Test1234!

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
import { addSupplier } from "@/lib/repo/suppliers";
import { createPurchaseOrder } from "@/lib/repo/purchase-orders";
import { createTask } from "@/lib/repo/tasks";
import { addExpense } from "@/lib/repo/expenses";
import { recordSale } from "@/lib/repo/operations";
import { addTeamMember } from "@/lib/repo/team";
import { logActivity } from "@/lib/repo/activity";

const EMAIL = "amr@matgary.local";
const PASSWORD = "Test1234!";
const STORE_NAME = "متجر عمرو";
const STORE_SLUG = "amr-store";

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
  // ── watches (8) ─────────────────────────────────────────
  { categoryKey: "watches", name: "Casio MTP-1374L", brand: "Casio", quantity: 35, price: "1250.00", costPrice: "850.00", lowStockThreshold: 3 },
  { categoryKey: "watches", name: "Casio Edifice EFR-526", brand: "Casio", quantity: 22, price: "3400.00", costPrice: "2500.00", lowStockThreshold: 2 },
  { categoryKey: "watches", name: "Casio G-Shock GA-2100", brand: "Casio", quantity: 18, price: "2800.00", costPrice: "1900.00", lowStockThreshold: 3 },
  { categoryKey: "watches", name: "Citizen Eco-Drive AW1236", brand: "Citizen", quantity: 14, price: "3200.00", costPrice: "2400.00", lowStockThreshold: 2 },
  { categoryKey: "watches", name: "Citizen Promaster BN0150", brand: "Citizen", quantity: 9, price: "5200.00", costPrice: "3900.00", lowStockThreshold: 1 },
  { categoryKey: "watches", name: "Seiko SKX007 Diver", brand: "Seiko", quantity: 6, price: "6800.00", costPrice: "5100.00", lowStockThreshold: 1 },
  { categoryKey: "watches", name: "Seiko Presage Cocktail", brand: "Seiko", quantity: 5, price: "8200.00", costPrice: "6100.00", lowStockThreshold: 1 },
  { categoryKey: "watches", name: "Tissot PR 100", brand: "Tissot", quantity: 8, price: "7100.00", costPrice: "5300.00", lowStockThreshold: 2 },
  // ── perfumes (8) ────────────────────────────────────────
  { categoryKey: "perfumes", name: "Chanel No. 5 EDP 100ml", brand: "Chanel", quantity: 24, price: "4800.00", costPrice: "3600.00", lowStockThreshold: 4 },
  { categoryKey: "perfumes", name: "Chanel Coco Mademoiselle 50ml", brand: "Chanel", quantity: 16, price: "4200.00", costPrice: "3100.00", lowStockThreshold: 3 },
  { categoryKey: "perfumes", name: "Dior Sauvage EDT 60ml", brand: "Dior", quantity: 30, price: "3200.00", costPrice: "2300.00", lowStockThreshold: 5 },
  { categoryKey: "perfumes", name: "Dior J'adore 50ml", brand: "Dior", quantity: 12, price: "4400.00", costPrice: "3300.00", lowStockThreshold: 2 },
  { categoryKey: "perfumes", name: "Tom Ford Black Orchid 50ml", brand: "Tom Ford", quantity: 9, price: "5400.00", costPrice: "4000.00", lowStockThreshold: 2 },
  { categoryKey: "perfumes", name: "Tom Ford Oud Wood 50ml", brand: "Tom Ford", quantity: 7, price: "6800.00", costPrice: "5100.00", lowStockThreshold: 2 },
  { categoryKey: "perfumes", name: "Yves Saint Laurent Libre 50ml", brand: "YSL", quantity: 18, price: "3600.00", costPrice: "2700.00", lowStockThreshold: 3 },
  { categoryKey: "perfumes", name: "Versace Eros 100ml", brand: "Versace", quantity: 13, price: "2900.00", costPrice: "2100.00", lowStockThreshold: 3 },
  // ── sunglasses (8) ──────────────────────────────────────
  { categoryKey: "sunglasses", name: "Ray-Ban Aviator RB3025", brand: "Ray-Ban", quantity: 40, price: "1850.00", costPrice: "1200.00", lowStockThreshold: 6 },
  { categoryKey: "sunglasses", name: "Ray-Ban Wayfarer RB2140", brand: "Ray-Ban", quantity: 32, price: "1750.00", costPrice: "1150.00", lowStockThreshold: 5 },
  { categoryKey: "sunglasses", name: "Ray-Ban Clubmaster RB3016", brand: "Ray-Ban", quantity: 18, price: "1950.00", costPrice: "1300.00", lowStockThreshold: 4 },
  { categoryKey: "sunglasses", name: "Oakley Holbrook OO9102", brand: "Oakley", quantity: 17, price: "2400.00", costPrice: "1700.00", lowStockThreshold: 3 },
  { categoryKey: "sunglasses", name: "Oakley Frogskins OO9013", brand: "Oakley", quantity: 11, price: "2200.00", costPrice: "1550.00", lowStockThreshold: 2 },
  { categoryKey: "sunglasses", name: "Persol PO3019S", brand: "Persol", quantity: 6, price: "3900.00", costPrice: "2900.00", lowStockThreshold: 2 },
  { categoryKey: "sunglasses", name: "Persol PO0649", brand: "Persol", quantity: 5, price: "4300.00", costPrice: "3200.00", lowStockThreshold: 1 },
  { categoryKey: "sunglasses", name: "Carrera Champion", brand: "Carrera", quantity: 14, price: "1650.00", costPrice: "1100.00", lowStockThreshold: 3 },
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
  { name: "يوسف الشريف", phone: "01001234007" },
  { name: "ليلى السيد", phone: "01001234008" },
  { name: "عمر النجار", phone: "01001234009" },
  { name: "هدى الفقي", phone: "01001234010" },
  { name: "كريم الزيات", phone: "01001234011" },
  { name: "منى الحلو", phone: "01001234012" },
  { name: "طارق الشرقاوي", phone: "01001234013" },
  { name: "رنا حمدي", phone: "01001234014" },
  { name: "أحمد العشري", phone: "01001234015" },
];

const TASKS = [
  { title: "متابعة شحنة الساعات الجديدة من المورد", priority: "high" as const, dueOffsetDays: 2 },
  { title: "تحديث أسعار العطور بعد رفع الجمارك", priority: "normal" as const, dueOffsetDays: 5 },
  { title: "تنظيف الواجهة الزجاجية وفتارين العرض", priority: "low" as const, dueOffsetDays: 1 },
  { title: "مراجعة المخزون قبل قفل الشهر", priority: "high" as const, dueOffsetDays: 7 },
];

const EXPENSES = [
  { title: "إيجار المحل - يونيو", amount: 8500, category: "rent" as const, daysAgo: 12 },
  { title: "فاتورة الكهرباء", amount: 420, category: "electricity" as const, daysAgo: 8 },
  { title: "اشتراك الإنترنت", amount: 350, category: "internet" as const, daysAgo: 15 },
  { title: "رواتب الموظفين", amount: 12000, category: "salaries" as const, daysAgo: 3 },
  { title: "مصاريف نقل بضاعة", amount: 600, category: "other" as const, daysAgo: 5 },
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  // Vary the hour so the "peak hours" chart shows a realistic curve.
  d.setHours(10 + Math.floor(Math.random() * 10), Math.floor(Math.random() * 60));
  return d;
}

async function main() {
  console.log("Wiping all tables…");
  await db.execute(sql`
    truncate
      tasks, leave_requests, notifications, sale_payments,
      returns, sales, expenses, purchase_order_items,
      purchase_order_payments, purchase_orders, suppliers,
      product_attribute_values, product_history, products,
      brands, category_attribute_values, category_attributes,
      categories,
      shop_settings, tenant_members, branches,
      sessions, accounts, users, tenants
    restart identity cascade
  `);

  console.log("Creating owner + tenant…");
  const passwordHash = await bcrypt.hash(PASSWORD, 12);

  const setup = await db.transaction(async (tx) => {
    const [u] = await tx
      .insert(users)
      .values({ email: EMAIL, name: "Amr Owner", passwordHash })
      .returning({ id: users.id });
    const [t] = await tx
      .insert(tenants)
      .values({ name: STORE_NAME, slug: STORE_SLUG })
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
      shopName: STORE_NAME,
      shopPhone: "01000000001",
      messageTemplate: DEFAULT_MESSAGE_TEMPLATE,
      onboardingCompletedAt: new Date(),
    });
    await seedCornerStorePreset(tx, t.id, b.id);
    return { tenantId: t.id, branchId: b.id, userId: u.id };
  });

  const { tenantId, branchId, userId } = setup;

  // ── Products ──────────────────────────────────────────────
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

  // ── Suppliers ─────────────────────────────────────────────
  console.log(`Adding ${SUPPLIERS.length} suppliers…`);
  const supplierIds: string[] = [];
  for (const s of SUPPLIERS) {
    const r = await addSupplier(tenantId, branchId, {
      name: s.name,
      phone: s.phone,
      address: s.address,
    });
    supplierIds.push(r.id);
  }

  // ── Sales (spread across 30 days) ────────────────────────
  // Mix of cash / instapay / card / deferred; some with customer attribution,
  // some walk-ins. Quantity stays small per line so we don't blow through
  // the seeded stock.
  const SALE_COUNT = 90;
  console.log(`Recording ${SALE_COUNT} sales across the past 30 days…`);
  const PAYMENT_METHODS = ["cash", "cash", "cash", "instapay", "card", "deferred"] as const;
  for (let i = 0; i < SALE_COUNT; i++) {
    const product = pick(productIds);
    const qty = Math.random() < 0.7 ? 1 : 2;
    const customer = Math.random() < 0.8 ? pick(CUSTOMERS) : null;
    const paymentMethod = pick(PAYMENT_METHODS);
    const discountPct = Math.random() < 0.3 ? Math.floor(Math.random() * 15) + 5 : 0;

    // Bias: first 25% of sales land in the past 24h so dashboard "today"
    // KPIs show real numbers; the rest spread uniformly over 30 days so
    // reports trend lines have a continuous curve.
    const offsetDays =
      i < SALE_COUNT * 0.25 ? 0 : Math.floor(Math.random() * 30);

    try {
      await recordSale(tenantId, {
        productId: product.id,
        quantitySold: qty,
        pricePerUnit: product.price,
        customerName: customer?.name,
        customerPhone: customer?.phone,
        paymentMethod,
        customDate: daysAgo(offsetDays),
        recordedByUserId: userId,
        branchId,
        ...(discountPct > 0
          ? { discountType: "percentage" as const, discountValue: discountPct }
          : {}),
        ...(paymentMethod === "deferred"
          ? { amountPaidNow: 0 }
          : {}),
      });
    } catch (err) {
      // Out-of-stock or similar — skip and continue. Seeded stock may
      // not cover every random selection.
      console.warn(
        `  skipped sale #${i}: ${(err as Error).message ?? String(err)}`,
      );
    }
  }

  // ── Purchase orders ──────────────────────────────────────
  console.log("Creating purchase orders…");
  for (let i = 0; i < 3; i++) {
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

  // ── Tasks ────────────────────────────────────────────────
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

  // ── Expenses ─────────────────────────────────────────────
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

  // ── Team members (cashier + manager) ─────────────────────
  // Two staff accounts so the /team page shows multiple rows with
  // different permission sets — what a real shop with sub-accounts
  // looks like. Logins are synthetic: `<username>@<tenant-slug>`.
  console.log("Adding 2 staff members…");
  await addTeamMember(tenantId, {
    username: "cashier",
    displayName: "ياسمين الكاشير",
    password: "Cashier123!",
    permissions: [
      "view_dashboard",
      "view_inventory",
      "view_sales",
      "view_customers",
      "record_sales",
    ],
    phone: "01200000010",
    branchId,
  });
  await addTeamMember(tenantId, {
    username: "manager",
    displayName: "محمد المدير",
    password: "Manager123!",
    permissions: [
      "view_dashboard",
      "view_inventory",
      "view_sales",
      "view_customers",
      "view_expenses",
      "view_returns",
      "view_insights",
      "view_suppliers",
      "view_purchases",
      "manage_inventory",
      "record_sales",
      "manage_returns",
      "manage_expenses",
      "manage_suppliers",
      "manage_purchases",
      "manage_tasks",
    ],
    phone: "01200000011",
    branchId,
  });

  // ── Activity log (a few representative events) ───────────
  // The repo helper logs auth + mutations via fire-and-forget calls; this
  // mirrors them inline so the /activity page has a populated feed without
  // having to drive the UI to generate one.
  console.log("Seeding activity log entries…");
  const ACT_EVENTS = [
    { action: "product.created", category: "product" as const, label: PRODUCTS[0].name, mins: 60 * 24 * 7 },
    { action: "product.created", category: "product" as const, label: PRODUCTS[1].name, mins: 60 * 24 * 6 },
    { action: "supplier.created", category: "supplier" as const, label: SUPPLIERS[0].name, mins: 60 * 24 * 5 },
    { action: "purchase.created", category: "purchase" as const, label: "أمر شراء #1", mins: 60 * 24 * 4 },
    { action: "expense.created", category: "expense" as const, label: EXPENSES[0].title, mins: 60 * 24 * 3 },
    { action: "sale.recorded", category: "sale" as const, label: "بيع — Casio Edifice", mins: 60 * 8 },
    { action: "team.member_added", category: "team" as const, label: "ياسمين الكاشير", mins: 60 * 2 },
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
      actorName: "Amr Owner",
      action: evt.action,
      category: evt.category,
      entityLabel: evt.label,
      branchId,
    });
  }

  console.log("");
  console.log("✅ Rich seed complete");
  console.log(`   login   : ${EMAIL}`);
  console.log(`   password: ${PASSWORD}`);
  console.log(`   tenant  : ${tenantId}`);
  console.log("");
  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
