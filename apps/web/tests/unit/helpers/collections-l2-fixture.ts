/**
 * Shared harness for the doc 15 spec 07 DB suites (ingest pipeline, credits,
 * devices): its own tenant per suite (never truncates), an owner, two staff
 * members with the collections permissions, a manager who registers devices,
 * a product to ring up, and builders for VF-1-shaped messages whose date line
 * is the current Africa/Cairo time (the shape of 06's VF-1 fixture, never a
 * hand-typed format: the text is the fixture's own with its fills replaced).
 */
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db, withTenant } from "@/lib/db";
import { categories, shopSettings, tenantMembers, tenants, branches, users } from "@/lib/db/schema";
import { addProduct } from "@/lib/repo/catalog";
import { recordCartSale, type CartSaleOptions } from "@/lib/repo/operations";
import { saveCollectionSettings } from "@/lib/repo/collections";
import { createCollectionAccount, type AccountActor } from "@/lib/repo/collection-accounts";
import { createIngestDevice, type DeviceActor } from "@/lib/repo/collection-devices";
import type { IngestDeviceContext } from "@/lib/api/ingest-token";
import type { IngestMessage } from "@/lib/repo/collection-ingest";
import { seedCornerStorePreset } from "@/lib/seeds/cornerstore";
import { sampleById } from "@matgary/domain/collections/__fixtures__/samples";
import type { IngestChannel, IngestPlatform } from "@matgary/domain/collections/types";

export const hasTestDb = /test/i.test(process.env.DATABASE_URL ?? "");

export interface L2Fixture {
  tenantId: string;
  branchId: string;
  ownerId: string;
  staffA: string;
  staffB: string;
  managerId: string;
  productId: string;
}

export async function setupL2Tenant(label: string): Promise<L2Fixture> {
  const made = await db.transaction(async (tx) => {
    const mk = async (who: string) =>
      (
        await tx
          .insert(users)
          .values({
            email: `dc07-${label}-${who}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@iso.test`,
            name: `DC07 ${who}`,
            passwordHash: "x",
          })
          .returning({ id: users.id })
      )[0]!.id;
    const o = await mk("owner");
    const a = await mk("staffa");
    const b = await mk("staffb");
    const m = await mk("manager");
    const [t] = await tx
      .insert(tenants)
      .values({ name: `DC07 ${label}`, slug: `dc07-${label}-${Math.random().toString(36).slice(2, 8)}` })
      .returning({ id: tenants.id });
    await tx.execute(sql`select set_config('app.tenant_id', ${t!.id}, true)`);
    const [br] = await tx
      .insert(branches)
      .values({ tenantId: t!.id, slug: "main", name: "الفرع الرئيسي", isPrimary: true })
      .returning({ id: branches.id });
    await tx.insert(tenantMembers).values({ tenantId: t!.id, userId: o, role: "owner" });
    const perms = ["record_sales", "view_collections", "confirm_collections"];
    await tx.insert(tenantMembers).values({ tenantId: t!.id, userId: a, role: "staff", permissions: perms, branchIds: [br!.id] });
    await tx.insert(tenantMembers).values({ tenantId: t!.id, userId: b, role: "staff", permissions: perms, branchIds: [br!.id] });
    await tx.insert(tenantMembers).values({
      tenantId: t!.id,
      userId: m,
      role: "staff",
      permissions: ["manage_collection_accounts", "view_collections"],
      branchIds: [br!.id],
    });
    await tx.insert(shopSettings).values({ tenantId: t!.id, branchId: br!.id, shopName: `DC07 ${label}` });
    await seedCornerStorePreset(tx, t!.id, br!.id);
    return { tenantId: t!.id, branchId: br!.id, o, a, b, m };
  });
  await saveCollectionSettings(made.tenantId, made.branchId, { collectionsEnabled: true });
  const cats = await withTenant(made.tenantId, (tx) =>
    tx.select({ id: categories.id }).from(categories).where(eq(categories.tenantId, made.tenantId)).limit(1),
  );
  const { id: productId } = await addProduct(made.tenantId, made.branchId, {
    name: `DC07 ${Math.random().toString(36).slice(2, 7)}`,
    categoryId: cats[0]!.id,
    quantity: 100_000,
    price: 10,
    lowStockThreshold: 0,
  });
  return {
    tenantId: made.tenantId,
    branchId: made.branchId,
    ownerId: made.o,
    staffA: made.a,
    staffB: made.b,
    managerId: made.m,
    productId,
  };
}

