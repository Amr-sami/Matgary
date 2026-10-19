/**
 * Digital collections — the web's pure rules (doc 15 spec 12 §4.2, §7).
 * components/collections/rules.ts: method grids, POS accounts, the transfer
 * draft (split / validate / wire options), inbox URL state, the four-eyes and
 * reopen gates, pills, the ledger timeline, and the account form; M2 (§5 step
 * 22): device health tones, the match / ignore / paste / raw / unrecognised
 * gates, and the credits tab URL.
 */
import { describe, expect, it } from "vitest";
import { DEVICE_HEALTH_VALUES } from "@matgary/domain/collections/types";
import type { PermissionPrincipal, Permission } from "@/lib/permissions";
import {
  EMPTY_TRANSFER,
  NO_FEATURES,
  accountIdentity,
  accountPatchBody,
  accountsForMethod,
  addPart,
  HEALTH_TONE_CLASS,
  canDecide,
  canMatch,
  cashRemainder,
  changedFields,
  collectionOptionsFromDraft,
  collectionsAccess,
  creditsAccess,
  defaultAccountFor,
  deviceHealthTone,
  defaultRejectOutcome,
  emptyAccountDraft,
  listQueryFor,
  methodsFor,
  parseInboxParams,
  pastedCount,
  pasteNotice,
  paymentEventView,
  pillTone,
  removePart,
  reopenAllowed,
  salePills,
  settleMethodsFor,
  splitDevices,
  startSplit,
  validateAccountDraft,
  validateTransfer,
  type AccountDraft,
  type AccountLike,
  type TransferDraft,
} from "@/components/collections/rules";

const BR = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

function acct(p: Partial<AccountLike> & Pick<AccountLike, "id" | "rail">): AccountLike {
  return {
    branchId: null,
    provider: p.rail === "instapay" ? "cib" : "vodafone_cash",
    label: p.id,
    ipaHandle: null,
    ipaLink: null,
    accountLast4: null,
    walletMsisdn: null,
    isPosDefault: false,
    sortOrder: 0,
    archivedAt: null,
    ...p,
  };
}

const cib = acct({ id: "cib", rail: "instapay", label: "CIB", ipaHandle: "amr@instapay", isPosDefault: true });
const nbe = acct({ id: "nbe", rail: "instapay", label: "NBE", accountLast4: "4821" });
const vf = acct({ id: "vf", rail: "wallet", label: "Vodafone", walletMsisdn: "+201012345678", isPosDefault: true });
const orange = acct({ id: "or", rail: "wallet", label: "Orange", walletMsisdn: "+201234567890" });
const archived = acct({ id: "old", rail: "wallet", label: "Old", archivedAt: "2026-09-01T00:00:00Z" });
const otherBranch = acct({ id: "ob", rail: "instapay", label: "Other", branchId: OTHER });
const thisBranch = acct({ id: "tb", rail: "wallet", label: "Branch wallet", branchId: BR, sortOrder: 5 });

const principal = (role: string, permissions: Permission[] = []): PermissionPrincipal => ({ role, permissions });

describe("methodsFor / settleMethodsFor", () => {
  it("adds wallet only when the feature is on, keeping today's order otherwise", () => {
    expect(methodsFor(false)).toEqual(["cash", "instapay", "card", "deferred"]);
    expect(methodsFor(true)).toEqual(["cash", "instapay", "wallet", "card", "deferred"]);
    expect(settleMethodsFor(false)).toEqual(["cash", "instapay", "card"]);
    expect(settleMethodsFor(true)).toEqual(["cash", "instapay", "wallet", "card"]);
  });
  it("NO_FEATURES is all false", () => {
    expect(Object.values(NO_FEATURES).every((v) => v === false)).toBe(true);
  });
});

describe("accountsForMethod", () => {
  const all = [orange, archived, nbe, otherBranch, vf, cib, thisBranch];
  it("hides archived and other-branch rows, keeps branchId null", () => {
    const ids = accountsForMethod(all, "instapay", BR).map((a) => a.id);
    expect(ids).not.toContain("old");
    expect(ids).not.toContain("ob");
    expect(ids).toContain("tb");
  });
  it("instapay lists the bank rail first, then wallets; each rail POS default, sortOrder, label", () => {
    expect(accountsForMethod(all, "instapay", BR).map((a) => a.id)).toEqual(["cib", "nbe", "vf", "or", "tb"]);
  });
  it("wallet lists wallets only", () => {
    expect(accountsForMethod(all, "wallet", BR).map((a) => a.id)).toEqual(["vf", "or", "tb"]);
  });
  it("non-digital methods list nothing", () => {
    expect(accountsForMethod(all, "cash", BR)).toEqual([]);
  });
});

