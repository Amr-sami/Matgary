/**
 * Doc 15 spec 13 §7 T1 — the collection notification registry, pure.
 *
 *   - every event has recipients, both default rows, a push default, a kind
 *     and a digest label (a runtime walk on top of tsc's Record checks);
 *   - the five 03 §B.6 / D13-2 defaults, exactly;
 *   - EVENT_RECIPIENT_PERMISSION and visibleEventTypes (D13-8);
 *   - renderInApp for every collection event × ar/en × every unmatched hold
 *     reason × every limit warning: non-empty copy, formatted amounts, never
 *     "undefined" / "null" / "NaN";
 *   - stale plurals and durations;
 *   - Q18: dispatch.ts never names a payer field;
 *   - push: the server-side mobile route override, the Android channel per
 *     kind, and the channel on the Expo wire payload.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  countAr,
  durAr,
  durEn,
  EVENT_TO_KIND,
  methodName,
  renderInApp,
  type EventPayloadMap,
} from "@/lib/notifications/dispatch";
import {
  DEFAULT_EVENT_LINK,
  DEFAULT_EVENT_PREFERENCE,
  EVENT_LABELS,
  EVENT_RECIPIENT_PERMISSION,
  EVENT_RECIPIENT_ROLES,
  NOTIFICATION_EVENT_TYPES,
  visibleEventTypes,
  type NotificationEventType,
} from "@/lib/notifications/event-types";
import { toExpoRequest } from "@/lib/push/expo-push";
import { channelForKind, KIND_MOBILE_ROUTE_OVERRIDE, routeForNotification } from "@/lib/push/notify";
import { DEFAULT_PUSH } from "@/lib/repo/notifications";

const COLLECTION_EVENTS = [
  "collection.pending",
  "collection.stale",
  "collection.unmatched_credit",
  "collection.source_silent",
  "collection.limit_warning",
] as const satisfies readonly NotificationEventType[];

// The five pre-collections events. `sale.alert` (doc 16) is neither: it is
// push-only, has no fanout recipients and is gated by view_sales.
const LEGACY_EVENTS = NOTIFICATION_EVENT_TYPES.filter(
  (e) => !e.startsWith("collection.") && e !== "sale.alert",
);
/** LEGACY_EVENTS with `sale.alert` in its registry slot (right after sale.created). */
const withSaleAlert = (evs: readonly NotificationEventType[]): NotificationEventType[] => [
  evs[0]!,
  "sale.alert",
  ...evs.slice(1),
];

describe("registry walk", () => {
  it("lists the five collection events after the five legacy ones, in 13 §4.2 order", () => {
    expect(NOTIFICATION_EVENT_TYPES).toEqual([
      "sale.created",
      "sale.alert",
      "purchase.received",
      "inventory.low_stock",
      "payment.deferred_settled",
      "leave.requested",
      ...COLLECTION_EVENTS,
    ]);
  });

  it("gives every event roles, both default rows, a push default, a kind and a label", () => {
    for (const e of NOTIFICATION_EVENT_TYPES) {
      expect(EVENT_RECIPIENT_ROLES[e], e).toBeDefined();
      for (const role of ["owner", "staff"] as const) {
        const d = DEFAULT_EVENT_PREFERENCE[role][e];
        expect(d, `${role} ${e}`).toBeDefined();
        expect(typeof d.inApp).toBe("boolean");
        expect(typeof d.email).toBe("boolean");
        expect(["instant", "digest"]).toContain(d.digestMode);
        expect(typeof DEFAULT_PUSH[role][e], `push ${role} ${e}`).toBe("boolean");
      }
      expect(EVENT_TO_KIND[e], e).toBeTruthy();
      expect(EVENT_LABELS[e].ar.trim(), e).not.toBe("");
      expect(EVENT_LABELS[e].en.trim(), e).not.toBe("");
    }
  });

  it("keeps the legacy digest labels verbatim (moved from notifications-digest)", () => {
    expect(EVENT_LABELS["sale.created"]).toEqual({ ar: "المبيعات", en: "Sales" });
    expect(EVENT_LABELS["purchase.received"]).toEqual({ ar: "التوريدات المستلمة", en: "Purchases received" });
    expect(EVENT_LABELS["inventory.low_stock"]).toEqual({ ar: "تنبيهات مخزون منخفض", en: "Low stock alerts" });
    expect(EVENT_LABELS["payment.deferred_settled"]).toEqual({
      ar: "مدفوعات آجل مسدّدة",
      en: "Deferred settlements",
    });
    expect(EVENT_LABELS["leave.requested"]).toEqual({ ar: "طلبات إجازة", en: "Leave requests" });
  });

  it("maps each collection event to its own kind, 1:1", () => {
    expect(COLLECTION_EVENTS.map((e) => EVENT_TO_KIND[e])).toEqual([
      "collection_pending",
      "collection_stale",
      "collection_unmatched",
      "collection_source_silent",
      "collection_limit",
    ]);
    // No legacy event moved.
    expect(LEGACY_EVENTS.map((e) => EVENT_TO_KIND[e])).toEqual([
      "info",
      "info",
      "low_stock",
      "info",
      "leave_submitted",
    ]);
  });
});

