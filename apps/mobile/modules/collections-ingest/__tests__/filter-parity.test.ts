/**
 * Run:  cd apps/mobile && npx tsx --test modules/collections-ingest/__tests__/filter-parity.test.ts
 *
 * Doc 15 spec 10 §7.1 (filter-parity row), §5 step 15. `ios/IngestFilter.swift` carries COPIES of 06's
 * device filter (the App Intent's fallback when it has no fresh server config). This test reads the
 * Swift file as text, extracts its arrays and fails on any drift:
 *   - `DEFAULT_KEYWORDS` = 06 `CANDIDATE_KEYWORDS.ar ∪ .en` (order-insensitive, no duplicates);
 *   - `DEFAULT_OTP_PATTERNS` = 06 `OTP_PATTERNS` (same order: ICU evaluates them one by one);
 *   - `PERSONAL_SENDER` = `shortcuts/filter.lock.json` `personalSenderRegex` (D10-3), copied here as a
 *     constant because mobile-dev-docs/ is not in git;
 *   - the Swift header names the current `FILTER_CONFIG_VERSION`, so a 06 bump forces a look here.
 * `tsx`, not plain Node: `filter.ts` has extensionless imports (06 §4.1).
 */
/// <reference types="node" />
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CANDIDATE_KEYWORDS, FILTER_CONFIG_VERSION, OTP_PATTERNS } from "../../../../../packages/domain/src/collections/filter";

const here = dirname(fileURLToPath(import.meta.url));
const SWIFT = readFileSync(join(here, "../ios/IngestFilter.swift"), "utf8");
/** `shortcuts/filter.lock.json` → `personalSenderRegex` (2026-10-18-1). */
const LOCKED_PERSONAL_SENDER = "^(\\+?20|0020|0)?1[0125][0-9]{8}$";
const LOCK_FILE = join(here, "../../../../../mobile-dev-docs/15-digital-collections/shortcuts/filter.lock.json");

/** One Swift string literal: raw `#"…"#` (verbatim) or `"…"` (with \\ \" \n \t escapes). */
const LITERAL = /#"((?:(?!"#).)*)"#|"((?:[^"\\]|\\.)*)"/g;
function unescapeSwift(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => ({ n: "\n", t: "\t", r: "\r", "0": "\0" })[c] ?? c);
}
function literals(src: string): string[] {
  return [...src.matchAll(LITERAL)].map((m) => (m[1] !== undefined ? m[1] : unescapeSwift(m[2] ?? "")));
}

function swiftArray(name: string): string[] {
  const start = SWIFT.indexOf(`static let ${name}: [String] = [`);
  assert.ok(start > -1, `${name} not found in IngestFilter.swift`);
  const open = SWIFT.indexOf("[", SWIFT.indexOf("=", start));
  const close = SWIFT.indexOf("\n  ]", open);
  assert.ok(close > open, `${name}: closing bracket not found`);
  return literals(SWIFT.slice(open + 1, close));
}

function swiftString(name: string): string {
  const m = SWIFT.match(new RegExp(`static let ${name}: String = (#".*?"#|"(?:[^"\\\\]|\\\\.)*")`));
  assert.ok(m, `${name} not found`);
  return literals(m[1])[0];
}

test("the extractor reads raw and escaped Swift literals", () => {
  assert.deepEqual(literals(String.raw`[ #"a\b"#, "c\"d", "e\\f" ]`), [String.raw`a\b`, `c"d`, String.raw`e\f`]);
});

test("DEFAULT_KEYWORDS = 06 CANDIDATE_KEYWORDS (ar ∪ en)", () => {
  const swift = swiftArray("DEFAULT_KEYWORDS");
  const domain = [...CANDIDATE_KEYWORDS.ar, ...CANDIDATE_KEYWORDS.en];
  assert.equal(new Set(swift).size, swift.length, "duplicate keyword in Swift");
  assert.deepEqual([...swift].sort(), [...domain].sort());
});

test("DEFAULT_OTP_PATTERNS = 06 OTP_PATTERNS, same order", () => {
  assert.deepEqual(swiftArray("DEFAULT_OTP_PATTERNS"), [...OTP_PATTERNS]);
});

test("PERSONAL_SENDER = the locked D10-3 regex", () => {
  assert.equal(swiftString("PERSONAL_SENDER"), LOCKED_PERSONAL_SENDER);
  if (existsSync(LOCK_FILE)) {
    const lock = JSON.parse(readFileSync(LOCK_FILE, "utf8")) as { personalSenderRegex: string };
    assert.equal(lock.personalSenderRegex, LOCKED_PERSONAL_SENDER, "filter.lock.json changed: update this constant AND the Swift file");
  }
  const re = new RegExp(LOCKED_PERSONAL_SENDER);
  for (const p of ["+201012345678", "01012345678", "00201012345678"]) assert.ok(re.test(p), p);
  for (const s of ["AHLY", "vf-cash", "1234", "QNBEGYPT"]) assert.ok(!re.test(s), s);
});

test("the Swift copy names the current FILTER_CONFIG_VERSION", () => {
  assert.ok(SWIFT.includes(FILTER_CONFIG_VERSION),
    `IngestFilter.swift does not mention ${FILTER_CONFIG_VERSION}: re-copy 06's lists and update its header`);
});
