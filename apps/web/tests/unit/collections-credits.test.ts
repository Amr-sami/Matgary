/**
 * Doc 15 spec 07 §7 — the credits inbox repo against a real database
 * (lib/repo/collection-credits.ts): match (four-eyes, evidence, baseline,
 * sibling suggestions), ignore, paste, the owner-only Unrecognised list +
 * share, list / detail DTOs and 05's `matchedCredit` hook. Skipped unless
 * DATABASE_URL names a `test` database; its own tenant.
 *
 * Covers acceptance 11 (a human match sets the baseline), 12 (detail
 * candidates), 15, 16, 17, 18 (repo half; the owner gate is the route's,
 * pinned in route-gates.test.ts), 21 (share expiry) and 27 (list envelope).
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isDomainError } from "@/lib/errors";
import { decryptRawText } from "@/lib/collections/raw-text";
import { ingestMessages } from "@/lib/repo/collection-ingest";
import {
  getCredit,
  ignoreCredit,
  listCredits,
  listUnrecognised,
  matchCredit,
  pasteCredits,
  shareUnrecognised,
  splitPaste,
  type CreditActor,
} from "@/lib/repo/collection-credits";
import { confirmCollection, getCollection, rejectCollection } from "@/lib/repo/collections";
import { sampleById } from "@matgary/domain/collections/__fixtures__/samples";
import {
  accountRow,
  collectionRow,
  creditRow,
  device,
  eventsOf,
  hasTestDb,
  msg,
  q,
  setBaseline,
  setupL2Tenant,
  vf1,
  walletAccount,
  walletCart,
  type L2Fixture,
} from "./helpers/collections-l2-fixture";

let f: L2Fixture;
let dev: Awaited<ReturnType<typeof device>>;
const savedEnv = { e: process.env.COLLECTIONS_ENABLED, i: process.env.COLLECTIONS_INGEST_ENABLED };

const owner = (): CreditActor => ({ userId: f.ownerId, isOwner: true, accessibleBranchIds: null });
const staff = (id: string): CreditActor => ({ userId: id, isOwner: false, accessibleBranchIds: [f.branchId] });

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return isDomainError(err) ? `${err.httpStatus}:${err.code}` : String(err);
  }
}

/** Ingest one VF-1-shaped credit and return its id. */
async function credit(accountMsisdn: string, amount: string, extra: { balance?: string; test?: boolean; at?: Date } = {}): Promise<string> {
  const m = msg(vf1({ amount, receiving: accountMsisdn, balance: extra.balance, at: extra.at }), {
    test: extra.test ?? false,
    ...(extra.at ? { receivedAt: extra.at.toISOString() } : {}),
  });
  await ingestMessages(dev.ctx, [m]);
  const [r] = await q<{ id: string }>(
    f,
    sql`SELECT c.id FROM collection_credits c JOIN collection_raw_messages r ON r.id = c.raw_message_id
         WHERE c.tenant_id = ${f.tenantId} AND r.client_fingerprint = ${m.fp}`,
  );
  return r!.id;
}

beforeAll(async () => {
  if (!hasTestDb) return;
  process.env.COLLECTIONS_ENABLED = "on";
  process.env.COLLECTIONS_INGEST_ENABLED = "on";
  f = await setupL2Tenant("cred");
  dev = await device(f, { label: "credits phone" });
});

afterAll(() => {
  if (savedEnv.e === undefined) delete process.env.COLLECTIONS_ENABLED;
  else process.env.COLLECTIONS_ENABLED = savedEnv.e;
  if (savedEnv.i === undefined) delete process.env.COLLECTIONS_INGEST_ENABLED;
  else process.env.COLLECTIONS_INGEST_ENABLED = savedEnv.i;
});

