// The phone ships a subset of packages/i18n's dictionaries.
//
// `ar.json` / `en.json` are JSON modules: Metro cannot tree-shake them, Metro's
// transform worker serialises JSON itself (never via the Babel transformer),
// and `packages/i18n/src/mobile.ts` picking namespaces at import time would
// still bundle the whole file. So the cut happens in the resolver: when
// packages/i18n asks for `./ar.json`, a non-dev bundle gets a pruned copy
// written under .expo/i18n-mobile/ at Metro-config load. Dev bundles keep the
// real file so dictionary edits still hot-reload.
//
// The namespace list is packages/i18n/src/mobile-namespaces.json (one list,
// both consumers); packages/i18n/test/mobile.test.ts pins `pruneDictionary`
// to `pickNamespaces` and checks every key the app references still resolves.
const fs = require("node:fs");
const path = require("node:path");

const dictionaryDir = path.resolve(__dirname, "../../packages/i18n/src");
const outDir = path.resolve(__dirname, ".expo/i18n-mobile");
const LOCALES = ["ar", "en"];

function namespaces() {
  return JSON.parse(fs.readFileSync(path.join(dictionaryDir, "mobile-namespaces.json"), "utf8"));
}

function pruneDictionary(dict) {
  const out = {};
  for (const p of namespaces()) {
    const segs = p.split(".");
    let src = dict;
    let dst = out;
    for (let i = 0; i < segs.length; i++) {
      if (!src || typeof src !== "object" || !(segs[i] in src)) break;
      const value = src[segs[i]];
      if (i === segs.length - 1) dst[segs[i]] = value;
      else {
        dst = dst[segs[i]] ??= {};
        src = value;
      }
    }
  }
  return out;
}

const namespacesFile = path.join(dictionaryDir, "mobile-namespaces.json");

/** Writes one pruned copy; returns its path. */
function writePrunedDictionary(source, target) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(target, JSON.stringify(pruneDictionary(JSON.parse(fs.readFileSync(source, "utf8")))));
  return target;
}

/**
 * True when the pruned copy is missing or older than either input. A long-lived
 * non-dev server (`expo start --no-dev`, release-mode `expo run:ios`) would
 * otherwise keep serving the copy written at config load after a dictionary edit.
 */
function isStale(source, target) {
  try {
    const built = fs.statSync(target).mtimeMs;
    return fs.statSync(source).mtimeMs > built || fs.statSync(namespacesFile).mtimeMs > built;
  } catch {
    return true;
  }
}

/** Writes .expo/i18n-mobile/{ar,en}.json; returns { "<abs source path>": "<abs pruned path>" }. */
function writePrunedDictionaries() {
  const map = {};
  for (const locale of LOCALES) {
    const source = path.join(dictionaryDir, `${locale}.json`);
    map[source] = writePrunedDictionary(source, path.join(outDir, `${locale}.json`));
  }
  return map;
}

/** Metro config wrapper: chains onto the existing resolveRequest. */
function withMobileDictionaries(config) {
  const pruned = writePrunedDictionaries();
  const previous = config.resolver.resolveRequest;
  config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (!context.dev && /^\.\/(ar|en)\.json$/.test(moduleName) && path.dirname(context.originModulePath) === dictionaryDir) {
      const source = path.resolve(dictionaryDir, moduleName);
      const target = pruned[source];
      if (target) {
        if (isStale(source, target)) writePrunedDictionary(source, target);
        return { type: "sourceFile", filePath: target };
      }
    }
    return (previous ?? context.resolveRequest)(context, moduleName, platform);
  };
  return config;
}

module.exports = { pruneDictionary, withMobileDictionaries, writePrunedDictionaries };
