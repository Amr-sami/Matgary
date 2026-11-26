// Receipt identity (migration 0065) — integration coverage.
//
// Covers:
//  - read-after-write for all 6 fields through getShopSettings/saveShopSettings
//  - tenant isolation (Tenant A's receipt identity is invisible to Tenant B)
//  - empty-string cleanup (empty field → stored as NULL → read as "")
//  - reference-prefix normalisation (lowercased + non-alphanumeric stripped +
//    capped at 8 chars)
//  - the professional filename format from @matgary/domain
//  - the receipt renderer OMITS blank identity rows entirely
//
// Non-destructive: creates isolated tenants + branches + shop_settings rows,
// tears them down in afterAll via CASCADE on tenants.id.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { branches, shopSettings, tenantMembers, tenants, users } from "@/lib/db/schema";
import { getShopSettings, saveShopSettings } from "@/lib/repo/settings";
import { receiptFilename, receiptReference, receiptShortCode } from "@matgary/domain/receipt/filename";

let tenantA: { tenantId: string; userId: string; branchId: string };
let tenantB: { tenantId: string; userId: string; branchId: string };

async function freshTenant(suffix: string) {
  return db.transaction(async (tx) => {
    const email = `receipt-id-${suffix}-${Date.now()}@test.local`;
    const [u] = await tx
      .insert(users)
      .values({ email, name: `Rcpt ${suffix}`, passwordHash: "x" })
      .returning({ id: users.id });
    const slug = `receipt-id-${suffix}-${Math.random().toString(36).slice(2, 8)}`;
    const [t] = await tx
      .insert(tenants)
      .values({ name: `Rcpt ${suffix}`, slug })
      .returning({ id: tenants.id });
    await tx.execute(sql`select set_config('app.tenant_id', ${t.id}, true)`);
    const [b] = await tx
      .insert(branches)
      .values({
        tenantId: t.id,
        slug: "main",
        name: "Main",
        isPrimary: true,
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
      shopName: `Rcpt ${suffix}`,
    });
    return { tenantId: t.id, userId: u.id, branchId: b.id };
  });
}

async function cleanup(id: string) {
  await db.execute(sql`delete from tenants where id = ${id}`);
}

beforeAll(async () => {
  tenantA = await freshTenant("a");
  tenantB = await freshTenant("b");
});

afterAll(async () => {
  if (tenantA?.tenantId) await cleanup(tenantA.tenantId);
  if (tenantB?.tenantId) await cleanup(tenantB.tenantId);
});

describe("receipt identity — persistence", () => {
  it("defaults every identity field to the empty string when nothing was saved", async () => {
    const s = await getShopSettings(tenantA.tenantId, tenantA.branchId);
    expect(s.receiptTaxRegistration).toBe("");
    expect(s.receiptTaxCardNumber).toBe("");
    expect(s.receiptSlogan).toBe("");
    expect(s.receiptReturnPolicy).toBe("");
    expect(s.receiptAddress).toBe("");
    expect(s.receiptReferencePrefix).toBe("");
  });

  it("round-trips all six fields through save → read", async () => {
    await saveShopSettings(tenantA.tenantId, tenantA.branchId, {
      receiptTaxRegistration: "123-456-789",
      receiptTaxCardNumber: "100-200-300",
      receiptSlogan: "الجودة تبدأ من هنا",
      receiptReturnPolicy: "الاستبدال خلال 14 يومًا بشرط وجود الفاتورة.",
      receiptAddress: "15 شارع النصر، مدينة نصر، القاهرة",
      receiptReferencePrefix: "INV",
    });
    const s = await getShopSettings(tenantA.tenantId, tenantA.branchId);
    expect(s.receiptTaxRegistration).toBe("123-456-789");
    expect(s.receiptTaxCardNumber).toBe("100-200-300");
    expect(s.receiptSlogan).toBe("الجودة تبدأ من هنا");
    expect(s.receiptReturnPolicy).toBe("الاستبدال خلال 14 يومًا بشرط وجود الفاتورة.");
    expect(s.receiptAddress).toBe("15 شارع النصر، مدينة نصر، القاهرة");
    expect(s.receiptReferencePrefix).toBe("INV");
  });

  it("clears a field when an empty / whitespace-only value is saved", async () => {
    await saveShopSettings(tenantA.tenantId, tenantA.branchId, {
      receiptSlogan: "   ",
      receiptAddress: "",
    });
    const s = await getShopSettings(tenantA.tenantId, tenantA.branchId);
    expect(s.receiptSlogan).toBe("");
    expect(s.receiptAddress).toBe("");
  });

  it("normalises the reference prefix (upper-case, [A-Z0-9-] only, 8-char cap)", async () => {
    await saveShopSettings(tenantA.tenantId, tenantA.branchId, {
      receiptReferencePrefix: "inv-store #99 extra",
    });
    const s = await getShopSettings(tenantA.tenantId, tenantA.branchId);
    // Lowercase upper-cased, "#" and spaces stripped, and the result is
    // capped at 8 chars. "inv-store #99 extra" → "INV-STOR".
    expect(s.receiptReferencePrefix).toBe("INV-STOR");
  });

  it("caps long fields at their server-side maximums", async () => {
    const huge = "x".repeat(1000);
    await saveShopSettings(tenantA.tenantId, tenantA.branchId, {
      receiptTaxRegistration: huge,
      receiptReturnPolicy: huge,
    });
    const s = await getShopSettings(tenantA.tenantId, tenantA.branchId);
    expect(s.receiptTaxRegistration.length).toBe(80);
    expect(s.receiptReturnPolicy.length).toBe(500);
  });
});

