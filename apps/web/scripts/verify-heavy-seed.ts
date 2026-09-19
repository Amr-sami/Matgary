import "dotenv/config";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import {
  attendanceEvents,
  branches,
  categories as categoriesTbl,
  employeeCompensation,
  leaveRequests,
  products as productsTbl,
  purchaseOrders,
  purchaseOrderPayments,
  sales as salesTbl,
  suppliers as suppliersTbl,
  tenantMembers,
  tenants,
  users,
} from "@/lib/db/schema";

const OWNER_EMAIL = "samyamr819@gmail.com";

async function main() {
  const [owner] = await db.select().from(users).where(eq(users.email, OWNER_EMAIL));
  if (!owner) throw new Error(`owner ${OWNER_EMAIL} not found`);
  const [member] = await db
    .select()
    .from(tenantMembers)
    .where(eq(tenantMembers.userId, owner.id));
  const tenantId = member.tenantId;
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId));

  console.log(`▶ tenant=${tenant.slug} id=${tenantId}`);
  console.log(`▶ owner=${OWNER_EMAIL}\n`);

  await withTenant(tenantId, async (tx) => {
    const branchRows = await tx.select().from(branches);
    console.log("── branches");
    for (const b of branchRows) {
      console.log(`  · ${b.name} (${b.id.slice(0, 8)}…) default=${b.isDefault}`);
    }

    const catCount = await tx
      .select({ branchId: categoriesTbl.branchId, n: sql<number>`count(*)::int` })
      .from(categoriesTbl)
      .groupBy(categoriesTbl.branchId);
    console.log("\n── categories per branch");
    for (const r of catCount) {
      const b = branchRows.find((x) => x.id === r.branchId);
      console.log(`  · ${b?.name ?? "?"}: ${r.n}`);
    }

    const prodCount = await tx
      .select({ branchId: productsTbl.branchId, n: sql<number>`count(*)::int` })
      .from(productsTbl)
      .groupBy(productsTbl.branchId);
    console.log("\n── products per branch");
    for (const r of prodCount) {
      const b = branchRows.find((x) => x.id === r.branchId);
      console.log(`  · ${b?.name ?? "?"}: ${r.n}`);
    }

    const staff = await tx
      .select({ userId: tenantMembers.userId, role: tenantMembers.role })
      .from(tenantMembers);
    console.log(`\n── tenant members: ${staff.length} (incl. owner)`);
    for (const m of staff) {
      const [u] = await db.select().from(users).where(eq(users.id, m.userId));
      console.log(`  · ${u?.email ?? "?"}   role=${m.role}`);
    }

    const comps = await tx.select().from(employeeCompensation);
    console.log(`\n── compensation rows: ${comps.length}`);
    for (const c of comps) {
      console.log(
        `  · employee=${c.employeeId.slice(0, 8)}… pay=${c.payType} base=${c.baseSalaryMonthly} hourly=${c.hourlyRate ?? "—"} hrs=${c.standardMonthlyHours ?? "—"}`,
      );
    }

    const attEvents = await tx
      .select({ employeeId: attendanceEvents.employeeId, n: sql<number>`count(*)::int` })
      .from(attendanceEvents)
      .groupBy(attendanceEvents.employeeId);
    const reviewRows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(attendanceEvents)
      .where(eq(attendanceEvents.requiresReview, true));
    console.log(`\n── attendance events per employee (review-flag count=${reviewRows[0]?.n ?? 0})`);
    for (const r of attEvents) {
      console.log(`  · emp=${r.employeeId.slice(0, 8)}…: ${r.n} events`);
    }

    const leaves = await tx.select().from(leaveRequests);
    console.log(`\n── leave requests: ${leaves.length}`);
    for (const l of leaves) {
      const [u] = await db.select().from(users).where(eq(users.id, l.userId));
      const start = (l.startDate instanceof Date ? l.startDate.toISOString() : String(l.startDate)).slice(0, 10);
      const end = (l.endDate instanceof Date ? l.endDate.toISOString() : String(l.endDate)).slice(0, 10);
      console.log(
        `  · ${u?.email ?? l.userId.slice(0, 8)} status=${l.status} ${start}→${end} reason="${l.reason ?? ""}"`,
      );
    }

    const sup = await tx.select().from(suppliersTbl);
    console.log(`\n── suppliers: ${sup.length}`);
    for (const s of sup) {
      console.log(`  · ${s.name} balance=${s.balance ?? 0}`);
    }

    const pos = await tx.select().from(purchaseOrders);
    console.log(`\n── purchase orders: ${pos.length}`);
    for (const p of pos) {
      console.log(
        `  · ${p.id.slice(0, 8)}… status=${p.status} total=${p.total} paid=${p.paidAmount}`,
      );
    }

    const pays = await tx.select().from(purchaseOrderPayments);
    console.log(`\n── purchase payments: ${pays.length}`);
    for (const p of pays) {
      console.log(`  · po=${p.purchaseOrderId.slice(0, 8)}… amount=${p.amount} method=${p.method}`);
    }

    const totalSales = await tx
      .select({ n: sql<number>`count(*)::int`, sum: sql<string>`coalesce(sum(total_price::numeric),0)` })
      .from(salesTbl);
    console.log(`\n── sale-line rows: ${totalSales[0].n} (gross=${totalSales[0].sum})`);
    const byMethod = await tx
      .select({ method: salesTbl.paymentMethod, n: sql<number>`count(*)::int`, sum: sql<string>`coalesce(sum(total_price::numeric),0)` })
      .from(salesTbl)
      .groupBy(salesTbl.paymentMethod);
    for (const r of byMethod) {
      console.log(`  · ${r.method}: ${r.n} sales, ${r.sum} EGP`);
    }
    const byStaff = await tx
      .select({ uid: salesTbl.recordedByUserId, n: sql<number>`count(*)::int` })
      .from(salesTbl)
      .groupBy(salesTbl.recordedByUserId);
    console.log(`\n── sales attributed by user`);
    for (const r of byStaff) {
      if (!r.uid) {
        console.log(`  · (unattributed): ${r.n}`);
        continue;
      }
      const [u] = await db.select().from(users).where(eq(users.id, r.uid));
      console.log(`  · ${u?.email ?? r.uid.slice(0, 8)}: ${r.n}`);
    }
  });

  console.log("\n✓ verification done");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
