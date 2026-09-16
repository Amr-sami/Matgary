// Monorepo Metro config. Three settings matter, and getting any of them wrong
// produces the same symptom — a red screen about hooks or two Reacts.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

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

module.exports = config;
