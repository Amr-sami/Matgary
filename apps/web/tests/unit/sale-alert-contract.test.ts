/**
 * Doc 16 §12 — sale-alert contract checks, no DB:
 *   - parseAlertOrigin cases (the X-Alert-Origin header);
 *   - the SSE frame for a sale alert, and telling it apart from a bell marker;
 *   - the pure copy renderers;
 *   - text parity with the mobile app (channel id, sound name, plugin asset),
 *     read from the files — the server and the app must agree on both names;
 *   - the two cha_ching.wav files exist, are byte-identical, and are the
 *     format iOS and Android accept (RIFF/WAVE PCM, 16-bit mono, < 2 s, < 200 KB).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { formatSaleAlertSse, parseSaleAlertMessage, type SaleAlertEvent } from "@/lib/notifications/events";
import {
  MemoryBurstStore,
  parseAlertOrigin,
  renderSaleAlert,
  renderSaleSummary,
  SALE_ALERT_BURST_WINDOW_MS,
  SALE_ALERT_CHANNEL,
  SALE_ALERT_SOUND,
} from "@/lib/notifications/sale-alerts";

const REPO = path.resolve(__dirname, "../../../..");
const read = (rel: string) => readFileSync(path.join(REPO, rel), "utf8");

describe("parseAlertOrigin", () => {
  it("accepts an Expo token or a web:<uuid> origin, nothing else", () => {
    expect(parseAlertOrigin("ExponentPushToken[abc123]")).toBe("ExponentPushToken[abc123]");
    expect(parseAlertOrigin("ExpoPushToken[x]")).toBe("ExpoPushToken[x]");
    expect(parseAlertOrigin(" web:0f8fad5b-d9cb-469f-a165-70867728950e ")).toBe(
      "web:0f8fad5b-d9cb-469f-a165-70867728950e",
    );
    for (const bad of [
      null,
      undefined,
      "",
      "web:",
      "web:not-a-uuid",
      "web:0f8fad5b-d9cb-469f-a165-70867728950e-extra",
      "fcm:abc",
      "ExponentPushToken[]",
      `ExponentPushToken[${"x".repeat(300)}]`,
    ]) {
      expect(parseAlertOrigin(bad as string | null | undefined), String(bad)).toBeNull();
    }
  });
});

describe("SSE frame", () => {
  const alert: SaleAlertEvent = {
    t: "sale_alert",
    id: "line-1",
    title: "New sale · EGP 2,700",
    body: "INV-1 · 3 items",
    link: "/sales",
    origin: null,
  };

  it("formats `event: sale_alert` + one data line", () => {
    const frame = formatSaleAlertSse(alert);
    expect(frame.startsWith("event: sale_alert\ndata: {")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    expect(frame.split("\n").filter((l) => l.startsWith("data: "))).toHaveLength(1);
    expect(JSON.parse(frame.split("\n")[1]!.slice(6))).toEqual(alert);
  });

  it("tells a sale alert apart from a bell marker", () => {
    expect(parseSaleAlertMessage(JSON.stringify(alert))).toEqual(alert);
    expect(parseSaleAlertMessage("1")).toBeNull();
    expect(parseSaleAlertMessage("{not json")).toBeNull();
    expect(parseSaleAlertMessage(JSON.stringify({ t: "other", id: "x", title: "y" }))).toBeNull();
  });
});

describe("copy", () => {
  const base = {
    invoiceId: "INV-8K2Q",
    total: 2700,
    itemCount: 3,
    paymentMethod: "instapay" as const,
    sellerName: "أحمد محمد",
    branchName: "المعادي",
    offlineAt: null,
    timeZone: "Africa/Cairo",
  };

  it("matches the doc 16 §3 table", () => {
    expect(renderSaleAlert("ar", base)).toEqual({
      title: "بيع جديد · 2,700 ج.م",
      body: "INV-8K2Q · 3 قطع · إنستاباي · سجّلها أحمد · فرع المعادي",
    });
    expect(renderSaleAlert("en", { ...base, sellerName: "Ahmed", branchName: "Maadi" })).toEqual({
      title: "New sale · EGP 2,700",
      body: "INV-8K2Q · 3 items · InstaPay · by Ahmed · Maadi",
    });
    expect(renderSaleSummary("ar", { count: 5, total: 12400, branchName: "المعادي" })).toEqual({
      title: "5 بيعات جديدة · 12,400 ج.م",
      body: "في آخر دقيقة · فرع المعادي",
    });
    expect(renderSaleSummary("en", { count: 5, total: 12400, branchName: "Maadi" })).toEqual({
      title: "5 new sales · EGP 12,400",
      body: "In the last minute · Maadi",
    });
  });

  it("offline suffix: 12 h, Western digits, ص/م in Arabic", () => {
    // 11:32 UTC = 14:32 Cairo (EEST, UTC+3) on 2026-10-19.
    const at = new Date(Date.UTC(2026, 9, 19, 11, 32));
    expect(renderSaleAlert("en", { ...base, offlineAt: at }).body).toMatch(/ · recorded offline at 2:32 PM$/);
    expect(renderSaleAlert("ar", { ...base, offlineAt: at }).body).toMatch(/ · اتسجّلت أوفلاين الساعة 2:32 م$/);
    // A bad zone falls back to Cairo instead of throwing.
    expect(renderSaleAlert("en", { ...base, offlineAt: at, timeZone: "Not/AZone" }).body).toMatch(/2:32 PM$/);
  });

  it("a branch name that already says فرع is not doubled; empty parts vanish", () => {
    expect(renderSaleAlert("ar", { ...base, branchName: "فرع المعادي" }).body).toMatch(/ · فرع المعادي$/);
    expect(renderSaleAlert("ar", { ...base, branchName: "الفرع الرئيسي" }).body).toMatch(/ · الفرع الرئيسي$/);
    expect(renderSaleAlert("ar", { ...base, branchName: null, sellerName: "  " }).body).toBe(
      "INV-8K2Q · 3 قطع · إنستاباي",
    );
    expect(renderSaleAlert("ar", { ...base, itemCount: 2 }).body).toContain("قطعتين");
    expect(renderSaleAlert("ar", { ...base, itemCount: 12 }).body).toContain("12 قطعة");
  });
});

describe("MemoryBurstStore", () => {
  it("counts a sliding window, dedupes a sale id, and hands the summary claim to one caller", async () => {
    const s = new MemoryBurstStore();
    expect(await s.record("k", "a", 0)).toBe(1);
    expect(await s.record("k", "a", 1)).toBe(1);
    expect(await s.record("k", "b", 2)).toBe(2);
    expect(await s.record("k", "c", SALE_ALERT_BURST_WINDOW_MS + 1)).toBe(2);
    expect(await s.claimSummary("k", 0)).toBe(true);
    expect(await s.claimSummary("k", 1)).toBe(false);
    await s.pushPending("k", 10);
    await s.pushPending("k", 5);
    expect(await s.drainPending("k")).toEqual([10, 5]);
    expect(await s.drainPending("k")).toEqual([]);
    await s.releaseSummary("k");
    expect(await s.claimSummary("k", 2)).toBe(true);
  });
});

describe("mobile parity (doc 16 §4, §9.3)", () => {
  it("the server's channel and sound match PushRegistrar and the plugin asset", () => {
    expect(SALE_ALERT_CHANNEL).toBe("sales");
    expect(SALE_ALERT_SOUND).toBe("cha_ching.wav");
    const registrar = read("apps/mobile/src/effects/PushRegistrar.tsx");
    expect(registrar).toContain(`"${SALE_ALERT_CHANNEL}"`);
    expect(registrar).toContain(`"${SALE_ALERT_SOUND}"`);
    expect(read("apps/mobile/app.config.ts")).toContain(`./assets/sounds/${SALE_ALERT_SOUND}`);
  });
});

describe("cha_ching.wav (doc 16 §4)", () => {
  const mobile = path.join(REPO, "apps/mobile/assets/sounds/cha_ching.wav");
  const web = path.join(REPO, "apps/web/public/sounds/cha_ching.wav");

  it("exists in both apps, byte-identical", () => {
    expect(existsSync(mobile), mobile).toBe(true);
    expect(existsSync(web), web).toBe(true);
    expect(readFileSync(mobile).equals(readFileSync(web))).toBe(true);
  });

  it("is RIFF/WAVE PCM 16-bit mono, shorter than 2 s and smaller than 200 KB", () => {
    const buf = readFileSync(mobile);
    expect(statSync(mobile).size).toBeLessThan(200 * 1024);
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.toString("ascii", 8, 12)).toBe("WAVE");
    let off = 12;
    let fmt: { format: number; channels: number; rate: number; bits: number; blockAlign: number } | null = null;
    let dataBytes = -1;
    while (off + 8 <= buf.length) {
      const id = buf.toString("ascii", off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === "fmt ") {
        fmt = {
          format: buf.readUInt16LE(off + 8),
          channels: buf.readUInt16LE(off + 10),
          rate: buf.readUInt32LE(off + 12),
          blockAlign: buf.readUInt16LE(off + 20),
          bits: buf.readUInt16LE(off + 22),
        };
      } else if (id === "data") {
        dataBytes = size;
      }
      off += 8 + size + (size % 2);
    }
    expect(fmt).not.toBeNull();
    expect(fmt!.format).toBe(1);
    expect(fmt!.channels).toBe(1);
    expect(fmt!.bits).toBe(16);
    expect(dataBytes).toBeGreaterThan(0);
    const seconds = dataBytes / (fmt!.rate * fmt!.blockAlign);
    expect(seconds).toBeGreaterThan(0.5);
    expect(seconds).toBeLessThan(2);
  });
});
