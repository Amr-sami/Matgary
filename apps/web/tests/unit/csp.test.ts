import { describe, expect, it } from "vitest";
import { buildCspHeader } from "@/lib/csp";

// Audit web W3: `https://o*.ingest.sentry.io` is not a valid CSP source (a
// host wildcard is allowed only as the whole left-most label), so browsers
// dropped it with a console warning on every page.
const directives = (h: string) =>
  Object.fromEntries(
    h.split(";").map((d) => {
      const [name, ...sources] = d.trim().split(/\s+/);
      return [name, sources];
    }),
  );

// CSP3 host-source: [scheme "://"] host [":" port] [path]; host = "*" / ["*."] 1*host-char *("." 1*host-char)
const HOST_SOURCE = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:\*|(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*)(?::(?:\d+|\*))?(?:\/[^\s;,]*)?$/i;
const KEYWORD = /^'(?:self|none|unsafe-inline|unsafe-eval|strict-dynamic|nonce-[A-Za-z0-9+/=_-]+)'$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:$/i;

describe("CSP header (lib/csp.ts)", () => {
  it("every source in every directive is a valid CSP source expression", () => {
    for (const isDev of [false, true]) {
      const d = directives(buildCspHeader("abc123==", isDev));
      for (const [name, sources] of Object.entries(d)) {
        if (name === "upgrade-insecure-requests") continue;
        for (const s of sources) {
          const ok = KEYWORD.test(s) || SCHEME.test(s) || HOST_SOURCE.test(s);
          expect(ok, `${name}: ${s}`).toBe(true);
        }
      }
    }
  });

  it("Sentry ingest stays reachable with valid wildcards (W3)", () => {
    const connect = directives(buildCspHeader("n", false))["connect-src"];
    expect(connect).toContain("https://*.sentry.io");
    expect(connect).toContain("https://*.ingest.sentry.io");
    expect(connect.some((s: string) => /\w\*/.test(s))).toBe(false); // no mid-label wildcard like o*
  });

  it("nonce and dev-only unsafe-eval in script-src", () => {
    expect(directives(buildCspHeader("N0NCE", false))["script-src"]).toEqual(["'self'", "'nonce-N0NCE'", "'strict-dynamic'"]);
    expect(directives(buildCspHeader("N0NCE", true))["script-src"]).toContain("'unsafe-eval'");
  });
});