describe("defaultAccountFor", () => {
  it("the POS default of the method's rail wins", () => {
    expect(defaultAccountFor([nbe, cib, vf], "instapay")?.id).toBe("cib");
    expect(defaultAccountFor([orange, vf], "wallet")?.id).toBe("vf");
  });
  it("else the only listed account", () => {
    expect(defaultAccountFor([orange], "wallet")?.id).toBe("or");
    expect(defaultAccountFor([nbe], "instapay")?.id).toBe("nbe");
  });
  it("else none", () => {
    expect(defaultAccountFor([nbe, orange], "instapay")).toBeNull();
    expect(defaultAccountFor([], "wallet")).toBeNull();
  });
});

describe("accountIdentity", () => {
  it("IPA handle, wallet number, last 4 — never the IBAN", () => {
    expect(accountIdentity(cib)).toBe("amr@instapay");
    expect(accountIdentity(vf)).toBe("010 1234 5678");
    expect(accountIdentity(nbe)).toBe("•••• 4821");
    const withIban = { ...acct({ id: "x", rail: "instapay" }), iban: "EG380019000500000000263180002" } as AccountLike;
    expect(accountIdentity(withIban)).toBe("");
    expect(accountIdentity(withIban)).not.toContain("EG38");
  });
});

describe("validateTransfer", () => {
  const base = { total: 150, listed: [cib, vf], accountsKnown: true, requireAccount: true };
  const draft = (p: Partial<TransferDraft> = {}): TransferDraft => ({ ...EMPTY_TRANSFER, parts: [], ...p });
  const codes = (r: ReturnType<typeof validateTransfer>) => r.errors.map((e) => e.code);

  it("non-digital methods never error", () => {
    expect(validateTransfer({ ...base, method: "cash", draft: draft() }).errors).toEqual([]);
  });
  it("account_required in single mode when required, known and listed", () => {
    expect(codes(validateTransfer({ ...base, method: "wallet", draft: draft() }))).toEqual(["account_required"]);
    expect(codes(validateTransfer({ ...base, method: "wallet", draft: draft({ accountId: "vf" }) }))).toEqual([]);
  });
  it("account_required is off when accounts are unknown, none are listed, or the branch does not require it", () => {
    expect(codes(validateTransfer({ ...base, method: "wallet", draft: draft(), accountsKnown: false }))).toEqual([]);
    expect(codes(validateTransfer({ ...base, method: "wallet", draft: draft(), listed: [] }))).toEqual([]);
    expect(codes(validateTransfer({ ...base, method: "wallet", draft: draft(), requireAccount: false }))).toEqual([]);
  });
  it("payer_last4_invalid and reference_invalid only for non-empty bad values", () => {
    const d = draft({ accountId: "vf", payerPhoneLast4: "12a", payerReference: "ab" });
    expect(codes(validateTransfer({ ...base, method: "wallet", draft: d }))).toEqual([
      "payer_last4_invalid",
      "reference_invalid",
    ]);
    const ok = draft({ accountId: "vf", payerPhoneLast4: "١٢٣٤", payerReference: "A1b2C3d4" });
    expect(codes(validateTransfer({ ...base, method: "wallet", draft: ok }))).toEqual([]);
  });
  it("part_amount_invalid, parts_exceed_total, too_many_parts", () => {
    const p = (amount: string) => ({ accountId: "vf", amount, payerPhoneLast4: "", payerReference: "" });
    expect(codes(validateTransfer({ ...base, method: "wallet", draft: draft({ parts: [p("0")] }) }))).toEqual([
      "part_amount_invalid",
    ]);
    expect(codes(validateTransfer({ ...base, method: "wallet", draft: draft({ parts: [p("100"), p("60")] }) }))).toEqual([
      "parts_exceed_total",
    ]);
    const five = draft({ parts: [p("10"), p("10"), p("10"), p("10"), p("10")] });
    expect(codes(validateTransfer({ ...base, method: "wallet", draft: five }))).toContain("too_many_parts");
  });
  it("a part without an account is always account_required (03 §B.17 accountId is required)", () => {
    const d = draft({ parts: [{ accountId: null, amount: "100", payerPhoneLast4: "", payerReference: "" }] });
    expect(validateTransfer({ ...base, method: "wallet", draft: d, requireAccount: false }).errors).toEqual([
      { code: "account_required", part: 1 },
    ]);
  });
  it("piaster rounding: 0.1 + 0.2 parts on a 0.30 total is valid", () => {
    const d = draft({
      parts: [
        { accountId: "vf", amount: "0.1", payerPhoneLast4: "", payerReference: "" },
        { accountId: "vf", amount: "0.2", payerPhoneLast4: "", payerReference: "" },
      ],
    });
    expect(validateTransfer({ ...base, total: 0.3, method: "wallet", draft: d }).errors).toEqual([]);
  });
  it("warns (never blocks) above EGP 70,000 on InstaPay", () => {
    const at = validateTransfer({ ...base, total: 70_000, method: "instapay", draft: draft({ accountId: "cib" }) });
    expect(at.warnings).toEqual([]);
    const over = validateTransfer({ ...base, total: 70_000.01, method: "instapay", draft: draft({ accountId: "cib" }) });
    expect(over.warnings).toEqual([{ code: "instapay_over_limit", part: null }]);
    expect(over.errors).toEqual([]);
    const wallet = validateTransfer({ ...base, total: 70_000.01, method: "wallet", draft: draft({ accountId: "vf" }) });
    expect(wallet.warnings).toEqual([]);
  });
});

