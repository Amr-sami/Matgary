/**
 * HANDOFF §8 #2 — the refresh-time revocation verdict.
 *
 * `judgeRefresh` is the pure core of /api/v1/auth/refresh. The row facts come
 * from auth_devices; the live token_version from users. The bearer is NOT an
 * input — that was the hole: a device whose access token had expired
 * refreshed with no Authorization header, the old route had nothing to
 * compare against, and "sign out everywhere" missed exactly that device.
 * Migration 0052 puts the baseline on the row; these tests pin that the
 * verdict follows the row alone.
 */
import { describe, expect, it } from "vitest";

import { judgeRefresh, type RefreshRowFacts } from "@/lib/api/native-token";

const live = (over: Partial<RefreshRowFacts> = {}): RefreshRowFacts => ({
  revoked: false,
  replacedById: null,
  expired: false,
  tokenVersion: 3,
  ...over,
});

describe("judgeRefresh", () => {
  it("a live row issued under the current token_version rotates", () => {
    expect(judgeRefresh(live(), 3)).toEqual({ kind: "ok" });
  });

  it("sign out everywhere: a row behind users.token_version is refused with NO bearer in play", () => {
    // Issued under v3, the user has since bumped to v4. Nothing about the
    // client's headers is consulted — the row itself is the baseline.
    expect(judgeRefresh(live({ tokenVersion: 3 }), 4)).toEqual({ kind: "stale_version" });
  });

  it("a per-device revocation (DELETE /auth/devices?id=) is an ordinary dead token", () => {
    expect(judgeRefresh(live({ revoked: true }), 3)).toEqual({ kind: "revoked" });
  });

  it("revoked AND superseded is reuse — the secret leaked", () => {
    expect(judgeRefresh(live({ revoked: true, replacedById: "succ" }), 3)).toEqual({ kind: "reuse" });
  });

  it("reuse outranks a stale version: the sweep must not mask a leak", () => {
    expect(judgeRefresh(live({ revoked: true, replacedById: "succ", tokenVersion: 1 }), 3)).toEqual({
      kind: "reuse",
    });
  });

  it("a row the sweep already tombstoned reports revoked, not stale_version", () => {
    // bumpTokenVersion() revokes every live row AND bumps the version. The
    // verdict for such a row is the plain dead-token one; the version
    // comparison is the fallback for bumps that never swept (2FA, reset).
    expect(judgeRefresh(live({ revoked: true, tokenVersion: 2 }), 3)).toEqual({ kind: "revoked" });
  });

  it("expired rows are tombstoned before the version is ever compared", () => {
    expect(judgeRefresh(live({ expired: true, tokenVersion: 1 }), 3)).toEqual({ kind: "expired" });
  });

  it("a row AHEAD of the live version is also stale — versions only ever match or not", () => {
    // Cannot happen without a manual DB edit, but the comparison is
    // equality, not <=, so a forged-forward row buys nothing.
    expect(judgeRefresh(live({ tokenVersion: 9 }), 3)).toEqual({ kind: "stale_version" });
  });
});
