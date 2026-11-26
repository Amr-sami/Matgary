/**
 * Run:  node --test --experimental-strip-types apps/mobile/src/collections/__tests__/rules.test.ts
 *
 * `rules.ts` has type-only imports, so plain Node loads it. Cases: doc 15
 * spec 08 §7 (rules.test.ts row).
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
// prettier-ignore
// @ts-ignore TS5097 — explicit .ts extension required by `node --test`
import * as r from "../rules.ts";

const me = (isOwner: boolean, permissions: string[], id = "u1") => ({ isOwner, permissions, user: { id } }) as never;

test("collectionAccess: owner / view-only / view+confirm / confirm-without-view / none / me null", () => {
  const owner = r.collectionAccess(me(true, []));
  assert.equal(owner.isOwner, true);
  assert.equal(owner.canView && owner.canConfirm && owner.canManage, true);

  const viewOnly = r.collectionAccess(me(false, ["view_collections"]));
  assert.deepEqual([viewOnly.canView, viewOnly.canConfirm, viewOnly.canManage], [true, false, false]);

  const confirmer = r.collectionAccess(me(false, ["view_collections", "confirm_collections"]));
  assert.deepEqual([confirmer.canView, confirmer.canConfirm], [true, true]);

  // R8: confirm without view cannot act (the inbox and detail are unreachable).
  const confirmNoView = r.collectionAccess(me(false, ["confirm_collections"]));
  assert.deepEqual([confirmNoView.canView, confirmNoView.canConfirm], [false, false]);

  const cashier = r.collectionAccess(me(false, ["record_sales"]));
  assert.deepEqual([cashier.canView, cashier.canConfirm, cashier.canRecord], [false, false, true]);

  const nobody = r.collectionAccess(null);
  assert.deepEqual(nobody, {
    isOwner: false,
    userId: null,
    canView: false,
    canConfirm: false,
    canManage: false,
    canRecord: false,
  });
});

test("canDecide: self for a staff recorder, ok for an owner recorder, not_pending when decided", () => {
  const staff = r.collectionAccess(me(false, ["view_collections", "confirm_collections"], "s1"));
  const owner = r.collectionAccess(me(true, [], "o1"));
  const pending = (by: string | null) => ({ status: "pending" as const, recordedBy: by ? { id: by } : null });
  assert.equal(r.canDecide(staff, pending("s1")), "self");
  assert.equal(r.canDecide(staff, pending("s2")), "ok");
  assert.equal(r.canDecide(staff, pending(null)), "ok");
  assert.equal(r.canDecide(owner, pending("o1")), "ok");
  assert.equal(r.canDecide(owner, { status: "confirmed", recordedBy: null }), "not_pending");
  assert.equal(r.canDecide(r.collectionAccess(me(false, ["view_collections"])), pending("x")), "no_permission");
});

test("canReopen: owner at 6 d 23 h yes, at 7 d 1 min no; staff never; pending never", () => {
  const owner = { isOwner: true };
  const decidedAt = "2026-09-20T10:00:00.000Z";
  const at = (ms: number) => new Date(new Date(decidedAt).getTime() + ms);
  const H = 3_600_000;
  const c = { status: "rejected" as const, decidedAt };
  assert.equal(r.canReopen(owner, c, at(6 * 24 * H + 23 * H)), true);
  assert.equal(r.canReopen(owner, c, at(7 * 24 * H + 60_000)), false);
  assert.equal(r.canReopen({ isOwner: false }, c, at(H)), false);
  assert.equal(r.canReopen(owner, { status: "pending", decidedAt: null }, at(H)), false);
  assert.equal(r.canReopen(owner, { status: "auto_confirmed", decidedAt }, at(H)), true);
  assert.equal(r.canReopen(owner, { status: "void", decidedAt }, at(H)), false);
  assert.equal(r.reopenDeadline(c)?.toISOString(), "2026-09-27T10:00:00.000Z");
});

test("defaultRejectOutcome: phone → debt, none → loss, settlement → debt", () => {
  assert.equal(r.defaultRejectOutcome({ sourceType: "sale", customerPhone: "+201001234013" }), "debt");
  assert.equal(r.defaultRejectOutcome({ sourceType: "sale", customerPhone: null }), "loss");
  assert.equal(r.defaultRejectOutcome({ sourceType: "settlement", customerPhone: null }), "debt");
});

test("rejectNeedsPhone: debt on a phone-less sale only", () => {
  assert.equal(r.rejectNeedsPhone({ sourceType: "sale", customerPhone: null }, "debt"), true);
  assert.equal(r.rejectNeedsPhone({ sourceType: "sale", customerPhone: null }, "loss"), false);
  assert.equal(r.rejectNeedsPhone({ sourceType: "sale", customerPhone: "+201001234013" }, "debt"), false);
  assert.equal(r.rejectNeedsPhone({ sourceType: "settlement", customerPhone: null }, "debt"), false);
});

test("parseInboxParams: the 03 §B.6 web links", () => {
  assert.deepEqual(r.parseInboxParams({ status: "pending", stale: "1" }), { tab: "pending", staleOnly: true });
  assert.deepEqual(r.parseInboxParams({ status: "pending" }), { tab: "pending", staleOnly: false });
  assert.deepEqual(r.parseInboxParams({ tab: "credits" }, { collectionsIngest: false }), { tab: "pending", staleOnly: false });
  assert.deepEqual(r.parseInboxParams({ tab: "credits" }, { collectionsIngest: true }), { tab: "credits", staleOnly: false });
  assert.deepEqual(r.parseInboxParams({ tab: "totals", account: "a1", warning: "day_80" }), { tab: "totals", staleOnly: false });
  assert.deepEqual(r.parseInboxParams({ tab: ["rejected", "x"] }), { tab: "rejected", staleOnly: false });
  assert.deepEqual(r.parseInboxParams({ status: "confirmed" }), { tab: "confirmed", staleOnly: false });
  assert.deepEqual(r.parseInboxParams({ tab: "nope" }), { tab: "pending", staleOnly: false });
  assert.deepEqual(r.parseInboxParams(undefined), { tab: "pending", staleOnly: false });
  // stale wins over another tab: "late" only exists on Pending.
  assert.deepEqual(r.parseInboxParams({ tab: "totals", stale: "1" }), { tab: "pending", staleOnly: true });
});

test("inboxTabs + statusFilterFor", () => {
  assert.deepEqual(r.inboxTabs({ collectionsIngest: false }), ["pending", "confirmed", "rejected", "totals"]);
  assert.deepEqual(r.inboxTabs({ collectionsIngest: true }), ["pending", "credits", "confirmed", "rejected", "totals"]);
  assert.equal(r.statusFilterFor("confirmed"), "confirmed,auto_confirmed");
  assert.equal(r.statusFilterFor("pending"), "pending");
  assert.equal(r.statusFilterFor("rejected"), "rejected");
  assert.equal(r.statusFilterFor("totals"), null);
});

test("saleBadgeKind priority: returned → rejected → pending → unpaid → method", () => {
  assert.equal(r.saleBadgeKind({ isReturned: true, collectionStatus: "rejected", paymentMethod: "deferred" }), "returned");
  assert.equal(r.saleBadgeKind({ collectionStatus: "rejected", paymentMethod: "deferred", isPaid: false }), "rejected");
  assert.equal(r.saleBadgeKind({ collectionStatus: "pending", paymentMethod: "instapay", isPaid: true }), "pending");
  assert.equal(r.saleBadgeKind({ collectionStatus: null, paymentMethod: "deferred", isPaid: false }), "unpaid");
  assert.equal(r.saleBadgeKind({ collectionStatus: "confirmed", paymentMethod: "wallet", isPaid: true }), "method");
  assert.equal(r.saleBadgeKind({ paymentMethod: null }), null);
});

test("invoiceCollectionStatus: the first non-null line value", () => {
  assert.equal(r.invoiceCollectionStatus([{ collectionStatus: null }, { collectionStatus: "pending" }]), "pending");
  assert.equal(r.invoiceCollectionStatus([{}, {}]), null);
  assert.equal(r.invoiceCollectionStatus([]), null);
});

test("collectionErrorKey maps known codes only", () => {
  assert.equal(r.collectionErrorKey("SELF_CONFIRM_FORBIDDEN"), "app.collections.errors.SELF_CONFIRM_FORBIDDEN");
  assert.equal(r.collectionErrorKey("REOPEN_BLOCKED_SETTLED"), "app.collections.errors.REOPEN_BLOCKED_SETTLED");
  assert.equal(r.collectionErrorKey("SOMETHING_ELSE"), null);
  assert.equal(r.collectionErrorKey(null), null);
});

test("REJECT_REASONS and IGNORE_REASONS follow 03 §B.1 order", () => {
  assert.deepEqual([...r.REJECT_REASONS], ["not_received", "wrong_amount", "wrong_account", "duplicate", "other"]);
  assert.deepEqual([...r.IGNORE_REASONS], ["personal", "not_a_sale", "duplicate", "other"]);
});

// ─── M2 credits (spec 08 §4.11, order 21) ────────────────────────────────────

const acc = (isOwner: boolean, perms: string[], id = "u1") => r.collectionAccess(me(isOwner, perms, id));
const ON = { collections: true, collectionsIngest: true };

test("creditsAccess: tab with ingest + view; paste/ignore with confirm; Unrecognised owner only", () => {
  assert.deepEqual(r.creditsAccess(ON, acc(true, [])), { canList: true, canPaste: true, canIgnore: true, canSeeUnrecognised: true });
  assert.deepEqual(r.creditsAccess(ON, acc(false, ["view_collections"])), {
    canList: true,
    canPaste: false,
    canIgnore: false,
    canSeeUnrecognised: false,
  });
  const confirmer = r.creditsAccess(ON, acc(false, ["view_collections", "confirm_collections"]));
  assert.deepEqual([confirmer.canList, confirmer.canPaste, confirmer.canIgnore, confirmer.canSeeUnrecognised], [true, true, true, false]);
  // R8: confirm without view → nothing (the tab is unreachable).
  assert.equal(r.creditsAccess(ON, acc(false, ["confirm_collections"])).canPaste, false);
  // Ingest off (or collections off) → no tab even for the owner.
  assert.equal(r.creditsAccess({ collections: true, collectionsIngest: false }, acc(true, [])).canList, false);
  assert.equal(r.creditsAccess({ collections: false, collectionsIngest: true }, acc(true, [])).canSeeUnrecognised, false);
  assert.equal(r.creditsAccess(null, acc(true, [])).canList, false);
});

test("canMatchCandidate: four-eyes on the collection, owner exempt, open credits only", () => {
  const cand = (over: Record<string, unknown> = {}) =>
    ({ status: "pending", selfRecorded: false, recordedBy: { id: "u9", name: "x" }, ...over }) as never;
  const held = { state: "held" } as never;
  const staff = acc(false, ["view_collections", "confirm_collections"], "u1");
  assert.equal(r.canMatchCandidate(staff, held, cand()), "ok");
  assert.equal(r.canMatchCandidate(staff, held, cand({ selfRecorded: true })), "self");
  assert.equal(r.canMatchCandidate(staff, held, cand({ recordedBy: { id: "u1", name: "me" } })), "self");
  assert.equal(r.canMatchCandidate(acc(true, [], "u1"), held, cand({ selfRecorded: true })), "ok");
  assert.equal(r.canMatchCandidate(acc(false, ["view_collections"]), held, cand()), "no_permission");
  assert.equal(r.canMatchCandidate(staff, { state: "unmatched" } as never, cand()), "ok");
  assert.equal(r.canMatchCandidate(staff, { state: "matched" } as never, cand()), "not_open");
  assert.equal(r.canMatchCandidate(staff, { state: "ignored" } as never, cand()), "not_open");
  assert.equal(r.canMatchCandidate(staff, held, cand({ status: "confirmed" })), "not_pending");
});

test("candidateWarnings: amount in piasters, account only when both are known", () => {
  const credit = { amount: 0.3, account: { id: "a1" } } as never;
  assert.deepEqual(r.candidateWarnings(credit, { amount: 0.1 + 0.2, accountId: "a1" } as never), {
    amountDiffers: false,
    accountDiffers: false,
  });
  assert.deepEqual(r.candidateWarnings(credit, { amount: 0.31, accountId: "a2" } as never), {
    amountDiffers: true,
    accountDiffers: true,
  });
  assert.equal(r.candidateWarnings(credit, { amount: 0.3, accountId: null } as never).accountDiffers, false);
  assert.equal(r.candidateWarnings({ amount: 5, account: null } as never, { amount: 5, accountId: "a1" } as never).accountDiffers, false);
});

test("creditPayerText: full name, masked name, last 4, or null", () => {
  assert.equal(r.creditPayerText({ payerName: "Ahmed Mohamed", payerNameMasked: "AHMED M****", payerPhoneLast4: "1234" }), "Ahmed Mohamed");
  assert.equal(r.creditPayerText({ payerName: null, payerNameMasked: "AHMED M****", payerPhoneLast4: "1234" }), "AHMED M****");
  assert.equal(r.creditPayerText({ payerName: null, payerNameMasked: null, payerPhoneLast4: "1234" }), "•••• 1234");
  assert.equal(r.creditPayerText({ payerName: null, payerNameMasked: null, payerPhoneLast4: null }), null);
});

test("pasteOutcome: new credits counted apart from unknown-format, duplicates and drops", () => {
  const ok = { status: "accepted", creditId: "k1" } as const;
  const unk = { status: "accepted", reason: "unknown_format" } as const;
  const dup = { status: "duplicate", reason: "duplicate", creditId: "k0" } as const;
  const drop = { status: "dropped", reason: "not_credit" } as const;
  assert.deepEqual(r.pasteOutcome([ok]), { added: 1, duplicates: 0, unrecognised: 0, dropped: 0, notice: "added" });
  assert.deepEqual(r.pasteOutcome([ok, ok, dup, unk, drop]), { added: 2, duplicates: 1, unrecognised: 1, dropped: 1, notice: "added" });
  assert.equal(r.pasteOutcome([dup, unk]).notice, "already");
  assert.equal(r.pasteOutcome([unk, drop]).notice, "unrecognised");
  assert.equal(r.pasteOutcome([drop]).notice, "not_credit");
  assert.equal(r.pasteOutcome([]).notice, "not_credit");
});

test("OPEN_CREDIT_STATES is the 03 §B.4 comma list the credits tab asks for", () => {
  assert.equal(r.OPEN_CREDIT_STATES, "unmatched,held");
  assert.ok(r.KNOWN_COLLECTION_ERRORS.includes("CREDIT_ALREADY_MATCHED" as never));
  assert.ok(r.KNOWN_COLLECTION_ERRORS.includes("INGEST_PAYLOAD_TOO_LARGE" as never));
});