describe("collection defaults (03 §B.6 + D13-2)", () => {
  it("sends every collection event to owners by role and to staff only by permission", () => {
    for (const e of COLLECTION_EVENTS) expect(EVENT_RECIPIENT_ROLES[e]).toEqual(["owner"]);
    expect(EVENT_RECIPIENT_PERMISSION).toEqual({
      "collection.pending": "view_collections",
      "collection.stale": "view_collections",
      "collection.unmatched_credit": "view_collections",
      "collection.source_silent": "manage_collection_accounts",
      "collection.limit_warning": "manage_collection_accounts",
    });
    for (const e of LEGACY_EVENTS) expect(EVENT_RECIPIENT_PERMISSION[e]).toBeUndefined();
  });

  it("owner: in-app on; push on for stale/unmatched/silent only; email only for silent; pending is digest", () => {
    const o = DEFAULT_EVENT_PREFERENCE.owner;
    expect(o["collection.pending"]).toEqual({ inApp: true, email: false, digestMode: "digest" });
    expect(o["collection.stale"]).toEqual({ inApp: true, email: false, digestMode: "instant" });
    expect(o["collection.unmatched_credit"]).toEqual({ inApp: true, email: false, digestMode: "instant" });
    expect(o["collection.source_silent"]).toEqual({ inApp: true, email: true, digestMode: "instant" });
    expect(o["collection.limit_warning"]).toEqual({ inApp: true, email: false, digestMode: "instant" });
    expect(COLLECTION_EVENTS.map((e) => DEFAULT_PUSH.owner[e])).toEqual([false, true, true, true, false]);
  });

  it("staff (permission holders): same channels, never email", () => {
    const s = DEFAULT_EVENT_PREFERENCE.staff;
    for (const e of COLLECTION_EVENTS) {
      expect(s[e].inApp, e).toBe(true);
      expect(s[e].email, e).toBe(false);
    }
    expect(s["collection.pending"].digestMode).toBe("digest");
    expect(COLLECTION_EVENTS.map((e) => DEFAULT_PUSH.staff[e])).toEqual([false, true, true, true, false]);
  });

  it("legacy push defaults are unchanged", () => {
    expect(LEGACY_EVENTS.map((e) => DEFAULT_PUSH.owner[e])).toEqual([false, true, true, true, true]);
    expect(LEGACY_EVENTS.map((e) => DEFAULT_PUSH.staff[e])).toEqual([false, true, true, false, false]);
  });

  it("has a default web link for every collection event and none for legacy ones", () => {
    expect(DEFAULT_EVENT_LINK).toEqual({
      "collection.pending": "/collections?status=pending",
      "collection.stale": "/collections?status=pending&stale=1",
      "collection.unmatched_credit": "/collections?tab=credits",
      "collection.source_silent": "/settings/collections",
      "collection.limit_warning": "/collections?tab=totals",
    });
  });
});

