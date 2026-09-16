import "dotenv/config";
import { and, eq, sql } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import {
  branches,
  categories,
  products as productsTbl,
  shopSettings,
  tenantMembers,
  users,
} from "@/lib/db/schema";
import { addCategory } from "@/lib/repo/catalog-admin";
import { addProduct } from "@/lib/repo/catalog";
import { recordCartSale } from "@/lib/repo/operations";
import { grantCredit } from "@/lib/repo/loyalty";

// One-shot showcase seed for the demo account.
//
// Targets: samyamr819@gmail.com (tenant "elhenawystore"). Adds a richer
// catalog to the primary branch, seeds a different catalog for the
// cairo branch (proves multi-store isolation), enables the loyalty
// programme on both branches with sane rates, records a couple of
// weeks of customer sales (mix of paid + deferred so /customers shows
// a real ledger), and grants a couple of customers store credit so
// the wallet UI has history to render.
//
// Idempotency: every helper checks "does it already exist by name/key"
// before inserting, so re-running is safe (no duplicates, no errors).
//
// Invoke: TSX_OPTS=--no-warnings npx tsx scripts/seed-showcase.ts

const OWNER_EMAIL = "samyamr819@gmail.com";

interface Ctx {
  tenantId: string;
  ownerId: string;
  mainBranchId: string;
  cairoBranchId: string | null;
}

async function main(): Promise<void> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, OWNER_EMAIL))
    .limit(1);
  if (!user) throw new Error(`No user with email ${OWNER_EMAIL}`);

  const [member] = await db
    .select({ tenantId: tenantMembers.tenantId })
    .from(tenantMembers)
    .where(eq(tenantMembers.userId, user.id))
    .limit(1);
  if (!member) throw new Error(`No tenant for ${OWNER_EMAIL}`);

  // RLS on branches requires app.tenant_id to be set in the session;
  // wrap the read in withTenant so the policy lets us see the rows.
  const allBranches = await withTenant(member.tenantId, (tx) =>
    tx.select().from(branches).where(eq(branches.tenantId, member.tenantId)),
  );
  const main = allBranches.find((b) => b.isPrimary);
  const cairo = allBranches.find((b) => !b.isPrimary && b.isActive);
  if (!main) throw new Error("No primary branch");

  const ctx: Ctx = {
    tenantId: member.tenantId,
    ownerId: user.id,
    mainBranchId: main.id,
    cairoBranchId: cairo?.id ?? null,
  };

  console.log(`▶ tenant ${ctx.tenantId} / owner ${ctx.ownerId}`);
  console.log(`▶ main branch ${ctx.mainBranchId}`);
  console.log(`▶ cairo branch ${ctx.cairoBranchId ?? "(none — will skip)"}`);

  await enableLoyalty(ctx);
  await seedMainBranch(ctx);
  if (ctx.cairoBranchId) await seedCairoBranch(ctx);

  console.log("✓ done. open http://localhost:3000 to see the data.");
  process.exit(0);
}