describe.skipIf(!hasTestDb)("matchCredit (§4.13; acceptance 16)", () => {
  it("staff on a collection they recorded → 403 SELF_CONFIRM_FORBIDDEN; another staff member → 200 confirmed; again → 409 CREDIT_ALREADY_MATCHED", async () => {
    const acc = await walletAccount(f);
    const sale = await walletCart(f, 300, acc.id, { by: f.staffA });
    const cid = sale.collectionIds[0]!;
    const crId = await credit(acc.msisdn, "300.00");
    expect(await codeOf(matchCredit(f.tenantId, staff(f.staffA), crId, cid))).toBe("403:SELF_CONFIRM_FORBIDDEN");
    const out = await matchCredit(f.tenantId, staff(f.staffB), crId, cid);
    expect(out.collection).toEqual({ id: cid, status: "confirmed" });
    expect(out.warnings).toEqual([]);
    expect(out.credit).toMatchObject({ id: crId, state: "matched", holdReason: null });
    expect(out.credit.matchedCollection?.id).toBe(cid);
    const col = await collectionRow(f, cid);
    expect(col).toMatchObject({ status: "confirmed", matched_credit_id: crId, decided_by_user_id: f.staffB });
    const ev = (await eventsOf(f, cid)).find((e) => e.kind === "matched")!;
    expect(ev).toMatchObject({ actor_user_id: f.staffB, credit_id: crId });
    const lines = await q<{ collection_status: string }>(f, sql`SELECT collection_status FROM sales WHERE tenant_id = ${f.tenantId} AND invoice_id = ${sale.invoiceId}`);
    expect(lines.every((l) => l.collection_status === "confirmed")).toBe(true);
    expect(await codeOf(matchCredit(f.tenantId, owner(), crId, cid))).toBe("409:CREDIT_ALREADY_MATCHED");
  });

  it("the owner is exempt from four-eyes; amount / account differences come back as warnings", async () => {
    const acc = await walletAccount(f);
    const other = await walletAccount(f);
    const sale = await walletCart(f, 310, other.id);
    const crId = await credit(acc.msisdn, "311.00");
    const out = await matchCredit(f.tenantId, owner(), crId, sale.collectionIds[0]!);
    expect(out.warnings.sort()).toEqual(["account_differs", "amount_differs"]);
  });

  it("a test or info credit → 409 CREDIT_NOT_MATCHABLE; a rejected collection → 409 COLLECTION_NOT_PENDING; unknown ids → 404", async () => {
    const acc = await walletAccount(f);
    const sale = await walletCart(f, 320, acc.id);
    const cid = sale.collectionIds[0]!;
    const testId = await credit(acc.msisdn, "320.00", { test: true });
    expect(await codeOf(matchCredit(f.tenantId, owner(), testId, cid))).toBe("409:CREDIT_NOT_MATCHABLE");
    const realId = await credit(acc.msisdn, "320.00");
    await q(f, sql`UPDATE collection_credits SET state = 'info' WHERE id = ${realId}`);
    expect(await codeOf(matchCredit(f.tenantId, owner(), realId, cid))).toBe("409:CREDIT_NOT_MATCHABLE");
    await q(f, sql`UPDATE collection_credits SET state = 'unmatched' WHERE id = ${realId}`);

    await rejectCollection(f.tenantId, cid, { userId: f.ownerId, isOwner: true, accessibleBranchIds: null }, { reason: "not_received" });
    expect(await codeOf(matchCredit(f.tenantId, owner(), realId, cid))).toBe("409:COLLECTION_NOT_PENDING");
    expect(await codeOf(matchCredit(f.tenantId, owner(), "99999999-9999-4999-8999-999999999999", cid))).toBe("404:CREDIT_NOT_FOUND");
    expect(await codeOf(matchCredit(f.tenantId, owner(), realId, "99999999-9999-4999-8999-999999999999"))).toBe("404:COLLECTION_NOT_FOUND");
  });

  it("a confirmed collection without a credit → the credit is attached as evidence (status unchanged)", async () => {
    const acc = await walletAccount(f);
    const sale = await walletCart(f, 330, acc.id);
    const cid = sale.collectionIds[0]!;
    await q(f, sql`UPDATE collections SET status = 'confirmed', decided_by_user_id = ${f.ownerId}, decided_at = now() WHERE id = ${cid}`);
    // Ingested AFTER the confirm, the pipeline itself attaches it; undo that to test the manual path.
    const crId = await credit(acc.msisdn, "330.00");
    await q(f, sql`UPDATE collections SET matched_credit_id = NULL WHERE id = ${cid}`);
    await q(f, sql`UPDATE collection_credits SET state = 'unmatched', matched_collection_id = NULL WHERE id = ${crId}`);
    const out = await matchCredit(f.tenantId, owner(), crId, cid);
    expect(out.collection.status).toBe("confirmed");
    expect((await collectionRow(f, cid)).matched_credit_id).toBe(crId);
    expect((await eventsOf(f, cid)).some((e) => e.kind === "evidence_attached" && e.actor_user_id === f.ownerId)).toBe(true);
  });

  it("a human match sets the baseline, forward in time only; other credits suggesting the collection are cleared (acceptance 11)", async () => {
    const acc = await walletAccount(f, { balanceCheck: true });
    const sale = await walletCart(f, 340, acc.id);
    const cid = sale.collectionIds[0]!;
    const crId = await credit(acc.msisdn, "340.00", { balance: "5340.00" });
    // No baseline yet; with the pending sale the gate's priority reads unverified_format first (06).
    expect((await creditRow(f, crId)).hold_reason).toBe("unverified_format");
    expect((await accountRow(f, acc.id)).balance_baseline).toBeNull();
    const sib = await credit(acc.msisdn, "340.00", { balance: "5680.00" });
    await q(f, sql`UPDATE collection_credits SET suggested_collection_id = ${cid}, state = 'held', hold_reason = 'ambiguous' WHERE id = ${sib}`);

    await matchCredit(f.tenantId, owner(), crId, cid);
    expect((await accountRow(f, acc.id)).balance_baseline).toBe("5340.00");
    expect((await creditRow(f, sib)).suggested_collection_id).toBeNull();

    // An OLDER credit matched later never moves the baseline backwards.
    const sale2 = await walletCart(f, 341, acc.id);
    const old = await credit(acc.msisdn, "341.00", { balance: "1.00", at: new Date(Date.now() - 3 * 3_600_000) });
    await setBaseline(f, acc.id, "5340.00", new Date());
    await matchCredit(f.tenantId, owner(), old, sale2.collectionIds[0]!);
    expect((await accountRow(f, acc.id)).balance_baseline).toBe("5340.00");
  });

  it("05's CollectionDTO.matchedCredit is filled from the linked credit (07 §4.3 hook)", async () => {
    const acc = await walletAccount(f);
    const sale = await walletCart(f, 350, acc.id);
    const cid = sale.collectionIds[0]!;
    const crId = await credit(acc.msisdn, "350.00");
    await matchCredit(f.tenantId, owner(), crId, cid);
    const dto = await getCollection(f.tenantId, cid, { accessibleBranchIds: null, includeSnapshots: false });
    const mc = dto!.matchedCredit;
    expect(mc?.id).toBe(crId);
    expect(mc?.amount).toBe(350);
  });
});

