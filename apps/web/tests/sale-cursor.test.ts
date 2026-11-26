import { describe, expect, it } from "vitest";
import { decodeSaleCursor, encodeSaleCursor } from "@/lib/repo/operations";

// The cursor is `<saleDate ISO>:<saleId>` and the ISO timestamp itself has
// colons in it. Splitting on the first ':' made every cursor decode to null,
// so ?paginated=1 handed back page 1 forever with a non-null nextCursor.
describe("sale cursor codec", () => {
  it("round-trips encode → decode", () => {
    const row = {
      saleDate: new Date("2026-09-18T13:45:07.123Z"),
      id: "c30680e2-1b2c-4d5e-8f90-0123456789ab",
    };
    const decoded = decodeSaleCursor(encodeSaleCursor(row));
    expect(decoded).not.toBeNull();
    expect(decoded!.id).toBe(row.id);
    expect(decoded!.saleDate.getTime()).toBe(row.saleDate.getTime());
  });

  it("accepts the client's all-f anchor cursor", () => {
    const decoded = decodeSaleCursor("2026-01-01T00:00:00.000Z:ffffffff-ffff-ffff-ffff-ffffffffffff");
    expect(decoded?.id).toBe("ffffffff-ffff-ffff-ffff-ffffffffffff");
    expect(decoded?.saleDate.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("rejects garbage", () => {
    expect(decodeSaleCursor(null)).toBeNull();
    expect(decodeSaleCursor("")).toBeNull();
    expect(decodeSaleCursor("no-colon")).toBeNull();
    expect(decodeSaleCursor("not-a-date:abc")).toBeNull();
    expect(decodeSaleCursor("2026-01-01T00:00:00.000Z:")).toBeNull();
  });
});
