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
  // Platform-admin guard. lib/admin/db.ts uses a BYPASSRLS pool; tenant
  // code accidentally importing from there would skip RLS for every query
  // it runs. Allowed paths: the admin pages, the admin API routes, the
  // admin library itself, and the migration runner.
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
        },
      ],
    },
  },
]);

export default eslintConfig;