describe.skipIf(!hasTestDb)("ignoreCredit (§4.13)", () => {
  it("`personal` moves the baseline; `other` does not; a matched credit → 409", async () => {
    const acc = await walletAccount(f, { balanceCheck: true });
    const a = await credit(acc.msisdn, "360.00", { balance: "7000.00" });
    const dto = await ignoreCredit(f.tenantId, owner(), a, { reason: "personal" });
    expect(dto).toMatchObject({ state: "ignored", ignoredReason: "personal" });
    expect((await accountRow(f, acc.id)).balance_baseline).toBe("7000.00");

    const b = await credit(acc.msisdn, "361.00", { balance: "9999.00" });
    await ignoreCredit(f.tenantId, owner(), b, { reason: "other" });
    expect((await accountRow(f, acc.id)).balance_baseline).toBe("7000.00");

    const sale = await walletCart(f, 362, acc.id);
    const c = await credit(acc.msisdn, "362.00", { balance: "7362.00" });
    await matchCredit(f.tenantId, owner(), c, sale.collectionIds[0]!);
    expect(await codeOf(ignoreCredit(f.tenantId, owner(), c, { reason: "duplicate" }))).toBe("409:CREDIT_ALREADY_MATCHED");
  });
});

describe.skipIf(!hasTestDb)("pasteCredits (§4.13; acceptance 17)", () => {
  it("splits on blank lines; three fixtures → three results; none auto-confirms or notifies; the gate says manual_source", async () => {
    const acc = await walletAccount(f);
    const sale = await walletCart(f, 370, acc.id);
    const text = [vf1({ amount: "370.00", receiving: acc.msisdn }), vf1({ amount: "371.00", receiving: acc.msisdn }), sampleById("ZYNK-CARD")!.text].join("\n\n");
    expect(splitPaste(text)).toHaveLength(3);
    const out = await pasteCredits(f.tenantId, owner(), { text, sender: null });
    expect(out.results.map((r) => r.index)).toEqual([0, 1, 2]);
    expect(out.results[0]).toMatchObject({ status: "accepted", reason: "parsed", state: "held", holdReason: "manual_source", suggestedCollectionId: sale.collectionIds[0] });
    expect(out.results[2]).toMatchObject({ status: "dropped", reason: "not_credit" });
    expect((await collectionRow(f, sale.collectionIds[0]!)).status).toBe("pending");
    const raw = await q<{ sender_kind: string; ingest_device_id: string | null; client_fingerprint: string | null }>(
      f,
      sql`SELECT r.sender_kind, r.ingest_device_id, r.client_fingerprint FROM collection_credits c JOIN collection_raw_messages r ON r.id = c.raw_message_id WHERE c.id = ${out.results[0]!.creditId}`,
    );
    expect(raw[0]).toMatchObject({ sender_kind: "numeric", ingest_device_id: null });
    expect(raw[0]!.client_fingerprint).toBeTruthy();
  });

  it("W1: a held credit stops suggesting a sale once that sale is confirmed by hand", async () => {
    const acc = await walletAccount(f);
    const sale = await walletCart(f, 390, acc.id);
    const out = await pasteCredits(f.tenantId, owner(), { text: vf1({ amount: "390.00", receiving: acc.msisdn }), sender: null });
    const creditId = out.results[0]!.creditId!;
    expect((await getCredit(f.tenantId, creditId, { userId: f.ownerId, accessibleBranchIds: null, includeRaw: false }))!.suggestedCollection?.id).toBe(sale.collectionIds[0]);
    await confirmCollection(f.tenantId, sale.collectionIds[0]!, owner(), { note: null });
    const after = (await getCredit(f.tenantId, creditId, { userId: f.ownerId, accessibleBranchIds: null, includeRaw: false }))!;
    expect(after.state).toBe("held");
    expect(after.suggestedCollection).toBeNull();
  });

  it("a pasted copy of an already-ingested credit → duplicate with the same creditId (unchanged)", async () => {
    const acc = await walletAccount(f);
    const body = vf1({ amount: "380.00", receiving: acc.msisdn });
    await ingestMessages(dev.ctx, [msg(body)]);
    const [orig] = await q<{ id: string; seen_count: number }>(
      f,
      sql`SELECT id, seen_count FROM collection_credits WHERE tenant_id = ${f.tenantId} AND collection_account_id = ${acc.id}`,
    );
    const out = await pasteCredits(f.tenantId, owner(), { text: body });
    expect(out.results[0]).toMatchObject({ status: "duplicate", creditId: orig!.id });
    expect((await creditRow(f, orig!.id)).seen_count).toBe(orig!.seen_count);
  });

  it("`accountId` forces the routing; an unknown account → 404; 21 pieces → 413", async () => {
    const acc = await walletAccount(f);
    const out = await pasteCredits(f.tenantId, owner(), { text: "تم استلام مبلغ 390.00 جنيه", accountId: acc.id });
    expect(out.results[0]).toMatchObject({ status: "accepted", reason: "fallback" });
    expect((await creditRow(f, out.results[0]!.creditId!)).collection_account_id).toBe(acc.id);
    expect(await codeOf(pasteCredits(f.tenantId, owner(), { text: "x", accountId: "99999999-9999-4999-8999-999999999999" }))).toBe(
      "404:COLLECTION_ACCOUNT_NOT_FOUND",
    );
    const many = Array.from({ length: 21 }, (_, i) => `تم استلام مبلغ ${i + 1}.00 جنيه`).join("\n\n");
    expect(await codeOf(pasteCredits(f.tenantId, owner(), { text: many }))).toBe("413:INGEST_PAYLOAD_TOO_LARGE");
  });
});

