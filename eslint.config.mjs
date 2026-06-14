import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  // Two guardrails, single rule:
  //
  // (1) Platform-admin protection. lib/admin/db.ts uses a BYPASSRLS pool;
  //     tenant code accidentally importing from there would skip RLS for
  //     every query it runs. Allowed paths: the admin pages, the admin
  //     API routes, the admin library itself, and the migration runner.
  //
  // (2) Heavy-lib lazy-load convention. Route-specific client libraries
  //     larger than ~50 KB MUST be loaded on demand so they don't bloat
  //     the bundle for users who never reach the feature. Add a package
  //     here only when it satisfies ALL of:
  //         - > 50 KB minified
  //         - used in one route or behind a user gesture
  //         - has a clean dynamic-import path (no SSR-only side effects)
  //     Server-side use in `lib/` and `app/api/` is fine (never ships
  //     to the browser) — that's why those paths are scoped out below.
  //
  //     ✗ Bad:   import QRCode from "qrcode";
  //     ✓ Good:  const { default: QRCode } = await import("qrcode");
  //
  // Both guardrails are merged into one block because flat ESLint config
  // does NOT merge same-name rules across blocks — a second block with
  // its own `no-restricted-imports` would silently win for overlapping
  // files and drop the admin protection.
  {
    files: [
      "app/**/*.{ts,tsx}",
      "lib/**/*.ts",
      "components/**/*.tsx",
      "hooks/**/*.ts",
    ],
    ignores: [
      "app/admin/**",
      "app/api/admin/**",
      "app/api/cron/admin-*/**",
      "lib/admin/**",
      "lib/db/migrate.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/lib/admin/*", "@/lib/admin"],
              message:
                "lib/admin/* is godmode (BYPASSRLS). Tenant code must not import from it. See docs/specs/platform-admin-dashboard.md §2.",
            },
          ],
          paths: [
            {
              name: "qrcode",
              // The ban is intentionally global to the listed file scope
              // and not narrowed to client-only files — qrcode has no
              // server use today; if one appears, scope a per-file
              // override (eslint-disable with a comment).
              message:
                "Heavy client lib — load on demand: `const { default: QRCode } = await import(\"qrcode\")`. See eslint.config.mjs.",
            },
          ],
        },
      ],
    },
  },
]);

export default eslintConfig;
