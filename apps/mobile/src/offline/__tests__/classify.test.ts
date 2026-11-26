/**
 * Run:  node --test --experimental-strip-types apps/mobile/src/offline/__tests__/classify.test.ts
 *
 * classify.ts has a type-only import from @matgary/api-client, which Node's
 * stripper erases, so plain Node loads it. §6.6 of doc 06 is the acceptance
 * test: a sale is never dropped, never sent twice, and a 4xx wall never
 * masquerades as a lost sale.
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore TS5097 — explicit .ts extension required by `node --test`
import { backoffMs, classifyOutcome, MAX_BACKOFF_MS, type ErrorLike } from "../classify.ts";

const err = (over: Partial<ErrorLike>): ErrorLike => ({
  kind: "unknown",
  code: null,
  status: null,
  retryAfterSec: null,
  message: "",
  ...over,
});
const zero = () => 0;

test("offline and timeout are network-retryable with backoff", () => {
  for (const kind of ["offline", "timeout"] as const) {
    const o = classifyOutcome(err({ kind }), 1, zero);
    assert.equal(o.kind, "retryable-network");
    assert.equal(o.kind === "retryable-network" && o.delayMs, 1000);
  }
});

test("5xx and unclassified errors are server-retryable", () => {
  assert.equal(classifyOutcome(err({ kind: "server", status: 502 }), 3, zero).kind, "retryable-server");
  assert.equal(classifyOutcome(err({ kind: "unknown", status: 200 }), 1, zero).kind, "retryable-server");
});

test("a non-ApiError thrown by a handler is retried, never dropped", () => {
  const o = classifyOutcome(new TypeError("boom"), 1, zero);
  assert.equal(o.kind, "retryable-server");
});

test("429 honours Retry-After over the exponential curve", () => {
  const o = classifyOutcome(err({ kind: "rateLimited", status: 429, retryAfterSec: 42 }), 1, zero);
  assert.equal(o.kind, "retryable-server");
  assert.equal(o.kind === "retryable-server" && o.delayMs, 42_000);
  const noHeader = classifyOutcome(err({ kind: "rateLimited", status: 429 }), 2, zero);
  assert.equal(noHeader.kind === "retryable-server" && noHeader.delayMs, 2000);
});

test("session, credentials, billing and TOTP pause the drain (auth-wait)", () => {
  assert.equal(classifyOutcome(err({ kind: "session", status: 401 }), 1).kind, "auth-wait");
  assert.equal(classifyOutcome(err({ kind: "credentials", status: 401 }), 1).kind, "auth-wait");
  assert.equal(classifyOutcome(err({ kind: "billing", status: 402, code: "SUBSCRIPTION_REQUIRED" }), 1).kind, "auth-wait");
  assert.equal(classifyOutcome(err({ kind: "conflict", status: 409, code: "TOTP_REQUIRED" }), 1).kind, "auth-wait");
});

test("409 idempotent replay counts as done", () => {
  for (const code of ["IDEMPOTENT_REPLAY", "DUPLICATE", "ALREADY_RECORDED"]) {
    assert.equal(classifyOutcome(err({ kind: "conflict", status: 409, code }), 1).kind, "done");
  }
});

test("409 branch mismatch is terminal but cashier-actionable", () => {
  const byCode = classifyOutcome(err({ kind: "conflict", status: 409, code: "BRANCH_MISMATCH" }), 1);
  assert.deepEqual(byCode, { kind: "terminal-failure", actionable: true, code: "BRANCH_MISMATCH", message: "" });
  const byMessage = classifyOutcome(
    err({ kind: "conflict", status: 409, message: "هذه الفاتورة كانت مُسجَّلة لفرع آخر. بدّل للفرع الصحيح ثم أعد المزامنة." }),
    1,
  );
  assert.equal(byMessage.kind === "terminal-failure" && byMessage.actionable, true);
  const other = classifyOutcome(err({ kind: "conflict", status: 409, code: "SOMETHING_ELSE" }), 1);
  assert.equal(other.kind === "terminal-failure" && other.actionable, false);
});

test("validation: stock/product/branch codes are actionable, the rest are not", () => {
  for (const code of ["INSUFFICIENT_STOCK", "PRODUCT_NOT_FOUND", "PRODUCT_WRONG_BRANCH"]) {
    const o = classifyOutcome(err({ kind: "validation", status: 400, code }), 1);
    assert.equal(o.kind, "terminal-failure");
    assert.equal(o.kind === "terminal-failure" && o.actionable, true);
  }
  const bad = classifyOutcome(err({ kind: "validation", status: 422, code: "INVALID_BODY" }), 1);
  assert.equal(bad.kind === "terminal-failure" && bad.actionable, false);
});

test("forbidden and notFound are terminal, not actionable", () => {
  assert.equal(classifyOutcome(err({ kind: "forbidden", status: 403 }), 1).kind, "terminal-failure");
  assert.equal(classifyOutcome(err({ kind: "notFound", status: 404 }), 1).kind, "terminal-failure");
});

test("backoff doubles from 1s and never exceeds the 5-minute cap", () => {
  assert.equal(backoffMs(1, zero), 1000);
  assert.equal(backoffMs(2, zero), 2000);
  assert.equal(backoffMs(5, zero), 16_000);
  assert.equal(backoffMs(9, zero), 256_000);
  assert.equal(backoffMs(10, zero), MAX_BACKOFF_MS);
  assert.equal(backoffMs(50, () => 0.999), MAX_BACKOFF_MS);
  assert.equal(backoffMs(0, zero), 1000);
});

test("jitter adds under one base unit and stays within the cap", () => {
  const j = backoffMs(1, () => 0.5);
  assert.ok(j >= 1000 && j < 2000);
  assert.equal(backoffMs(9, () => 0.999), 256_999);
});
