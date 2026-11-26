/**
 * Doc 15 spec 07 §7 — the ingest pipeline against a real database
 * (lib/repo/collection-ingest.ts + lib/repo/collection-matching.ts).
 * Skipped unless DATABASE_URL names a `test` database; its own tenant.
 *
 * Messages are 06's fixtures (VF-1, VF-2, EM-1, IP-NBE-2a, the Zynk
 * negatives) with their fills and date line replaced, never hand-typed
 * formats. The auto-confirm path injects a `pilot_verified` copy of the VF
 * credit template through `deps.templates` (every seed template is
 * `published_sample`, so nothing auto-confirms at M2 — acceptance 9).
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "@/lib/db";
import { encryptRawText } from "@/lib/collections/raw-text";
import { ingestMessages, ingestOne, purgeExpiredRawMessages, type IngestMessage, type IngestSource } from "@/lib/repo/collection-ingest";
import { newEffects, releaseCredits, type MatchEffects } from "@/lib/repo/collection-matching";
import { confirmCollection, rejectCollection, reopenCollection, type DecisionActor } from "@/lib/repo/collections";
import { createCollectionAccount } from "@/lib/repo/collection-accounts";
import { COLLECTION_TEMPLATES } from "@matgary/domain/collections/templates/index";
import { autoConfirmGate } from "@matgary/domain/collections/match";
import { sampleById } from "@matgary/domain/collections/__fixtures__/samples";
import type { CollectionTemplate } from "@matgary/domain/collections/types";
import {
  accountRow,
  collectionRow,
  creditRow,
  device,
  eventsOf,
  hasTestDb,
  msg,
  ownerAccountActor,
  q,
  ref12,
  setAutoConfirmSwitch,
  setBaseline,
  setupL2Tenant,
  vf1,
  vf2Debit,
  walletAccount,
  walletCart,
  type L2Fixture,
} from "./helpers/collections-l2-fixture";

let f: L2Fixture;
let dev: Awaited<ReturnType<typeof device>>;
const savedEnv = {
  e: process.env.COLLECTIONS_ENABLED,
  i: process.env.COLLECTIONS_INGEST_ENABLED,
  a: process.env.COLLECTIONS_AUTO_CONFIRM_ENABLED,
};

const VF_CREDIT = "vodafone_cash.sms.credit.v1";
/** The registry with the VF credit template promoted (tests only). */
const PILOT_TEMPLATES: readonly CollectionTemplate[] = COLLECTION_TEMPLATES.map((t) =>
  t.id === VF_CREDIT ? { ...t, status: "pilot_verified" as const } : t,
);

const owner = (): DecisionActor => ({ userId: f.ownerId, isOwner: true, accessibleBranchIds: null });

beforeAll(async () => {
  if (!hasTestDb) return;
  process.env.COLLECTIONS_ENABLED = "on";
  process.env.COLLECTIONS_INGEST_ENABLED = "on";
  process.env.COLLECTIONS_AUTO_CONFIRM_ENABLED = "on";
  f = await setupL2Tenant("pipe");
  dev = await device(f, { label: "pipeline phone" });
});

