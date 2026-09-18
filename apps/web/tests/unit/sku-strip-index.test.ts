/**
 * HANDOFF §8 #6 — the scanner's expression index and its query must agree.
 *
 * Migration 0053 indexes `lower(regexp_replace(sku, <pattern>, '', 'g'))`.
 * Postgres only uses an expression index when the query's expression is
 * textually identical, so the pattern in lib/repo/catalog.ts (inlined into
 * the query as a literal) and the one baked into the migration must be the
 * same bytes. This is the guard: touching SKU_STRIP_PG without a migration
 * that rebuilds the index fails here, not silently in a seq scan.
 *
 * Also pins that the Postgres pattern strips everything the JS rule
 * (lib/sales/scan-cart.ts `normalizeSku`) strips — the drift that let a
 * NBSP-carrying SKU vanish from the SQL pre-filter.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { SKU_STRIP_PG } from "@/lib/repo/catalog";
import { normalizeSku } from "@/lib/sales/scan-cart";

const MIGRATION = path.resolve(__dirname, "../../lib/db/migrations/0053_products_norm_sku_idx.sql");

describe("SKU_STRIP_PG", () => {
  it("is byte-identical to the expression migration 0053 indexed", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toContain(`lower(regexp_replace(sku, '${SKU_STRIP_PG}', '', 'g'))`);
    expect(sql).toContain("products_tenant_norm_sku_idx");
  });

  it("enumerates every code point the JS \\s class strips (Postgres \\s is only [[:space:]])", () => {
    // Every JS-whitespace code point outside ASCII, plus the zero-width set.
    const jsSpaces = [
      0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
      0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
      0x200b, 0x200c, 0x200d,
    ];
    const covered = (cp: number): boolean => {
      const hex = cp.toString(16).toUpperCase().padStart(4, "0");
      if (SKU_STRIP_PG.includes(`\\u${hex}`)) return true;
      // Ranges: \uXXXX-\uYYYY
      for (const m of SKU_STRIP_PG.matchAll(/\\u([0-9A-F]{4})-\\u([0-9A-F]{4})/g)) {
        if (cp >= parseInt(m[1]!, 16) && cp <= parseInt(m[2]!, 16)) return true;
      }
      return false;
    };
    for (const cp of jsSpaces) {
      expect(normalizeSku(`a${String.fromCodePoint(cp)}b`)).toBe("ab");
      expect(covered(cp), `U+${cp.toString(16)}`).toBe(true);
    }
  });
});
