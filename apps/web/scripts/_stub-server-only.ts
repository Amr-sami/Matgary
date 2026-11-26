/**
 * Preload shim for standalone scripts (`npx tsx`) that import modules which
 * transitively use Next.js's `server-only` guard.
 *
 * The real `server-only` throws on load (its sole job is to crash a client
 * bundle that tries to pull in server code). Scripts aren't client bundles,
 * so swap the module with an empty export via require.cache.
 */
import Module from "node:module";

const req = Module.createRequire(import.meta.url);
try {
  const resolved = req.resolve("server-only");
  // Pre-seed the cache with a benign module so the real one never runs.
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: {},
    children: [],
    parent: null,
    paths: [],
    path: resolved,
    isPreloading: false,
    require: req,
  } as unknown as NodeJS.Module;
} catch {
  // server-only isn't resolvable → nothing to stub.
}
