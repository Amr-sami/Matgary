// Slice 2a — regression safety-net: assert the new Financials code contains
// NO branch functionality. Fails if someone ever writes branch-aware code
// inside /insights/financials/* or lib/finance/*.
//
// The user rule: "No new Financials code may read, write, filter, calculate,
// or display branch information." Enforce it in CI.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const WEB_ROOT = resolve(__dirname, "../..");

// Finance source directories/files that must stay branchless at runtime.
// The migration file is excluded on purpose — its comments mention the
// legacy `branch_id` column on `expenses` to document that we deliberately
// leave it alone. That's not runtime code.
const FINANCE_PATHS = [
  "app/insights/financials",
  "lib/finance",
  "app/api/financials",
  "hooks/useFinancials.ts",
  "components/financials",
];

// Forbidden tokens — any one of these appearing in a Finance file is a red
// flag for new branch-aware code. We compile them case-insensitively so
// `BranchId`, `branchID`, `branch_id` all catch.
const FORBIDDEN_PATTERNS = [
  /\bbranchId\b/,
  /\bbranch_id\b/,
  /\bBranchPicker\b/,
  /\bBranchSwitcher\b/,
  /\buseBranches\b/,
  /\bbranchScope\b/,
  /\bInsightsBranchScope\b/,
];

/** Returns every file (one per line) under `root` matching the glob. */
function filesUnder(path: string): string[] {
  try {
    const full = resolve(WEB_ROOT, path);
    // -L to follow symlinks (none here, but defensive).
    const cmd = `find "${full}" -type f \\( -name '*.ts' -o -name '*.tsx' -o -name '*.sql' \\) 2>/dev/null`;
    const out = execSync(cmd, { encoding: "utf8" }).trim();
    return out ? out.split("\n") : [];
  } catch {
    return [];
  }
}

describe("Financials — branch-free guarantee", () => {
  it("every Finance source file contains no active branch-UI token", () => {
    const hits: string[] = [];
    for (const path of FINANCE_PATHS) {
      const files = filesUnder(path);
      for (const file of files) {
        const content = readFileSync(file, "utf8");
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(content)) {
            hits.push(`${file}: matches ${pattern}`);
          }
        }
      }
    }
    // Allow the integration test file itself to reference branches (it has
    // to insert a branch row because the DB schema still demands one for
    // sales/categories). But it lives under tests/, not under the finance
    // source directories above, so it's already excluded.
    expect(hits).toEqual([]);
  });

  it("the deleted branch UI files are actually gone", () => {
    const deleted = [
      "app/settings/branches/page.tsx",
      "components/branches/BranchPicker.tsx",
    ];
    for (const path of deleted) {
      const full = resolve(WEB_ROOT, path);
      expect(
        () => readFileSync(full, "utf8"),
        `${path} should no longer exist`,
      ).toThrow();
    }
  });

  it("Header component no longer imports or renders BranchPicker", () => {
    const content = readFileSync(resolve(WEB_ROOT, "components/layout/Header.tsx"), "utf8");
    expect(content).not.toContain("BranchPicker");
    expect(content).not.toContain("useBranches");
  });

  it("Sidebar component no longer imports useBranches or useActiveBranchName", () => {
    const content = readFileSync(resolve(WEB_ROOT, "components/layout/Sidebar.tsx"), "utf8");
    expect(content).not.toContain("useBranches");
    expect(content).not.toContain("useActiveBranchName");
  });

  it("Insights page no longer renders the branch-scope toggle", () => {
    const content = readFileSync(resolve(WEB_ROOT, "app/insights/page.tsx"), "utf8");
    expect(content).not.toContain("showBranchToggle");
    expect(content).not.toContain("setBranchScope");
  });
});