export function ownerAccountActor(f: L2Fixture): AccountActor {
  return { userId: f.ownerId, isOwner: true, activeBranchId: f.branchId, accessibleBranchIds: null };
}

export function ownerDeviceActor(f: L2Fixture): DeviceActor {
  return { tenantId: f.tenantId, userId: f.ownerId, isOwner: true, accessibleBranchIds: null };
}

let last4Seq = 1000 + Math.floor(Math.random() * 7000);

/** A unique Egyptian wallet number 010XXXXXXXX whose last 4 digits are
 *  unique within the test file (routing goes by the last 4). */
export function uniqueMsisdn(): string {
  last4Seq += 1;
  return `010${String(Math.floor(Math.random() * 1e4)).padStart(4, "0")}${String(last4Seq).padStart(4, "0")}`;
}

export async function walletAccount(
  f: L2Fixture,
  opts: { msisdn?: string; label?: string; balanceCheck?: boolean; autoConfirm?: boolean; threshold?: number } = {},
): Promise<{ id: string; msisdn: string }> {
  const msisdn = opts.msisdn ?? uniqueMsisdn();
  const a = await createCollectionAccount(f.tenantId, ownerAccountActor(f), {
    rail: "wallet",
    provider: "vodafone_cash",
    label: opts.label ?? `VF ${msisdn.slice(-4)}`,
    walletMsisdn: msisdn,
    branchId: null,
    balanceCheckEnabled: opts.balanceCheck ?? false,
    autoConfirmEnabled: opts.autoConfirm ?? false,
    ...(opts.threshold !== undefined ? { reviewThreshold: opts.threshold } : {}),
  } as Parameters<typeof createCollectionAccount>[2]);
  return { id: a.id, msisdn };
}

export async function device(
  f: L2Fixture,
  opts: { platform?: IngestPlatform; channels?: IngestChannel[]; accountIds?: string[]; label?: string } = {},
): Promise<{ id: string; token: string; ctx: IngestDeviceContext }> {
  const platform = opts.platform ?? "ios_shortcut";
  const channels = opts.channels ?? (platform === "android_listener" ? ["android_notification"] : ["ios_sms", "ios_notification"]);
  const created = await createIngestDevice(ownerDeviceActor(f), {
    label: opts.label ?? "Test phone",
    platform,
    channels,
    accountIds: opts.accountIds,
    consentVersion: "2026-10-01",
  });
  return {
    id: created.device.id,
    token: created.token,
    ctx: {
      deviceId: created.device.id,
      tenantId: f.tenantId,
      branchId: created.device.branchId,
      platform,
      channels,
      accountIds: created.device.accountIds,
      createdByUserId: f.ownerId,
      consentVersion: "2026-10-01",
      label: created.device.label,
    },
  };
}

const CAIRO = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Cairo",
  year: "2-digit",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "HH:MM YY-MM-DD" in Africa/Cairo (the VF-1 date line). */
export function cairoStamp(at: Date): string {
  const p = Object.fromEntries(CAIRO.formatToParts(at).map((x) => [x.type, x.value]));
  return `${p.hour}:${p.minute} ${p.year}-${p.month}-${p.day}`;
}

/** 12 random digits (a VF operation reference). */
export function ref12(): string {
  let s = "";
  for (const b of randomBytes(12)) s += String(b % 10);
  return s;
}

export interface Vf1Opts {
  amount: string;
  balance?: string;
  reference?: string;
  payer?: string;
  /** The receiving wallet (its last 4 route the credit). */
  receiving: string;
  at?: Date;
}

/** 06's VF-1 text with its fills, amount, balance, reference and date replaced. */
export function vf1(o: Vf1Opts): string {
  const s = sampleById("VF-1")!;
  const at = o.at ?? new Date();
  return s.text
    .replace("2700.00", o.amount)
    .replace("2724.51", o.balance ?? "9999.99")
    .replace("022177777777", o.reference ?? ref12())
    .replace("01127777705", o.payer ?? "01127777705")
    .replace("01007777765", o.receiving)
    .replace("17:36 26-07-27", cairoStamp(at));
}

/** 06's VF-2 debit text (a wallet "sent" message) with amount/balance replaced. */
export function vf2Debit(amount: string, balance: string): string {
  return sampleById("VF-2")!.text.replace("500.00", amount).replace("10.00", balance);
}