describe("collectionOptionsFromDraft (08 §4.3)", () => {
  const single: TransferDraft = { accountId: "vf", payerPhoneLast4: "1234", payerReference: "Ab12", parts: [] };
  it("non-digital or feature off → {}", () => {
    expect(collectionOptionsFromDraft("cash", single, true)).toEqual({});
    expect(collectionOptionsFromDraft("deferred", single, true)).toEqual({});
    expect(collectionOptionsFromDraft("wallet", single, false)).toEqual({});
  });
  it("single with an account → collectionAccountId + payer fields", () => {
    expect(collectionOptionsFromDraft("wallet", single, true)).toEqual({
      collectionAccountId: "vf",
      payerPhoneLast4: "1234",
      payerReference: "Ab12",
    });
  });
  it("payer fields only when non-empty; no account → payer fields only", () => {
    expect(collectionOptionsFromDraft("instapay", { ...single, payerReference: "" }, true)).toEqual({
      collectionAccountId: "vf",
      payerPhoneLast4: "1234",
    });
    expect(collectionOptionsFromDraft("instapay", { ...single, accountId: null, payerReference: "  " }, true)).toEqual({
      payerPhoneLast4: "1234",
    });
    expect(collectionOptionsFromDraft("instapay", { ...EMPTY_TRANSFER, parts: [] }, true)).toEqual({});
  });
  it("parts → collectionParts only, amounts as numbers, null accountId omitted", () => {
    const d: TransferDraft = {
      ...single,
      parts: [
        { accountId: "cib", amount: "100.5", payerPhoneLast4: "", payerReference: "ref123" },
        { accountId: null, amount: "20", payerPhoneLast4: "9876", payerReference: "" },
      ],
    };
    expect(collectionOptionsFromDraft("instapay", d, true)).toEqual({
      collectionParts: [
        { accountId: "cib", amount: 100.5, payerReference: "ref123" },
        { amount: 20, payerPhoneLast4: "9876" },
      ],
    });
  });
});

