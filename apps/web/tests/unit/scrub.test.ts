/**
 * Locks the shared Sentry scrubber (packages/domain/src/observability/scrub.ts).
 *
 * The denylist is shared by the web's `@sentry/nextjs` beforeSend and the
 * mobile app's `@sentry/react-native` beforeSend, so a regression here leaks
 * customer phones / emails from BOTH apps at once. Pure functions — no DB.
 */
import { describe, expect, it } from "vitest";

import {
  scrubHeaders,
  scrubObject,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
} from "@matgary/domain/observability/scrub";
import * as shim from "@/lib/sentry/scrub";

const REDACTED = "[REDACTED]";

describe("scrubObject — customer PII keys (doc 06 §10.2)", () => {
  it("redacts phone / customerName / email variants at any nesting depth, keeping the shape", () => {
    const out = scrubObject({
      sale: {
        id: "s1",
        total: 1250,
        customer: {
          id: "c1",
          phone: "+201001234567",
          phoneNumber: "+201001234567",
          phone_number: "+201001234567",
          normalizedPhone: "201001234567",
          normalized_phone: "201001234567",
          email: "x@example.com",
          customerEmail: "x@example.com",
          customer_email: "x@example.com",
        },
        customerName: "Ahmed",
        customer_name: "Ahmed",
        customerPhone: "+20100",
        customer_phone: "+20100",
        lines: [{ sku: "A", qty: 2, customerName: "leaked-in-array" }],
      },
    }) as any;

    expect(out.sale.id).toBe("s1");
    expect(out.sale.total).toBe(1250);
    expect(out.sale.customer.id).toBe("c1");
    for (const k of [
      "phone",
      "phoneNumber",
      "phone_number",
      "normalizedPhone",
      "normalized_phone",
      "email",
      "customerEmail",
      "customer_email",
    ]) {
      expect(out.sale.customer[k], k).toBe(REDACTED);
    }
    for (const k of ["customerName", "customer_name", "customerPhone", "customer_phone"]) {
      expect(out.sale[k], k).toBe(REDACTED);
    }
    expect(out.sale.lines).toEqual([{ sku: "A", qty: 2, customerName: REDACTED }]);
  });

  it("is case-insensitive on keys and still redacts the classic secrets", () => {
    const out = scrubObject({
      Password: "p",
      PHONE: "x",
      Email: "e",
      accessToken: "t",
      totp: "123456",
      code: "999",
      nested: { CustomerName: "n" },
    }) as any;
    expect(out).toEqual({
      Password: REDACTED,
      PHONE: REDACTED,
      Email: REDACTED,
      accessToken: REDACTED,
      totp: REDACTED,
      code: REDACTED,
      nested: { CustomerName: REDACTED },
    });
  });

  it("passes primitives / null through and guards depth", () => {
    expect(scrubObject(null)).toBeNull();
    expect(scrubObject(undefined)).toBeUndefined();
    expect(scrubObject(42)).toBe(42);
    expect(scrubObject("phone")).toBe("phone");
    // 8 levels deep: the guard (> 6) replaces the tail with REDACTED instead of recursing forever.
    let deep: any = { leaf: true };
    for (let i = 0; i < 8; i++) deep = { child: deep };
    const out = JSON.stringify(scrubObject(deep));
    expect(out).toContain(REDACTED);
    expect(out).not.toContain("leaf");
  });
});

