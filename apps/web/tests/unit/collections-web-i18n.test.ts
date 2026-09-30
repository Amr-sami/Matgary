/**
 * Digital collections — the web's dictionary subtrees (doc 15 spec 12 §4.12,
 * §7): `app.collections.web`, `app.shell.secondary.collections` and
 * `app.settingsPage.collectionsTile` have identical, non-empty leaves in ar
 * and en; every CollectionEventKind, DeviceHealth and IngestPlatform has a
 * label; and no copy says "accept payments", "gateway" or "refund the
 * transfer" (03 §A positioning, 02 §4.9).
 */
import { describe, expect, it } from "vitest";
import ar from "@matgary/i18n/ar";
import en from "@matgary/i18n/en";
import {
  COLLECTION_EVENT_KIND_VALUES,
  DEVICE_HEALTH_VALUES,
  INGEST_PLATFORM_VALUES,
} from "@matgary/domain/collections/types";

type Tree = { [k: string]: unknown };

function leaves(node: unknown, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof node === "string") {
    out.set(prefix, node);
    return out;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Tree)) {
      for (const [p, s] of leaves(v, prefix ? `${prefix}.${k}` : k)) out.set(p, s);
    }
  }
  return out;
}

function at(root: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((n, k) => (n as Tree | undefined)?.[k], root);
}

const SUBTREES = ["app.collections.web", "app.shell.secondary.collections", "app.settingsPage.collectionsTile"];

describe("collections web i18n", () => {
  for (const sub of SUBTREES) {
    it(`${sub}: same leaves in ar and en, none empty`, () => {
      const a = leaves(at(ar, sub), sub);
      const e = leaves(at(en, sub), sub);
      expect(a.size).toBeGreaterThan(0);
      expect([...a.keys()].sort()).toEqual([...e.keys()].sort());
      for (const [k, v] of [...a, ...e]) expect(v.trim(), k).not.toBe("");
    });
  }

  it("same {placeholders} in ar and en", () => {
    const a = leaves(at(ar, "app.collections.web"), "w");
    const e = leaves(at(en, "app.collections.web"), "w");
    const ph = (s: string) => (s.match(/\{[a-zA-Z]+\}/g) ?? []).sort().join(",");
    for (const [k, v] of a) expect(ph(v), k).toBe(ph(e.get(k) ?? ""));
  });

  it("every CollectionEventKind has a history label", () => {
    for (const dict of [ar, en]) {
      const events = at(dict, "app.collections.web.detail.events") as Tree;
      for (const kind of COLLECTION_EVENT_KIND_VALUES) expect(typeof events[kind], kind).toBe("string");
    }
  });

  it("every DeviceHealth and IngestPlatform has a label (M2 keys, added at M1)", () => {
    for (const dict of [ar, en]) {
      const health = at(dict, "app.collections.web.devices.health") as Tree;
      for (const h of DEVICE_HEALTH_VALUES) expect(typeof health[h], h).toBe("string");
      const platform = at(dict, "app.collections.web.devices.platform") as Tree;
      for (const p of INGEST_PLATFORM_VALUES) expect(typeof platform[p], p).toBe("string");
    }
  });

  it("copy never says accept payments / gateway / refund the transfer", () => {
    const enBad = /accept payments|payment gateway|process payments|refund the transfer|reverse the transfer/i;
    const arBad = ["استقبال المدفوعات", "بوابة دفع", "استرجاع التحويل"];
    for (const sub of SUBTREES) {
      for (const v of leaves(at(en, sub)).values()) expect(enBad.test(v), v).toBe(false);
      for (const v of leaves(at(ar, sub)).values()) for (const bad of arBad) expect(v.includes(bad), v).toBe(false);
    }
  });

  it("method labels resolve for every web method chip", () => {
    for (const dict of [ar, en]) {
      const pay = at(dict, "app.catalog.payment") as Tree;
      for (const m of ["cash", "instapay", "wallet", "card", "deferred"]) expect(typeof pay[m], m).toBe("string");
    }
    expect(at(ar, "app.catalog.payment.wallet")).toBe("محفظة موبايل");
  });
});
