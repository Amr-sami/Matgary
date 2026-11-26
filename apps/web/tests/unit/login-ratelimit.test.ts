/**
 * Doc 14 §10 M4 + D11 — the native login's rate-limit discipline.
 *
 * The bug: POST /api/v1/auth/login ran the per-identifier limiter with
 * commit:true BEFORE the password check, so five successful sign-ins in 15
 * minutes locked the account, and anyone who knew an email could lock its
 * owner out by signing in correctly on their behalf. The web authorize() in
 * lib/auth.ts already peeks and consumes only after a failed password; the
 * native route now mirrors it. D11 widens the per-IP bucket to 30/15 min.
 *
 * Pinned from SOURCE (see route-gates.test.ts for why): the handler's import
 * chain reaches Postgres and Redis, and the contract is the ORDER of a few
 * calls — peek, bcrypt, consume-on-failure.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = readFileSync(
  fileURLToPath(new URL("../../app/api/v1/auth/login/route.ts", import.meta.url)),
  "utf8",
);

/** Index of the first occurrence, failing loudly when absent. */
function at(needle: string): number {
  const i = src.indexOf(needle);
  expect(i, `expected login route to contain ${JSON.stringify(needle)}`).toBeGreaterThanOrEqual(0);
  return i;
}

describe("POST /api/v1/auth/login rate limits", () => {
  it("D11: login.ip is 30 per 15 minutes; login.email stays 5", () => {
    expect(src).toContain("const LOGIN_IP_LIMIT = 30;");
    expect(src).toContain("const LOGIN_EMAIL_LIMIT = 5;");
    expect(src).toContain("const LOGIN_WINDOW_SEC = 15 * 60;");
    // No literal buckets survive — the constants are the single source.
    expect(src).not.toMatch(/rateLimit\("login\.ip",[^)]*limit:\s*10\b/);
    expect(src).not.toMatch(/rateLimit\("login\.email",[^)]*limit:\s*5\b/);
  });

  it("M4: both limiters PEEK (commit:false) before the password check", () => {
    const ipPeek = at('rateLimit("login.ip", ip, {');
    const ipBlock = src.slice(ipPeek, src.indexOf("});", ipPeek));
    expect(ipBlock).toContain("commit: false");

    const emailPeek = at('rateLimit("login.email", identifier, {');
    const emailBlock = src.slice(emailPeek, src.indexOf("});", emailPeek));
    expect(emailBlock).toContain("commit: false");

    const compare = at("bcrypt.compare(body.password");
    expect(ipPeek).toBeLessThan(compare);
    expect(emailPeek).toBeLessThan(compare);
  });

  it("M4: rateLimitConsume for both buckets runs only inside the failed-password branch", () => {
    expect(src).toContain('import { rateLimit, rateLimitConsume } from "@/lib/ratelimit";');
    const failBranch = at("if (!user || !ok) {");
    const failEnd = src.indexOf("}", src.indexOf("status: 401", failBranch));
    const branch = src.slice(failBranch, failEnd);
    expect(branch).toContain('rateLimitConsume("login.ip", ip,');
    expect(branch).toContain('rateLimitConsume("login.email", identifier,');
    expect(branch).toContain("INVALID_CREDENTIALS");
    // Exactly two consumes in the whole file, both in that branch.
    expect(src.match(/rateLimitConsume\(/g)?.length).toBe(2);
    // The consume awaits before the 401 is returned.
    expect(branch.indexOf("rateLimitConsume")).toBeLessThan(branch.indexOf("status: 401"));
  });

  it("a successful password never consumes a bucket", () => {
    const failBranch = at("if (!user || !ok) {");
    const afterFail = src.slice(src.indexOf("status: 401", failBranch));
    expect(afterFail).not.toContain("rateLimitConsume(");
    // And nothing consumes before the compare either.
    const beforeCompare = src.slice(0, at("bcrypt.compare(body.password"));
    expect(beforeCompare.replace(/import[^\n]*\n/g, "")).not.toContain("rateLimitConsume(");
  });
});
