/**
 * Doc 15 spec 13 §4.15 / acceptance 11 — the web side of the receipt payment
 * row: `receiptPaymentInfo` builds the ASCII masks from account rows, the
 * WhatsApp PDF prints the row (and survives an untrusted `payment`), and no
 * web receipt renderer can print a confirmation status. The pure helper's
 * rules are pinned in packages/domain/src/escpos/__tests__/escpos.test.ts (T8).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { generateReceiptPdf, type PdfInvoiceData } from "@/lib/pdfReceipt";
import { receiptPaymentInfo, receiptPaymentRows } from "@/lib/receipt-strings";

const base: PdfInvoiceData = {
  invoiceId: "INV-DC13PDF",
  saleDate: "2026-09-30T10:00:00.000Z",
  lines: [{ productName: "Watch", quantity: 1, pricePerUnit: 3200, subtotal: 3200, lineDiscountAmount: 0 }],
  cartSubtotal: 3200,
  orderDiscountAmount: 0,
  totalPrice: 3200,
  shopName: "Amr Store",
  shopPhone: "0100",
};

/** Every decompressed content stream of the PDF, as latin1 text. */
function pdfText(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes);
  const s = buf.toString("latin1");
  let out = "";
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const start = m.index + m[0].length;
    const end = s.indexOf("endstream", start);
    if (end < 0) break;
    const chunk = buf.subarray(start, end);
    try {
      out += inflateSync(chunk).toString("latin1");
    } catch {
      out += chunk.toString("latin1");
    }
  }
  return out;
}

/** pdf-lib writes WinAnsi text as <hex> strings; decode them all. */
function shownText(bytes: Uint8Array): string {
  return [...pdfText(bytes).matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)]
    .map((m) => Buffer.from(m[1]!, "hex").toString("latin1"))
    .join("\n");
}

describe("receiptPaymentInfo (13 §4.15)", () => {
  it("masks each account with 06's accountMask; empty accounts → method only", () => {
    expect(
      receiptPaymentInfo("instapay", [{ accountLast4: "0150" }, { walletMsisdn: "+201012345678" }, { ipaHandle: "shop@instapay" }]),
    ).toEqual({ method: "instapay", accountMasks: ["***0150", "***5678", "***@instapay"] });
    expect(receiptPaymentInfo("wallet", [])).toEqual({ method: "wallet", accountMasks: [] });
    expect(receiptPaymentInfo(null, [])).toBeUndefined();
    expect(receiptPaymentRows(receiptPaymentInfo("instapay", [{ accountLast4: "0150" }]), "ar")).toEqual([
      { label: "طريقة الدفع", value: "إنستاباي ***0150" },
    ]);
  });
});

describe("generateReceiptPdf payment row (13 §4.15)", () => {
  it("prints PAID BY + method + mask after the total; a cash PDF prints no row", async () => {
    const withPay = shownText(await generateReceiptPdf({ ...base, payment: { method: "instapay", accountMasks: ["***0150"] } }));
    expect(withPay).toContain("PAID BY");
    expect(withPay).toContain("InstaPay ***0150");
    expect(withPay.indexOf("TOTAL AMOUNT")).toBeLessThan(withPay.indexOf("PAID BY"));
    expect(withPay).not.toMatch(/pending|awaiting|confirm/i);

    const cash = shownText(await generateReceiptPdf({ ...base, payment: { method: "cash", accountMasks: ["***0150"] } }));
    const none = shownText(await generateReceiptPdf(base));
    expect(cash).not.toContain("PAID BY");
    expect(none).not.toContain("PAID BY");
  });

  it("an untrusted payment shape never throws", async () => {
    for (const payment of ["instapay", { method: 5 }, { method: "wallet", accountMasks: "x" }, { method: "card", accountMasks: [1, "<b>"] }]) {
      await expect(generateReceiptPdf({ ...base, payment: payment as never })).resolves.toBeInstanceOf(Uint8Array);
    }
  });
});

describe("no web receipt renderer prints a status (acceptance 11)", () => {
  const files = ["components/sales/Receipt.tsx", "components/sales/InvoiceReceipt.tsx", "lib/pdfReceipt.ts", "lib/receipt-strings.ts"];
  for (const f of files) {
    it(`${f} renders payment rows through the shared helper, with no status field`, () => {
      const src = readFileSync(fileURLToPath(new URL(`../../${f}`, import.meta.url)), "utf8");
      expect(src).toContain("receiptPaymentRows");
      expect(src).not.toMatch(/collectionStatus|collection_status/);
    });
  }
});
