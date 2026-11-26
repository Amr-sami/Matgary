/**
 * SEC14-F5 regression: lib/repo/collections.ts and lib/repo/collection-matching.ts
 * import each other. A module-level read of the other file's export
 * (NO_SALE_COLLECTIONS once read EMPTY_EFFECTS) throws a TDZ ReferenceError when
 * the graph is entered from the other side, and every collections route then
 * 500s until the process restarts. Each entry point below is loaded first in a
 * fresh module registry, the way the v1 ingest route and paste load them.
 */
import { describe, expect, it, vi } from "vitest";

const ENTRY_POINTS = [
  "@/lib/repo/collection-ingest",
  "@/lib/repo/collection-matching",
  "@/lib/repo/collection-credits",
  "@/lib/repo/collection-devices",
  "@/lib/repo/collections",
] as const;

describe("collections repo import order (SEC14-F5)", () => {
  for (const entry of ENTRY_POINTS) {
    it(`loads cleanly when ${entry} is imported first`, async () => {
      vi.resetModules();
      await expect(import(entry)).resolves.toBeTruthy();
      const collections = await import("@/lib/repo/collections");
      expect(collections.NO_SALE_COLLECTIONS.matchEffects).toEqual({
        autoConfirmed: [],
        notify: [],
        bust: false,
      });
    });
  }
});
