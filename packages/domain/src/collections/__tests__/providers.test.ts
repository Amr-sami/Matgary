// Run: npm test -w @matgary/domain
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COLLECTION_PROVIDERS,
  INSTAPAY_APP_PACKAGE,
  packagesForProviders,
  providerById,
  sendersForProviders,
} from "../providers";
import { COLLECTION_PROVIDER_VALUES, type CollectionProvider } from "../types";

// §B.1 grouping: the first eleven providers are banks (rail instapay), the
// rest are wallets.
const INSTAPAY_PROVIDERS = [
  "nbe", "cib", "qnb", "banque_misr", "bdc", "aaib", "alexbank", "hsbc", "faisal", "adib", "other_bank",
];

// SMS / MMS apps must never be listened to by the Play build (Q7).
const SMS_APP_PACKAGES = [
  "com.google.android.apps.messaging",
  "com.samsung.android.messaging",
  "com.android.mms",
  "com.android.messaging",
  "com.android.providers.telephony",
  "com.oneplus.mms",
  "com.miui.mms",
  "com.huawei.message",
  "com.textra",
  "com.p1.chompsms",
  "org.thoughtcrime.securesms",
];

const allPackages = (): string[] => [
  ...Object.values(COLLECTION_PROVIDERS).flatMap((p) => [...p.androidPackages]),
  INSTAPAY_APP_PACKAGE,
];

test("every CollectionProvider has an entry, keyed by its id, with the §B.1 rail", () => {
  assert.deepEqual(Object.keys(COLLECTION_PROVIDERS).sort(), [...COLLECTION_PROVIDER_VALUES].sort());
  for (const id of COLLECTION_PROVIDER_VALUES) {
    const p = COLLECTION_PROVIDERS[id];
    assert.equal(p.id, id);
    assert.equal(p.rail, INSTAPAY_PROVIDERS.includes(id) ? "instapay" : "wallet", id);
  }
});

test("labelKey is under the app.collections.vocab.providers subtree", () => {
  for (const id of COLLECTION_PROVIDER_VALUES) {
    assert.equal(COLLECTION_PROVIDERS[id].labelKey, `app.collections.vocab.providers.${id}`);
  }
});

test("package ids are well-formed", () => {
  const re = /^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/;
  for (const pkg of allPackages()) assert.ok(re.test(pkg), pkg);
});

test("no SMS-app package appears anywhere (Q7), the InstaPay app included", () => {
  for (const pkg of allPackages()) {
    assert.ok(!SMS_APP_PACKAGES.includes(pkg), `${pkg} is an SMS app`);
    assert.ok(!/(^|\.)(mms|sms|messaging|message)(\.|$)/i.test(pkg), `${pkg} looks like an SMS app`);
  }
  assert.equal(INSTAPAY_APP_PACKAGE, "com.egyptianbanks.instapay");
});

test("the Play-confirmed package ids of android.md §1.4", () => {
  const expected: Partial<Record<CollectionProvider, string[]>> = {
    nbe: ["com.ofss.obdx.and.nbe.com.eg"],
    cib: ["com.cibeg.ddc1.digitalbanking.live"],
    qnb: ["eg.com.qnb.eazymobile"],
    banque_misr: ["com.BanqueMisr.MobileBanking"],
    vodafone_cash: ["com.emeint.android.myservices"],
    etisalat_money: ["com.etisalat.flous"],
    orange_cash: ["com.orange.mobinilandme"],
    we_pay: ["com.TE.WEWallet"],
    nbe_phone_cash: ["com.emeint.android.mwallet"],
    bm_wallet: ["com.emeint.android.mwallet.bm"],
  };
  for (const id of COLLECTION_PROVIDER_VALUES) {
    assert.deepEqual([...COLLECTION_PROVIDERS[id].androidPackages], expected[id] ?? [], id);
  }
});

