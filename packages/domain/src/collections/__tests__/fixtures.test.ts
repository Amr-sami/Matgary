// Run: npm test -w @matgary/domain
// Spec 06 §7 fixtures.test.ts (the corpus of §4.14).
import { test } from "node:test";
import assert from "node:assert/strict";

import { SAMPLES, applyFills } from "../__fixtures__/samples";

test("24 fixtures: 20 published + 4 illustrative, unique ids", () => {
  assert.equal(SAMPLES.length, 24);
  assert.equal(SAMPLES.filter((s) => s.kind === "published").length, 20);
  assert.equal(SAMPLES.filter((s) => s.kind === "illustrative").length, 4);
  assert.equal(new Set(SAMPLES.map((s) => s.id)).size, SAMPLES.length);
});

test("applyFills replaces every occurrence, in order, and throws on a missing placeholder", () => {
  assert.equal(applyFills("a <N> b <N>", [["<N>", "x"]]), "a x b x");
  assert.equal(applyFills("ab", [["a", "b"], ["bb", "c"]]), "c");
  assert.throws(() => applyFills("no mask here", [["<NAME>", "x"]]), /absent/);
  assert.throws(() => applyFills("abc", [["", "x"]]), /absent/);
  assert.equal(applyFills("same", []), "same");
});

test("text = applyFills(published, fills) for every fixture", () => {
  for (const s of SAMPLES) assert.equal(s.text, applyFills(s.published, s.fills), s.id);
});

test("no filled text keeps a research placeholder or a lower-case x mask run of 5+", () => {
  for (const s of SAMPLES) {
    assert.ok(!/<[^>]*>/.test(s.text), `${s.id}: placeholder left`);
    // The bank's own masks are allowed: IP-UNK-1 "xxx6201" (3 x) and CIB's "*" runs.
    assert.ok(!/x{5,}/.test(s.text), `${s.id}: x mask left`);
  }
  assert.ok(SAMPLES.find((s) => s.id === "IP-UNK-1")?.text.includes("xxx6201"));
  assert.ok(SAMPLES.find((s) => s.id === "IP-CIB-1")?.text.includes("********0018"));
});

test("fills are synthetic: phone / reference masks become 7s, names the fixed synthetic names", () => {
  for (const s of SAMPLES) {
    for (const [ph, rep] of s.fills) {
      if (ph.startsWith("<")) assert.match(rep, /^[A-Z* ]+$|^[؀-ۿ ]+$/, `${s.id} ${ph}`);
      else assert.equal(rep, ph.replace(/x/g, /[٠-٩]/.test(ph) ? "٧" : "7"), `${s.id} ${ph}`);
    }
  }
});

test("every published fixture has an https source URL, a research tag and a receivedAt ISO time", () => {
  for (const s of SAMPLES) {
    if (s.kind !== "illustrative") assert.match(s.sourceUrl, /^https:\/\//, s.id);
    assert.ok(s.source.length > 0 && s.researchRef.length > 0, s.id);
    assert.equal(new Date(s.receivedAt).toISOString(), s.receivedAt, s.id);
  }
});

test("the synthetic InstaPay: samples the research proved invented are excluded", () => {
  for (const s of SAMPLES) assert.ok(!/^InstaPay:/i.test(s.published), s.id);
});