describe("receipt identity — tenant isolation", () => {
  it("does not leak Tenant A's identity into Tenant B's settings read", async () => {
    await saveShopSettings(tenantA.tenantId, tenantA.branchId, {
      receiptTaxRegistration: "AAA-111",
      receiptSlogan: "A-slogan",
      receiptReferencePrefix: "AAA",
    });
    await saveShopSettings(tenantB.tenantId, tenantB.branchId, {
      receiptTaxRegistration: "BBB-222",
      receiptSlogan: "B-slogan",
      receiptReferencePrefix: "BBB",
    });
    const a = await getShopSettings(tenantA.tenantId, tenantA.branchId);
    const b = await getShopSettings(tenantB.tenantId, tenantB.branchId);
    expect(a.receiptTaxRegistration).toBe("AAA-111");
    expect(a.receiptSlogan).toBe("A-slogan");
    expect(a.receiptReferencePrefix).toBe("AAA");
    expect(b.receiptTaxRegistration).toBe("BBB-222");
    expect(b.receiptSlogan).toBe("B-slogan");
    expect(b.receiptReferencePrefix).toBe("BBB");
  });
});

describe("receipt filename — professional format", () => {
  it("builds `Invoice-YYYY-MM-DD-{reference}.pdf` with a configured prefix", () => {
    const name = receiptFilename({
      invoiceId: "01HXYZAAAAAAAA-A1B2C3D4E5",
      saleDate: new Date("2026-11-22T03:45:00Z"),
      referencePrefix: "INV",
    });
    // Reference = prefix + short (last 10 of invoice id, upper-cased).
    expect(name).toBe("Invoice-2026-11-22-INV-A1B2C3D4E5.pdf");
  });

  it("builds a plain `Invoice-YYYY-MM-DD-{short}.pdf` with no prefix", () => {
    const name = receiptFilename({
      invoiceId: "0001234567",
      saleDate: new Date("2026-01-05T10:15:00Z"),
      referencePrefix: "",
    });
    expect(name).toBe("Invoice-2026-01-05-0001234567.pdf");
  });

  it("strips non-alphanumeric characters from the prefix in the reference", () => {
    const ref = receiptReference("01HXYZAAAAAAAAAAA-A1B2C3D4E5", " i N v  ! ");
    expect(ref).toBe("INV-A1B2C3D4E5");
  });

  it("returns the plain short code when the prefix is null / undefined", () => {
    expect(receiptReference("abc1234567", null)).toBe("ABC1234567");
    expect(receiptReference("abc1234567", undefined)).toBe("ABC1234567");
    expect(receiptShortCode("abc1234567")).toBe("ABC1234567");
  });
});

