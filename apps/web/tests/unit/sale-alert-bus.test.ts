/**
 * Doc 16 §6/§12 — the dashboard tab's sale-alert decisions, no DB, no DOM:
 *   - the SSE `data:` parser and the in-tab bus;
 *   - the tab's own origin is skipped (no toast, no chime);
 *   - one alert toasts in every tab but chimes in only one (the cross-tab
 *     localStorage claim), with stale claims purged and a broken storage
 *     failing open;
 *   - the 1.5 s chime throttle and the 3-toast stack;
 *   - playChime() resolves false on NotAllowedError (→ "Turn on sound"),
 *     and prime-then-play inside the click recovers;
 *   - the web origin header shape matches what the server accepts.
 */
import { describe, expect, it } from "vitest";

import {
  CHIME_MIN_GAP_MS,
  CLAIM_PREFIX,
  CLAIM_TTL_MS,
  ChimeThrottle,
  claimChime,
  decideSaleAlert,
  emitSaleAlert,
  parseSaleAlert,
  pushToast,
  subscribeSaleAlerts,
  type ClaimStorage,
  type SaleAlert,
} from "@/lib/sale-alerts/bus";
import { createChime, installChimePrimer, type ChimeAudio } from "@/lib/sale-alerts/chime";
import {
  alertOriginHeaders,
  getTabOrigin,
  isWebOrigin,
  outboxReplayHeaders,
} from "@/lib/sale-alerts/origin";
import { formatSaleAlertSse, type SaleAlertEvent } from "@/lib/notifications/events";
import { parseAlertOrigin } from "@/lib/notifications/sale-alerts";

