/**
 * Run:  node --test --experimental-strip-types apps/mobile/src/offline/__tests__/branch-mismatch.test.ts
 *
 * Pins BRANCH_MISMATCH_RE to the sentence the cart route actually sends. The
 * route has no machine code for this 409, so the sync screen's "switch branch
 * and retry" copy depends on this regex matching the server's prose verbatim.
 * If someone edits the sentence in route.ts this test is what fails, instead
 * of the cashier silently seeing a generic "conflict".
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore TS5097 — explicit .ts extension required by `node --test`
import { BRANCH_MISMATCH_RE, isBranchMismatchRow, isBranchMismatchText } from "../branch-mismatch.ts";

const here = dirname(fileURLToPath(import.meta.url));
const ROUTE = resolve(here, "../../../../../apps/web/app/api/sales/cart/route.ts");

test("the regex matches the exact sentence the cart route sends on X-Outbox-Branch mismatch", () => {
  const src = readFileSync(ROUTE, "utf8");
  // The 409 block: `error:\n "<sentence>",\n ... { status: 409 }`.
  const m = src.match(/X-Outbox-Branch[\s\S]*?error:\s*"([^"]+)"[\s\S]*?status:\s*409/);
  assert.ok(m, "cart route no longer has the X-Outbox-Branch 409 block this test pins");
  const sentence = m![1];
  assert.match(sentence, BRANCH_MISMATCH_RE);
  assert.equal(isBranchMismatchText(sentence), true);
});

test("a row stored under the prose-as-code shape and under kind=conflict+text both classify", () => {
  const prose = "هذه الفاتورة كانت مُسجَّلة لفرع آخر. بدّل للفرع الصحيح ثم أعد المزامنة.";
  assert.equal(isBranchMismatchRow({ lastErrorCode: prose, lastErrorText: null }), true);
  assert.equal(isBranchMismatchRow({ lastErrorCode: "conflict", lastErrorText: prose }), true);
  assert.equal(isBranchMismatchRow({ lastErrorCode: "BRANCH_MISMATCH", lastErrorText: null }), true);
  assert.equal(isBranchMismatchRow({ lastErrorCode: "INSUFFICIENT_STOCK", lastErrorText: null }), false);
  assert.equal(isBranchMismatchRow({ lastErrorCode: "conflict", lastErrorText: "duplicate" }), false);
});
