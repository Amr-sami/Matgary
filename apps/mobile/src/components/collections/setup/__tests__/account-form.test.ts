/**
 * Run:  node --test --experimental-strip-types apps/mobile/src/components/collections/setup/__tests__/account-form.test.ts
 *
 * `account-form.ts` has type-only imports, so plain Node loads it. The rules
 * it takes are the REAL spec 06 validators (`packages/domain/src/collections/
 * ipa.ts` has no imports; `normalize.ts` only type imports), so these cases
 * also pin the phone to the exact functions behind the server's 400s
 * (INVALID_IPA_LINK / INVALID_IBAN / INVALID_WALLET_NUMBER). Cases: doc 15
 * spec 09 §7 (account-form.test.ts), adapted to 09 §4.5 "Reconciliation with
 * spec 06" (the IBAN and wallet rules come from 06).
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
// prettier-ignore
// @ts-ignore TS5097 — explicit .ts extension required by `node --test`
import * as f from "../account-form.ts";
// prettier-ignore
// @ts-ignore TS5097
import { ipaHandleFromLink, ipaLinkFromShareText, isValidIpaLink } from "../../../../../../../packages/domain/src/collections/ipa.ts";
// prettier-ignore
// @ts-ignore TS5097
import { normalizeIban, normalizeWalletMsisdn } from "../../../../../../../packages/domain/src/collections/normalize.ts";

const rules: f.AccountRules = { isValidIpaLink, ipaHandleFromLink, ipaLinkFromShareText, normalizeIban, normalizeWalletMsisdn };
const providers: f.ProviderRails = {
  nbe: { rail: "instapay" },
  cib: { rail: "instapay" },
  vodafone_cash: { rail: "wallet" },
};
const TODAY = "2026-09-30";
const opts = (over: Partial<f.ValidateOptions> = {}): f.ValidateOptions => ({ includeL2: false, today: TODAY, providers, ...over });

const LINK = "https://ipn.eg/S/shop/instapay/AbC123";
const SHARE = `Click the link to send money to shop@instapay ${LINK} Powered by InstaPay`;
const IBAN_OK = "EG380019000500000000263180002";

const instapay = (over: Partial<f.AccountDraft> = {}): f.AccountDraft => ({
  ...f.emptyDraft("instapay", null),
  provider: "cib",
  label: "CIB business",
  ...over,
});
const wallet = (over: Partial<f.AccountDraft> = {}): f.AccountDraft => ({
  ...f.emptyDraft("wallet", "b1"),
  provider: "vodafone_cash",
  label: "Vodafone",
  walletMsisdn: "01012345678",
  ...over,
});

function ok(r: f.ValidationResult): { body: Record<string, unknown>; warnings: string[] } {
  if (!r.ok) assert.fail(`expected ok, got ${JSON.stringify(r.errors)}`);
  return r;
}
function errs(r: f.ValidationResult): f.AccountErrors {
  if (r.ok) assert.fail(`expected errors, got ${JSON.stringify(r.body)}`);
  return r.errors;
}

// ─── asciiDigits ─────────────────────────────────────────────────────────────

test("asciiDigits: Arabic-Indic and extended Arabic-Indic digits", () => {
  assert.equal(f.asciiDigits("٠١٢٣٤٥٦٧٨٩"), "0123456789");
  assert.equal(f.asciiDigits("۱۲"), "12");
  assert.equal(f.asciiDigits("a1-٣"), "a1-3");
});

// ─── extractIpaLink ──────────────────────────────────────────────────────────

test("extractIpaLink: the full share text → the link; a bare link → the link", () => {
  assert.equal(f.extractIpaLink(SHARE, rules), LINK);
  assert.equal(f.extractIpaLink(LINK, rules), LINK);
  assert.equal(f.extractIpaLink(`  ${LINK}\n`, rules), LINK);
});

test("extractIpaLink: look-alikes and broken links → null", () => {
  assert.equal(f.extractIpaLink("http://ipn.eg/S/shop/instapay/AbC123", rules), null);
  assert.equal(f.extractIpaLink("https://ipn.eg.evil.com/S/a/instapay/b", rules), null);
  assert.equal(f.extractIpaLink("https://ipn.eg/S/a/instapay/", rules), null);
  assert.equal(f.extractIpaLink("no link here", rules), null);
  assert.equal(f.extractIpaLink("", rules), null);
});

test("extractIpaLink: two links → the first", () => {
  const second = "https://ipn.eg/S/other/instapay/Zz9";
  assert.equal(f.extractIpaLink(`${LINK} and ${second}`, rules), LINK);
});

// ─── IBAN (06 normalizeIban through the form) ────────────────────────────────

test("IBAN: the 06 vector is accepted; spaces and lower case are normalised", () => {
  assert.equal(ok(f.validateAccountDraft(instapay({ iban: IBAN_OK }), rules, opts())).body.iban, IBAN_OK);
  const spaced = "eg38 0019 0005 0000 0000 2631 8000 2";
  assert.equal(ok(f.validateAccountDraft(instapay({ iban: spaced }), rules, opts())).body.iban, IBAN_OK);
  assert.equal(ok(f.validateAccountDraft(instapay({ iban: "EG٣٨0019000500000000263180002" }), rules, opts())).body.iban, IBAN_OK);
});

test("IBAN: a changed check digit → checksum; wrong length → invalid", () => {
  const bad = IBAN_OK.slice(0, -1) + "3";
  assert.equal(errs(f.validateAccountDraft(instapay({ iban: bad }), rules, opts())).iban, "fields.iban.checksum");
  assert.equal(errs(f.validateAccountDraft(instapay({ iban: IBAN_OK + "1" }), rules, opts())).iban, "fields.iban.invalid");
  assert.equal(errs(f.validateAccountDraft(instapay({ iban: "GB38001900050000000026318000" }), rules, opts())).iban, "fields.iban.invalid");
});

// ─── validateAccountDraft: InstaPay ──────────────────────────────────────────

test("InstaPay: no identity → identityRequired", () => {
  assert.deepEqual(errs(f.validateAccountDraft(instapay(), rules, opts())), { identity: "identityRequired" });
});

test("InstaPay: link only (pasted share text) → ok, handle derived, no warning", () => {
  const r = ok(f.validateAccountDraft(instapay({ ipaText: SHARE }), rules, opts()));
  assert.equal(r.body.ipaLink, LINK);
  assert.equal(r.body.ipaHandle, "shop@instapay");
  assert.deepEqual(r.warnings, []);
});

test("InstaPay: last 4 only → ok with ipaLinkMissing; Arabic-Indic digits accepted", () => {
  const r = ok(f.validateAccountDraft(instapay({ accountLast4: "١٢٣٤" }), rules, opts()));
  assert.equal(r.body.accountLast4, "1234");
  assert.equal(r.body.ipaLink, null);
  assert.deepEqual(r.warnings, ["ipaLinkMissing"]);
});

test("InstaPay: a non-link paste → ipaLink invalid, and identityRequired is not stacked on it", () => {
  assert.deepEqual(errs(f.validateAccountDraft(instapay({ ipaText: "hello" }), rules, opts())), {
    ipa_link: "fields.ipaLink.invalid",
  });
  // With another identity the paste is still an error (never silently dropped).
  assert.equal(
    errs(f.validateAccountDraft(instapay({ ipaText: "hello", accountLast4: "1234" }), rules, opts())).ipa_link,
    "fields.ipaLink.invalid",
  );
});

test("InstaPay: is_prepaid_card only counts for NBE and is sent as false otherwise", () => {
  assert.deepEqual(errs(f.validateAccountDraft(instapay({ isPrepaidCard: true }), rules, opts())), {
    identity: "identityRequired",
  });
  const cib = ok(f.validateAccountDraft(instapay({ isPrepaidCard: true, accountLast4: "1234" }), rules, opts()));
  assert.equal(cib.body.isPrepaidCard, false);
  const nbe = ok(f.validateAccountDraft(instapay({ provider: "nbe", isPrepaidCard: true }), rules, opts()));
  assert.equal(nbe.body.isPrepaidCard, true);
});

test("InstaPay: accountLast4 '12a4' → invalid; a 61-char label → labelTooLong; 81-char holder → holderNameTooLong", () => {
  assert.equal(
    errs(f.validateAccountDraft(instapay({ accountLast4: "12a4" }), rules, opts())).account_last4,
    "fields.accountLast4.invalid",
  );
  assert.equal(
    errs(f.validateAccountDraft(instapay({ label: "x".repeat(61), accountLast4: "1234" }), rules, opts())).label,
    "labelTooLong",
  );
  assert.equal(
    errs(f.validateAccountDraft(instapay({ label: "   ", accountLast4: "1234" }), rules, opts())).label,
    "labelRequired",
  );
  assert.equal(
    errs(f.validateAccountDraft(instapay({ holderName: "y".repeat(81), accountLast4: "1234" }), rules, opts())).holder_name,
    "holderNameTooLong",
  );
});

test("InstaPay: provider missing or of the other rail → providerRequired", () => {
  assert.equal(errs(f.validateAccountDraft(instapay({ provider: "", accountLast4: "1234" }), rules, opts())).provider, "providerRequired");
  assert.equal(
    errs(f.validateAccountDraft(instapay({ provider: "vodafone_cash", accountLast4: "1234" }), rules, opts())).provider,
    "providerRequired",
  );
});

test("InstaPay: the wallet fields are null in the body", () => {
  const r = ok(f.validateAccountDraft(instapay({ ipaText: LINK, walletMsisdn: "01012345678" }), rules, opts()));
  assert.equal(r.body.walletMsisdn, null);
  assert.equal(r.body.walletOpenedOn, null);
  assert.equal(r.body.rail, "instapay");
  assert.equal(r.body.provider, "cib");
  assert.equal(r.body.holderName, null);
});

// ─── validateAccountDraft: wallet ────────────────────────────────────────────

test("wallet: every typed shape is stored as +2010XXXXXXXX", () => {
  for (const typed of ["010 1234 5678", "01012345678", "+201012345678", "0020 10 1234 5678", "٠١٠١٢٣٤٥٦٧٨"]) {
    assert.equal(ok(f.validateAccountDraft(wallet({ walletMsisdn: typed }), rules, opts())).body.walletMsisdn, "+201012345678", typed);
  }
});

test("wallet: 10 digits or a non-mobile prefix → invalid", () => {
  for (const typed of ["0101234567", "0131234567", "", "01312345678"]) {
    assert.equal(errs(f.validateAccountDraft(wallet({ walletMsisdn: typed }), rules, opts())).wallet_msisdn, "fields.walletMsisdn.invalid", typed);
  }
});

test("wallet: walletOpenedOn tomorrow or malformed → error; today → sent", () => {
  assert.equal(
    errs(f.validateAccountDraft(wallet({ walletOpenedOn: "2026-10-01" }), rules, opts())).wallet_opened_on,
    "fields.walletOpenedOn.invalid",
  );
  assert.equal(
    errs(f.validateAccountDraft(wallet({ walletOpenedOn: "2026-02-30" }), rules, opts())).wallet_opened_on,
    "fields.walletOpenedOn.invalid",
  );
  assert.equal(ok(f.validateAccountDraft(wallet({ walletOpenedOn: TODAY }), rules, opts())).body.walletOpenedOn, TODAY);
});

test("wallet: the InstaPay fields are null in the body", () => {
  const r = ok(f.validateAccountDraft(wallet({ ipaText: LINK, accountLast4: "1234", iban: IBAN_OK, isPrepaidCard: true }), rules, opts()));
  for (const k of ["ipaLink", "ipaHandle", "accountLast4", "iban", "isPrepaidCard", "isDefaultForMobile"]) {
    assert.equal(r.body[k], null, k);
  }
  assert.equal(r.body.branchId, "b1");
});

// ─── L2 fields ───────────────────────────────────────────────────────────────

test("L2: without includeL2 the body has no auto-confirm, threshold or balance-check field", () => {
  const r = ok(f.validateAccountDraft(wallet({ autoConfirmEnabled: true, reviewThreshold: "abc" }), rules, opts()));
  for (const k of ["autoConfirmEnabled", "reviewThreshold", "balanceCheckEnabled"]) assert.equal(k in r.body, false, k);
});

test("L2: thresholds — Arabic digits with the Arabic thousands separator, invalid forms", () => {
  const l2 = opts({ includeL2: true });
  assert.equal(ok(f.validateAccountDraft(wallet({ reviewThreshold: "٥٬٠٠٠" }), rules, l2)).body.reviewThreshold, 5000);
  assert.equal(ok(f.validateAccountDraft(wallet({ reviewThreshold: "5,000.50" }), rules, l2)).body.reviewThreshold, 5000.5);
  assert.equal(ok(f.validateAccountDraft(wallet({ reviewThreshold: "0" }), rules, l2)).body.reviewThreshold, 0);
  for (const bad of ["-1", "12.345", "1,00", "abc"]) {
    assert.equal(errs(f.validateAccountDraft(wallet({ reviewThreshold: bad }), rules, l2)).review_threshold, "fields.reviewThreshold.invalid", bad);
  }
  const r = ok(f.validateAccountDraft(wallet({ autoConfirmEnabled: true }), rules, l2));
  assert.equal(r.body.autoConfirmEnabled, true);
  assert.equal("reviewThreshold" in r.body, false); // empty → the server keeps its value
  assert.equal(r.body.balanceCheckEnabled, true);
  // balanceCheckEnabled is a wallet field only.
  assert.equal("balanceCheckEnabled" in ok(f.validateAccountDraft(instapay({ ipaText: LINK }), rules, l2)).body, false);
});

// ─── changedFields / patchBody / draftFromDto ────────────────────────────────

test("changedFields: unchanged → {}; a label change → {label} only", () => {
  const a = { label: "A", branchId: null, isPosDefault: false };
  assert.deepEqual(f.changedFields(a, { ...a }), {});
  assert.deepEqual(f.changedFields(a, { ...a, label: "B" }), { label: "B" });
  assert.deepEqual(f.changedFields({ x: undefined }, { x: null }), {});
});

const DTO: f.CollectionAccountLike = {
  rail: "instapay",
  provider: "cib",
  label: "CIB business",
  holderName: null,
  ipaHandle: "shop@instapay",
  ipaLink: LINK,
  accountLast4: "1234",
  isPrepaidCard: false,
  iban: null,
  walletMsisdn: null,
  walletOpenedOn: null,
  branchId: null,
  isPosDefault: true,
  isDefaultForMobile: false,
  autoConfirmEnabled: false,
  reviewThreshold: 5000,
  balanceCheckEnabled: true,
};

test("draftFromDto → patchBody: an unchanged edit sends nothing, a label edit sends only the label", () => {
  const before = f.draftFromDto(DTO);
  assert.deepEqual(ok(f.patchBody(before, { ...before }, rules, opts())).body, {});
  assert.deepEqual(ok(f.patchBody(before, { ...before, label: "CIB 2" }, rules, opts())).body, { label: "CIB 2" });
  // Never rail / provider, even if the draft were changed.
  assert.deepEqual(ok(f.patchBody(before, { ...before, provider: "nbe" }, rules, opts())).body, {});
  // Clearing the link sends ipaLink: null and keeps the stored handle.
  assert.deepEqual(ok(f.patchBody(before, { ...before, ipaText: "" }, rules, opts())).body, { ipaLink: null });
});

test("patchBody: a wallet edit never sends InstaPay fields; the stored number round-trips", () => {
  const before = f.draftFromDto({ ...DTO, rail: "wallet", provider: "vodafone_cash", ipaHandle: null, ipaLink: null, accountLast4: null, walletMsisdn: "+201012345678" });
  assert.equal(before.walletMsisdn, "01012345678");
  assert.deepEqual(ok(f.patchBody(before, { ...before }, rules, opts())).body, {});
  assert.deepEqual(ok(f.patchBody(before, { ...before, walletMsisdn: "01112345678", branchId: "b2" }, rules, opts())).body, {
    walletMsisdn: "+201112345678",
    branchId: "b2",
  });
  // An invalid edit is refused, not half-sent.
  assert.equal(errs(f.patchBody(before, { ...before, walletMsisdn: "0101" }, rules, opts())).wallet_msisdn, "fields.walletMsisdn.invalid");
});

test("staleMinutesFrom: integers 15..1440 only (Arabic-Indic digits allowed)", () => {
  assert.equal(f.staleMinutesFrom("90"), 90);
  assert.equal(f.staleMinutesFrom(" 15 "), 15);
  assert.equal(f.staleMinutesFrom("1440"), 1440);
  assert.equal(f.staleMinutesFrom("١٢٠"), 120);
  for (const bad of ["10", "14", "1441", "12.5", "-20", "", "abc", "99999"]) {
    assert.equal(f.staleMinutesFrom(bad), null, bad);
  }
});

test("parseThreshold and nationalWalletNumber", () => {
  assert.equal(f.parseThreshold("١٢٫٥"), 12.5);
  assert.equal(f.parseThreshold(""), null);
  assert.equal(f.nationalWalletNumber("+201012345678"), "01012345678");
  assert.equal(f.nationalWalletNumber(null), "");
});