describe("visibleEventTypes (D13-8)", () => {
  it("owner, tenant not admitted → the five legacy events + sale alerts", () => {
    expect(visibleEventTypes("owner", [], false)).toEqual(withSaleAlert(LEGACY_EVENTS));
  });
  it("sale.alert is listed to the owner and to staff holding view_sales only (doc 16 §7)", () => {
    expect(visibleEventTypes("staff", ["record_sales"], false)).toEqual(LEGACY_EVENTS);
    expect(visibleEventTypes("staff", ["record_sales", "view_sales"], false)).toEqual(withSaleAlert(LEGACY_EVENTS));
    expect(visibleEventTypes("staff", ["view_sales", "view_collections"], true)).toContain("sale.alert");
    expect(EVENT_RECIPIENT_PERMISSION["sale.alert"]).toBeUndefined();
  });
  it("owner, admitted → all eleven", () => {
    expect(visibleEventTypes("owner", [], true)).toEqual([...NOTIFICATION_EVENT_TYPES]);
  });
  it("staff with view_collections → 8", () => {
    const v = visibleEventTypes("staff", ["record_sales", "view_collections"], true);
    expect(v).toHaveLength(8);
    expect(v).toEqual([
      ...LEGACY_EVENTS,
      "collection.pending",
      "collection.stale",
      "collection.unmatched_credit",
    ]);
  });
  it("staff with manage_collection_accounts → 7", () => {
    const v = visibleEventTypes("staff", ["manage_collection_accounts"], true);
    expect(v).toEqual([...LEGACY_EVENTS, "collection.source_silent", "collection.limit_warning"]);
  });
  it("staff with both keys → 10; with neither → 5; either way 5 when not admitted", () => {
    expect(visibleEventTypes("staff", ["view_collections", "manage_collection_accounts"], true)).toHaveLength(10);
    expect(visibleEventTypes("staff", ["confirm_collections"], true)).toEqual(LEGACY_EVENTS);
    expect(visibleEventTypes("staff", ["view_collections", "manage_collection_accounts"], false)).toEqual(
      LEGACY_EVENTS,
    );
  });
});

// ─── Copy ─────────────────────────────────────────────────────────────────────

const HOLD_REASONS = [
  null,
  "ambiguous",
  "untrusted_source",
  "balance_mismatch",
  "no_balance_baseline",
  "above_review_limit",
  "no_account",
  "unverified_format",
  "manual_source",
  "suspicious_link",
  "too_old",
  "amount_mismatch",
  "auto_confirm_off",
  "matches_rejected",
  "test",
] as const;
const WARNINGS = ["day_80", "month_80", "new_wallet_day_80", "balance_90"] as const;

type Case = { [E in NotificationEventType]: { event: E; payload: EventPayloadMap[E]; amount: string } }[NotificationEventType];

