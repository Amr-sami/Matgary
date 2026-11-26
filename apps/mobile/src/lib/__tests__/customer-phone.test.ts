/**
 * Run:  node --test --experimental-strip-types apps/mobile/src/lib/__tests__/customer-phone.test.ts
 *
 * `customer-phone.ts` imports nothing, so plain Node loads it. The shapes below
 * are the ones a `/customers/[phone]` param has actually been seen in: an
 * in-app push (decoded once), a custom-scheme deep link (not decoded),
 * a double-encoded "+", and the "+"-became-a-space variant.
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
// prettier-ignore
// @ts-ignore TS5097 — explicit .ts extension required by `node --test`
import { customerPhoneParam, customerRoute, decodeRouteParam, toE164 } from "../customer-phone.ts";

const E164 = "+201001234013";

test("decodeRouteParam: no escapes → untouched", () => {
  assert.equal(decodeRouteParam(E164), E164);
  assert.equal(decodeRouteParam("01001234013"), "01001234013");
});

test("decodeRouteParam: decodes once, twice, and stops when stable", () => {
  assert.equal(decodeRouteParam("%2B201001234013"), E164);
  assert.equal(decodeRouteParam("%252B201001234013"), E164);
  assert.equal(decodeRouteParam("%25252B201001234013"), E164);
});

test("decodeRouteParam: array params take the first, empty and missing are ''", () => {
  assert.equal(decodeRouteParam(["%2B201001234013", "x"]), E164);
  assert.equal(decodeRouteParam(undefined), "");
  assert.equal(decodeRouteParam(null), "");
  assert.equal(decodeRouteParam([]), "");
});

test("decodeRouteParam: a malformed escape never throws", () => {
  assert.equal(decodeRouteParam("%E0%A4%A"), "%E0%A4%A");
  assert.equal(decodeRouteParam("%2B2010%ZZ"), "%2B2010%ZZ");
});

test("toE164: every stored shape of one Egyptian mobile", () => {
  for (const input of [
    "+201001234013",
    "201001234013",
    "01001234013",
    "0020 100 123 4013",
    "+20 (100) 123-4013",
    " 201001234013", // "+" mangled into a space
    "٠١٠٠١٢٣٤٠١٣", // Arabic-Indic digits
    "1001234013",
  ]) {
    assert.equal(toE164(input), E164, input);
  }
});

test("toE164: rejects what is not an Egyptian mobile", () => {
  assert.equal(toE164(""), null);
  assert.equal(toE164("   "), null);
  assert.equal(toE164(null), null);
  assert.equal(toE164(undefined), null);
  assert.equal(toE164("abc"), null);
  assert.equal(toE164("+2010012340"), null); // too short
  assert.equal(toE164("+2013001234013"), null); // 13 is not an operator prefix
  assert.equal(toE164("+14155552671"), null); // not Egypt
  assert.equal(toE164("+2010012340130"), null); // too long
});

test("customerPhoneParam: deep-link shapes all land on the same E.164", () => {
  for (const param of [
    E164,
    "%2B201001234013",
    "%252B201001234013",
    " 201001234013",
    "%20201001234013",
    "201001234013",
    "01001234013",
    ["%2B201001234013"],
  ]) {
    assert.equal(customerPhoneParam(param), E164, JSON.stringify(param));
  }
});

test("customerPhoneParam: a non-number falls back to the decoded, trimmed param", () => {
  assert.equal(customerPhoneParam("%20abc%20"), "abc");
  assert.equal(customerPhoneParam("+14155552671"), "+14155552671");
  assert.equal(customerPhoneParam(undefined), "");
});

test("customerRoute: normalises then encodes so '+' survives the URL", () => {
  const route = customerRoute("01001234013");
  assert.equal(route, "/customers/%2B201001234013");
  assert.equal(customerRoute(E164), route);
  assert.equal(customerRoute(" 201001234013"), route);
  // What the screen reads back is the same key the list pushed.
  assert.equal(customerPhoneParam(route.slice("/customers/".length)), E164);
});

test("customerRoute: an unknown shape is still a safe path segment", () => {
  assert.equal(customerRoute("+14155552671"), "/customers/%2B14155552671");
  assert.equal(customerRoute("a/b"), "/customers/a%2Fb");
});