describe("startSplit / addPart / removePart / cashRemainder", () => {
  const d0: TransferDraft = { accountId: "vf", payerPhoneLast4: "1234", payerReference: "", parts: [] };
  it("startSplit: part 1 takes the account, payer fields and the whole total", () => {
    const s = startSplit(d0, 150, "cib");
    expect(s.parts).toEqual([{ accountId: "vf", amount: "150", payerPhoneLast4: "1234", payerReference: "" }]);
    expect(startSplit({ ...d0, accountId: null }, 150, "cib").parts[0].accountId).toBe("cib");
  });
  it("addPart appends max(0, total − Σ) up to 4", () => {
    let s = startSplit(d0, 150, "cib");
    s = { ...s, parts: [{ ...s.parts[0], amount: "100" }] };
    s = addPart(s, 150, "cib");
    expect(s.parts[1]).toEqual({ accountId: "cib", amount: "50", payerPhoneLast4: "", payerReference: "" });
    s = addPart(s, 150, "cib");
    expect(s.parts[2].amount).toBe("0");
    s = addPart(s, 150, "cib");
    s = addPart(s, 150, "cib");
    expect(s.parts).toHaveLength(4);
  });
  it("addPart from single mode enters parts mode first", () => {
    const s = addPart(d0, 150, "cib");
    expect(s.parts).toHaveLength(2);
    expect(s.parts[0].amount).toBe("150");
  });
  it("removing down to one part equal to the total collapses to single mode", () => {
    let s = startSplit(d0, 150, "cib");
    s = { ...s, parts: [{ ...s.parts[0], accountId: "or" }] };
    s = addPart(s, 150, "cib");
    const back = removePart(s, 2, 150);
    expect(back.parts).toEqual([]);
    expect(back.accountId).toBe("or");
    expect(back.payerPhoneLast4).toBe("1234");
  });
  it("one remaining part below the total stays in parts mode", () => {
    let s = startSplit(d0, 150, "cib");
    s = { ...s, parts: [{ ...s.parts[0], amount: "100" }] };
    s = addPart(s, 150, "cib");
    const r = removePart(s, 2, 150);
    expect(r.parts).toHaveLength(1);
    expect(cashRemainder(150, r)).toBe(5000);
  });
  it("cashRemainder is 0 in single mode and never negative", () => {
    expect(cashRemainder(150, d0)).toBe(0);
    const over: TransferDraft = { ...d0, parts: [{ accountId: "vf", amount: "200", payerPhoneLast4: "", payerReference: "" }] };
    expect(cashRemainder(150, over)).toBe(0);
    const bad: TransferDraft = { ...d0, parts: [{ accountId: "vf", amount: "abc", payerPhoneLast4: "", payerReference: "" }] };
    expect(cashRemainder(150, bad)).toBe(15000);
  });
});

describe("parseInboxParams / listQueryFor", () => {
  const sp = (q: string) => new URLSearchParams(q);
  const now = new Date(2026, 8, 30, 12, 0, 0);
  it("defaults to pending and today", () => {
    const p = parseInboxParams(sp(""), false, { now });
    expect(p).toMatchObject({ tab: "pending", stale: false, invoice: null, id: null, date: "2026-09-30", allBranches: false });
  });
  it("status=pending and stale=1 (the 03 §B.6 links)", () => {
    expect(parseInboxParams(sp("status=pending"), false, { now }).tab).toBe("pending");
    const p = parseInboxParams(sp("status=pending&stale=1"), false, { now });
    expect(p.tab).toBe("pending");
    expect(p.stale).toBe(true);
    expect(parseInboxParams(sp("tab=totals"), false, { now }).tab).toBe("totals");
  });
  it("tab=credits needs ingest", () => {
    expect(parseInboxParams(sp("tab=credits"), false, { now }).tab).toBe("pending");
    expect(parseInboxParams(sp("tab=credits"), true, { now }).tab).toBe("credits");
  });
  it("invoice, id; bad date → today; unknown tab → pending", () => {
    const p = parseInboxParams(sp("invoice=INV-1&id=abc&date=2026-02-30&tab=nope"), false, { now });
    expect(p).toMatchObject({ tab: "pending", invoice: "INV-1", id: "abc", date: "2026-09-30" });
    expect(parseInboxParams(sp("date=2026-09-01"), false, { now }).date).toBe("2026-09-01");
  });
  it("branch=all is owner only", () => {
    expect(parseInboxParams(sp("branch=all"), false, { now, isOwner: false }).allBranches).toBe(false);
    expect(parseInboxParams(sp("branch=all"), false, { now, isOwner: true }).allBranches).toBe(true);
  });
  it("listQueryFor per tab", () => {
    const p = { stale: false, invoice: null, allBranches: false };
    expect(listQueryFor("pending", p)).toEqual({ status: "pending", order: "asc" });
    expect(listQueryFor("pending", { ...p, stale: true })).toEqual({ status: "pending", order: "asc", stale: true });
    expect(listQueryFor("confirmed", p)).toEqual({ status: "confirmed,auto_confirmed" });
    expect(listQueryFor("rejected", { ...p, invoice: "INV-9", allBranches: true })).toEqual({
      status: "rejected",
      invoiceId: "INV-9",
      branchId: "all",
    });
    expect(listQueryFor("totals", p)).toBeNull();
    expect(listQueryFor("credits", p)).toBeNull();
  });
});