function cases(): Case[] {
  const out: Case[] = [];
  for (const sourceType of ["sale", "settlement"] as const) {
    for (const method of ["instapay", "wallet"] as const) {
      for (const [partsCount, accountLabel] of [
        [1, "CIB business"],
        [2, null],
        [4, "Vodafone Cash counter"],
      ] as const) {
        out.push({
          event: "collection.pending",
          amount: "1,250",
          payload: {
            invoiceId: sourceType === "sale" ? "INV-1" : null,
            sourceType,
            method,
            amountEgp: 1250,
            partsCount,
            accountLabel,
            customerName: "Customer record",
            branchName: "Main",
            actorUserId: null,
          },
        });
      }
    }
  }
  for (const count of [1, 2, 3, 11]) {
    for (const branchName of ["Main", null]) {
      out.push({
        event: "collection.stale",
        amount: "12,500",
        payload: { branchName, count, amountEgp: 12_500, staleAfterMinutes: 120 },
      });
    }
  }
  for (const holdReason of HOLD_REASONS) {
    for (const accountLabel of ["NBE salary", null]) {
      out.push({
        event: "collection.unmatched_credit",
        amount: "3,400",
        payload: {
          creditId: "c1",
          accountId: accountLabel ? "a1" : null,
          accountLabel,
          amount: 3400,
          state: holdReason ? "held" : "unmatched",
          holdReason,
          suggestedCollectionId: null,
        },
      });
    }
  }
  for (const missedCount of [1, 3, 12]) {
    out.push({
      event: "collection.source_silent",
      amount: "",
      payload: {
        deviceId: "d1",
        deviceLabel: "Owner iPhone",
        platform: "ios_shortcut",
        missedCount,
        branchName: null,
        link: "/settings/collections",
      },
    });
  }
  for (const warning of WARNINGS) {
    for (const limitEgp of [60_000, null]) {
      out.push({
        event: "collection.limit_warning",
        // 13 §4.5: the new-wallet copy quotes the limit, not the day total.
        amount: warning !== "new_wallet_day_80" ? "48,500" : limitEgp ? "60,000" : "",
        payload: {
          accountId: "a1",
          accountLabel: "VF cash",
          accountMask: "***0150",
          provider: "vodafone_cash",
          warning,
          receivedEgp: 48_500,
          limitEgp,
          link: `/collections?tab=totals&account=a1&warning=${warning}`,
        },
      });
    }
  }
  return out;
}