export function fp(): string {
  return randomBytes(16).toString("hex");
}

export function msg(body: string, over: Partial<IngestMessage> = {}): IngestMessage {
  return {
    fp: fp(),
    channel: "ios_sms",
    sourceApp: null,
    sender: "vf-cash",
    title: null,
    subtitle: null,
    body,
    receivedAt: new Date().toISOString(),
    test: false,
    ...over,
  };
}

/** A wallet cart of `price` on `accountId`, recorded by `by` (default the owner). */
export function walletCart(
  f: L2Fixture,
  price: number,
  accountId: string,
  opts: Partial<CartSaleOptions> & { by?: string } = {},
) {
  const { by, ...rest } = opts;
  const recorder = by ?? f.ownerId;
  return recordCartSale(f.tenantId, [{ productId: f.productId, quantity: 1, pricePerUnit: price }], {
    branchId: f.branchId,
    recordedByUserId: recorder,
    recordedByRole: recorder === f.ownerId ? "owner" : "staff",
    paymentMethod: "wallet",
    collectionAccountId: accountId,
    ...rest,
  });
}

export async function q<T = Record<string, unknown>>(f: L2Fixture, query: ReturnType<typeof sql>): Promise<T[]> {
  return withTenant(f.tenantId, async (tx) => (await tx.execute(query)) as unknown as T[]);
}

export async function creditRow(f: L2Fixture, id: string) {
  const [r] = await q<{
    id: string;
    state: string;
    hold_reason: string | null;
    suggested_collection_id: string | null;
    matched_collection_id: string | null;
    channels: string[];
    seen_count: number;
    amount: string;
    collection_account_id: string | null;
    payer_name: string | null;
    payer_name_masked: string | null;
    payer_phone_last4: string | null;
    payer_phone_hmac: string | null;
    raw_message_id: string | null;
    dedupe_key: string;
    is_test: boolean;
    direction: string;
  }>(f, sql`SELECT *, amount::text AS amount FROM collection_credits WHERE tenant_id = ${f.tenantId} AND id = ${id}`);
  return r!;
}

export async function collectionRow(f: L2Fixture, id: string) {
  const [r] = await q<{ id: string; status: string; matched_credit_id: string | null; decided_by_user_id: string | null }>(
    f,
    sql`SELECT id, status, matched_credit_id, decided_by_user_id FROM collections WHERE tenant_id = ${f.tenantId} AND id = ${id}`,
  );
  return r!;
}

export async function accountRow(f: L2Fixture, id: string) {
  const [r] = await q<{
    balance_baseline: string | null;
    balance_baseline_at: string | null;
    balance_chain_broken_at: string | null;
  }>(
    f,
    sql`SELECT balance_baseline::text AS balance_baseline, to_json(balance_baseline_at) #>> '{}' AS balance_baseline_at,
               to_json(balance_chain_broken_at) #>> '{}' AS balance_chain_broken_at
          FROM collection_accounts WHERE tenant_id = ${f.tenantId} AND id = ${id}`,
  );
  return r!;
}

export async function setBaseline(f: L2Fixture, accountId: string, baseline: string | null, at: Date | null) {
  await q(
    f,
    sql`UPDATE collection_accounts SET balance_baseline = ${baseline}::numeric,
           balance_baseline_at = ${at ? at.toISOString() : null}::timestamptz, balance_chain_broken_at = NULL
         WHERE tenant_id = ${f.tenantId} AND id = ${accountId}`,
  );
}

export async function eventsOf(f: L2Fixture, collectionId: string) {
  return q<{ kind: string; actor_user_id: string | null; actor_device_id: string | null; credit_id: string | null; details: Record<string, unknown> | null }>(
    f,
    sql`SELECT kind, actor_user_id, actor_device_id, credit_id, details FROM collection_events
         WHERE tenant_id = ${f.tenantId} AND collection_id = ${collectionId} ORDER BY created_at, id`,
  );
}

/** Branch the auto-confirm switch of the fixture's branch. */
export async function setAutoConfirmSwitch(f: L2Fixture, on: boolean) {
  await withTenant(f.tenantId, (tx) =>
    tx.update(shopSettings).set({ collectionsAutoConfirmEnabled: on }).where(eq(shopSettings.branchId, f.branchId)),
  );
}