async function enableLoyalty(ctx: Ctx): Promise<void> {
  // Earn 0.1 = 1 point per 10 EGP. Redeem 0.5 = 1 point worth 0.50 EGP.
  // Sane Egyptian-shop ratios — burning 100 pts = 50 EGP off feels like
  // a reward without giving away the store.
  // shop_settings is RLS-forced; wrap in withTenant. Also some branches
  // (created before the createBranch flow auto-seeded settings) have
  // no row yet, so we INSERT-or-UPDATE.
  const ids = [ctx.mainBranchId, ctx.cairoBranchId].filter(
    (v): v is string => !!v,
  );
  await withTenant(ctx.tenantId, async (tx) => {
    for (const branchId of ids) {
      const [existing] = await tx
        .select({ branchId: shopSettings.branchId })
        .from(shopSettings)
        .where(
          and(
            eq(shopSettings.tenantId, ctx.tenantId),
            eq(shopSettings.branchId, branchId),
          ),
        )
        .limit(1);
      if (existing) {
        await tx
          .update(shopSettings)
          .set({
            loyaltyEnabled: true,
            loyaltyPointsPerEgp: "0.1000",
            loyaltyEgpPerPoint: "0.5000",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(shopSettings.tenantId, ctx.tenantId),
              eq(shopSettings.branchId, branchId),
            ),
          );
      } else {
        await tx.insert(shopSettings).values({
          tenantId: ctx.tenantId,
          branchId,
          shopName: "",
          loyaltyEnabled: true,
          loyaltyPointsPerEgp: "0.1000",
          loyaltyEgpPerPoint: "0.5000",
        });
      }
    }
  });
  console.log(
    "  ✓ loyalty enabled on every branch (0.1 pts/EGP earn, 0.5 EGP/pt redeem)",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main branch — extends the existing watches/perfumes/sunglasses with
// electronics + clothing. Seeds 6 customers with a mix of sales.
// ─────────────────────────────────────────────────────────────────────────────

async function seedMainBranch(ctx: Ctx): Promise<void> {
  console.log("▶ seeding MAIN branch");

  // 1. Make sure a few categories exist beyond the seed-preset set.
  const newCats: Array<{ key: string; label: string; icon: string }> = [
    { key: "electronics", label: "إلكترونيات", icon: "Zap" },
    { key: "bags", label: "حقائب", icon: "ShoppingBasket" },
  ];
  const catsByKey = await ensureCategories(ctx, ctx.mainBranchId, newCats);

  // Reuse existing watches if it's there; otherwise we'd skip silently.
  const watchesId = await getCategoryId(ctx, ctx.mainBranchId, "watches");
  const perfumesId = await getCategoryId(ctx, ctx.mainBranchId, "perfumes");

  // 2. Add a handful of products — only those not already present by name.
  const productSpecs: ProductSpec[] = [
    // Electronics
    {
      categoryId: catsByKey.electronics,
      name: "سماعات بلوتوث Anker",
      brand: "Anker",
      qty: 25,
      price: 850,
      cost: 600,
      sku: "ANK-BT-01",
    },
    {
      categoryId: catsByKey.electronics,
      name: "كابل شحن Type-C",
      brand: "Baseus",
      qty: 80,
      price: 120,
      cost: 70,
      sku: "BSE-USBC-01",
    },
    {
      categoryId: catsByKey.electronics,
      name: "بور بانك 20000mAh",
      brand: "Anker",
      qty: 15,
      price: 1200,
      cost: 850,
      sku: "ANK-PB-20",
    },
    // Bags
    {
      categoryId: catsByKey.bags,
      name: "شنطة ظهر مدرسية",
      brand: "Generic",
      qty: 30,
      price: 420,
      cost: 250,
      sku: "BAG-SCH-01",
    },
    {
      categoryId: catsByKey.bags,
      name: "حقيبة لاب توب",
      brand: "Targus",
      qty: 12,
      price: 980,
      cost: 600,
      sku: "BAG-LP-01",
    },
    // Watches (reuse existing category)
    ...(watchesId
      ? [
          {
            categoryId: watchesId,
            name: "ساعة Casio MTP",
            brand: "Casio",
            qty: 18,
            price: 1450,
            cost: 950,
            sku: "CSO-MTP-01",
          } as ProductSpec,
          {
            categoryId: watchesId,
            name: "ساعة Citizen Eco",
            brand: "Citizen",
            qty: 8,
            price: 3200,
            cost: 2100,
            sku: "CTZ-ECO-01",
          } as ProductSpec,
        ]
      : []),
    // Perfumes
    ...(perfumesId
      ? [
          {
            categoryId: perfumesId,
            name: "Sauvage Dior 100ml",
            brand: "Dior",
            qty: 6,
            price: 4800,
            cost: 3200,
            sku: "DIO-SAU-100",
          } as ProductSpec,
          {
            categoryId: perfumesId,
            name: "Bleu de Chanel 50ml",
            brand: "Chanel",
            qty: 4,
            price: 5200,
            cost: 3600,
            sku: "CHA-BLE-50",
          } as ProductSpec,
        ]
      : []),
  ];

  const productIds = await ensureProducts(ctx, ctx.mainBranchId, productSpecs);

  // 3. Customers + sales spanning the past 18 days. A few deferred to
  //    populate the ledger. One customer gets credit + redeemed points
  //    so their wallet has visible history.
  const cashier = ctx.ownerId;
  const today = new Date();
  const daysAgo = (n: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return d;
  };

  const sales: SaleSpec[] = [
    // Ahmed — repeat customer with active wallet
    {
      customer: { name: "أحمد محمد سامي", phone: "+201112233445" },
      paymentMethod: "cash",
      saleDate: daysAgo(15),
      lines: [
        { productKey: "ANK-BT-01", qty: 1, price: 850 },
        { productKey: "BSE-USBC-01", qty: 2, price: 120 },
      ],
    },
    {
      customer: { name: "أحمد محمد سامي", phone: "+201112233445" },
      paymentMethod: "instapay",
      saleDate: daysAgo(8),
      lines: [{ productKey: "BAG-SCH-01", qty: 1, price: 420 }],
    },
    {
      customer: { name: "أحمد محمد سامي", phone: "+201112233445" },
      paymentMethod: "cash",
      saleDate: daysAgo(2),
      lines: [{ productKey: "ANK-PB-20", qty: 1, price: 1200 }],
    },
    // Mona — single big sale, redeems some points later
    {
      customer: { name: "منى علي", phone: "+201023456789" },
      paymentMethod: "card",
      saleDate: daysAgo(11),
      lines: [{ productKey: "DIO-SAU-100", qty: 1, price: 4800 }],
    },
    // Khaled — has TWO deferred sales (the ledger demo)
    {
      customer: { name: "خالد إبراهيم", phone: "+201554443322" },
      paymentMethod: "deferred",
      saleDate: daysAgo(12),
      lines: [
        { productKey: "CSO-MTP-01", qty: 1, price: 1450 },
        { productKey: "BSE-USBC-01", qty: 1, price: 120 },
      ],
    },
    {
      customer: { name: "خالد إبراهيم", phone: "+201554443322" },
      paymentMethod: "deferred",
      saleDate: daysAgo(4),
      lines: [{ productKey: "BAG-LP-01", qty: 1, price: 980 }],
    },
    // Sara — recent first-timer
    {
      customer: { name: "سارة فؤاد", phone: "+201268889977" },
      paymentMethod: "cash",
      saleDate: daysAgo(1),
      lines: [{ productKey: "CTZ-ECO-01", qty: 1, price: 3200 }],
    },
    // Walk-in (no customer)
    {
      paymentMethod: "cash",
      saleDate: daysAgo(7),
      lines: [{ productKey: "BSE-USBC-01", qty: 3, price: 120 }],
    },
    // Yousef — pays with mixed loyalty redemption later (we'll do the
    // redemption in a separate sale below)
    {
      customer: { name: "يوسف عبد الله", phone: "+201156784321" },
      paymentMethod: "cash",
      saleDate: daysAgo(18),
      lines: [{ productKey: "CHA-BLE-50", qty: 1, price: 5200 }],
    },
  ];

  const placedSales = await placeSales(ctx, ctx.mainBranchId, cashier, sales, productIds);

  // 4. Manual credit grant for one customer (refund-as-credit scenario
  //    you'd hit in real life: damaged product complaint).
  await grantCreditOnce(
    ctx,
    ctx.mainBranchId,
    "+201112233445",
    100,
    "تعويض عن منتج معطوب",
    cashier,
    "أحمد محمد سامي",
  );

  // 5. A redemption sale — Mona burns 50 points + 200 EGP credit. We
  //    grant her a starter credit balance so the redemption has
  //    something to draw on; her existing earned points cover the
  //    points side.
  await grantCreditOnce(
    ctx,
    ctx.mainBranchId,
    "+201023456789",
    300,
    "هدية ولاء",
    cashier,
    "منى علي",
  );

  // Quick sale that exercises the redemption path so the wallet event
  // log on the customer detail page is non-trivial.
  try {
    await recordCartSale(ctx.tenantId, [{
      productId: productIds["BSE-USBC-01"]!,
      quantity: 1,
      pricePerUnit: 120,
    }], {
      branchId: ctx.mainBranchId,
      recordedByUserId: cashier,
      paymentMethod: "cash",
      customerName: "منى علي",
      customerPhone: "+201023456789",
      applyCreditEgp: 50,
      customDate: new Date(),
    });
    console.log("    ✓ wallet redemption sale recorded for Mona");
  } catch (err) {
    console.log(
      "    ⚠ wallet redemption sale skipped:",
      err instanceof Error ? err.message : err,
    );
  }

  console.log(
    `  ✓ main: ${placedSales} sales recorded, ${Object.keys(productIds).length} products available`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Cairo branch — different catalog to prove multi-store isolation
// ─────────────────────────────────────────────────────────────────────────────

async function seedCairoBranch(ctx: Ctx): Promise<void> {
  if (!ctx.cairoBranchId) return;
  console.log("▶ seeding CAIRO branch (different catalog)");

  const cats = await ensureCategories(ctx, ctx.cairoBranchId, [
    { key: "mobile-accessories", label: "إكسسوارات موبايل", icon: "Phone" },
    { key: "gifts", label: "هدايا", icon: "Star" },
  ]);

  const productSpecs: ProductSpec[] = [
    {
      categoryId: cats["mobile-accessories"],
      name: "جراب iPhone 15",
      brand: "Spigen",
      qty: 40,
      price: 350,
      cost: 200,
      sku: "SPG-IP15",
    },
    {
      categoryId: cats["mobile-accessories"],
      name: "شاشة حماية Samsung",
      brand: "Generic",
      qty: 60,
      price: 80,
      cost: 35,
      sku: "GLS-SAM",
    },
    {
      categoryId: cats["mobile-accessories"],
      name: "حامل سيارة مغناطيسي",
      brand: "Baseus",
      qty: 22,
      price: 240,
      cost: 130,
      sku: "BSE-CAR-MGT",
    },
    {
      categoryId: cats.gifts,
      name: "صندوق شوكولاتة فاخر",
      brand: "Galaxy",
      qty: 15,
      price: 480,
      cost: 280,
      sku: "GFT-CHO-01",
    },
    {
      categoryId: cats.gifts,
      name: "باقة ورد رومنسية",
      brand: "Local",
      qty: 8,
      price: 650,
      cost: 350,
      sku: "GFT-FLR-01",
    },
  ];
  const productIds = await ensureProducts(ctx, ctx.cairoBranchId, productSpecs);

  const today = new Date();
  const daysAgo = (n: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return d;
  };

  const sales: SaleSpec[] = [
    {
      customer: { name: "ندى حسن", phone: "+201556677889" },
      paymentMethod: "cash",
      saleDate: daysAgo(5),
      lines: [
        { productKey: "SPG-IP15", qty: 1, price: 350 },
        { productKey: "GLS-SAM", qty: 1, price: 80 },
      ],
    },
    {
      customer: { name: "محمود رضا", phone: "+201234567812" },
      paymentMethod: "instapay",
      saleDate: daysAgo(2),
      lines: [{ productKey: "GFT-CHO-01", qty: 2, price: 480 }],
    },
    {
      customer: { name: "محمود رضا", phone: "+201234567812" },
      paymentMethod: "deferred",
      saleDate: daysAgo(1),
      lines: [{ productKey: "GFT-FLR-01", qty: 1, price: 650 }],
    },
  ];

  const placedSales = await placeSales(
    ctx,
    ctx.cairoBranchId,
    ctx.ownerId,
    sales,
    productIds,
  );
  console.log(
    `  ✓ cairo: ${placedSales} sales recorded, ${Object.keys(productIds).length} products available`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

interface ProductSpec {
  categoryId: string;
  name: string;
  brand: string;
  qty: number;
  price: number;
  cost: number;
  sku: string;
}

interface SaleSpec {
  customer?: { name: string; phone: string };
  paymentMethod: "cash" | "instapay" | "card" | "deferred";
  saleDate: Date;
  lines: Array<{ productKey: string; qty: number; price: number }>;
}

async function ensureCategories(
  ctx: Ctx,
  branchId: string,
  specs: Array<{ key: string; label: string; icon: string }>,
): Promise<Record<string, string>> {
  const existing = await withTenant(ctx.tenantId, (tx) =>
    tx
      .select({ id: categories.id, key: categories.key })
      .from(categories)
      .where(
        and(
          eq(categories.tenantId, ctx.tenantId),
          eq(categories.branchId, branchId),
        ),
      ),
  );
  const byKey = Object.fromEntries(existing.map((c) => [c.key, c.id]));

  for (const spec of specs) {
    if (byKey[spec.key]) continue;
    const created = await addCategory(ctx.tenantId, branchId, {
      key: spec.key,
      label: spec.label,
      icon: spec.icon,
    });
    byKey[spec.key] = created.id;
    console.log(`    + category ${spec.label} (${spec.key})`);
  }
  return byKey;
}

async function getCategoryId(
  ctx: Ctx,
  branchId: string,
  key: string,
): Promise<string | undefined> {
  const [row] = await withTenant(ctx.tenantId, (tx) =>
    tx
      .select({ id: categories.id })
      .from(categories)
      .where(
        and(
          eq(categories.tenantId, ctx.tenantId),
          eq(categories.branchId, branchId),
          eq(categories.key, key),
        ),
      )
      .limit(1),
  );
  return row?.id;
}

async function ensureProducts(
  ctx: Ctx,
  branchId: string,
  specs: ProductSpec[],
): Promise<Record<string, string>> {
  // Map sku → id, skipping existing rows by sku.
  const existing = await withTenant(ctx.tenantId, (tx) =>
    tx
      .select({ id: productsTbl.id, sku: productsTbl.sku })
      .from(productsTbl)
      .where(
        and(
          eq(productsTbl.tenantId, ctx.tenantId),
          eq(productsTbl.branchId, branchId),
        ),
      ),
  );
  const bySku: Record<string, string> = {};
  for (const r of existing) if (r.sku) bySku[r.sku] = r.id;

  for (const spec of specs) {
    if (bySku[spec.sku]) continue;
    const created = await addProduct(ctx.tenantId, branchId, {
      categoryId: spec.categoryId,
      name: spec.name,
      brand: spec.brand,
      quantity: spec.qty,
      price: spec.price,
      costPrice: spec.cost,
      lowStockThreshold: 3,
      sku: spec.sku,
      tags: [],
    });
    bySku[spec.sku] = created.id;
    console.log(`    + product ${spec.name} (${spec.sku}) qty=${spec.qty}`);
  }
  return bySku;
}

async function placeSales(
  ctx: Ctx,
  branchId: string,
  cashier: string,
  sales: SaleSpec[],
  productIdsBySku: Record<string, string>,
): Promise<number> {
  // Idempotency: if any seeded sale already exists for this branch we
  // assume the seed already ran and skip to avoid duplicate revenue.
  // Production: would key on idempotencyKey per row, but for a one-shot
  // seed this is enough.
  const { sales: salesTbl } = await import("@/lib/db/schema");
  const [existing] = await withTenant(ctx.tenantId, (tx) =>
    tx
      .select({ id: salesTbl.id })
      .from(salesTbl)
      .where(
        and(
          eq(salesTbl.tenantId, ctx.tenantId),
          eq(salesTbl.branchId, branchId),
        ),
      )
      .limit(1),
  );
  if (existing) {
    console.log(
      `    ⤷ sales already present at this branch; skipping (delete sales rows to re-seed)`,
    );
    return 0;
  }

  let count = 0;
  for (const s of sales) {
    try {
      const lines = s.lines.map((l) => ({
        productId: productIdsBySku[l.productKey]!,
        quantity: l.qty,
        pricePerUnit: l.price,
      }));
      // Skip when a referenced sku didn't exist (e.g. main category was
      // missing) — rather than crash, log and continue.
      if (lines.some((l) => !l.productId)) {
        console.log("    ⚠ skipping sale — missing product id");
        continue;
      }
      await recordCartSale(ctx.tenantId, lines, {
        branchId,
        recordedByUserId: cashier,
        paymentMethod: s.paymentMethod,
        customerName: s.customer?.name,
        customerPhone: s.customer?.phone,
        customDate: s.saleDate,
      });
      count += 1;
    } catch (err) {
      console.log(
        "    ⚠ sale failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
  return count;
}

async function grantCreditOnce(
  ctx: Ctx,
  branchId: string,
  phone: string,
  amount: number,
  reason: string,
  actorUserId: string,
  customerName: string,
): Promise<void> {
  try {
    await grantCredit(ctx.tenantId, branchId, phone, amount, {
      customerName,
      actorUserId,
      reason,
    });
    console.log(`    + credit ${amount} EGP → ${customerName} (${reason})`);
  } catch (err) {
    console.log(
      `    ⚠ grantCredit failed for ${customerName}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

main().catch((err) => {
  console.error("seed failed:", err);
  process.exit(1);
});
