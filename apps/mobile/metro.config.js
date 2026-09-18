// Monorepo Metro config. Three settings matter, and getting any of them wrong
// produces the same symptom — a red screen about hooks or two Reacts.
const { getSentryExpoConfig } = require("@sentry/react-native/metro");
const path = require("node:path");
const { withMobileDictionaries } = require("./metro.i18n");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

// Expo's default config plus Sentry's two additions: debug-ID injection through
// Expo's own serializer plugin (release source maps match; the runbook's upload
// step depends on it), and `includeWebReplay: false`, whose resolver answers
// `{ type: "empty" }` for `@sentry/replay` on ios/android — a browser-only
// feature that was riding along in the Hermes bundle. (`withSentryConfig` is
// the bare-RN variant: it replaces the serializer and breaks `expo export`
// with "Cannot read properties of undefined (reading 'match')".)
const config = getSentryExpoConfig(projectRoot, { includeWebReplay: false });

// 1. Watch the workspace so edits in packages/* hot-reload.
config.watchFolders = [workspaceRoot];

// 2. Resolve from the app first, then the hoisted root. Order matters: the web
//    app pins react 19.2.4 and Expo pins 19.2.3, so npm nests one of them.
//    Looking in apps/mobile/node_modules first is what keeps RN on its own copy.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// 3. Without this, Metro walks UP from any file it resolves — including files in
//    packages/* — and can reach apps/web/node_modules. That is how a second React
//    gets into the bundle.
config.resolver.disableHierarchicalLookup = true;

// packages/* ship untranspiled TypeScript via the "exports" field.
config.resolver.unstable_enablePackageExports = true;

// Non-dev bundles get the phone's subset of the i18n dictionaries — the
// namespaces in packages/i18n/src/mobile-namespaces.json; web-only copy (hero,
// pricing, faq, showcase, marketing pages other than privacy/terms/contact)
// never reaches Hermes. See metro.i18n.js for why this is a resolver, not a
// transformer, and why dev bundles are left alone.
module.exports = withMobileDictionaries(config);
