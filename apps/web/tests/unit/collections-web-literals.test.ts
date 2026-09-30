/**
 * Digital collections — hard-coded Arabic moved to the dictionary (doc 15
 * spec 12 §4.12, §7): the settle modal and the bell carry no Arabic letter
 * outside comments, and the listed customer-ledger literals are gone.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const WEB = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(WEB, rel), "utf8");

/** Drop block and line comments (a `//` inside a string such as a URL is
 *  kept when preceded by `:`). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const ARABIC = /[؀-ۿ]/;

describe("collections web — no hard-coded Arabic", () => {
  it("InvoiceSettleModal.tsx has no Arabic letter outside comments", () => {
    const src = stripComments(read("components/customers/InvoiceSettleModal.tsx"));
    const hit = src.split("\n").find((l) => ARABIC.test(l));
    expect(hit).toBeUndefined();
  });

  it("NotificationBell.tsx has no Arabic letter outside comments", () => {
    const src = stripComments(read("components/notifications/NotificationBell.tsx"));
    const hit = src.split("\n").find((l) => ARABIC.test(l));
    expect(hit).toBeUndefined();
  });

  it("the customer ledger page no longer hard-codes the moved strings", () => {
    const src = read("app/customers/[phone]/page.tsx");
    for (const s of ["سجل الفواتير", "سجل الدفعات", "دفعة سابقة", "إنستا باي", "تم تسجيل"]) {
      expect(src.includes(s), s).toBe(false);
    }
  });

  it("the new collections UI files carry no Arabic letter outside comments", () => {
    const dir = path.join(WEB, "components/collections");
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
      .map((f) => `components/collections/${f}`);
    files.push("app/collections/page.tsx", "app/settings/collections/page.tsx", "lib/api/collections.ts");
    for (const f of files) {
      const hit = stripComments(read(f))
        .split("\n")
        .find((l) => ARABIC.test(l));
      expect(hit, f).toBeUndefined();
    }
  });
});