describe("renderInApp — every collection event × locale × variant", () => {
  const all = cases();

  it("covers every variant (sanity)", () => {
    expect(all.length).toBe(12 + 8 + 30 + 3 + 8);
  });

  it("renders a non-empty title and body with no undefined/null/NaN, amounts formatted", () => {
    for (const c of all) {
      for (const locale of ["ar", "en"] as const) {
        const r = renderInApp(c.event, c.payload as never, locale);
        const label = `${c.event} ${locale} ${JSON.stringify(c.payload)}`;
        expect(r.title.trim(), label).not.toBe("");
        expect(r.title, label).not.toBe(c.event); // never the default branch
        expect(r.body ?? "", label).not.toBe("");
        const text = `${r.title}\n${r.body ?? ""}`;
        expect(text, label).not.toMatch(/undefined|null|NaN/);
        if (c.amount) expect(text, label).toContain(c.amount);
        // Western digits only (fmtEgp uses en-US), no Arabic-Indic digits.
        expect(text, label).not.toMatch(/[٠-٩]/);
      }
    }
  });

  it("never renders the customer record or any payer detail", () => {
    for (const c of all) {
      for (const locale of ["ar", "en"] as const) {
        const r = renderInApp(c.event, c.payload as never, locale);
        expect(`${r.title} ${r.body}`).not.toContain("Customer record");
      }
    }
  });

  it("pending: settlement prefix, method label, missing account, parts count", () => {
    const base = cases()[0]!.payload as EventPayloadMap["collection.pending"];
    const en = renderInApp("collection.pending", { ...base, sourceType: "settlement", method: "wallet", accountLabel: null, partsCount: 2 }, "en");
    expect(en.title).toBe("Transfer awaiting confirmation — EGP 1,250");
    expect(en.body).toBe("Debt payment · Mobile wallet · no account · 2 transfers · Main");
    const ar = renderInApp("collection.pending", { ...base, sourceType: "sale", method: "instapay", accountLabel: "CIB", partsCount: 1 }, "ar");
    expect(ar.title).toBe("تحويل في انتظار التأكيد — 1,250 ج.م");
    expect(ar.body).toBe("إنستاباي · CIB · Main");
  });

  it("unmatched: the reason picks the copy", () => {
    const p = (holdReason: string | null, state: "held" | "unmatched" = "held") =>
      ({
        creditId: "c",
        accountId: "a",
        accountLabel: "NBE",
        amount: 150,
        state,
        holdReason,
        suggestedCollectionId: null,
      }) as EventPayloadMap["collection.unmatched_credit"];
    expect(renderInApp("collection.unmatched_credit", p(null, "unmatched"), "en").title).toBe(
      "EGP 150 arrived on NBE with no matching sale",
    );
    expect(renderInApp("collection.unmatched_credit", p("no_account"), "en")).toEqual({
      title: "EGP 150 arrived",
      body: "We couldn't tell which account received it — pick one",
    });
    expect(renderInApp("collection.unmatched_credit", p("balance_mismatch"), "en").body).toMatch(/balance/);
    expect(renderInApp("collection.unmatched_credit", p("suspicious_link"), "en").body).toMatch(/link/);
    expect(renderInApp("collection.unmatched_credit", p("matches_rejected"), "en").title).toBe(
      "EGP 150 arrived for a transfer you rejected",
    );
    expect(renderInApp("collection.unmatched_credit", p("unverified_format"), "en").body).toBe(
      "It needs your check in Collections",
    );
    expect(
      renderInApp("collection.unmatched_credit", { ...p(null, "unmatched"), accountLabel: null }, "ar").title,
    ).toContain("حساب غير معروف");
  });

  it("limit: label + ASCII mask, the day copy says 'may', a null limit still reads", () => {
    const p = (warning: (typeof WARNINGS)[number], limitEgp: number | null) =>
      ({
        accountId: "a",
        accountLabel: "VF cash",
        accountMask: "***0150",
        provider: "vodafone_cash",
        warning,
        receivedEgp: 48_000,
        limitEgp,
      }) as EventPayloadMap["collection.limit_warning"];
    const day = renderInApp("collection.limit_warning", p("day_80", 60_000), "en");
    expect(day.title).toBe("VF cash ***0150 is at 80% of today's limit");
    expect(day.body).toBe("Received today EGP 48,000 of 60,000. The limit may also apply to money you receive.");
    expect(renderInApp("collection.limit_warning", p("balance_90", null), "en").body).toBe(
      "Balance EGP 48,000. Move some out so new transfers aren't refused.",
    );
    expect(renderInApp("collection.limit_warning", p("month_80", 200_000), "ar").title).toContain("***0150");
  });

  it("source_silent names the device and counts", () => {
    const r = renderInApp(
      "collection.source_silent",
      { deviceId: "d", deviceLabel: "Counter Android", platform: "android_listener", missedCount: 3, branchName: null },
      "en",
    );
    expect(r).toEqual({
      title: "Automatic confirmation stopped on Counter Android — set it up again",
      body: "3 transfers arrived with no message from this phone",
    });
    expect(
      renderInApp(
        "collection.source_silent",
        { deviceId: "d", deviceLabel: "Counter Android", platform: "android_listener", missedCount: 1, branchName: null },
        "ar",
      ).body,
    ).toBe("وصل تحويل واحد دون رسالة من هذا الهاتف");
  });
});

