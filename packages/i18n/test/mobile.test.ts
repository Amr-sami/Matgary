// Every dictionary key the phone references must resolve in the mobile subset.
//
//   node --test --experimental-strip-types packages/i18n/test/
//
// Scans apps/mobile/src for t("literal") calls, template keys (the static
// prefix up to the first `${`), the `NS`-prefixed keys in lib/activity-details,
// and the four screens that read `dictionaries[locale].<ns>` directly. Also
// pins the resolver helper (apps/mobile/metro.i18n.js) to the same
// algorithm as `pickNamespaces`, so what ships equals what the types say.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The sources import `./ar.json` bare, the way Metro and Next accept it; Node's
// ESM loader insists on `with { type: "json" }`, so supply the attribute here.
registerHooks({
  resolve(specifier, context, next) {
    const r = next(specifier, context);
    if (r.url.endsWith(".json")) r.importAttributes = { type: "json" };
    return r;
  },
});
const { lookup } = await import("../src/index.ts");
const { MOBILE_NAMESPACES, asDictionary, mobileDictionaries, pickNamespaces } = await import("../src/mobile.ts");

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../..");
const mobileSrc = join(root, "apps/mobile/src");

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

type Scan = {
  literals: Map<string, string>;
  prefixes: Map<string, string>;
  /** `t(`…`)` sites the template regex parsed vs. a plain count of `t(\`` — must agree. */
  templates: { parsed: number; sites: number };
};

function referencedKeys(): Scan {
  const literals = new Map<string, string>();
  const prefixes = new Map<string, string>();
  const templates = { parsed: 0, sites: 0 };
  for (const file of walk(mobileSrc)) {
    const src = readFileSync(file, "utf8");
    const rel = file.slice(root.length + 1);
    const ns = /const NS = "([^"]+)"/.exec(src)?.[1];
    // Quoted keys: t("a.b"), t('a.b').
    for (const m of src.matchAll(/\bt\(\s*(["'])([^"']*)\1/g)) {
      const key = m[2];
      if (/[*<>\s]/.test(key)) continue; // t("auth.reset.*") in a doc comment, not a call
      literals.set(key, rel);
    }
    // Template keys, scanned separately: `${…}` may itself contain a quoted
    // string (t(`x.${ok ? code : "GENERIC"}`)), which a shared [^`"']* class
    // would abort on and silently drop from the prefix check.
    templates.sites += (src.match(/\bt\(\s*`/g) ?? []).length;
    for (const m of src.matchAll(/\bt\(\s*`((?:[^`\\]|\\.)*)`/g)) {
      templates.parsed++;
      let key = m[1];
      if (/[*<>\s]/.test(key)) continue;
      if (ns && key.startsWith("${NS}")) key = ns + key.slice(5);
      const cut = key.indexOf("${");
      if (cut === -1) literals.set(key, rel);
      else prefixes.set(key.slice(0, cut).replace(/\.$/, ""), rel);
    }
    for (const m of src.matchAll(/dictionaries\[[^\]]+\]\.((?:[A-Za-z_]+\.?)+)/g)) {
      prefixes.set(m[1].replace(/\.$/, ""), rel);
    }
  }
  return { literals, prefixes, templates };
}

test("mobile namespaces list matches the JSON both consumers read", () => {
  const json = JSON.parse(readFileSync(join(here, "../src/mobile-namespaces.json"), "utf8"));
  assert.deepEqual([...MOBILE_NAMESPACES], json);
});

test("every listed namespace exists in the source dictionaries (a typo would be pruned to nothing)", () => {
  // `MobileDictionary` is derived from the tuple, so a typo there is a compile
  // error; this catches the JSON copy and the dictionaries themselves drifting.
  const tops = [...new Set(MOBILE_NAMESPACES.map((ns) => ns.split(".")[0]))].sort();
  const marketingTails = MOBILE_NAMESPACES.filter((ns) => ns.startsWith("marketing.")).map((ns) => ns.slice("marketing.".length)).sort();
  for (const locale of ["ar", "en"] as const) {
    const dict = mobileDictionaries[locale];
    assert.deepEqual(Object.keys(dict).sort(), tops, `${locale}: top-level namespaces`);
    assert.deepEqual(Object.keys(dict.marketing).sort(), marketingTails, `${locale}: marketing.* tails`);
  }
});

test("the template-key scanner parsed every t(`…`) site it counted", () => {
  const { templates } = referencedKeys();
  assert.ok(templates.sites > 0, "no template sites found — regex broke?");
  assert.equal(templates.parsed, templates.sites);
});

test("every literal key referenced in apps/mobile/src resolves in the mobile dictionary", () => {
  const { literals } = referencedKeys();
  assert.ok(literals.size > 1000, `scan found only ${literals.size} keys — regex broke?`);
  const missing: string[] = [];
  for (const locale of ["ar", "en"] as const) {
    const dict = asDictionary(mobileDictionaries[locale]);
    for (const [key, file] of literals) {
      if (lookup(dict, key) === key) missing.push(`${locale}: ${key} (${file})`);
    }
  }
  assert.deepEqual(missing, []);
});

test("every template-key prefix and direct dictionaries[...] path exists in the mobile dictionary", () => {
  const { prefixes } = referencedKeys();
  const missing: string[] = [];
  for (const locale of ["ar", "en"] as const) {
    for (const [prefix, file] of prefixes) {
      let node: unknown = mobileDictionaries[locale];
      for (const seg of prefix.split(".")) {
        node = node && typeof node === "object" ? (node as Record<string, unknown>)[seg] : undefined;
      }
      if (node === undefined) missing.push(`${locale}: ${prefix}.* (${file})`);
    }
  }
  assert.deepEqual(missing, []);
});

test("the Metro resolver helper prunes ar.json/en.json exactly like pickNamespaces", () => {
  const require = createRequire(import.meta.url);
  const { pruneDictionary } = require(join(root, "apps/mobile/metro.i18n.js"));
  for (const locale of ["ar", "en"]) {
    const full = JSON.parse(readFileSync(join(here, `../src/${locale}.json`), "utf8"));
    assert.deepEqual(pruneDictionary(full), pickNamespaces(full, MOBILE_NAMESPACES));
  }
});

test("the subset is a real subset: web-only namespaces are gone", () => {
  for (const ns of ["hero", "pricing", "faq", "showcase", "stats", "how", "cta", "nav", "meta"]) {
    assert.equal(ns in mobileDictionaries.ar, false, ns);
  }
  assert.equal("about" in mobileDictionaries.ar.marketing, false);
  assert.ok(mobileDictionaries.ar.marketing.privacy);
});