describe.skipIf(!hasTestDb)("list / detail (§4.5, §4.6; acceptance 12, 27)", () => {
  it("list answers the house envelope {data, nextCursor}, excludes test credits, filters by state, pages by cursor", async () => {
    const acc = await walletAccount(f);
    const ids = [await credit(acc.msisdn, "400.00"), await credit(acc.msisdn, "401.00"), await credit(acc.msisdn, "402.00")];
    const testId = await credit(acc.msisdn, "403.00", { test: true });
    const page1 = await listCredits(f.tenantId, { branchId: f.branchId, accountId: acc.id, limit: 2, viewerUserId: f.ownerId });
    expect(Object.keys(page1).sort()).toEqual(["data", "nextCursor"]);
    expect(page1.data).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await listCredits(f.tenantId, { branchId: f.branchId, accountId: acc.id, limit: 2, cursor: page1.nextCursor, viewerUserId: f.ownerId });
    const all = [...page1.data, ...page2.data].map((c) => c.id);
    expect(all.sort()).toEqual([...ids].sort());
    expect(all).not.toContain(testId);
    const unmatched = await listCredits(f.tenantId, { branchId: null, states: ["unmatched"], accountId: acc.id, viewerUserId: f.ownerId });
    expect(unmatched.data.every((c) => c.state === "unmatched")).toBe(true);
    const c0 = page1.data[0]!;
    expect(c0.account?.id).toBe(acc.id);
    expect(c0.account?.mask).toBeTruthy();
    expect(c0.payerNameMasked).toBe("محمد ا****");
    expect(c0.payerName).toBeNull();
    expect(c0.templateStatus).toBe("published_sample");
    expect(c0.device).toEqual({ id: dev.id, label: "credits phone" });
  });

  it("an ambiguous credit's detail lists both candidates; the four-eyes hint marks the viewer's own sale", async () => {
    const acc = await walletAccount(f);
    const s1 = await walletCart(f, 410, acc.id, { by: f.staffA });
    const s2 = await walletCart(f, 410, acc.id);
    const crId = await credit(acc.msisdn, "410.00");
    expect((await creditRow(f, crId)).hold_reason).toBe("ambiguous");
    const d = await getCredit(f.tenantId, crId, { userId: f.staffA, accessibleBranchIds: [f.branchId], includeRaw: false });
    const cand = d!.candidates.map((c) => c.id).sort();
    expect(cand).toEqual([s1.collectionIds[0], s2.collectionIds[0]].sort());
    expect(d!.candidates.find((c) => c.id === s1.collectionIds[0])!.selfRecorded).toBe(true);
    expect(d!.candidates.find((c) => c.id === s2.collectionIds[0])!.selfRecorded).toBe(false);
    expect(d!.raw).toBeNull();
  });

  it("includeRaw returns the decrypted message", async () => {
    const acc = await walletAccount(f);
    const crId = await credit(acc.msisdn, "420.00");
    const d = await getCredit(f.tenantId, crId, { userId: f.ownerId, accessibleBranchIds: null, includeRaw: true });
    expect(d!.raw?.body).toContain("420.00");
  });
});

