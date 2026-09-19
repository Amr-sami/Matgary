import { afterEach, describe, expect, it } from "vitest";
import { appOrigin, safeNext } from "@/lib/url-safe";

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

// Regression guard for the "https://0.0.0.0:3000/ar/login" class of bug. In a
// self-hosted standalone build, req.url carries HOSTNAME (0.0.0.0 in the
// Dockerfile), so any route handler that builds an absolute redirect from it
// sends the browser somewhere unreachable. Only reproduces in production —
// `next dev` leaves hostname unset and it resolves to localhost.
describe("appOrigin", () => {
  const req = (headers: Record<string, string>, url = "https://0.0.0.0:3000/api/demo/exit") =>
    ({ headers: new Headers(headers), url }) as { headers: Headers; url: string };

  const saved = process.env.NEXT_PUBLIC_APP_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = saved;
  });

  it("prefers NEXT_PUBLIC_APP_URL over anything on the request", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://thestoro.com";
    expect(appOrigin(req({ host: "0.0.0.0:3000" }))).toBe("https://thestoro.com");
  });

  it("strips a trailing slash so new URL() joins cleanly", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://thestoro.com/";
    expect(new URL("/ar/login", appOrigin(req({}))).href).toBe("https://thestoro.com/ar/login");
  });

  it("falls back to the proxy's forwarded host, not req.url", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(
      appOrigin(req({ "x-forwarded-host": "thestoro.com", "x-forwarded-proto": "https" })),
    ).toBe("https://thestoro.com");
  });

  it("never returns the 0.0.0.0 origin while any host hint exists", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    expect(appOrigin(req({ host: "thestoro.com" }))).not.toContain("0.0.0.0");
  });
});
