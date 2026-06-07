import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/url-safe";

// Guards the open-redirect closure (#1). Anything that isn't a same-origin
// relative path MUST collapse to the fallback.
describe("safeNext", () => {
  it("returns the fallback for empty / null / undefined", () => {
    expect(safeNext(null)).toBe("/");
    expect(safeNext(undefined)).toBe("/");
    expect(safeNext("")).toBe("/");
  });

  it("returns the fallback for absolute URLs", () => {
    expect(safeNext("https://example.com")).toBe("/");
    expect(safeNext("http://evil.test/danger")).toBe("/");
    expect(safeNext("javascript:alert(1)")).toBe("/");
  });

  it("returns the fallback for protocol-relative URLs", () => {
    expect(safeNext("//evil.test")).toBe("/");
    expect(safeNext("//evil.test/dashboard")).toBe("/");
  });

  it("returns the fallback for backslash-prefixed paths (IE/Edge quirk)", () => {
    expect(safeNext("/\\evil.test")).toBe("/");
  });

  it("preserves a plain same-origin path", () => {
    expect(safeNext("/dashboard")).toBe("/dashboard");
    expect(safeNext("/ar/welcome")).toBe("/ar/welcome");
  });

  it("preserves a path with query string", () => {
    expect(safeNext("/reports?from=yesterday")).toBe(
      "/reports?from=yesterday",
    );
  });

  it("preserves a path with hash fragment", () => {
    expect(safeNext("/inventory#low-stock")).toBe("/inventory#low-stock");
  });

  it("uses a custom fallback when provided", () => {
    expect(safeNext("https://evil", "/safe-default")).toBe("/safe-default");
    expect(safeNext(null, "/login")).toBe("/login");
  });

  it("rejects non-string input", () => {
    // @ts-expect-error — runtime guard for user-supplied data.
    expect(safeNext(42)).toBe("/");
    // @ts-expect-error
    expect(safeNext({})).toBe("/");
  });
});