describe.skipIf(!hasTestDb)("Unrecognised list + share (§4.10; acceptance 18, 21)", () => {
  it("lists unknown-format / fallback rows decrypted, newest first; share is idempotent with a 90-day expiry", async () => {
    const m1 = msg("تم استلام مبلغ ما من بنك جديد", { sender: "NewBank" });
    const m2 = msg("تم استلام مبلغ ما من بنك آخر", { sender: "OtherBank", title: "عنوان", subtitle: "فرعي" });
    await ingestMessages(dev.ctx, [m1]);
    await ingestMessages(dev.ctx, [m2]);
    const page = await listUnrecognised(f.tenantId, { limit: 100 });
    expect(Object.keys(page).sort()).toEqual(["data", "nextCursor"]);
    const a = page.data.find((d) => d.body === m2.body)!;
    const b = page.data.find((d) => d.body === m1.body)!;
    expect(a).toMatchObject({ parseStatus: "unknown_format", title: "عنوان", subtitle: "فرعي", sender: "OtherBank", sharedAt: null });
    expect(page.data.indexOf(a)).toBeLessThan(page.data.indexOf(b));
    expect(a.device).toEqual({ id: dev.id, label: "credits phone" });

    const s1 = await shareUnrecognised(f.tenantId, f.ownerId, a.id);
    expect(s1.firstShare).toBe(true);
    expect((Date.parse(s1.expiresAt) - Date.parse(s1.sharedAt)) / 86_400_000).toBeCloseTo(90, 3);
    const s2 = await shareUnrecognised(f.tenantId, f.ownerId, a.id);
    expect(s2.firstShare).toBe(false);
    expect(s2.sharedAt).toBe(s1.sharedAt);
    expect(s2.expiresAt).toBe(s1.expiresAt);
    expect(await codeOf(shareUnrecognised(f.tenantId, f.ownerId, "99999999-9999-4999-8999-999999999999"))).toBe("404:NOT_FOUND");
    // The stored text stays encrypted.
    const [row] = await q<{ body_enc: string }>(f, sql`SELECT body_enc FROM collection_raw_messages WHERE id = ${a.id}`);
    expect(row!.body_enc).toMatch(/^v1:/);
    expect(decryptRawText(row!.body_enc)).toBe(m2.body);
  });
});