describe("collectionsAccess (the §4.2 table)", () => {
  it("owner passes everything", () => {
    expect(collectionsAccess(principal("owner"), "u1")).toEqual({
      isOwner: true,
      userId: "u1",
      canView: true,
      canConfirm: true,
      canManage: true,
    });
  });
  it("view only → cannot confirm", () => {
    const a = collectionsAccess(principal("staff", ["view_collections"]), "u2");
    expect(a).toMatchObject({ canView: true, canConfirm: false, canManage: false, isOwner: false });
  });
  it("view + confirm → can confirm", () => {
    expect(collectionsAccess(principal("staff", ["view_collections", "confirm_collections"]), "u2").canConfirm).toBe(true);
  });
  it("confirm without view → canConfirm false", () => {
    expect(collectionsAccess(principal("staff", ["confirm_collections"]), "u2").canConfirm).toBe(false);
  });
  it("manage alone", () => {
    expect(collectionsAccess(principal("staff", ["manage_collection_accounts"]), "u2")).toMatchObject({
      canManage: true,
      canView: false,
    });
  });
  it("no permissions / null principal → all false", () => {
    const none = collectionsAccess(principal("staff", ["record_sales"]), "u3");
    expect([none.canView, none.canConfirm, none.canManage, none.isOwner]).toEqual([false, false, false, false]);
    const nul = collectionsAccess(null, null);
    expect([nul.canView, nul.canConfirm, nul.canManage, nul.isOwner]).toEqual([false, false, false, false]);
  });
});

describe("canDecide / reopenAllowed / defaultRejectOutcome", () => {
  const c = { status: "pending" as const, recordedBy: { id: "u1", name: "A" } };
  const owner = { isOwner: true, canConfirm: true, userId: "u1" };
  const staff = { isOwner: false, canConfirm: true, userId: "u1" };
  it("the owner may decide their own sale", () => {
    expect(canDecide(c, owner)).toEqual({ allowed: true, reason: null });
  });
  it("staff may not decide their own sale", () => {
    expect(canDecide(c, staff)).toEqual({ allowed: false, reason: "self" });
    expect(canDecide(c, { ...staff, userId: "u2" })).toEqual({ allowed: true, reason: null });
  });
  it("no key → permission; decided → status", () => {
    expect(canDecide(c, { ...staff, userId: "u2", canConfirm: false }).reason).toBe("permission");
    expect(canDecide({ ...c, status: "confirmed" as const }, owner).reason).toBe("status");
  });
  it("reopen within 7 days (−1 ms true, +1 ms false), owner only", () => {
    const decidedAt = "2026-09-01T10:00:00.000Z";
    const at = new Date(decidedAt).getTime() + 7 * 86_400_000;
    const d = { status: "confirmed" as const, decidedAt };
    expect(reopenAllowed(d, true, at - 1)).toBe(true);
    expect(reopenAllowed(d, true, at + 1)).toBe(false);
    expect(reopenAllowed(d, false, at - 1)).toBe(false);
    expect(reopenAllowed({ ...d, status: "pending" }, true, at - 1)).toBe(false);
    expect(reopenAllowed({ ...d, status: "rejected" }, true, at - 1)).toBe(true);
    expect(reopenAllowed({ ...d, status: "auto_confirmed" }, true, at - 1)).toBe(true);
  });
  it("defaultRejectOutcome: settlement → debt; phone → debt; else loss", () => {
    expect(defaultRejectOutcome({ sourceType: "settlement", customerPhone: null })).toBe("debt");
    expect(defaultRejectOutcome({ sourceType: "sale", customerPhone: "+201012345678" })).toBe("debt");
    expect(defaultRejectOutcome({ sourceType: "sale", customerPhone: null })).toBe("loss");
  });
});

