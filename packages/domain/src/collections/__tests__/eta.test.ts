// Run: npm test -w @matgary/domain
import { test } from "node:test";
import assert from "node:assert/strict";

import { ETA_PAYMENT_NUMBER_MAX, etaPaymentMethodCode } from "../eta";
import { PAYMENT_METHOD_VALUES } from "../types";

test("the five payment methods map to ETA codes (03 §B.1, D06-d)", () => {
  assert.equal(etaPaymentMethodCode("cash"), "C");
  assert.equal(etaPaymentMethodCode("card"), "V");
  assert.equal(etaPaymentMethodCode("instapay"), "O");
  assert.equal(etaPaymentMethodCode("wallet"), "O");
  assert.equal(etaPaymentMethodCode("deferred"), "O");
  for (const m of PAYMENT_METHOD_VALUES) assert.match(etaPaymentMethodCode(m), /^(C|V|CC|VC|VO|PR|GC|P|O)$/);
});

test("initial is not a payment method", () => {
  assert.throws(() => etaPaymentMethodCode("initial"), RangeError);
  assert.throws(() => etaPaymentMethodCode("vfcash" as never), RangeError);
});

test("paymentNumber max length", () => {
  assert.equal(ETA_PAYMENT_NUMBER_MAX, 50);
});
