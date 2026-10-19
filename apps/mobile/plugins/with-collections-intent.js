// Expo config plugin: compile the ForwardPaymentMessageIntent App Intent into the APP TARGET
// (doc 15 spec 10 §4.11, M3; 03 §B.10 option B). App Intents metadata extraction only sees the app
// target, so the Swift file cannot live in the `collections-ingest` pod; it imports that pod as
// `import CollectionsIngest` instead (same process: no App Group, no extension).
//
// What it does, all idempotent across prebuilds:
//   1. Strings (at plugin time, before mods run): `mobile.collections.ios.intent.*` from
//      @matgary/i18n ar/en → `collections_intent_<snake_case(name)>` merged into
//      `config.locales[lang].ios["Localizable.strings"]` (on top of ./locales/<lang>.json, which is
//      NOT edited). Expo writes that entry to Supporting/<lang>.lproj/Localizable.strings. A value
//      with `"`, `\` or a newline throws: Expo's .strings writer does not escape.
//   2. withDangerousMod: copy plugins/collections-intent/ForwardPaymentMessageIntent.swift to
//      ios/<projectName>/CollectionsIntent/.
//   3. withXcodeProject: add that file to the app target's Sources once (`project.hasFile`).
//   4. No Info.plist, entitlement or background-mode change (App Intents need none).
//
// Changing this plugin changes the fingerprint runtime: M3 ships only in a store build, never OTA.
// CommonJS on purpose: `expo/config-plugins` resolves to the hoisted root copy.
/* global __dirname */
const fs = require("fs");
const path = require("path");
const { withDangerousMod, withXcodeProject, IOSConfig } = require("expo/config-plugins");

const INTENT_FILE = "ForwardPaymentMessageIntent.swift";
const INTENT_DIR = "CollectionsIntent";
const SOURCE = path.join(__dirname, "collections-intent", INTENT_FILE);
const LANGS = ["ar", "en"];
const STRINGS = "Localizable.strings";

/** `paramReceivedAt` → `param_received_at`. */
function snakeCase(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** The `mobile.collections.ios.intent` object of one dictionary. */
function loadIntentDict(lang, resolve = require.resolve) {
  const file = resolve(`@matgary/i18n/${lang}`);
  const dict = JSON.parse(fs.readFileSync(file, "utf8"));
  const intent = dict && dict.mobile && dict.mobile.collections && dict.mobile.collections.ios && dict.mobile.collections.ios.intent;
  if (!intent || typeof intent !== "object") {
    throw new Error(`with-collections-intent: ${lang}: mobile.collections.ios.intent is missing in ${file}`);
  }
  return intent;
}

/** `{name: value}` → `{collections_intent_<snake>: value}`; refuses values .strings cannot hold. */
function buildIntentStrings(intent, lang = "?") {
  const out = {};
  for (const [name, value] of Object.entries(intent)) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`with-collections-intent: ${lang}: intent.${name} must be a non-empty string`);
    }
    if (/["\\\n\r]/.test(value)) {
      throw new Error(`with-collections-intent: ${lang}: intent.${name} contains a double quote, backslash or newline`);
    }
    const key = `collections_intent_${snakeCase(name)}`;
    if (key in out) throw new Error(`with-collections-intent: duplicate key ${key}`);
    out[key] = value;
  }
  return out;
}

/** The locale object for `lang`: `./locales/<lang>.json` (or an inline object) + our strings. */
function mergeLocale(existing, projectRoot, strings) {
  let base = {};
  if (typeof existing === "string") {
    base = JSON.parse(fs.readFileSync(path.resolve(projectRoot, existing), "utf8"));
  } else if (existing && typeof existing === "object") {
    base = existing;
  }
  const ios = { ...(base.ios || {}) };
  ios[STRINGS] = { ...(ios[STRINGS] || {}), ...strings };
  return { ...base, ios };
}

function withIntentStrings(config, { projectRoot, resolve } = {}) {
  const root = projectRoot || config._internal?.projectRoot || process.cwd();
  const locales = { ...(config.locales || {}) };
  for (const lang of LANGS) {
    locales[lang] = mergeLocale(locales[lang], root, buildIntentStrings(loadIntentDict(lang, resolve), lang));
  }
  return { ...config, locales };
}

/** Copy the Swift file into ios/<projectName>/CollectionsIntent/ (overwrites: the source is truth). */
function copyIntentSource(platformProjectRoot, projectName, source = SOURCE) {
  const dir = path.join(platformProjectRoot, projectName, INTENT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, INTENT_FILE);
  fs.copyFileSync(source, dest);
  return dest;
}

/** Add `<projectName>/CollectionsIntent/ForwardPaymentMessageIntent.swift` to the app target once. */
function addIntentToProject(project, projectName) {
  const filepath = `${projectName}/${INTENT_DIR}/${INTENT_FILE}`;
  if (project.hasFile(filepath)) return project;
  const target = IOSConfig.XcodeUtils.getApplicationNativeTarget({ project, projectName });
  return IOSConfig.XcodeUtils.addBuildSourceFileToGroup({ filepath, groupName: projectName, project, targetUuid: target.uuid });
}

function projectNameOf(modRequest) {
  const name = modRequest.projectName || IOSConfig.XcodeUtils.getProjectName(modRequest.projectRoot);
  if (!name) throw new Error("with-collections-intent: cannot determine the iOS project name");
  return name;
}

const withCollectionsIntent = (config) => {
  config = withIntentStrings(config);
  config = withDangerousMod(config, [
    "ios",
    async (cfg) => {
      copyIntentSource(cfg.modRequest.platformProjectRoot, projectNameOf(cfg.modRequest));
      return cfg;
    },
  ]);
  config = withXcodeProject(config, (cfg) => {
    cfg.modResults = addIntentToProject(cfg.modResults, projectNameOf(cfg.modRequest));
    return cfg;
  });
  return config;
};

module.exports = withCollectionsIntent;
module.exports.snakeCase = snakeCase;
module.exports.loadIntentDict = loadIntentDict;
module.exports.buildIntentStrings = buildIntentStrings;
module.exports.mergeLocale = mergeLocale;
module.exports.withIntentStrings = withIntentStrings;
module.exports.copyIntentSource = copyIntentSource;
module.exports.addIntentToProject = addIntentToProject;
module.exports.INTENT_FILE = INTENT_FILE;
module.exports.INTENT_DIR = INTENT_DIR;