describe("salePills / pillTone / paymentEventView", () => {
  it("salePills: deferred paid/unpaid × pending/confirmed/rejected/null", () => {
    for (const isPaid of [false, true]) {
      for (const cs of ["pending", "confirmed", "rejected", null] as const) {
        const p = salePills({ paymentMethod: "deferred", isPaid, collectionStatus: cs });
        expect(p.methodTone).toBe(isPaid ? "deferred_paid" : "deferred_unpaid");
        expect(p.collection).toBe(cs === "pending" || cs === "rejected" ? cs : null);
      }
    }
    expect(salePills({ paymentMethod: "wallet", isPaid: true, collectionStatus: "pending" })).toEqual({
      methodTone: "default",
      collection: "pending",
    });
  });
  it("pillTone", () => {
    expect(pillTone("pending")).toContain("orange");
    expect(pillTone("confirmed")).toContain("success");
    expect(pillTone("auto_confirmed")).toContain("success");
    expect(pillTone("rejected")).toContain("danger");
    expect(pillTone("void")).toContain("gray");
  });
  const labels = { methods: { cash: "Cash", instapay: "InstaPay", wallet: "Mobile wallet", card: "Card" }, initial: "Earlier payment" };
  it("labels: method, initial, unknown raw", () => {
    expect(paymentEventView({ method: "wallet" }, labels).label).toBe("Mobile wallet");
    expect(paymentEventView({ method: "initial" }, labels).label).toBe("Earlier payment");
    expect(paymentEventView({ method: "vfcash" }, labels).label).toBe("vfcash");
  });
  it("voided → struck + rejected; pending → pending pill", () => {
    expect(paymentEventView({ method: "wallet", voidedAt: "2026-09-30T10:00:00Z", collectionId: "c1" }, labels)).toEqual({
      label: "Mobile wallet",
      struck: true,
      pill: "rejected",
      collectionId: "c1",
    });
    expect(paymentEventView({ method: "instapay", collectionStatus: "pending", collectionId: "c2" }, labels)).toMatchObject({
      struck: false,
      pill: "pending",
    });
    expect(paymentEventView({ method: "cash", voidedAt: null }, labels)).toMatchObject({ struck: false, pill: null });
  });
});

