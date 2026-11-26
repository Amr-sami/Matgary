import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    pool: "forks",
    testTimeout: 20_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      // Next.js ships `server-only` as a build-time guard that throws when
      // imported from a client component. Vitest's Vite runtime can't
      // resolve it (it's not in node_modules under test), so any test that
      // transitively pulls in an `import "server-only"` file (e.g.
      // tests/isolation.test.ts → lib/observability/tracing.ts) fails to
      // load. Stub it with a no-op so the import is inert under test.
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
});