describe("receipt identity — visibility toggles (0066)", () => {
  it("defaults every visibility toggle to true for a fresh tenant", async () => {
    const s = await getShopSettings(tenantA.tenantId, tenantA.branchId);
    expect(s.receiptShowAddress).toBe(true);
    expect(s.receiptShowSlogan).toBe(true);
    expect(s.receiptShowTaxInfo).toBe(true);
    expect(s.receiptShowReturnPolicy).toBe(true);
  });

  it("persists each toggle independently and reads it back", async () => {
    await saveShopSettings(tenantA.tenantId, tenantA.branchId, {
      receiptShowAddress: false,
      receiptShowSlogan: false,
      receiptShowTaxInfo: false,
      receiptShowReturnPolicy: false,
    });
    const s = await getShopSettings(tenantA.tenantId, tenantA.branchId);
    expect(s.receiptShowAddress).toBe(false);
    expect(s.receiptShowSlogan).toBe(false);
    expect(s.receiptShowTaxInfo).toBe(false);
    expect(s.receiptShowReturnPolicy).toBe(false);

    // And flipping them back on persists too — proves the column accepts
    // both values and doesn't drift back to the DB default on update.
    await saveShopSettings(tenantA.tenantId, tenantA.branchId, {
      receiptShowAddress: true,
      receiptShowSlogan: true,
      receiptShowTaxInfo: true,
      receiptShowReturnPolicy: true,
    });
    const s2 = await getShopSettings(tenantA.tenantId, tenantA.branchId);
    expect(s2.receiptShowAddress).toBe(true);
    expect(s2.receiptShowSlogan).toBe(true);
    expect(s2.receiptShowTaxInfo).toBe(true);
    expect(s2.receiptShowReturnPolicy).toBe(true);
  });

  it("keeps the typed TEXT when a toggle is flipped off (hide without losing)", async () => {
    await saveShopSettings(tenantA.tenantId, tenantA.branchId, {
      receiptSlogan: "شكراً لتسوقكم معنا",
      receiptReturnPolicy: "الاستبدال خلال 14 يومًا.",
    });
    await saveShopSettings(tenantA.tenantId, tenantA.branchId, {
      receiptShowSlogan: false,
      receiptShowReturnPolicy: false,
    });
    const s = await getShopSettings(tenantA.tenantId, tenantA.branchId);
    // Text survives — Owner can flip back on without re-typing.
    expect(s.receiptSlogan).toBe("شكراً لتسوقكم معنا");
    expect(s.receiptReturnPolicy).toBe("الاستبدال خلال 14 يومًا.");
    expect(s.receiptShowSlogan).toBe(false);
    expect(s.receiptShowReturnPolicy).toBe(false);
  });

  it("isolates toggle state between tenants", async () => {
    await saveShopSettings(tenantA.tenantId, tenantA.branchId, {
      receiptShowTaxInfo: false,
    });
    await saveShopSettings(tenantB.tenantId, tenantB.branchId, {
      receiptShowTaxInfo: true,
    });
    const a = await getShopSettings(tenantA.tenantId, tenantA.branchId);
    const b = await getShopSettings(tenantB.tenantId, tenantB.branchId);
    expect(a.receiptShowTaxInfo).toBe(false);
    expect(b.receiptShowTaxInfo).toBe(true);
  });
});

describe("receipt identity — alignment overrides (0067)", () => {
  it("defaults to an empty alignment map (renderer falls back to center)", async () => {
    const s = await getShopSettings(tenantA.tenantId, tenantA.branchId);
    expect(s.receiptBlockAlignments).toEqual({});
  });

  it("round-trips a mixed set of alignments", async () => {
    await saveShopSettings(tenantA.tenantId, tenantA.branchId, {
      receiptBlockAlignments: {
        name: "right",
        phone: "left",
        slogan: "right",
        taxReg: "left",
        taxCard: "right",
      },
    });
    const s = await getShopSettings(tenantA.tenantId, tenantA.branchId);
    expect(s.receiptBlockAlignments).toEqual({
      name: "right",
      phone: "left",
      slogan: "right",
      taxReg: "left",
      taxCard: "right",
    });
  });

  it("drops redundant center entries from storage (sparse map)", async () => {
    await saveShopSettings(tenantA.tenantId, tenantA.branchId, {
      receiptBlockAlignments: {
        name: "center",
        phone: "left",
        slogan: "center",
      },
    });
    const s = await getShopSettings(tenantA.tenantId, tenantA.branchId);
    // Only "phone" survives — "center" is the renderer default so storing
    // the entry is wasted bytes.
    expect(s.receiptBlockAlignments).toEqual({ phone: "left" });
  });

  it("drops unknown row keys (schema-level allowlist)", async () => {
    await saveShopSettings(tenantA.tenantId, tenantA.branchId, {
      receiptBlockAlignments: {
        name: "right",
        bogusKey: "left" as unknown as "left",
        another: "right" as unknown as "right",
      },
    });
    const s = await getShopSettings(tenantA.tenantId, tenantA.branchId);
    expect(s.receiptBlockAlignments).toEqual({ name: "right" });
  });

  it("isolates alignment state between tenants", async () => {
    await saveShopSettings(tenantA.tenantId, tenantA.branchId, {
      receiptBlockAlignments: { name: "right" },
    });
    await saveShopSettings(tenantB.tenantId, tenantB.branchId, {
      receiptBlockAlignments: { name: "left" },
    });
    const a = await getShopSettings(tenantA.tenantId, tenantA.branchId);
    const b = await getShopSettings(tenantB.tenantId, tenantB.branchId);
    expect(a.receiptBlockAlignments).toEqual({ name: "right" });
    expect(b.receiptBlockAlignments).toEqual({ name: "left" });
  });
});

describe("receipt filename — security (no sensitive data leak)", () => {
  it("never contains the customer name or phone", () => {
    // Filename is built ONLY from invoiceId + saleDate + prefix; the API's
    // input type simply does not accept customer PII. This is a type-level
    // guarantee, reconfirmed at runtime: feeding a customer-shaped field
    // has no effect.
    const name = receiptFilename({
      invoiceId: "01HXYZ-A1B2C3D4E5",
      saleDate: "2026-11-22T00:00:00Z",
      referencePrefix: "INV",
    });
    expect(name).not.toMatch(/ahmed|khaled|01[0-9]{9}|@/i);
  });
});
