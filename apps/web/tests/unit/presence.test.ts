/**
 * Phase 2 — canonical constants + UA platform classifier.
 *
 * These are the two pure-function surfaces the whole presence system relies
 * on. The heartbeat DB write path is covered by the throttle-behavior test;
 * the aggregate SQL by a live smoke test in the stabilization shell.
 */
import { describe, expect, it } from "vitest";
import {
  ACTIVE_15M_MS,
  ACTIVE_5M_MS,
  HEARTBEAT_THROTTLE_MS,
  ONLINE_WINDOW_MS,
  REPORTING_TZ,
  classifyWebPlatform,
} from "@/lib/admin/presence";

describe("presence canonical constants", () => {
  it("online window is 5 minutes exactly", () => {
    expect(ONLINE_WINDOW_MS).toBe(5 * 60 * 1000);
    expect(ACTIVE_5M_MS).toBe(5 * 60 * 1000);
  });

  it("15m window is 15 minutes", () => {
    expect(ACTIVE_15M_MS).toBe(15 * 60 * 1000);
  });

  it("heartbeat throttle is 60 seconds", () => {
    expect(HEARTBEAT_THROTTLE_MS).toBe(60 * 1000);
  });

  it("reporting TZ defaults to Africa/Cairo (env override respected elsewhere)", () => {
    // Current process has no STORO_REPORTING_TZ in test env → default.
    expect(REPORTING_TZ).toBe("Africa/Cairo");
  });
});

describe("UA → platform classifier", () => {
  it("classifies Chrome / Safari / Firefox / Edge as 'web'", () => {
    expect(
      classifyWebPlatform(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ),
    ).toBe("web");
    expect(
      classifyWebPlatform(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
      ),
    ).toBe("web");
    expect(
      classifyWebPlatform(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
      ),
    ).toBe("web");
  });

  it("classifies curl / wget / bots as 'other' (never inflates web)", () => {
    expect(classifyWebPlatform("curl/8.4.0")).toBe("other");
    expect(classifyWebPlatform("Wget/1.21.4")).toBe("other");
    expect(classifyWebPlatform("Googlebot/2.1")).toBe("other");
    expect(classifyWebPlatform("UptimeRobot/2.0")).toBe("other");
    expect(classifyWebPlatform("go-http-client/1.1")).toBe("other");
    expect(classifyWebPlatform("node-fetch/1.0")).toBe("other");
    expect(classifyWebPlatform("python-requests/2.31.0")).toBe("other");
  });

  it("returns 'other' on missing / empty / nonsense UA", () => {
    expect(classifyWebPlatform(null)).toBe("other");
    expect(classifyWebPlatform("")).toBe("other");
    expect(classifyWebPlatform("asdfghjkl")).toBe("other");
  });
});