describe("validateAccountDraft / changedFields", () => {
  const today = "2026-09-30";
  const ip = (p: Partial<AccountDraft>): AccountDraft => ({ ...emptyAccountDraft("instapay"), provider: "cib", label: "CIB", ...p });
  const wl = (p: Partial<AccountDraft>): AccountDraft => ({ ...emptyAccountDraft("wallet"), provider: "vodafone_cash", label: "VF", ...p });

  it("06's IBAN vector is valid; last digit 3 → fields.iban.checksum; bad shape → fields.iban.invalid", () => {
    const ok = validateAccountDraft(ip({ iban: "EG38 0019 0005 0000 0000 2631 8000 2" }), { includeL2: false, today });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.body.iban).toBe("EG380019000500000000263180002");
    const bad = validateAccountDraft(ip({ iban: "EG380019000500000000263180003" }), { includeL2: false, today });
    expect(bad).toEqual({ ok: false, errors: { iban: "fields.iban.checksum" } });
    const shape = validateAccountDraft(ip({ iban: "EG12" }), { includeL2: false, today });
    expect(shape).toEqual({ ok: false, errors: { iban: "fields.iban.invalid" } });
  });
  it("share text containing a link → the link and the derived handle", () => {
    const r = validateAccountDraft(
      ip({ ipaText: "Click the link to send money to amrstore@instapay https://ipn.eg/S/amrstore/instapay/Ab12Cd Powered by InstaPay" }),
      { includeL2: false, today },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.body.ipaLink).toBe("https://ipn.eg/S/amrstore/instapay/Ab12Cd");
      expect(r.body.ipaHandle).toBe("amrstore@instapay");
      expect(r.warnings).toEqual([]);
    }
    const bad = validateAccountDraft(ip({ ipaText: "https://ipn.eg.evil.com/S/x/instapay/1" }), { includeL2: false, today });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.ipa_link).toBe("fields.ipaLink.invalid");
  });
  it("InstaPay identity rule; missing link is a warning, not an error", () => {
    expect(validateAccountDraft(ip({}), { includeL2: false, today })).toEqual({
      ok: false,
      errors: { identity: "identityRequired" },
    });
    const last4 = validateAccountDraft(ip({ accountLast4: "٤٨٢١" }), { includeL2: false, today });
    expect(last4.ok).toBe(true);
    if (last4.ok) {
      expect(last4.body.accountLast4).toBe("4821");
      expect(last4.warnings).toEqual(["ipaLinkMissing"]);
    }
    const prepaid = validateAccountDraft(ip({ provider: "nbe", isPrepaidCard: true }), { includeL2: false, today });
    expect(prepaid.ok).toBe(true);
    const prepaidCib = validateAccountDraft(ip({ isPrepaidCard: true }), { includeL2: false, today });
    expect(prepaidCib.ok).toBe(false);
  });
  it("wallet numbers: 0101234567 (10 digits) invalid, 01012345678 → E.164", () => {
    expect(validateAccountDraft(wl({ walletMsisdn: "0101234567" }), { includeL2: false, today })).toEqual({
      ok: false,
      errors: { wallet_msisdn: "fields.walletMsisdn.invalid" },
    });
    const ok = validateAccountDraft(wl({ walletMsisdn: "010 1234 5678" }), { includeL2: false, today });
    expect(ok.ok && ok.body.walletMsisdn).toBe("+201012345678");
    if (ok.ok) {
      expect(ok.body.ipaLink).toBeNull();
      expect(ok.body.iban).toBeNull();
    }
  });
  it("label, provider/rail and holder-name rules", () => {
    const r = validateAccountDraft(wl({ provider: "cib", label: " ", holderName: "x".repeat(81), walletMsisdn: "01012345678" }), {
      includeL2: false,
      today,
    });
    expect(r).toEqual({
      ok: false,
      errors: { provider: "providerRequired", label: "labelRequired", holder_name: "holderNameTooLong" },
    });
    const long = validateAccountDraft(wl({ label: "x".repeat(61), walletMsisdn: "01012345678" }), { includeL2: false, today });
    expect(long.ok ? null : long.errors.label).toBe("labelTooLong");
  });
  it("L2 fields are dropped when includeL2 is false", () => {
    const d = wl({ walletMsisdn: "01012345678", autoConfirmEnabled: true, reviewThreshold: "3,000.50" });
    const off = validateAccountDraft(d, { includeL2: false, today });
    expect(off.ok && "autoConfirmEnabled" in off.body).toBe(false);
    expect(off.ok && "reviewThreshold" in off.body).toBe(false);
    const on = validateAccountDraft(d, { includeL2: true, today });
    expect(on.ok && on.body.autoConfirmEnabled).toBe(true);
    expect(on.ok && on.body.reviewThreshold).toBe(3000.5);
    const bad = validateAccountDraft({ ...d, reviewThreshold: "1.234" }, { includeL2: true, today });
    expect(bad.ok ? null : bad.errors.review_threshold).toBe("fields.reviewThreshold.invalid");
  });
  it("a future wallet opening date is not sent", () => {
    const r = validateAccountDraft(wl({ walletMsisdn: "01012345678", walletOpenedOn: "2026-10-01" }), { includeL2: false, today });
    expect(r.ok && r.body.walletOpenedOn).toBeNull();
    const ok = validateAccountDraft(wl({ walletMsisdn: "01012345678", walletOpenedOn: "2026-09-01" }), { includeL2: false, today });
    expect(ok.ok && ok.body.walletOpenedOn).toBe("2026-09-01");
  });
  it("changedFields returns only the differing keys", () => {
    expect(changedFields({ a: 1, b: "x", c: null }, { a: 1, b: "y", c: undefined, d: false })).toEqual({ b: "y", d: false });
  });
  it("accountPatchBody never sends rail, provider or the other rail's fields", () => {
    const before = wl({ walletMsisdn: "01012345678" });
    const after = { ...before, label: "VF 2", isPosDefault: true };
    const r = accountPatchBody(before, after, false, today);
    expect(r).toEqual({ ok: true, body: { label: "VF 2", isPosDefault: true }, warnings: [] });
  });
});

// ---------------------------------------------------------------------------
// M2 (12 §5 step 22)
// ---------------------------------------------------------------------------

describe("deviceHealthTone (07's six DeviceHealth values)", () => {
  it("maps every value as the §4.2 row says", () => {
    expect(deviceHealthTone("ok")).toBe("success");
    expect(deviceHealthTone("never_seen")).toBe("neutral");
    expect(deviceHealthTone("heartbeat_late")).toBe("warning");
    expect(deviceHealthTone("silent")).toBe("danger");
    expect(deviceHealthTone("listener_off")).toBe("danger");
    expect(deviceHealthTone("revoked")).toBe("neutral");
  });
  it("covers the whole union with a class (warning = the orange tone)", () => {
    expect(DEVICE_HEALTH_VALUES).toHaveLength(6);
    for (const h of DEVICE_HEALTH_VALUES) expect(HEALTH_TONE_CLASS[deviceHealthTone(h)]).toBeTruthy();
    expect(HEALTH_TONE_CLASS.warning).toBe("bg-orange-100 text-orange-700");
  });
});

