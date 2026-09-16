import "dotenv/config";
import { and, eq, sql } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import {
  branches,
  categories as categoriesTbl,
  products as productsTbl,
  tenantMembers,
  tenants,
  users,
} from "@/lib/db/schema";
import { addProduct } from "@/lib/repo/catalog";
import { addCategory } from "@/lib/repo/catalog-admin";
import { addTeamMember } from "@/lib/repo/team";
import { recordCartSale } from "@/lib/repo/operations";
import { addSupplier } from "@/lib/repo/suppliers";
import {
  createPurchaseOrder,
  receivePurchaseOrder,
} from "@/lib/repo/purchase-orders";
import { recordPayment } from "@/lib/repo/purchase-payments";
import { recordAttendanceEvent } from "@/lib/repo/attendance-events";
import { createCompensation } from "@/lib/repo/payroll";
import {
  submitLeaveRequest,
  decideLeaveRequest,
} from "@/lib/repo/leave-requests";
import type { Permission } from "@/lib/permissions";

// Heavy E2E seed for the showcase account.
//
// Targets: samyamr819@gmail.com (tenant "elhenawystore"). Layered on top of
// seed-showcase.ts. Designed to be idempotent — every helper checks for a
// pre-existing matching row before inserting, so re-running the script is
// safe (no duplicate employees, no extra purchase orders, no double-paid
// invoices).
//
// What it produces:
//   • +12 products spread across the main + cairo branches so margin /
//     low-stock / dead-stock filters all have signal to render
//   • 4 staff accounts on the main branch (cashier, manager-ish, junior,
//     stockroom) with mixed permissions and a known login password
//   • 1 cashier on the cairo branch (proves cross-branch staff scoping)
//   • Compensation row per staffer (mix of fixed / hourly / hybrid)
//   • 2 weeks of attendance events per staffer with one deliberate
//     forgot-to-checkout flag so the manager review banner has work
//   • Submitted leave for 2 staff (1 approved, 1 rejected, 1 pending)
//   • 3 suppliers with phones + addresses
//   • 3 purchase orders → received, with mixed payment status
//     (one fully paid, one half-paid, one unpaid)
//   • 18 sales spread across the staff with mixed payment methods,
//     deferred invoices, repeat customers, and notes
//
// Invoke:
//   TSX_OPTS=--no-warnings npx tsx scripts/seed-heavy-test.ts

const OWNER_EMAIL = "samyamr819@gmail.com";

const STAFF_PASSWORD = "Test1234!";

interface Ctx {
  tenantId: string;
  tenantSlug: string;
  ownerId: string;
  mainBranchId: string;
  cairoBranchId: string | null;
}

type Counters = {
  products: number;
  staff: number;
  attendance: number;
  compensation: number;
  leaves: number;
  suppliers: number;
  purchaseOrders: number;
  payments: number;
  sales: number;
};

const counters: Counters = {
  products: 0,
  staff: 0,
  attendance: 0,
  compensation: 0,
  leaves: 0,
  suppliers: 0,
  purchaseOrders: 0,
  payments: 0,
  sales: 0,
};

const ALL_VIEW_PERMS: Permission[] = [
  "view_dashboard",
  "view_inventory",
  "view_sales",
  "view_customers",
  "view_expenses",
  "view_returns",
  "view_insights",
  "view_settings",
  "view_suppliers",
  "view_purchases",
];

const CASHIER_PERMS: Permission[] = [
  "view_dashboard",
  "view_inventory",
  "view_sales",
  "view_customers",
  "record_sales",
  "attendance_self_manual",
  "request_leave",
];

const MANAGER_PERMS: Permission[] = [
  ...ALL_VIEW_PERMS,
  "manage_inventory",
  "record_sales",
  "modify_sales",
  "manage_returns",
  "manage_expenses",
  "manage_suppliers",
  "manage_purchases",
  "manage_tasks",
  "manage_leave",
  "attendance_self_manual",
  "request_leave",
];

const STOCKROOM_PERMS: Permission[] = [
  "view_dashboard",
  "view_inventory",
  "view_suppliers",
  "view_purchases",
  "manage_inventory",
  "manage_purchases",
  "request_leave",
  "attendance_self_manual",
];

const JUNIOR_PERMS: Permission[] = [
  "view_dashboard",
  "view_sales",
  "record_sales",
  "request_leave",
  "attendance_self_manual",
];

interface StaffSpec {
  username: string;
  displayName: string;
  perms: Permission[];
  pay: {
    payType: "fixed" | "hourly" | "hybrid";
    baseSalaryMonthly: number | null;
    hourlyRate: number | null;
    standardMonthlyHours: number | null;
  };
  branch: "main" | "cairo";
  phone?: string;
}

