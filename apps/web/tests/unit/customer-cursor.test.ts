/**
 * HANDOFF §8 #5 — the /api/v1/customers keyset cursor must not lose
 * microseconds.
 *
 * Postgres compares `(MAX(sale_date), customer_phone)` at microsecond
 * precision. The old cursor went through a JS Date (milliseconds), so a
 * customer whose last purchase shared the boundary row's millisecond but not
 * its microseconds compared as not-below the cursor and vanished from page 2.
 * The codec now carries the text Postgres rendered, untouched.
 */
import { describe, expect, it } from "vitest";

import {
  canonicalIsoMicros,
  decodeCustomerCursor,
  encodeCustomerCursor,
  isAfterCustomerCursor,
} from "@/lib/repo/customer-cursor";

describe("customer cursor codec", () => {
  it("round-trips a microsecond timestamp byte for byte", () => {
    const c = { lastPurchaseAt: "2026-09-18T10:00:00.123456Z", phone: "+201001234567" };
    const decoded = decodeCustomerCursor(encodeCustomerCursor(c));
    expect(decoded).toEqual(c);
    // The whole point: no Date on the path, so the 456 survives.
    expect(decoded!.lastPurchaseAt.endsWith(".123456Z")).toBe(true);
    expect(new Date(decoded!.lastPurchaseAt).toISOString()).toBe("2026-09-18T10:00:00.123Z");
  });

  it("still accepts a millisecond cursor minted before the change", () => {
    const decoded = decodeCustomerCursor(
      Buffer.from("2026-09-18T10:00:00.123Z|+201001234567").toString("base64url"),
    );
    expect(decoded).toEqual({ lastPurchaseAt: "2026-09-18T10:00:00.123Z", phone: "+201001234567" });
  });

  it("rejects anything that is not an ISO-8601 UTC instant — the text is cast in SQL", () => {
    const enc = (s: string) => Buffer.from(s).toString("base64url");
    expect(decodeCustomerCursor(null)).toBeNull();
    expect(decodeCustomerCursor("")).toBeNull();
    expect(decodeCustomerCursor(enc("no-pipe"))).toBeNull();
    expect(decodeCustomerCursor(enc("2026-09-18T10:00:00.123456Z|"))).toBeNull();
    expect(decodeCustomerCursor(enc("2026-09-18 10:00:00.123456+00|+2010"))).toBeNull();
    expect(decodeCustomerCursor(enc("2026-13-45T10:00:00.123456Z|+2010"))).toBeNull();
    expect(decodeCustomerCursor(enc("'; drop table sales; --|+2010"))).toBeNull();
  });
});

describe("customer cursor ordering — two rows sharing a timestamp", () => {
  // The order is (lastPurchaseAt DESC, phone DESC). A page ends on `boundary`;
  // `twin` bought at the very same instant but has the lexically smaller
  // phone, so it belongs at the top of the NEXT page.
  const boundary = { lastPurchaseAt: "2026-09-18T10:00:00.123456Z", phone: "+201009999999" };
  const twin = { lastPurchaseAt: "2026-09-18T10:00:00.123456Z", phone: "+201001111111" };
  const cursor = decodeCustomerCursor(encodeCustomerCursor(boundary))!;

  it("the boundary row itself is not repeated", () => {
    expect(isAfterCustomerCursor(boundary, cursor)).toBe(false);
  });

  it("the twin with the same timestamp lands on page 2 by the phone tiebreak", () => {
    expect(isAfterCustomerCursor(twin, cursor)).toBe(true);
  });

  it("a row in the same millisecond but fewer microseconds is NOT skipped", () => {
    // This is the exact row the old millisecond cursor lost: 10:00:00.123
    // as the cursor made .123400 compare as not-below and drop out.
    const sameMs = { lastPurchaseAt: "2026-09-18T10:00:00.123400Z", phone: "+201009999999" };
    expect(isAfterCustomerCursor(sameMs, cursor)).toBe(true);

    // And with the truncated cursor the old code would have produced, the
    // same row is wrongly excluded — the regression this test guards.
    const truncated = { lastPurchaseAt: "2026-09-18T10:00:00.123Z", phone: "+201009999999" };
    expect(isAfterCustomerCursor(sameMs, truncated)).toBe(false);
  });

  it("a later purchase stays on page 1's side", () => {
    const later = { lastPurchaseAt: "2026-09-18T10:00:00.123457Z", phone: "+201000000000" };
    expect(isAfterCustomerCursor(later, cursor)).toBe(false);
  });

  it("canonicalises fractional digits so old and new cursors compare alike", () => {
    expect(canonicalIsoMicros("2026-09-18T10:00:00.123Z")).toBe("2026-09-18T10:00:00.123000Z");
    expect(canonicalIsoMicros("2026-09-18T10:00:00Z")).toBe("2026-09-18T10:00:00.000000Z");
    expect(canonicalIsoMicros("2026-09-18T10:00:00.123456Z")).toBe("2026-09-18T10:00:00.123456Z");
  });
});