describe("match / ignore / paste / raw / unrecognised (the §4.2 table, M2 rows)", () => {
  const owner = collectionsAccess(principal("owner"), "o1");
  const viewConfirm = collectionsAccess(principal("staff", ["view_collections", "confirm_collections"]), "s1");
  const viewOnly = collectionsAccess(principal("staff", ["view_collections"]), "s2");
  const confirmNoView = collectionsAccess(principal("staff", ["confirm_collections"]), "s3");
  const own = { selfRecorded: true };
  const other = { selfRecorded: false };

  it("owner matches every candidate, including a sale they recorded", () => {
    expect(canMatch(other, owner)).toBe(true);
    expect(canMatch(own, owner)).toBe(true);
  });
  it("view + confirm staff match others' sales but never their own (four-eyes)", () => {
    expect(canMatch(other, viewConfirm)).toBe(true);
    expect(canMatch(own, viewConfirm)).toBe(false);
  });
  it("view only and confirm-without-view never match", () => {
    expect(canMatch(other, viewOnly)).toBe(false);
    expect(canMatch(other, confirmNoView)).toBe(false);
  });
  it("paste / ignore follow canConfirm", () => {
    expect(creditsAccess(owner)).toMatchObject({ canPaste: true, canIgnore: true });
    expect(creditsAccess(viewConfirm)).toMatchObject({ canPaste: true, canIgnore: true });
    expect(creditsAccess(viewOnly)).toMatchObject({ canPaste: false, canIgnore: false });
    expect(creditsAccess(confirmNoView)).toMatchObject({ canPaste: false, canIgnore: false });
  });
  it("show message text and Unrecognised messages are owner only", () => {
    expect(creditsAccess(owner)).toMatchObject({ canShowRaw: true, canSeeUnrecognised: true });
    for (const who of [viewConfirm, viewOnly, confirmNoView]) {
      expect(creditsAccess(who)).toMatchObject({ canShowRaw: false, canSeeUnrecognised: false });
    }
    const nobody = collectionsAccess(null, null);
    expect(creditsAccess(nobody)).toEqual({ canPaste: false, canIgnore: false, canShowRaw: false, canSeeUnrecognised: false });
  });
  it("tab=credits renders with ingest on, falls back to pending with it off; credit= only with ingest", () => {
    const sp = new URLSearchParams("tab=credits&credit=c1");
    expect(parseInboxParams(sp, true)).toMatchObject({ tab: "credits", credit: "c1" });
    expect(parseInboxParams(sp, false)).toMatchObject({ tab: "pending", credit: null });
  });
});

describe("splitDevices / pastedCount", () => {
  it("live first, revoked apart, order kept", () => {
    const ds = [
      { id: "a", revokedAt: null },
      { id: "b", revokedAt: "2026-10-18T21:00:00Z" },
      { id: "c", revokedAt: null },
    ];
    const { live, revoked } = splitDevices(ds);
    expect(live.map((d) => d.id)).toEqual(["a", "c"]);
    expect(revoked.map((d) => d.id)).toEqual(["b"]);
  });
  it("counts accepted pieces that made a credit only", () => {
    expect(
      pastedCount([
        { status: "accepted", creditId: "c1" },
        { status: "duplicate", creditId: "c0" },
        { status: "dropped" },
        { status: "accepted", creditId: "c2" },
        { status: "accepted", creditId: null },
      ]),
    ).toBe(2);
    expect(pastedCount([])).toBe(0);
  });
  it("pasteNotice: 1 / 2 / 3–10 forms, base key past 10, and the nothing-new sentences", () => {
    const done = {
      pasted: "{n} base",
      pastedOne: "one",
      pastedTwo: "two",
      pastedFew: "{n} few",
      alreadyAdded: "already",
      notRecognised: "unknown",
      notCredit: "not credit",
    };
    const acc = (n: number) => Array.from({ length: n }, (_, i) => ({ status: "accepted", creditId: `c${i}` }));
    expect(pasteNotice(acc(1), done)).toBe("one");
    expect(pasteNotice(acc(2), done)).toBe("two");
    expect(pasteNotice(acc(3), done)).toBe("3 few");
    expect(pasteNotice(acc(10), done)).toBe("10 few");
    expect(pasteNotice(acc(12), done)).toBe("12 base");
    expect(pasteNotice(acc(1), { ...done, pastedOne: undefined })).toBe("1 base");
    expect(pasteNotice([{ status: "duplicate", creditId: "c1" }], done)).toBe("already");
    expect(pasteNotice([{ status: "accepted", creditId: null }], done)).toBe("unknown");
    expect(pasteNotice([{ status: "dropped" }], done)).toBe("not credit");
  });
});