/** A Map-backed Storage, shared between "tabs" like one browser profile. */
class MemStorage implements ClaimStorage {
  m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

class ThrowingStorage implements ClaimStorage {
  get length(): number {
    throw new Error("SecurityError");
  }
  key(): string | null {
    throw new Error("SecurityError");
  }
  getItem(): string | null {
    throw new Error("SecurityError");
  }
  setItem(): void {
    throw new Error("QuotaExceededError");
  }
  removeItem(): void {
    throw new Error("SecurityError");
  }
}

const OTHER = "web:0f8fad5b-d9cb-469f-a165-70867728950e";

function alert(id: string, origin: string | null = null): SaleAlert {
  return { t: "sale_alert", id, title: "New sale · EGP 2,700", body: "INV-1 · 3 items", link: "/sales", origin };
}

function tab(storage: ClaimStorage | null, origin = getTabOrigin()) {
  return { tabOrigin: origin, seen: new Set<string>(), storage, throttle: new ChimeThrottle() };
}

describe("parse + bus", () => {
  it("parses exactly what the server's SSE frame carries", () => {
    const ev: SaleAlertEvent = { t: "sale_alert", id: "line-1", title: "T", body: "B", link: "/sales", origin: OTHER };
    const frame = formatSaleAlertSse(ev);
    const data = frame.split("\n")[1]!.slice("data: ".length);
    expect(parseSaleAlert(data)).toEqual(ev);
  });

  it("rejects anything that is not a sale alert and sanitises the link", () => {
    expect(parseSaleAlert("1")).toBeNull();
    expect(parseSaleAlert("{bad")).toBeNull();
    expect(parseSaleAlert(JSON.stringify({ t: "other", id: "x", title: "y" }))).toBeNull();
    expect(parseSaleAlert(JSON.stringify({ t: "sale_alert", id: "", title: "y" }))).toBeNull();
    const a = parseSaleAlert(JSON.stringify({ t: "sale_alert", id: "x", title: "y", link: "https://evil.example" }));
    expect(a?.link).toBe("/sales");
    expect(a?.body).toBeNull();
    expect(a?.origin).toBeNull();
  });

  it("delivers to every subscriber until it unsubscribes", () => {
    const got: string[] = [];
    const off1 = subscribeSaleAlerts((a) => got.push(`1:${a.id}`));
    const off2 = subscribeSaleAlerts(() => {
      throw new Error("bad listener");
    });
    const off3 = subscribeSaleAlerts((a) => got.push(`3:${a.id}`));
    emitSaleAlert(alert("a"));
    off1();
    emitSaleAlert(alert("b"));
    off2();
    off3();
    emitSaleAlert(alert("c"));
    expect(got).toEqual(["1:a", "3:a", "3:b"]);
  });
});

describe("decideSaleAlert", () => {
  it("skips the tab that recorded the sale", () => {
    const me = tab(new MemStorage());
    expect(decideSaleAlert(alert("s1", me.tabOrigin), { ...me, now: 0 })).toEqual({ toast: false, chime: false });
    // Another tab's sale, a phone's sale (origin null) and a summary all ring.
    expect(decideSaleAlert(alert("s2", OTHER), { ...me, now: 0 })).toEqual({ toast: true, chime: true });
    expect(decideSaleAlert(alert("s3", null), { ...me, now: 5_000 })).toEqual({ toast: true, chime: true });
  });

  it("two tabs: both toast, only one chimes", () => {
    const shared = new MemStorage();
    const a = tab(shared, "web:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const b = tab(shared, "web:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    const da = decideSaleAlert(alert("s1"), { ...a, now: 1_000 });
    const db = decideSaleAlert(alert("s1"), { ...b, now: 1_010 });
    expect(da).toEqual({ toast: true, chime: true });
    expect(db).toEqual({ toast: true, chime: false });
    // The next alert can be claimed by either; here b gets it first.
    expect(decideSaleAlert(alert("s2"), { ...b, now: 5_000 }).chime).toBe(true);
    expect(decideSaleAlert(alert("s2"), { ...a, now: 5_001 }).chime).toBe(false);
  });

  it("a frame delivered twice to the same tab toasts once", () => {
    const me = tab(new MemStorage());
    expect(decideSaleAlert(alert("s1"), { ...me, now: 0 }).toast).toBe(true);
    expect(decideSaleAlert(alert("s1"), { ...me, now: 10 })).toEqual({ toast: false, chime: false });
  });

  it("throttles chimes to >= 1.5 s apart but still toasts every sale", () => {
    const me = tab(new MemStorage());
    expect(decideSaleAlert(alert("s1"), { ...me, now: 10_000 })).toEqual({ toast: true, chime: true });
    expect(decideSaleAlert(alert("s2"), { ...me, now: 10_000 + CHIME_MIN_GAP_MS - 1 })).toEqual({
      toast: true,
      chime: false,
    });
    expect(decideSaleAlert(alert("s3"), { ...me, now: 10_000 + CHIME_MIN_GAP_MS })).toEqual({
      toast: true,
      chime: true,
    });
  });

  it("no storage, or storage that throws, fails open (chime)", () => {
    expect(decideSaleAlert(alert("s1"), { ...tab(null), now: 0 }).chime).toBe(true);
    expect(decideSaleAlert(alert("s1"), { ...tab(new ThrowingStorage()), now: 0 }).chime).toBe(true);
  });
});

describe("claimChime", () => {
  it("purges claims older than 60 s and leaves other keys alone", () => {
    const s = new MemStorage();
    s.setItem("unrelated", "keep");
    expect(claimChime(s, "old", 0)).toBe(true);
    expect(claimChime(s, "old", 1)).toBe(false);
    expect(claimChime(s, "fresh", CLAIM_TTL_MS)).toBe(true);
    // At t = 60 001 the "old" claim (t=0) is purged; "fresh" (t=60 000) stays.
    expect(claimChime(s, "x", CLAIM_TTL_MS + 1)).toBe(true);
    expect(s.getItem(CLAIM_PREFIX + "old")).toBeNull();
    expect(s.getItem(CLAIM_PREFIX + "fresh")).not.toBeNull();
    expect(s.getItem("unrelated")).toBe("keep");
    // A garbage claim value is treated as stale.
    s.setItem(CLAIM_PREFIX + "junk", "nope");
    claimChime(s, "y", CLAIM_TTL_MS + 2);
    expect(s.getItem(CLAIM_PREFIX + "junk")).toBeNull();
  });
});

describe("pushToast", () => {
  it("keeps at most 3, newest last, and replaces a duplicate id", () => {
    let list: { id: string }[] = [];
    for (const id of ["a", "b", "c", "d"]) list = pushToast(list, { id });
    expect(list.map((x) => x.id)).toEqual(["b", "c", "d"]);
    list = pushToast(list, { id: "c" });
    expect(list.map((x) => x.id)).toEqual(["b", "d", "c"]);
  });
});

describe("chime (autoplay)", () => {
  function fakeAudio(policy: { allowed: boolean }) {
    const calls: string[] = [];
    const a: ChimeAudio = {
      muted: false,
      currentTime: 0,
      preload: "",
      play() {
        calls.push(a.muted ? "play(muted)" : "play");
        if (policy.allowed) return Promise.resolve();
        const err = new Error("play() failed because the user didn't interact");
        err.name = "NotAllowedError";
        return Promise.reject(err);
      },
      pause() {
        calls.push("pause");
      },
    };
    return { a, calls };
  }

  it("resolves false on NotAllowedError, then prime + play inside a click succeeds", async () => {
    const policy = { allowed: false };
    const { a, calls } = fakeAudio(policy);
    const chime = createChime(() => a);
    expect(await chime.play()).toBe(false);
    expect(chime.unlocked).toBe(false);
    // The "Turn on sound" click: the browser now counts a user activation.
    policy.allowed = true;
    chime.prime();
    expect(await chime.play()).toBe(true);
    expect(chime.unlocked).toBe(true);
    expect(a.preload).toBe("auto");
    expect(calls[0]).toBe("play");
    expect(calls).toContain("play(muted)");
    expect(a.muted).toBe(false);
  });

  it("no Audio (SSR) → false, never throws", async () => {
    const chime = createChime(() => null);
    chime.prime();
    expect(await chime.play()).toBe(false);
  });

  it("the primer hooks pointerdown and keydown once, and removes them", () => {
    const added: string[] = [];
    const removed: string[] = [];
    const doc = {
      addEventListener: (t: string) => added.push(t),
      removeEventListener: (t: string) => removed.push(t),
    } as unknown as Pick<Document, "addEventListener" | "removeEventListener">;
    const off = installChimePrimer(doc);
    const again = installChimePrimer(doc); // idempotent while installed
    expect(added).toEqual(["pointerdown", "keydown"]);
    again();
    off();
    expect(removed).toEqual(["pointerdown", "keydown"]);
  });
});

describe("web origin header", () => {
  it("is stable per page load and accepted by the server's parser", () => {
    const o = getTabOrigin();
    expect(getTabOrigin()).toBe(o);
    expect(isWebOrigin(o)).toBe(true);
    expect(parseAlertOrigin(o)).toBe(o);
    expect(alertOriginHeaders()).toEqual({ "X-Alert-Origin": o });
    expect(outboxReplayHeaders()).toEqual({ "X-Alert-Origin": o, "X-Outbox-Replay": "1" });
    expect(isWebOrigin("web:nope")).toBe(false);
  });
});