const STAFF: StaffSpec[] = [
  {
    username: "ahmed",
    displayName: "أحمد علي",
    perms: MANAGER_PERMS,
    pay: {
      payType: "fixed",
      baseSalaryMonthly: 9000,
      hourlyRate: null,
      standardMonthlyHours: null,
    },
    branch: "main",
    phone: "01001112233",
  },
  {
    username: "sara",
    displayName: "سارة محمد",
    perms: CASHIER_PERMS,
    pay: {
      payType: "hybrid",
      baseSalaryMonthly: 5500,
      hourlyRate: 30,
      standardMonthlyHours: 200,
    },
    branch: "main",
    phone: "01002223344",
  },
  {
    username: "khaled",
    displayName: "خالد إبراهيم",
    perms: STOCKROOM_PERMS,
    pay: {
      payType: "fixed",
      baseSalaryMonthly: 6500,
      hourlyRate: null,
      standardMonthlyHours: null,
    },
    branch: "main",
    phone: "01003334455",
  },
  {
    username: "mohamed",
    displayName: "محمد سامي",
    perms: JUNIOR_PERMS,
    pay: {
      payType: "hourly",
      baseSalaryMonthly: null,
      hourlyRate: 35,
      standardMonthlyHours: null,
    },
    branch: "main",
    phone: "01004445566",
  },
  {
    username: "nour",
    displayName: "نور حسن",
    perms: CASHIER_PERMS,
    pay: {
      payType: "fixed",
      baseSalaryMonthly: 5000,
      hourlyRate: null,
      standardMonthlyHours: null,
    },
    branch: "cairo",
    phone: "01005556677",
  },
];

interface ProductSpec {
  name: string;
  brand?: string;
  qty: number;
  price: number;
  cost: number;
  sku: string;
  branch: "main" | "cairo";
  categoryKey: string;
}

const PRODUCTS: ProductSpec[] = [
  // Main branch additions — fill in across categories that the showcase
  // seed already created.
  { name: "ساعة Casio MTP", brand: "Casio", qty: 18, price: 1450, cost: 900, sku: "WCH-CAS-01", branch: "main", categoryKey: "watches" },
  { name: "ساعة Tissot Classic", brand: "Tissot", qty: 9, price: 7800, cost: 5200, sku: "WCH-TIS-01", branch: "main", categoryKey: "watches" },
  { name: "ساعة Sekonda Sport", brand: "Sekonda", qty: 22, price: 950, cost: 580, sku: "WCH-SEK-01", branch: "main", categoryKey: "watches" },
  { name: "برفان Dior Sauvage", brand: "Dior", qty: 14, price: 4200, cost: 2750, sku: "PRF-DIO-01", branch: "main", categoryKey: "perfumes" },
  { name: "برفان Tom Ford Oud", brand: "Tom Ford", qty: 6, price: 6800, cost: 4400, sku: "PRF-TOM-01", branch: "main", categoryKey: "perfumes" },
  { name: "برفان Bvlgari Aqua", brand: "Bvlgari", qty: 12, price: 3600, cost: 2300, sku: "PRF-BVL-01", branch: "main", categoryKey: "perfumes" },
  { name: "نظارة Police Pilot", brand: "Police", qty: 16, price: 1300, cost: 720, sku: "SUN-POL-01", branch: "main", categoryKey: "sunglasses" },
  { name: "نظارة Carrera Square", brand: "Carrera", qty: 11, price: 1850, cost: 1100, sku: "SUN-CAR-01", branch: "main", categoryKey: "sunglasses" },
  { name: "نظارة Persol Vintage", brand: "Persol", qty: 5, price: 3400, cost: 2100, sku: "SUN-PER-01", branch: "main", categoryKey: "sunglasses" },
  // Cairo branch additions
  // Cairo branch uses its existing categories (mobile-accessories, gifts) —
  // the (tenant_id, key) unique constraint means we can't reuse watches/perfumes.
  { name: "شاحن سريع PD 65W", brand: "Anker", qty: 30, price: 950, cost: 540, sku: "ACC-CHG-65W-CAI", branch: "cairo", categoryKey: "mobile-accessories" },
  { name: "سماعة بلوتوث Galaxy Buds", brand: "Samsung", qty: 12, price: 2400, cost: 1500, sku: "ACC-BUD-GLX-CAI", branch: "cairo", categoryKey: "mobile-accessories" },
  { name: "صندوق هدية فاخر", brand: "Atelier", qty: 18, price: 600, cost: 280, sku: "GFT-LUX-01-CAI", branch: "cairo", categoryKey: "gifts" },
];

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

  const [tenant] = await db
    .select({ slug: tenants.slug })
    .from(tenants)
    .where(eq(tenants.id, member.tenantId))
    .limit(1);
  if (!tenant) throw new Error("tenant row missing");

  const allBranches = await withTenant(member.tenantId, (tx) =>
    tx.select().from(branches).where(eq(branches.tenantId, member.tenantId)),
  );
  const main = allBranches.find((b) => b.isPrimary);
  const cairo = allBranches.find((b) => !b.isPrimary && b.isActive);
  if (!main) throw new Error("No primary branch");

  const ctx: Ctx = {
    tenantId: member.tenantId,
    tenantSlug: tenant.slug,
    ownerId: user.id,
    mainBranchId: main.id,
    cairoBranchId: cairo?.id ?? null,
  };

  console.log(`▶ tenant ${ctx.tenantId} (slug=${ctx.tenantSlug})`);
  console.log(`▶ owner ${ctx.ownerId}`);
  console.log(`▶ main  ${ctx.mainBranchId}`);
  console.log(`▶ cairo ${ctx.cairoBranchId ?? "(none)"}`);

  await addProducts(ctx);
  const staff = await addStaff(ctx);
  await addCompensation(ctx, staff);
  await addAttendance(ctx, staff);
  await addLeaves(ctx, staff);
  const suppliersByName = await addSuppliers(ctx);
  await addPurchaseOrders(ctx, suppliersByName);
  await placeSales(ctx, staff);

  console.log("\n══════════════════════════════════════════════════");
  console.log("✓ Heavy seed done.");
  console.log("══════════════════════════════════════════════════");
  console.log(`  products     +${counters.products}`);
  console.log(`  staff        +${counters.staff}`);
  console.log(`  compensation +${counters.compensation}`);
  console.log(`  attendance   +${counters.attendance}`);
  console.log(`  leave        +${counters.leaves}`);
  console.log(`  suppliers    +${counters.suppliers}`);
  console.log(`  purch orders +${counters.purchaseOrders}`);
  console.log(`  payments     +${counters.payments}`);
  console.log(`  sales        +${counters.sales}`);
  console.log("\nStaff login emails (password: " + STAFF_PASSWORD + "):");
  for (const [username, info] of Object.entries(staff)) {
    console.log(`  ${username}@${ctx.tenantSlug}   uid=${info.userId.slice(0, 8)}…   branch=${info.branch}`);
  }
  console.log("\nOpen http://localhost:3000 and log in as samyamr819@gmail.com");
}

