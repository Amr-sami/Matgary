// ar/en dictionaries must have the same leaves, the same kinds and the same placeholders.
//
//   node --test --experimental-strip-types packages/i18n/test/parity.test.ts
//
// The dictionary house rule (doc 15, 03 §B.9): identical leaf sets, the same kinds, no empty values,
// equal `{placeholder}` sets except Arabic dual `…Two` keys, which may omit `{n}`, and no new `{{…}}`.
// No count is pinned: leaf counts go into doc 14 §1.2 by hand, so adding copy never edits this file.
//
// Nineteen leaves are lists, and nine of those hold objects (`faq.items`, `marketing.terms.sections`,
// `auth.onboarding.step2.tips.*`, …), so the walk descends into list items (`faq.items[0].q`) and every
// rule below covers them too.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const src = join(dirname(fileURLToPath(import.meta.url)), "../src");
const load = (l: string): unknown => JSON.parse(readFileSync(join(src, `${l}.json`), "utf8"));

type Kind = "string" | "list" | "object" | "other";
type Node = { kind: Kind; value: unknown };
// Keys may contain dots ("sale.created", "collection.pending"): join path segments with a separator no key contains.
const SEP = "␟";
const kindOf = (v: unknown): Kind =>
  typeof v === "string" ? "string" : Array.isArray(v) ? "list" : v !== null && typeof v === "object" ? "object" : "other";
/** Every node below the root (objects, lists and strings) by path. A list item's segment is `[i]`. */
function nodes(node: unknown, path: string[] = [], out = new Map<string, Node>()): Map<string, Node> {
  const kind = kindOf(node);
  if (path.length > 0) out.set(path.join(SEP), { kind, value: node });
  if (kind === "list") (node as unknown[]).forEach((v, i) => nodes(v, [...path, `[${i}]`], out));
  else if (kind === "object") for (const [k, v] of Object.entries(node as Record<string, unknown>)) nodes(v, [...path, k], out);
  return out;
}
const stringLeaves = (d: Map<string, Node>): Map<string, string> =>
  new Map([...d].flatMap(([k, n]) => (n.kind === "string" ? [[k, n.value as string] as const] : [])));

const ar = nodes(load("ar")), en = nodes(load("en"));
const arStrings = stringLeaves(ar), enStrings = stringLeaves(en);
/** `app.activityLabels.actions["auth.login"]`, `faq.items[0].q`: a key that holds a dot is quoted, so it never reads as nesting. */
const show = (k: string) =>
  k.split(SEP).map((s, i) => (/^\[\d+\]$/.test(s) ? s : s.includes(".") ? `["${s}"]` : i === 0 ? s : `.${s}`)).join("");
const tokens = (s: string) => new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));
/** Arabic dual forms name the count in the word; only `{n}` may be dropped, only on keys ending in `Two`. */
const DUAL = /Two$/;
/** Pre-existing `{{…}}` placeholders (CODE FINDING 1; 18 §5 step 6b fixes the copy and empties this). New ones fail. */
const KNOWN_DOUBLE_BRACE = new Set(["mobile.sync.sellAnywayBody"]);
/** Subtrees added by doc 15; an Arabic leaf there that reads as an English sentence is an untranslated copy. */
const COLLECTION_ROOTS = ["app.collections", "app.collectionsSettings", "mobile.collections"];

/**
 * The text around a list item's link (`{before}<link>{after}`, e.g. `auth.onboarding.step2.tips.*[i]`) may be
 * empty: the sentence simply ends at the link. The link text itself may not.
 */
function isLinkSurround(d: Map<string, Node>, k: string): boolean {
  const cut = k.lastIndexOf(SEP), item = k.slice(0, cut), field = k.slice(cut + 1);
  if (!item.endsWith("]") || (field !== "before" && field !== "after")) return false;
  const link = d.get(`${item}${SEP}link`);
  return link?.kind === "string" && (link.value as string).trim().length > 0;
}

test("ar and en have exactly the same leaf paths", () => {
  const onlyAr = [...ar.keys()].filter((k) => !en.has(k)).map(show);
  const onlyEn = [...en.keys()].filter((k) => !ar.has(k)).map(show);
  assert.deepEqual({ onlyAr: onlyAr.slice(0, 20), onlyEn: onlyEn.slice(0, 20) }, { onlyAr: [], onlyEn: [] });
});

test("every leaf has the same kind (string vs list) and lists have the same length", () => {
  for (const [name, d] of [["ar", ar], ["en", en]] as const)
    for (const [k, n] of d) assert.notEqual(n.kind, "other", `${name}: ${show(k)} = ${JSON.stringify(n.value)} is not a string, list or object`);
  for (const [k, a] of ar) {
    const e = en.get(k);
    if (e === undefined) continue;
    assert.equal(a.kind, e.kind, `${show(k)}: ar is a ${a.kind}, en is a ${e.kind}`);
    if (a.kind === "list") assert.equal((a.value as unknown[]).length, (e.value as unknown[]).length, `${show(k)}: list lengths differ`);
  }
});

test("no empty or whitespace-only strings", () => {
  for (const [name, d, strings] of [["ar", ar, arStrings], ["en", en, enStrings]] as const)
    for (const [k, s] of strings) if (s.trim().length === 0) assert.ok(isLinkSurround(d, k), `${name}: ${show(k)} is empty`);
});

test("placeholders match; Arabic dual forms may omit only {n}", () => {
  for (const [k, a] of arStrings) {
    const e = enStrings.get(k);
    if (e === undefined) continue;
    const ta = tokens(a), te = tokens(e), key = show(k);
    const missingInAr = [...te].filter((t) => !ta.has(t)), extraInAr = [...ta].filter((t) => !te.has(t));
    assert.deepEqual(extraInAr, [], `${key}: ar has placeholders en lacks`);
    if (DUAL.test(key)) assert.ok(missingInAr.every((t) => t === "n"), `${key}: a dual form may drop only {n}, ar lacks ${missingInAr.join(", ")}`);
    else assert.deepEqual(missingInAr, [], `${key}: ar lacks placeholders`);
  }
});

test("no new {{double-brace}} placeholders", () => {
  const found = [...arStrings, ...enStrings].filter(([, s]) => s.includes("{{")).map(([k]) => show(k));
  assert.deepEqual([...new Set(found)].filter((k) => !KNOWN_DOUBLE_BRACE.has(k)), []);
});

test("Arabic leaves under the collections subtrees are not untranslated English sentences", () => {
  for (const [k, s] of arStrings) {
    const key = show(k);
    if (!COLLECTION_ROOTS.some((r) => key.startsWith(`${r}.`))) continue;
    if (!/[؀-ۿ]/.test(s)) assert.ok(!/[A-Za-z]{2,}\s+[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(s), `${key}: "${s}" looks untranslated`);
  }
});