describe("stale plurals and durations", () => {
  const stale = (count: number, staleAfterMinutes: number, locale: "ar" | "en") =>
    renderInApp(
      "collection.stale",
      { branchName: null, count, amountEgp: 500, staleAfterMinutes },
      locale,
    ).title;

  it("Arabic count forms for n ∈ {1, 2, 3, 11}", () => {
    expect(stale(1, 120, "ar")).toBe("تحويل في انتظار التأكيد منذ أكثر من ساعتين");
    expect(stale(2, 120, "ar")).toBe("تحويلان في انتظار التأكيد منذ أكثر من ساعتين");
    expect(stale(3, 120, "ar")).toBe("3 تحويلات في انتظار التأكيد منذ أكثر من ساعتين");
    expect(stale(11, 120, "ar")).toBe("11 تحويلًا في انتظار التأكيد منذ أكثر من ساعتين");
  });

  it("English count forms", () => {
    expect(stale(1, 120, "en")).toBe("1 transfer waiting over 2 hours");
    expect(stale(3, 120, "en")).toBe("3 transfers waiting over 2 hours");
  });

  it("durations for min ∈ {45, 60, 90, 120, 180} (and a long one)", () => {
    expect([45, 60, 90, 120, 180, 660].map(durAr)).toEqual([
      "45 دقيقة",
      "ساعة",
      "90 دقيقة",
      "ساعتين",
      "3 ساعات",
      "11 ساعة",
    ]);
    expect([45, 60, 90, 120, 180].map(durEn)).toEqual([
      "45 minutes",
      "1 hour",
      "90 minutes",
      "2 hours",
      "3 hours",
    ]);
    expect(stale(3, 45, "en")).toBe("3 transfers waiting over 45 minutes");
  });

  it("countAr and methodName helpers", () => {
    expect([1, 2, 5, 10, 11, 100].map((n) => countAr(n, "a", "b", "c", "d"))).toEqual([
      "a",
      "b",
      "5 c",
      "10 c",
      "11 d",
      "100 d",
    ]);
    expect(methodName("wallet", true)).toBe("محفظة موبايل");
    expect(methodName("wallet", false)).toBe("Mobile wallet");
    expect(methodName("instapay", true)).toBe("إنستاباي");
    expect(methodName("instapay", false)).toBe("InstaPay");
  });
});

describe("Q18 — no payer data in the dispatcher", () => {
  it("dispatch.ts never names a payer field", () => {
    const src = readFileSync(path.resolve(__dirname, "../../lib/notifications/dispatch.ts"), "utf8");
    expect(src).not.toMatch(/payerName|payerPhone|operatorReference/);
  });
});

describe("push routing and channel", () => {
  it("the silent alert opens the devices screen whatever its web link", () => {
    expect(routeForNotification("collection_source_silent", "/settings/collections")).toBe(
      "/settings/collections/devices",
    );
    expect(routeForNotification("collection_source_silent", null)).toBe("/settings/collections/devices");
    expect(KIND_MOBILE_ROUTE_OVERRIDE).toEqual({ collection_source_silent: "/settings/collections/devices" });
  });

  it("the other collection kinds keep the producer link (the app filters the query)", () => {
    expect(routeForNotification("collection_stale", "/collections?status=pending&stale=1")).toBe(
      "/collections?status=pending&stale=1",
    );
    expect(routeForNotification("collection_unmatched", null)).toBe("/collections");
    expect(routeForNotification("collection_limit", null)).toBe("/collections");
    expect(routeForNotification("collection_pending", null)).toBe("/collections");
    // Legacy behaviour untouched.
    expect(routeForNotification("low_stock", null)).toBe("/inventory");
    expect(routeForNotification("info", "/sales")).toBe("/sales");
  });

  it("channelForKind: collection_* → collections, the rest → default (undefined)", () => {
    for (const k of [
      "collection_pending",
      "collection_stale",
      "collection_unmatched",
      "collection_source_silent",
      "collection_limit",
    ]) {
      expect(channelForKind(k), k).toBe("collections");
    }
    for (const k of ["low_stock", "info", "task_assigned", "leave_decided", "collections"]) {
      expect(channelForKind(k), k).toBeUndefined();
    }
  });

  it("toExpoRequest carries the collections channel, and defaults to 'default'", () => {
    const req = toExpoRequest({
      to: "ExponentPushToken[x]",
      title: "t",
      data: { type: "collection_stale", route: "/collections", id: "n" },
      channelId: "collections",
    });
    expect(req.channelId).toBe("collections");
    expect(toExpoRequest({ to: "ExponentPushToken[x]", title: "t" }).channelId).toBe("default");
  });
});