describe("scrubSentryEvent", () => {
  it("scrubs PII inside extra, contexts and request.data", () => {
    const event = scrubSentryEvent({
      extra: { sale: { customer: { phone: "+20100", email: "a@b.c" }, customerName: "A" } },
      contexts: { pos: { customerName: "B", shift: "morning" } },
      request: {
        headers: { Authorization: "Bearer x", "content-type": "application/json", Cookie: "s=1" },
        data: { phone: "+20100", email: "a@b.c", items: 3 },
        cookies: { session: "abc" },
        query_string: "a=1&token=SECRET&code=123&keep=me",
      },
    });

    expect((event.extra as any).sale.customer.phone).toBe(REDACTED);
    expect((event.extra as any).sale.customer.email).toBe(REDACTED);
    expect((event.extra as any).sale.customerName).toBe(REDACTED);
    expect((event.contexts as any).pos).toEqual({ customerName: REDACTED, shift: "morning" });
    expect(event.request!.data).toEqual({ phone: REDACTED, email: REDACTED, items: 3 });
    expect(event.request!.headers).toEqual({
      Authorization: REDACTED,
      "content-type": "application/json",
      Cookie: REDACTED,
    });
    expect(event.request!.cookies).toBe(REDACTED);
    expect(event.request!.query_string).toBe(
      "a=1&token=[REDACTED]&code=[REDACTED]&keep=me",
    );
  });

  it("collapses user to { id } — email, ip_address, username and custom fields never ship", () => {
    const event = scrubSentryEvent({
      user: {
        id: "u_123",
        email: "cashier@shop.com",
        ip_address: "10.0.0.1",
        username: "cashier",
        phone: "+20100",
        name: "Ahmed",
      },
    });
    expect(event.user).toEqual({ id: "u_123" });
    expect(Object.keys(event.user!)).toEqual(["id"]);
  });

  it("keeps a numeric user id", () => {
    expect(scrubSentryEvent({ user: { id: 7, email: "x@y.z" } }).user).toEqual({ id: 7 });
  });

  it("collapses a user block without an id to {}", () => {
    const event = scrubSentryEvent({ user: { email: "x@y.z", ip_address: "1.2.3.4" } });
    expect(event.user).toEqual({});
  });

  it("leaves an event with no user / request / extra untouched and returns the same object", () => {
    const input: { message: string; user?: { id?: string } } = { message: "hello" };
    const out = scrubSentryEvent(input);
    expect(out).toBe(input);
    expect(out).toEqual({ message: "hello" });
    expect("user" in out).toBe(false);
  });
});

describe("scrubSentryBreadcrumb", () => {
  it("redacts ?token= / &code= in the message and PII keys in data", () => {
    const crumb = scrubSentryBreadcrumb({
      category: "fetch",
      message: "GET https://api.example.com/reset?token=abc123&x=1 200",
      data: { url: "/x", customerName: "A", phone: "+20100", status: 200 },
    });
    expect(crumb.message).toBe("GET https://api.example.com/reset?token=[REDACTED]&x=1 200");
    expect(crumb.data).toEqual({ url: "/x", customerName: REDACTED, phone: REDACTED, status: 200 });
  });

  it("redacts multiple sensitive params and stops at whitespace", () => {
    const crumb = scrubSentryBreadcrumb({
      message: "POST /verify?code=999&password=hunter2 then more",
    });
    expect(crumb.message).toBe("POST /verify?code=[REDACTED]&password=[REDACTED] then more");
  });

  it("passes a data-less, message-less crumb through", () => {
    expect(scrubSentryBreadcrumb({ category: "ui.click" })).toEqual({ category: "ui.click" });
  });
});

describe("scrubHeaders", () => {
  it("redacts the header denylist case-insensitively and returns undefined for undefined", () => {
    expect(scrubHeaders(undefined)).toBeUndefined();
    expect(
      scrubHeaders({ "X-CSRF-Token": "t", "x-api-key": "k", Accept: "*/*", "Set-Cookie": "a=b" }),
    ).toEqual({ "X-CSRF-Token": REDACTED, "x-api-key": REDACTED, Accept: "*/*", "Set-Cookie": REDACTED });
  });
});

describe("@/lib/sentry/scrub shim", () => {
  it("re-exports the exact same functions as @matgary/domain/observability/scrub", () => {
    expect(shim.scrubSentryEvent).toBe(scrubSentryEvent);
    expect(shim.scrubSentryBreadcrumb).toBe(scrubSentryBreadcrumb);
    expect(shim.scrubObject).toBe(scrubObject);
    expect(shim.scrubHeaders).toBe(scrubHeaders);
  });
});