test("SMS sender ids are the published ones only, and never numeric", () => {
  assert.deepEqual([...COLLECTION_PROVIDERS.nbe.smsSenderIds], ["AHLY", "BanK-AlAhly", "Bank-Alahly"]);
  assert.deepEqual([...COLLECTION_PROVIDERS.cib.smsSenderIds], ["cib"]);
  assert.deepEqual([...COLLECTION_PROVIDERS.qnb.smsSenderIds], ["QNB EGYPT"]);
  assert.deepEqual([...COLLECTION_PROVIDERS.vodafone_cash.smsSenderIds], ["vf-cash"]);
  assert.deepEqual([...COLLECTION_PROVIDERS.etisalat_money.smsSenderIds], ["e& money"]);
  assert.deepEqual([...COLLECTION_PROVIDERS.orange_cash.smsSenderIds], ["Orange Cash", "OrangeCash", "اورنج كاش"]);
  for (const id of ["banque_misr", "bdc", "we_pay", "nbe_phone_cash", "bm_wallet", "other_bank", "other_wallet"] as const) {
    assert.deepEqual([...COLLECTION_PROVIDERS[id].smsSenderIds], [], id);
  }
  for (const p of Object.values(COLLECTION_PROVIDERS)) {
    for (const s of p.smsSenderIds) assert.ok(!/^[+\d\s-]+$/.test(s), `${p.id}: numeric sender ${s}`);
  }
});

test("balance caps as tabled (wallets only)", () => {
  assert.equal(COLLECTION_PROVIDERS.vodafone_cash.balanceCap, 100000);
  assert.equal(COLLECTION_PROVIDERS.nbe_phone_cash.balanceCap, 100000);
  assert.equal(COLLECTION_PROVIDERS.etisalat_money.balanceCap, 200000);
  assert.equal(COLLECTION_PROVIDERS.orange_cash.balanceCap, 200000);
  assert.equal(COLLECTION_PROVIDERS.we_pay.balanceCap, 200000);
  assert.equal(COLLECTION_PROVIDERS.bm_wallet.balanceCap, null);
  assert.equal(COLLECTION_PROVIDERS.other_wallet.balanceCap, null);
  for (const id of INSTAPAY_PROVIDERS) {
    assert.equal(COLLECTION_PROVIDERS[id as CollectionProvider].balanceCap, null, id);
  }
});

test("packagesForProviders adds the InstaPay app for an instapay rail; sorted and unique", () => {
  const pk = packagesForProviders(["vodafone_cash", "nbe"]);
  assert.ok(pk.includes(INSTAPAY_APP_PACKAGE));
  assert.ok(pk.includes("com.emeint.android.myservices"));
  assert.ok(pk.includes("com.ofss.obdx.and.nbe.com.eg"));
  assert.deepEqual(pk, [...pk].sort());
  assert.equal(new Set(pk).size, pk.length);

  const walletsOnly = packagesForProviders(["vodafone_cash", "orange_cash", "vodafone_cash"]);
  assert.ok(!walletsOnly.includes(INSTAPAY_APP_PACKAGE), "no InstaPay app without an instapay rail");
  assert.deepEqual(walletsOnly, ["com.emeint.android.myservices", "com.orange.mobinilandme"]);

  // A bank with no confirmed app still brings the InstaPay app.
  assert.deepEqual(packagesForProviders(["bdc"]), [INSTAPAY_APP_PACKAGE]);
  assert.deepEqual(packagesForProviders([]), []);
});

test("sendersForProviders is sorted and unique", () => {
  const s = sendersForProviders(["orange_cash", "nbe", "orange_cash", "we_pay"]);
  assert.deepEqual(s, [...s].sort());
  assert.equal(new Set(s).size, s.length);
  assert.deepEqual(new Set(s), new Set(["Orange Cash", "OrangeCash", "اورنج كاش", "AHLY", "BanK-AlAhly", "Bank-Alahly"]));
  assert.deepEqual(sendersForProviders(["bdc", "we_pay"]), []);
});

test("providerById", () => {
  assert.equal(providerById("cib")?.id, "cib");
  assert.equal(providerById("paymob"), null);
  assert.equal(providerById("toString"), null);
  assert.equal(providerById(""), null);
});