async function ensureCairoCategories(ctx: Ctx): Promise<void> {
  if (!ctx.cairoBranchId) return;
  console.log("\n— cairo categories");
  const wanted: { key: string; label: string; icon: string }[] = [
    { key: "watches", label: "ساعات", icon: "⌚" },
    { key: "perfumes", label: "عطور", icon: "🧴" },
    { key: "sunglasses", label: "نظارات", icon: "🕶" },
  ];
  const existing = await withTenant(ctx.tenantId, (tx) =>
    tx
      .select({ key: categoriesTbl.key })
      .from(categoriesTbl)
      .where(
        and(
          eq(categoriesTbl.tenantId, ctx.tenantId),
          eq(categoriesTbl.branchId, ctx.cairoBranchId!),
        ),
      ),
  );
  const have = new Set(existing.map((c) => c.key));
  for (const w of wanted) {
    if (have.has(w.key)) {
      console.log(`  ⤷ ${w.key} already present`);
      continue;
    }
    try {
      await addCategory(ctx.tenantId, ctx.cairoBranchId!, {
        key: w.key,
        label: w.label,
        icon: w.icon,
      });
      console.log(`  + ${w.key}`);
    } catch (e) {
      console.log(`  ⚠ ${w.key}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

async function getCategoryId(
  ctx: Ctx,
  branchId: string,
  key: string,
): Promise<string | null> {
  const rows = await withTenant(ctx.tenantId, (tx) =>
    tx
      .select({ id: categoriesTbl.id, key: categoriesTbl.key })
      .from(categoriesTbl)
      .where(
        and(
          eq(categoriesTbl.tenantId, ctx.tenantId),
          eq(categoriesTbl.branchId, branchId),
        ),
      ),
  );
  return rows.find((r) => r.key === key)?.id ?? null;
}

async function addProducts(ctx: Ctx): Promise<void> {
  console.log("\n— products");
  for (const spec of PRODUCTS) {
    const branchId =
      spec.branch === "main" ? ctx.mainBranchId : ctx.cairoBranchId;
    if (!branchId) {
      console.log(`  ⤷ skip ${spec.sku} (branch missing)`);
      continue;
    }
    const existing = await withTenant(ctx.tenantId, (tx) =>
      tx
        .select({ id: productsTbl.id })
        .from(productsTbl)
        .where(
          and(
            eq(productsTbl.tenantId, ctx.tenantId),
            eq(productsTbl.branchId, branchId),
            eq(productsTbl.sku, spec.sku),
          ),
        )
        .limit(1),
    );
    if (existing.length > 0) {
      console.log(`  ⤷ ${spec.sku} already exists, skipping`);
      continue;
    }
    const categoryId = await getCategoryId(ctx, branchId, spec.categoryKey);
    if (!categoryId) {
      console.log(
        `  ⚠ skipping ${spec.sku} — category "${spec.categoryKey}" not found on branch`,
      );
      continue;
    }
    await addProduct(ctx.tenantId, branchId, {
      categoryId,
      name: spec.name,
      brand: spec.brand,
      quantity: spec.qty,
      price: spec.price,
      costPrice: spec.cost,
      lowStockThreshold: 3,
      sku: spec.sku,
      tags: ["heavy-seed"],
    });
    counters.products += 1;
    console.log(`  + ${spec.sku} ${spec.name} qty=${spec.qty}`);
  }
}

interface StaffInfo {
  userId: string;
  branch: "main" | "cairo";
  spec: StaffSpec;
}

async function addStaff(ctx: Ctx): Promise<Record<string, StaffInfo>> {
  console.log("\n— staff");
  const out: Record<string, StaffInfo> = {};
  for (const spec of STAFF) {
    const branchId =
      spec.branch === "main" ? ctx.mainBranchId : ctx.cairoBranchId;
    if (!branchId) {
      console.log(`  ⤷ skip ${spec.username} (branch missing)`);
      continue;
    }
    const loginEmail = `${spec.username}@${ctx.tenantSlug}`;
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, loginEmail))
      .limit(1);
    if (existing) {
      out[spec.username] = { userId: existing.id, branch: spec.branch, spec };
      console.log(`  ⤷ ${spec.username} already exists, reusing`);
      continue;
    }
    try {
      const res = await addTeamMember(ctx.tenantId, {
        username: spec.username,
        displayName: spec.displayName,
        password: STAFF_PASSWORD,
        permissions: spec.perms,
        phone: spec.phone,
        branchId,
      });
      out[spec.username] = { userId: res.userId, branch: spec.branch, spec };
      counters.staff += 1;
      console.log(`  + ${spec.username} → ${res.loginEmail}`);
    } catch (e) {
      console.log(`  ⚠ ${spec.username}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return out;
}

async function addCompensation(
  ctx: Ctx,
  staff: Record<string, StaffInfo>,
): Promise<void> {
  console.log("\n— compensation");
  // Effective ~60 days ago so the period summary actually computes a value.
  const effectiveFrom = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  for (const [username, info] of Object.entries(staff)) {
    try {
      // Idempotency check: skip if a compensation row already exists.
      const { employeeCompensation } = await import("@/lib/db/schema");
      const [existing] = await withTenant(ctx.tenantId, (tx) =>
        tx
          .select({ id: employeeCompensation.id })
          .from(employeeCompensation)
          .where(
            and(
              eq(employeeCompensation.tenantId, ctx.tenantId),
              eq(employeeCompensation.employeeId, info.userId),
            ),
          )
          .limit(1),
      );
      if (existing) {
        console.log(`  ⤷ ${username} comp already set`);
        continue;
      }
      await createCompensation(ctx.tenantId, {
        employeeId: info.userId,
        payType: info.spec.pay.payType,
        baseSalaryMonthly: info.spec.pay.baseSalaryMonthly,
        hourlyRate: info.spec.pay.hourlyRate,
        standardMonthlyHours: info.spec.pay.standardMonthlyHours,
        effectiveFrom,
        createdByUserId: ctx.ownerId,
      });
      counters.compensation += 1;
      console.log(
        `  + ${username} ${info.spec.pay.payType} base=${info.spec.pay.baseSalaryMonthly ?? "—"} hourly=${info.spec.pay.hourlyRate ?? "—"}`,
      );
    } catch (e) {
      console.log(`  ⚠ ${username}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

async function addAttendance(
  ctx: Ctx,
  staff: Record<string, StaffInfo>,
): Promise<void> {
  console.log("\n— attendance (last 14 days)");
  const { attendanceEvents } = await import("@/lib/db/schema");

  const now = new Date();
  for (const [username, info] of Object.entries(staff)) {
    // Skip if any attendance already exists for this employee.
    const [existing] = await withTenant(ctx.tenantId, (tx) =>
      tx
        .select({ id: attendanceEvents.id })
        .from(attendanceEvents)
        .where(
          and(
            eq(attendanceEvents.tenantId, ctx.tenantId),
            eq(attendanceEvents.employeeId, info.userId),
          ),
        )
        .limit(1),
    );
    if (existing) {
      console.log(`  ⤷ ${username} already has events`);
      continue;
    }

    let added = 0;
    // 14 days; weekends (Fri/Sat) skipped for most workers, leaving the
    // employee absent so the roster can show real "no show" rows.
    for (let i = 14; i >= 1; i--) {
      const day = new Date(now);
      day.setDate(day.getDate() - i);
      const dow = day.getDay(); // 0=Sun .. 6=Sat
      // Skip Fridays for everyone, Saturdays for half the staff
      if (dow === 5) continue;
      if (dow === 6 && (info.spec.username === "khaled" || info.spec.username === "nour")) continue;

      const checkIn = new Date(day);
      checkIn.setHours(9, Math.floor(Math.random() * 30), 0, 0); // 09:00-09:29
      const checkOut = new Date(day);
      checkOut.setHours(17 + Math.floor(Math.random() * 2), Math.floor(Math.random() * 60), 0, 0); // 17-18

      try {
        await recordAttendanceEvent(ctx.tenantId, {
          employeeId: info.userId,
          type: "check_in",
          source: "manager_attest",
          occurredAt: checkIn,
          recordedByUserId: ctx.ownerId,
        });
        added += 1;

        // For one specific day, leave the shift open (forgot-to-checkout)
        // so the manager review banner has work. Skip the day-3 checkout
        // for `sara` specifically.
        if (info.spec.username === "sara" && i === 3) continue;

        await recordAttendanceEvent(ctx.tenantId, {
          employeeId: info.userId,
          type: "check_out",
          source: "manager_attest",
          occurredAt: checkOut,
          recordedByUserId: ctx.ownerId,
        });
        added += 1;
      } catch (e) {
        console.log(
          `  ⚠ ${username} day ${i}: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
    counters.attendance += added;
    console.log(`  + ${username} ${added} events`);
  }
}

async function addLeaves(
  ctx: Ctx,
  staff: Record<string, StaffInfo>,
): Promise<void> {
  console.log("\n— leave requests");
  const { leaveRequests } = await import("@/lib/db/schema");
  const staffUserIds = Object.values(staff).map((s) => s.userId);
  const { inArray } = await import("drizzle-orm");
  const existingForSeeded = staffUserIds.length
    ? await withTenant(ctx.tenantId, (tx) =>
        tx
          .select({ id: leaveRequests.id, userId: leaveRequests.userId })
          .from(leaveRequests)
          .where(
            and(
              eq(leaveRequests.tenantId, ctx.tenantId),
              inArray(leaveRequests.userId, staffUserIds),
            ),
          ),
      )
    : [];
  const alreadyByUser = new Set(existingForSeeded.map((r) => r.userId));

  const requests: { user: string; start: number; end: number; reason: string; decide: "approved" | "rejected" | null }[] = [
    { user: "sara", start: 30, end: 32, reason: "ظرف عائلي", decide: "approved" },
    { user: "khaled", start: 25, end: 27, reason: "سفر مع العيلة", decide: "rejected" },
    { user: "mohamed", start: 5, end: 6, reason: "إجازة شخصية", decide: null }, // pending
    { user: "nour", start: 12, end: 14, reason: "حضور حفل زواج", decide: "approved" },
  ];

  for (const r of requests) {
    const info = staff[r.user];
    if (!info) {
      console.log(`  ⤷ skip ${r.user} (staff missing)`);
      continue;
    }
    if (alreadyByUser.has(info.userId)) {
      console.log(`  ⤷ skip ${r.user} (already has a leave)`);
      continue;
    }
    const branchId =
      info.branch === "main" ? ctx.mainBranchId : ctx.cairoBranchId!;
    const startDate = new Date(Date.now() - r.start * 24 * 60 * 60 * 1000);
    const endDate = new Date(Date.now() - r.end * 24 * 60 * 60 * 1000);
    try {
      const submitted = await submitLeaveRequest(
        ctx.tenantId,
        branchId,
        info.userId,
        {
          startDate: endDate, // start is older (further back); end is closer
          endDate: startDate,
          reason: r.reason,
        },
      );
      counters.leaves += 1;
      if (r.decide) {
        await decideLeaveRequest(
          ctx.tenantId,
          ctx.ownerId,
          submitted.id,
          r.decide,
          r.decide === "rejected" ? "الفترة مزدحمة" : "موافقة",
        );
      }
      console.log(`  + ${r.user} ${r.decide ?? "pending"}`);
    } catch (e) {
      console.log(`  ⚠ ${r.user}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

async function addSuppliers(
  ctx: Ctx,
): Promise<Record<string, string>> {
  console.log("\n— suppliers");
  const { suppliers: suppliersTbl } = await import("@/lib/db/schema");

  const specs = [
    { name: "موزع الساعات السويسرية", phone: "01000111222", address: "العتبة، القاهرة", notes: "حساسية موعد التسليم" },
    { name: "تجارة العطور الفاخرة", phone: "01000222333", address: "بورسعيد", notes: "خصومات على الكميات الكبيرة" },
    { name: "نظارات بصرية - مستورد", phone: "01000333444", address: "الإسكندرية", notes: "" },
  ];

  const out: Record<string, string> = {};
  for (const s of specs) {
    const [existing] = await withTenant(ctx.tenantId, (tx) =>
      tx
        .select({ id: suppliersTbl.id })
        .from(suppliersTbl)
        .where(
          and(
            eq(suppliersTbl.tenantId, ctx.tenantId),
            eq(suppliersTbl.branchId, ctx.mainBranchId),
            eq(suppliersTbl.name, s.name),
          ),
        )
        .limit(1),
    );
    if (existing) {
      out[s.name] = existing.id;
      console.log(`  ⤷ ${s.name} exists`);
      continue;
    }
    const created = await addSupplier(ctx.tenantId, ctx.mainBranchId, {
      name: s.name,
      phone: s.phone,
      email: null,
      address: s.address,
      notes: s.notes || null,
    });
    out[s.name] = created.id;
    counters.suppliers += 1;
    console.log(`  + ${s.name}`);
  }
  return out;
}

async function addPurchaseOrders(
  ctx: Ctx,
  suppliersByName: Record<string, string>,
): Promise<void> {
  console.log("\n— purchase orders");
  const { purchaseOrders } = await import("@/lib/db/schema");

  // Idempotency: if any PO with notes prefix "heavy-seed:" exists, skip the lot.
  const existing = await withTenant(ctx.tenantId, (tx) =>
    tx
      .select({ id: purchaseOrders.id, notes: purchaseOrders.notes })
      .from(purchaseOrders)
      .where(eq(purchaseOrders.tenantId, ctx.tenantId)),
  );
  if (existing.some((r) => (r.notes ?? "").startsWith("heavy-seed:"))) {
    console.log("  ⤷ heavy-seed POs already present, skipping");
    return;
  }

  const watchSupplier = suppliersByName["موزع الساعات السويسرية"];
  const perfumeSupplier = suppliersByName["تجارة العطور الفاخرة"];
  const sunglassSupplier = suppliersByName["نظارات بصرية - مستورد"];

  // Lookup products by SKU so the PO line items can reference real productIds.
  const skus = ["WCH-CAS-01", "WCH-SEK-01", "PRF-BVL-01", "PRF-LAT-CAI-01", "SUN-POL-01"];
  const prodMap = await withTenant(ctx.tenantId, async (tx) => {
    const rows = await tx
      .select({ id: productsTbl.id, sku: productsTbl.sku })
      .from(productsTbl)
      .where(eq(productsTbl.tenantId, ctx.tenantId));
    const m: Record<string, string> = {};
    for (const r of rows) if (r.sku && skus.includes(r.sku)) m[r.sku] = r.id;
    return m;
  });

  type POPlan = { name: string; supplierId: string; lines: { sku: string; qty: number; unitCost: number }[]; payRatio: 1 | 0.5 | 0 };
  const plans: POPlan[] = [
    {
      name: "watches Q1 restock",
      supplierId: watchSupplier,
      lines: [
        { sku: "WCH-CAS-01", qty: 12, unitCost: 880 },
        { sku: "WCH-SEK-01", qty: 20, unitCost: 560 },
      ],
      payRatio: 1, // fully paid
    },
    {
      name: "perfumes restock",
      supplierId: perfumeSupplier,
      lines: [
        { sku: "PRF-BVL-01", qty: 8, unitCost: 2200 },
      ],
      payRatio: 0.5,
    },
    {
      name: "sunglasses restock",
      supplierId: sunglassSupplier,
      lines: [
        { sku: "SUN-POL-01", qty: 10, unitCost: 700 },
      ],
      payRatio: 0,
    },
  ];

  for (const p of plans) {
    try {
      const items = p.lines
        .filter((l) => prodMap[l.sku])
        .map((l) => ({
          productId: prodMap[l.sku],
          productName: l.sku,
          quantity: l.qty,
          unitCost: l.unitCost,
        }));
      if (items.length === 0) {
        console.log(`  ⤷ ${p.name}: no product matches, skipping`);
        continue;
      }
      const po = await createPurchaseOrder(ctx.tenantId, {
        supplierId: p.supplierId,
        notes: `heavy-seed: ${p.name}`,
        items,
      });
      counters.purchaseOrders += 1;
      await receivePurchaseOrder(ctx.tenantId, po.id, { updateCost: true });
      const total = items.reduce((s, i) => s + i.quantity * i.unitCost, 0);
      if (p.payRatio > 0) {
        const amount = Math.round(total * p.payRatio * 100) / 100;
        await recordPayment(ctx.tenantId, po.id, {
          amount,
          method: "cash",
          notes: "heavy-seed payment",
          paidAt: new Date(),
        });
        counters.payments += 1;
      }
      console.log(
        `  + ${p.name}: total=${total} paid=${p.payRatio * 100}%`,
      );
    } catch (e) {
      console.log(`  ⚠ ${p.name}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

async function placeSales(
  ctx: Ctx,
  staff: Record<string, StaffInfo>,
): Promise<void> {
  console.log("\n— sales (attributed to staff)");
  const { sales: salesTbl } = await import("@/lib/db/schema");

  // Build sku → productId map for the heavy-seed SKUs.
  const prodMap = await withTenant(ctx.tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: productsTbl.id,
        sku: productsTbl.sku,
        branchId: productsTbl.branchId,
      })
      .from(productsTbl)
      .where(eq(productsTbl.tenantId, ctx.tenantId));
    const m: Record<string, { id: string; branchId: string }> = {};
    for (const r of rows) if (r.sku) m[r.sku] = { id: r.id, branchId: r.branchId };
    return m;
  });

  // Per-sale idempotency: skip if a sale already exists with same recordedByUserId
  // on the same calendar day. Older heavy-seed sales (without fingerprint tag)
  // are matched this way too, so the first 15 don't get duplicated.
  const existing = await withTenant(ctx.tenantId, (tx) =>
    tx
      .select({
        recordedByUserId: salesTbl.recordedByUserId,
        saleDate: salesTbl.saleDate,
      })
      .from(salesTbl)
      .where(eq(salesTbl.tenantId, ctx.tenantId)),
  );
  const seenKeys = new Set<string>();
  for (const r of existing) {
    if (!r.recordedByUserId) continue;
    const day = (r.saleDate instanceof Date ? r.saleDate : new Date(r.saleDate as unknown as string))
      .toISOString()
      .slice(0, 10);
    seenKeys.add(`${r.recordedByUserId}|${day}`);
  }

  type SaleSpec = {
    cashier: string;
    lines: { sku: string; qty: number; price: number }[];
    paymentMethod: "cash" | "instapay" | "card" | "deferred";
    customer?: { name?: string; phone?: string };
    daysAgo: number;
    note?: string;
  };

  const sales: SaleSpec[] = [
    { cashier: "sara", lines: [{ sku: "WCH-CAS-01", qty: 1, price: 1450 }], paymentMethod: "cash", customer: { name: "محمد أحمد", phone: "01122334455" }, daysAgo: 14, note: "heavy-seed: regular sale" },
    { cashier: "sara", lines: [{ sku: "PRF-DIO-01", qty: 1, price: 4200 }, { sku: "SUN-POL-01", qty: 1, price: 1300 }], paymentMethod: "card", customer: { name: "هبة سامي", phone: "01099887766" }, daysAgo: 12, note: "heavy-seed: combo sale" },
    { cashier: "sara", lines: [{ sku: "WCH-SEK-01", qty: 2, price: 950 }], paymentMethod: "instapay", customer: { name: "أحمد عادل", phone: "01211223344" }, daysAgo: 11, note: "heavy-seed:" },
    { cashier: "mohamed", lines: [{ sku: "PRF-TOM-01", qty: 1, price: 6800 }], paymentMethod: "card", customer: { name: "كريم يوسف", phone: "01055443322" }, daysAgo: 10, note: "heavy-seed: high-value" },
    { cashier: "mohamed", lines: [{ sku: "SUN-CAR-01", qty: 1, price: 1850 }], paymentMethod: "cash", customer: { name: "هبة سامي", phone: "01099887766" }, daysAgo: 9, note: "heavy-seed: repeat customer" },
    { cashier: "ahmed", lines: [{ sku: "WCH-TIS-01", qty: 1, price: 7800 }], paymentMethod: "deferred", customer: { name: "ياسمين كمال", phone: "01066554433" }, daysAgo: 8, note: "heavy-seed: deferred premium" },
    { cashier: "ahmed", lines: [{ sku: "PRF-BVL-01", qty: 1, price: 3600 }, { sku: "WCH-CAS-01", qty: 1, price: 1450 }], paymentMethod: "instapay", customer: { name: "هبة سامي", phone: "01099887766" }, daysAgo: 7, note: "heavy-seed: 3rd visit" },
    { cashier: "sara", lines: [{ sku: "PRF-DIO-01", qty: 1, price: 4200 }], paymentMethod: "deferred", customer: { name: "محمد أحمد", phone: "01122334455" }, daysAgo: 6, note: "heavy-seed: deferred" },
    { cashier: "mohamed", lines: [{ sku: "SUN-PER-01", qty: 1, price: 3400 }], paymentMethod: "cash", customer: { name: "نادية فؤاد", phone: "01277889900" }, daysAgo: 5, note: "heavy-seed:" },
    { cashier: "sara", lines: [{ sku: "SUN-POL-01", qty: 1, price: 1300 }], paymentMethod: "cash", customer: undefined, daysAgo: 4, note: "heavy-seed: walk-in" },
    { cashier: "sara", lines: [{ sku: "WCH-SEK-01", qty: 1, price: 950 }, { sku: "PRF-BVL-01", qty: 1, price: 3600 }], paymentMethod: "card", customer: { name: "كريم يوسف", phone: "01055443322" }, daysAgo: 3, note: "heavy-seed: repeat" },
    { cashier: "mohamed", lines: [{ sku: "WCH-CAS-01", qty: 1, price: 1450 }], paymentMethod: "instapay", customer: { name: "أحمد عادل", phone: "01211223344" }, daysAgo: 2, note: "heavy-seed:" },
    { cashier: "ahmed", lines: [{ sku: "PRF-DIO-01", qty: 1, price: 4200 }], paymentMethod: "cash", customer: { name: "هبة سامي", phone: "01099887766" }, daysAgo: 2, note: "heavy-seed: VIP" },
    { cashier: "sara", lines: [{ sku: "SUN-CAR-01", qty: 1, price: 1850 }], paymentMethod: "card", customer: { name: "ياسمين كمال", phone: "01066554433" }, daysAgo: 1, note: "heavy-seed:" },
    { cashier: "mohamed", lines: [{ sku: "WCH-SEK-01", qty: 1, price: 950 }], paymentMethod: "cash", customer: undefined, daysAgo: 1, note: "heavy-seed: walk-in" },
    // Cairo branch sales
    { cashier: "nour", lines: [{ sku: "ACC-CHG-65W-CAI", qty: 1, price: 950 }], paymentMethod: "cash", customer: { name: "ليلى حسن", phone: "01166778899" }, daysAgo: 8, note: "heavy-seed: cairo" },
    { cashier: "nour", lines: [{ sku: "ACC-BUD-GLX-CAI", qty: 1, price: 2400 }], paymentMethod: "instapay", customer: { name: "ليلى حسن", phone: "01166778899" }, daysAgo: 5, note: "heavy-seed: cairo repeat" },
    { cashier: "nour", lines: [{ sku: "GFT-LUX-01-CAI", qty: 1, price: 600 }], paymentMethod: "deferred", customer: { name: "مينا سيف", phone: "01133221100" }, daysAgo: 2, note: "heavy-seed: cairo deferred" },
  ];

  for (const s of sales) {
    const cashier = staff[s.cashier];
    if (!cashier) {
      console.log(`  ⤷ skip sale (cashier ${s.cashier} missing)`);
      continue;
    }
    const saleDate = new Date(Date.now() - s.daysAgo * 24 * 60 * 60 * 1000);
    const dayKey = saleDate.toISOString().slice(0, 10);
    const cashKey = `${cashier.userId}|${dayKey}`;
    if (seenKeys.has(cashKey)) {
      console.log(`  ⤷ skip ${s.cashier} d-${s.daysAgo} (already has sale that day)`);
      continue;
    }
    seenKeys.add(cashKey);
    const branchId =
      cashier.branch === "main" ? ctx.mainBranchId : ctx.cairoBranchId!;
    const lines = s.lines
      .map((l) => {
        const p = prodMap[l.sku];
        if (!p) return null;
        return { productId: p.id, quantity: l.qty, pricePerUnit: l.price };
      })
      .filter((v): v is NonNullable<typeof v> => v !== null);
    if (lines.length === 0) {
      console.log(`  ⤷ skip sale (no products match for ${s.cashier} d-${s.daysAgo})`);
      continue;
    }
    const noteWithFp = `${s.note ?? "heavy-seed:"}`;
    try {
      await recordCartSale(ctx.tenantId, lines, {
        branchId,
        recordedByUserId: cashier.userId,
        paymentMethod: s.paymentMethod,
        customerName: s.customer?.name,
        customerPhone: s.customer?.phone,
        customDate: saleDate,
        note: noteWithFp,
      });
      counters.sales += 1;
      console.log(
        `  + ${s.cashier} ${s.paymentMethod} d-${s.daysAgo}  ${s.customer?.name ?? "walk-in"}`,
      );
    } catch (e) {
      console.log(
        `  ⚠ sale ${s.cashier} d-${s.daysAgo}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
}

void sql;

main().then(
  () => {
    process.exit(0);
  },
  (e) => {
    console.error("✗ heavy seed failed:", e);
    process.exit(1);
  },
);