afterAll(() => {
  for (const [k, v] of [
    ["COLLECTIONS_ENABLED", savedEnv.e],
    ["COLLECTIONS_INGEST_ENABLED", savedEnv.i],
    ["COLLECTIONS_AUTO_CONFIRM_ENABLED", savedEnv.a],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** One message through ingestOne with an effects object the test can read. */
async function one(
  m: IngestMessage,
  opts: { templates?: readonly CollectionTemplate[]; source?: Partial<IngestSource> } = {},
): Promise<{ o: Awaited<ReturnType<typeof ingestOne>>; effects: MatchEffects }> {
  const effects = newEffects();
  const src: IngestSource = { tenantId: f.tenantId, device: dev.ctx, forcedAccountId: null, paste: false, ...opts.source };
  const o = await withTenant(f.tenantId, (tx) =>
    ingestOne(tx, src, m, opts.templates ? { templates: opts.templates } : {}, effects),
  );
  return { o, effects };
}

async function rawByFp(fp: string) {
  return q<{ id: string; parse_status: string; title_enc: string | null; body_enc: string | null; body_sha256: string | null; expires_at: string; created_at: string }>(
    f,
    sql`SELECT id, parse_status, title_enc, body_enc, body_sha256, to_json(expires_at) #>> '{}' AS expires_at,
               to_json(created_at) #>> '{}' AS created_at
          FROM collection_raw_messages WHERE tenant_id = ${f.tenantId} AND client_fingerprint = ${fp}`,
  );
}

async function creditCount(): Promise<number> {
  const [r] = await q<{ n: number }>(f, sql`SELECT count(*)::int AS n FROM collection_credits WHERE tenant_id = ${f.tenantId}`);
  return Number(r!.n);
}

const days = (iso: string, from: string) => (Date.parse(iso) - Date.parse(from)) / 86_400_000;

// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!hasTestDb)("dedupe (§4.7 steps 2, 6; acceptance 4, 5)", () => {
  it("the same fp from the same device twice → duplicate; nothing new stored", async () => {
    const acc = await walletAccount(f);
    const m = msg(vf1({ amount: "110.00", receiving: acc.msisdn }));
    const a = await ingestMessages(dev.ctx, [m]);
    expect(a.results[0]).toEqual({ fp: m.fp, status: "accepted", reason: "parsed" });
    const rawBefore = (await q<{ n: number }>(f, sql`SELECT count(*)::int AS n FROM collection_raw_messages WHERE tenant_id = ${f.tenantId}`))[0]!.n;
    const credits = await creditCount();
    const b = await ingestMessages(dev.ctx, [m]);
    expect(b.results[0]).toEqual({ fp: m.fp, status: "duplicate" });
    expect((await q<{ n: number }>(f, sql`SELECT count(*)::int AS n FROM collection_raw_messages WHERE tenant_id = ${f.tenantId}`))[0]!.n).toBe(rawBefore);
    expect(await creditCount()).toBe(credits);
  });

  it("a same-device same-channel re-post with a NEW fp → duplicate (seen_count++)", async () => {
    const acc = await walletAccount(f);
    const body = vf1({ amount: "111.00", receiving: acc.msisdn });
    const a = await one(msg(body));
    const b = await one(msg(body));
    expect(b.o.status).toBe("duplicate");
    expect(b.o.creditId).toBe(a.o.creditId);
    expect((await creditRow(f, a.o.creditId!)).seen_count).toBe(2);
  });

  it("SMS + notification copies (reference key) → ONE credit, both channels, seen_count 2", async () => {
    const acc = await walletAccount(f);
    const body = vf1({ amount: "112.00", receiving: acc.msisdn });
    const a = await one(msg(body, { channel: "ios_sms" }));
    const b = await one(msg(body, { channel: "ios_notification", sender: null, sourceApp: "ios.unknown" }));
    expect(b.o.status).toBe("accepted");
    expect(b.o.creditId).toBe(a.o.creditId);
    const c = await creditRow(f, a.o.creditId!);
    expect([...c.channels].sort()).toEqual(["ios_notification", "ios_sms"]);
    expect(c.seen_count).toBe(2);
  });

  it("cross-channel merge without a shared key: a reference-less fallback notification within 10 min merges into the SMS credit", async () => {
    const acc = await walletAccount(f);
    const scoped = await device(f, { accountIds: [acc.id], label: "scoped" });
    const sms = msg(vf1({ amount: "113.00", receiving: acc.msisdn }), { channel: "ios_sms" });
    const effects = newEffects();
    const src: IngestSource = { tenantId: f.tenantId, device: scoped.ctx, forcedAccountId: null, paste: false };
    const a = await withTenant(f.tenantId, (tx) => ingestOne(tx, src, sms, {}, effects));
    const noti = msg("تم استلام مبلغ 113.00 جنيه", { channel: "ios_notification", sender: null, sourceApp: "ios.unknown" });
    const b = await withTenant(f.tenantId, (tx) => ingestOne(tx, src, noti, {}, effects));
    expect(a.status).toBe("accepted");
    expect(b.status).toBe("accepted");
    expect(b.reason).toBe("fallback");
    expect(b.creditId).toBe(a.creditId);
    const c = await creditRow(f, a.creditId!);
    expect(c.channels.length).toBe(2);
    expect(c.seen_count).toBe(2);
  });

  it("f: key — two DIFFERENT bodies with the same amount in one 10-min bucket on one channel → two credits (#2 suffix)", async () => {
    const acc = await walletAccount(f);
    const scoped = await device(f, { accountIds: [acc.id], label: "f-key" });
    const src: IngestSource = { tenantId: f.tenantId, device: scoped.ctx, forcedAccountId: null, paste: false };
    const at = new Date().toISOString();
    const effects = newEffects();
    const a = await withTenant(f.tenantId, (tx) => ingestOne(tx, src, msg("تم استلام مبلغ 77.00 جنيه من عميل", { receivedAt: at }), {}, effects));
    const b = await withTenant(f.tenantId, (tx) => ingestOne(tx, src, msg("تم استلام مبلغ 77.00 جنيه من عميل آخر", { receivedAt: at }), {}, effects));
    expect(a.reason).toBe("fallback");
    expect(b.status).toBe("accepted");
    expect(b.creditId).not.toBe(a.creditId);
    const ka = (await creditRow(f, a.creditId!)).dedupe_key;
    const kb = (await creditRow(f, b.creditId!)).dedupe_key;
    expect(ka.startsWith("f:")).toBe(true);
    expect(kb).toBe(`${ka}#2`);
  });
});

describe.skipIf(!hasTestDb)("drops and raw retention (§4.7 step 3, §4.10; acceptance 6, 7, 8, 21)", () => {
  it("an OTP → dropped/otp; the raw row keeps only body_sha256 (no text), 2 days", async () => {
    const m = msg(sampleById("ZYNK-OTP")!.text, { sender: null });
    const r = await ingestMessages(dev.ctx, [m]);
    expect(r.results[0]).toEqual({ fp: m.fp, status: "dropped", reason: "otp" });
    const [raw] = await rawByFp(m.fp!);
    expect(raw).toMatchObject({ parse_status: "otp", title_enc: null, body_enc: null });
    expect(raw!.body_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(days(raw!.expires_at, raw!.created_at)).toBeCloseTo(2, 1);
  });

  it("receivedAt 49 h ago → dropped/too_old, no credit", async () => {
    const acc = await walletAccount(f);
    const before = await creditCount();
    const m = msg(vf1({ amount: "120.00", receiving: acc.msisdn }), { receivedAt: new Date(Date.now() - 49 * 3_600_000).toISOString() });
    const r = await ingestMessages(dev.ctx, [m]);
    expect(r.results[0]).toEqual({ fp: m.fp, status: "dropped", reason: "too_old" });
    expect(await creditCount()).toBe(before);
  });

  it("a non-money text → dropped/not_credit (2 d); an unrecognised money text → accepted/unknown_format kept 30 d, no credit", async () => {
    const before = await creditCount();
    const nc = msg(sampleById("ZYNK-CARD")!.text, { sender: null });
    const uf = msg("تم استلام مبلغ ما من صديق، شكراً", { sender: "SomeBank" });
    const r = await ingestMessages(dev.ctx, [nc, uf]);
    expect(r.results).toEqual([
      { fp: nc.fp, status: "dropped", reason: "not_credit" },
      { fp: uf.fp, status: "accepted", reason: "unknown_format" },
    ]);
    const [rn] = await rawByFp(nc.fp!);
    const [ru] = await rawByFp(uf.fp!);
    expect(days(rn!.expires_at, rn!.created_at)).toBeCloseTo(2, 1);
    expect(days(ru!.expires_at, ru!.created_at)).toBeCloseTo(30, 1);
    expect(ru!.body_enc).toMatch(/^v1:/);
    expect(await creditCount()).toBe(before);
  });

  it("a channel the device may not post, or manual_paste through ingest → dropped/channel_not_allowed, nothing stored", async () => {
    const a = msg("تم استلام مبلغ 5.00 جنيه", { channel: "android_notification" });
    const b = msg("تم استلام مبلغ 5.00 جنيه", { channel: "manual_paste" });
    const r = await ingestMessages(dev.ctx, [a, b]);
    expect(r.results.map((x) => x.reason)).toEqual(["channel_not_allowed", "channel_not_allowed"]);
    expect(r.results.every((x) => x.status === "dropped")).toBe(true);
    expect(await rawByFp(a.fp!)).toHaveLength(0);
    expect(await rawByFp(b.fp!)).toHaveLength(0);
  });

  it("a 5,000-char body is accepted and stored truncated to 2,000 (acceptance 3)", async () => {
    const long = "تم استلام مبلغ 9.00 جنيه " + "x".repeat(5000);
    const m = msg(long, { sender: "SomeBank" });
    await ingestMessages(dev.ctx, [m]);
    const [raw] = await rawByFp(m.fp!);
    const { decryptRawText } = await import("@/lib/collections/raw-text");
    expect(decryptRawText(raw!.body_enc)!.length).toBe(2000);
  });

  it("purgeExpiredRawMessages deletes only this tenant's expired rows", async () => {
    const m = msg("تم استلام مبلغ ما للحذف", { sender: "SomeBank" });
    await ingestMessages(dev.ctx, [m]);
    const keep = msg("تم استلام مبلغ ما للإبقاء", { sender: "SomeBank" });
    await ingestMessages(dev.ctx, [keep]);
    await q(f, sql`UPDATE collection_raw_messages SET expires_at = now() - interval '1 minute' WHERE tenant_id = ${f.tenantId} AND client_fingerprint = ${m.fp}`);
    const other = await setupL2Tenant("pipe-other");
    const otherDev = await device(other);
    const om = msg("تم استلام مبلغ ما في متجر آخر", { sender: "SomeBank" });
    await ingestMessages(otherDev.ctx, [om]);
    await q(other, sql`UPDATE collection_raw_messages SET expires_at = now() - interval '1 minute' WHERE tenant_id = ${other.tenantId}`);

    const out = await purgeExpiredRawMessages(f.tenantId);
    expect(out.deleted).toBeGreaterThanOrEqual(1);
    expect(await rawByFp(m.fp!)).toHaveLength(0);
    expect(await rawByFp(keep.fp!)).toHaveLength(1);
    const [left] = await q<{ n: number }>(other, sql`SELECT count(*)::int AS n FROM collection_raw_messages WHERE tenant_id = ${other.tenantId}`);
    expect(Number(left!.n)).toBe(1);
  });
});

describe.skipIf(!hasTestDb)("routing (§4.7 step 4)", () => {
  it("by the receiving wallet's last 4", async () => {
    const a1 = await walletAccount(f);
    await walletAccount(f);
    const { o } = await one(msg(vf1({ amount: "130.00", receiving: a1.msisdn })));
    expect((await creditRow(f, o.creditId!)).collection_account_id).toBe(a1.id);
  });

  it("by the single account of the template's provider (EM-1 carries no hint)", async () => {
    const em = await createCollectionAccount(f.tenantId, ownerAccountActor(f), {
      rail: "wallet",
      provider: "etisalat_money",
      label: "e& money",
      walletMsisdn: "011" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0"),
      branchId: null,
    } as never);
    const { o } = await one(msg(sampleById("EM-1")!.text, { sender: "e& money" }));
    expect(o.status).toBe("accepted");
    expect((await creditRow(f, o.creditId!)).collection_account_id).toBe(em.id);
  });

  it("an NBE prepaid-card credit routes to the prepaid account, not the bank account", async () => {
    const mk = (prepaid: boolean, last4: string) =>
      createCollectionAccount(f.tenantId, ownerAccountActor(f), {
        rail: "instapay",
        provider: "nbe",
        label: prepaid ? "NBE prepaid" : "NBE account",
        accountLast4: last4,
        isPrepaidCard: prepaid,
        branchId: null,
      } as never);
    await mk(false, "4411");
    const card = await mk(true, "4412");
    const { o } = await one(msg(sampleById("IP-NBE-2a")!.text, { sender: "AHLY" }));
    expect(o.status).toBe("accepted");
    expect((await creditRow(f, o.creditId!)).collection_account_id).toBe(card.id);
  });

  it("no matching account → held/no_account, notified (D07-1)", async () => {
    const { o, effects } = await one(msg(vf1({ amount: "131.00", receiving: "01099990000" })));
    expect(o).toMatchObject({ status: "accepted", state: "held", holdReason: "no_account" });
    expect(effects.notify.map((n) => n.creditId)).toEqual([o.creditId]);
  });
});

describe.skipIf(!hasTestDb)("matching at M2 (§4.9; acceptance 9, 12, 13, 25)", () => {
  it("one pending wallet sale + published template → held/unverified_format with the sale suggested; never auto_confirmed", async () => {
    const acc = await walletAccount(f, { autoConfirm: true });
    await setAutoConfirmSwitch(f, true);
    const sale = await walletCart(f, 140, acc.id);
    const m = msg(vf1({ amount: "140.00", receiving: acc.msisdn }));
    const { o, effects } = await one(m);
    expect(o).toMatchObject({ state: "held", holdReason: "unverified_format", suggestedCollectionId: sale.collectionIds[0] });
    expect(effects.autoConfirmed).toHaveLength(0);
    expect(effects.notify).toHaveLength(0); // a hold with a suggested pending sale does not notify
    expect((await collectionRow(f, sale.collectionIds[0]!)).status).toBe("pending");
    await setAutoConfirmSwitch(f, false);
  });

  it("two pending sales of the same amount, no signal → held/ambiguous suggesting the closest", async () => {
    const acc = await walletAccount(f);
    const s1 = await walletCart(f, 150, acc.id);
    const s2 = await walletCart(f, 150, acc.id);
    const { o } = await one(msg(vf1({ amount: "150.00", receiving: acc.msisdn })));
    expect(o.state).toBe("held");
    expect(o.holdReason).toBe("ambiguous");
    expect([s1.collectionIds[0], s2.collectionIds[0]]).toContain(o.suggestedCollectionId);
  });

  it("with the payer's last 4 typed on one of them → that one is chosen (then the M2 gate holds it)", async () => {
    const acc = await walletAccount(f);
    await walletCart(f, 160, acc.id);
    const s2 = await walletCart(f, 160, acc.id, { payerPhoneLast4: "7705" });
    const { o } = await one(msg(vf1({ amount: "160.00", receiving: acc.msisdn, payer: "01127777705" })));
    expect(o).toMatchObject({ state: "held", holdReason: "unverified_format", suggestedCollectionId: s2.collectionIds[0] });
  });

  it("an over-payment within OVERPAY_SUGGEST_MAX → held/amount_mismatch with that suggestion; an under-payment is never suggested", async () => {
    const acc = await walletAccount(f);
    const s = await walletCart(f, 170, acc.id);
    const over = await one(msg(vf1({ amount: "171.00", receiving: acc.msisdn })));
    expect(over.o).toMatchObject({ state: "held", holdReason: "amount_mismatch", suggestedCollectionId: s.collectionIds[0] });
    const acc2 = await walletAccount(f);
    await walletCart(f, 180, acc2.id);
    const under = await one(msg(vf1({ amount: "179.00", receiving: acc2.msisdn })));
    expect(under.o).toMatchObject({ state: "unmatched", suggestedCollectionId: null });
  });

  it("a numeric SMS sender + published template → untrusted_source (security-first), equal to autoConfirmGate().reason", async () => {
    const acc = await walletAccount(f);
    const sale = await walletCart(f, 190, acc.id);
    const { o } = await one(msg(vf1({ amount: "190.00", receiving: acc.msisdn }), { sender: "01012345678" }));
    expect(o).toMatchObject({ state: "held", holdReason: "untrusted_source", suggestedCollectionId: sale.collectionIds[0] });
    const gate = autoConfirmGate({
      autoConfirmFeature: false,
      account: { autoConfirmEnabled: false, reviewThreshold: "5000" },
      template: COLLECTION_TEMPLATES.find((t) => t.id === VF_CREDIT)!,
      channel: "ios_sms",
      senderKind: "numeric",
      senderMatched: false,
      device: { live: true, channels: ["ios_sms"] },
      amount: "190.00",
      occurredAt: new Date().toISOString(),
      reference: "x",
      suspiciousLinks: [],
      isTest: false,
      balance: "not_applicable",
      now: new Date(),
    });
    expect(gate.reasons.length).toBeGreaterThan(1);
    expect(o.holdReason).toBe(gate.reason);
  });

  it("a test message → held/test, no suggestion, no effects", async () => {
    const acc = await walletAccount(f);
    await walletCart(f, 195, acc.id);
    const { o, effects } = await one(msg(vf1({ amount: "195.00", receiving: acc.msisdn }), { test: true }));
    expect(o).toMatchObject({ state: "held", holdReason: "test", suggestedCollectionId: null });
    expect(effects).toEqual({ autoConfirmed: [], notify: [], bust: false });
  });
});

describe.skipIf(!hasTestDb)("auto-confirm with an injected pilot_verified template (acceptance 10, 13)", () => {
  async function autoReady(threshold?: number) {
    const acc = await walletAccount(f, { balanceCheck: true, autoConfirm: true, ...(threshold !== undefined ? { threshold } : {}) });
    await setBaseline(f, acc.id, "1000.00", new Date(Date.now() - 3_600_000));
    await setAutoConfirmSwitch(f, true);
    return acc;
  }

  it("trusted sender, threshold OK, correct baseline, one candidate → auto_confirmed, credit matched, event with actor_device_id, lines reconciled, activity with null actor", async () => {
    const acc = await autoReady();
    const sale = await walletCart(f, 200, acc.id);
    const cid = sale.collectionIds[0]!;
    const m = msg(vf1({ amount: "200.00", balance: "1200.00", receiving: acc.msisdn }));
    const res = await ingestMessages(dev.ctx, [m], { templates: PILOT_TEMPLATES });
    expect(res.results[0]).toEqual({ fp: m.fp, status: "accepted", reason: "parsed" });
    const col = await collectionRow(f, cid);
    expect(col.status).toBe("auto_confirmed");
    expect(col.decided_by_user_id).toBeNull();
    const credit = await creditRow(f, col.matched_credit_id!);
    expect(credit).toMatchObject({ state: "matched", matched_collection_id: cid, hold_reason: null });
    const ev = (await eventsOf(f, cid)).find((e) => e.kind === "auto_confirmed")!;
    expect(ev).toMatchObject({ actor_user_id: null, actor_device_id: dev.id, credit_id: credit.id });
    const lines = await q<{ collection_status: string }>(f, sql`SELECT collection_status FROM sales WHERE tenant_id = ${f.tenantId} AND invoice_id = ${sale.invoiceId}`);
    // SaleCollectionStatus is pending · confirmed · rejected (03 §B.1): an auto-confirmed part reads `confirmed`.
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.map((l) => l.collection_status)).toEqual(lines.map(() => "confirmed"));
    expect((await accountRow(f, acc.id)).balance_baseline).toBe("1200.00");
    // flushMatchEffects is fire-and-forget: poll the activity row briefly.
    let act: { actor_user_id: string | null }[] = [];
    for (let i = 0; i < 20 && act.length === 0; i++) {
      act = await q<{ actor_user_id: string | null }>(
        f,
        sql`SELECT actor_user_id FROM activity_logs WHERE tenant_id = ${f.tenantId} AND action = 'collection.auto_confirm' AND entity_id = ${cid}`,
      );
      if (act.length === 0) await new Promise((r) => setTimeout(r, 50));
    }
    expect(act).toEqual([{ actor_user_id: null }]);
    await setAutoConfirmSwitch(f, false);
  });

  it("above the review threshold → held/above_review_limit", async () => {
    const acc = await autoReady(50);
    const sale = await walletCart(f, 210, acc.id);
    const { o, effects } = await one(msg(vf1({ amount: "210.00", balance: "1210.00", receiving: acc.msisdn })), { templates: PILOT_TEMPLATES });
    expect(o).toMatchObject({ state: "held", holdReason: "above_review_limit", suggestedCollectionId: sale.collectionIds[0] });
    expect(effects.autoConfirmed).toHaveLength(0);
    await setAutoConfirmSwitch(f, false);
  });

  it("a numeric sender never passes the source gate, even with a verified template", async () => {
    const acc = await autoReady();
    await walletCart(f, 220, acc.id);
    const { o } = await one(msg(vf1({ amount: "220.00", balance: "1220.00", receiving: acc.msisdn }), { sender: "01012345678" }), {
      templates: PILOT_TEMPLATES,
    });
    expect(o).toMatchObject({ state: "held", holdReason: "untrusted_source" });
    await setAutoConfirmSwitch(f, false);
  });

  it("owner reopens the auto-confirmed collection → credit released: unmatched, links NULL, note event, baseline unchanged (acceptance 24)", async () => {
    const acc = await autoReady();
    const sale = await walletCart(f, 230, acc.id);
    const cid = sale.collectionIds[0]!;
    await ingestMessages(dev.ctx, [msg(vf1({ amount: "230.00", balance: "1230.00", receiving: acc.msisdn }))], { templates: PILOT_TEMPLATES });
    const col = await collectionRow(f, cid);
    expect(col.status).toBe("auto_confirmed");
    const creditId = col.matched_credit_id!;
    const baseline = (await accountRow(f, acc.id)).balance_baseline;

    await reopenCollection(f.tenantId, cid, owner(), {});
    const after = await collectionRow(f, cid);
    expect(after).toMatchObject({ status: "pending", matched_credit_id: null });
    const c = await creditRow(f, creditId);
    expect(c).toMatchObject({ state: "unmatched", matched_collection_id: null, suggested_collection_id: null, hold_reason: null });
    const notes = (await eventsOf(f, cid)).filter((e) => e.kind === "note" && e.details?.reason === "credit_released");
    expect(notes).toHaveLength(1);
    expect(notes[0]!.details).toMatchObject({ creditId, cause: "reopened" });
    expect((await accountRow(f, acc.id)).balance_baseline).toBe(baseline);
    await setAutoConfirmSwitch(f, false);
  });
});

describe.skipIf(!hasTestDb)("balance chain (acceptance 11)", () => {
  it("no baseline → no_balance_baseline; pass moves the baseline; mismatch holds and keeps it; a debit breaks the chain", async () => {
    const acc = await walletAccount(f, { balanceCheck: true });
    const scoped = await device(f, { accountIds: [acc.id], label: "chain" });
    const src: Partial<IngestSource> = { device: scoped.ctx };

    const first = await one(msg(vf1({ amount: "10.00", balance: "1000.00", receiving: acc.msisdn })), { source: src });
    expect(first.o).toMatchObject({ state: "held", holdReason: "no_balance_baseline" });
    expect((await accountRow(f, acc.id)).balance_baseline).toBeNull();

    await setBaseline(f, acc.id, "1000.00", new Date(Date.now() - 60_000));
    const pass = await one(msg(vf1({ amount: "100.00", balance: "1100.01", receiving: acc.msisdn })), { source: src });
    expect(pass.o.state).toBe("unmatched");
    expect((await accountRow(f, acc.id)).balance_baseline).toBe("1100.01");

    const bad = await one(msg(vf1({ amount: "50.00", balance: "2000.00", receiving: acc.msisdn })), { source: src });
    expect(bad.o).toMatchObject({ state: "held", holdReason: "balance_mismatch" });
    expect((await accountRow(f, acc.id)).balance_baseline).toBe("1100.01");
    expect(bad.effects.notify).toHaveLength(1);

    const debit = await one(msg(vf2Debit("20.00", "1080.01"), { sender: "vf-cash" }), { source: src });
    expect(debit.o).toMatchObject({ status: "accepted", state: "info" });
    expect((await accountRow(f, acc.id)).balance_chain_broken_at).not.toBeNull();

    const next = await one(msg(vf1({ amount: "5.00", balance: "1085.01", receiving: acc.msisdn })), { source: src });
    expect(next.o).toMatchObject({ state: "held", holdReason: "no_balance_baseline" });
  });
});

describe.skipIf(!hasTestDb)("reverse match and late arrivals (acceptance 14, 15)", () => {
  it("a credit that arrives BEFORE its sale is suggested by reverseMatch inside the cart transaction", async () => {
    const acc = await walletAccount(f);
    const { o } = await one(msg(vf1({ amount: "240.00", receiving: acc.msisdn })));
    expect(o).toMatchObject({ state: "unmatched", suggestedCollectionId: null });
    const sale = await walletCart(f, 240, acc.id);
    const c = await creditRow(f, o.creditId!);
    expect(c.state).toBe("held");
    expect(c.hold_reason).toBe("unverified_format");
    expect(c.suggested_collection_id).toBe(sale.collectionIds[0]);
  });

  it("a credit matching an already manually-confirmed collection without a credit → attached as evidence", async () => {
    const acc = await walletAccount(f);
    const sale = await walletCart(f, 250, acc.id);
    const cid = sale.collectionIds[0]!;
    await confirmCollection(f.tenantId, cid, owner(), {});
    const { o } = await one(msg(vf1({ amount: "250.00", receiving: acc.msisdn })));
    expect(o.state).toBe("matched");
    const col = await collectionRow(f, cid);
    expect(col).toMatchObject({ status: "confirmed", matched_credit_id: o.creditId });
    expect((await eventsOf(f, cid)).some((e) => e.kind === "evidence_attached" && e.credit_id === o.creditId)).toBe(true);
  });

  it("one matching a rejected collection → held/matches_rejected, a note on it, ONE fan-out carrying rejectedCollectionId", async () => {
    const acc = await walletAccount(f);
    const sale = await walletCart(f, 260, acc.id);
    const cid = sale.collectionIds[0]!;
    await rejectCollection(f.tenantId, cid, owner(), { reason: "not_received" });
    const { o, effects } = await one(msg(vf1({ amount: "260.00", receiving: acc.msisdn })));
    expect(o).toMatchObject({ state: "held", holdReason: "matches_rejected", suggestedCollectionId: cid });
    expect(effects.notify).toHaveLength(1);
    expect(effects.notify[0]!.payload).toMatchObject({ creditId: o.creditId, holdReason: "matches_rejected", rejectedCollectionId: cid });
    expect((await eventsOf(f, cid)).some((e) => e.kind === "note" && e.details?.reason === "matches_rejected")).toBe(true);
  });

  it("N-match: with a pending candidate in the window, a rejected (or confirmed) older sale is not a late arrival (03 §C.8 step 10)", async () => {
    // Credit 60 min ago; the newer pending sale was rung now (60 min after the
    // credit: suggest window, not auto). The older sales of the same amount
    // were rung 200 min before the credit (inside the late-arrival window).
    const acc = await walletAccount(f);
    const at = new Date(Date.now() - 60 * 60_000);
    const back = new Date(at.getTime() - 200 * 60_000);
    const rejected = await walletCart(f, 275, acc.id, { customDate: back });
    await rejectCollection(f.tenantId, rejected.collectionIds[0]!, owner(), { reason: "not_received" });
    const confirmed = await walletCart(f, 275, acc.id, { customDate: back });
    await confirmCollection(f.tenantId, confirmed.collectionIds[0]!, owner(), {});
    const pending = await walletCart(f, 275, acc.id);
    const { o } = await one(msg(vf1({ amount: "275.00", receiving: acc.msisdn, at }), { receivedAt: at.toISOString() }));
    expect(o).toMatchObject({ state: "unmatched", suggestedCollectionId: pending.collectionIds[0] });
    expect(await collectionRow(f, confirmed.collectionIds[0]!)).toMatchObject({ status: "confirmed", matched_credit_id: null });
    expect((await eventsOf(f, rejected.collectionIds[0]!)).some((e) => e.kind === "note")).toBe(false);
    // Once that sale is decided by hand, the same kind of credit IS a late arrival again.
    await confirmCollection(f.tenantId, pending.collectionIds[0]!, owner(), {});
    const late = await one(msg(vf1({ amount: "275.00", receiving: acc.msisdn, at }), { receivedAt: at.toISOString() }));
    expect(late.o.state).toBe("matched");
  });

  it("an unmatched credit with no suggestion notifies once; a merge into it does not re-notify", async () => {
    const acc = await walletAccount(f);
    const body = vf1({ amount: "265.00", receiving: acc.msisdn });
    const a = await one(msg(body, { channel: "ios_sms" }));
    expect(a.o).toMatchObject({ state: "unmatched", suggestedCollectionId: null });
    expect(a.effects.notify).toHaveLength(1);
    const b = await one(msg(body, { channel: "ios_notification", sender: null, sourceApp: "ios.unknown" }));
    expect(b.o.creditId).toBe(a.o.creditId);
    expect(b.effects.notify).toHaveLength(0);
  });
});

describe.skipIf(!hasTestDb)("releaseCredits — sale_deleted (§4.15, acceptance 24)", () => {
  it("releases the matched credit (cause sale_deleted) and clears every sibling suggestion pointing at the collection", async () => {
    const acc = await walletAccount(f);
    const sale = await walletCart(f, 270, acc.id);
    const cid = sale.collectionIds[0]!;
    // A matched credit (manual evidence on a confirmed collection) and a sibling suggesting it.
    await confirmCollection(f.tenantId, cid, owner(), {});
    const matched = await one(msg(vf1({ amount: "270.00", receiving: acc.msisdn })));
    expect(matched.o.state).toBe("matched");
    const sib = await one(msg(vf1({ amount: "270.00", receiving: acc.msisdn })));
    await q(f, sql`UPDATE collection_credits SET state = 'held', hold_reason = 'ambiguous', suggested_collection_id = ${cid} WHERE id = ${sib.o.creditId}`);

    await withTenant(f.tenantId, (tx) => releaseCredits(tx, f.tenantId, [cid], "sale_deleted"));
    const c = await creditRow(f, matched.o.creditId!);
    expect(c).toMatchObject({ state: "unmatched", matched_collection_id: null, suggested_collection_id: null });
    expect((await collectionRow(f, cid)).matched_credit_id).toBeNull();
    expect((await creditRow(f, sib.o.creditId!)).suggested_collection_id).toBeNull();
    const notes = (await eventsOf(f, cid)).filter((e) => e.kind === "note" && e.details?.reason === "credit_released");
    expect(notes.map((n) => n.details?.cause)).toEqual(["sale_deleted"]);
  });
});

describe.skipIf(!hasTestDb)("device bookkeeping (§4.7 step 9; 13's silent contract)", () => {
  it("an accepted batch sets last_message_at and clears silent_alerted_at; last_credit_at only for a real credit", async () => {
    const d = await device(f, { label: "bookkeeping" });
    await q(f, sql`UPDATE collection_ingest_devices SET silent_alerted_at = now() - interval '1 hour' WHERE id = ${d.id}`);
    await ingestMessages(d.ctx, [msg("تم استلام مبلغ ما بلا تفاصيل", { sender: "SomeBank" })]);
    const [r1] = await q<{ last_message_at: string | null; silent_alerted_at: string | null; last_credit_at: string | null }>(
      f,
      sql`SELECT last_message_at, silent_alerted_at, last_credit_at FROM collection_ingest_devices WHERE id = ${d.id}`,
    );
    expect(r1!.last_message_at).not.toBeNull();
    expect(r1!.silent_alerted_at).toBeNull();
    expect(r1!.last_credit_at).toBeNull();
    const acc = await walletAccount(f);
    await ingestMessages(d.ctx, [msg(vf1({ amount: "280.00", receiving: acc.msisdn, reference: ref12() }))]);
    const [r2] = await q<{ last_credit_at: string | null }>(f, sql`SELECT last_credit_at FROM collection_ingest_devices WHERE id = ${d.id}`);
    expect(r2!.last_credit_at).not.toBeNull();
  });

  it("raw text is never stored in clear (body_enc is ciphertext of the purpose key)", async () => {
    const acc = await walletAccount(f);
    const m = msg(vf1({ amount: "290.00", receiving: acc.msisdn }));
    await ingestMessages(dev.ctx, [m]);
    const [raw] = await rawByFp(m.fp!);
    expect(raw!.body_enc).toMatch(/^v1:/);
    expect(raw!.body_enc).not.toContain("290");
    expect(encryptRawText("x")).toMatch(/^v1:/);
  });
});
