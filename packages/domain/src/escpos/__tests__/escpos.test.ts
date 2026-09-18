// Run: npx tsx --test packages/domain/src/escpos/__tests__/escpos.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COLUMNS,
  ESC,
  GS,
  align,
  codepage,
  concat,
  cut,
  encodeText,
  init,
  packGray,
  qrCode,
  rasterImage,
  receiptToRasterCommands,
  rowText,
  saleToTicket,
  shapeArabic,
  size,
  testTicket,
  textReceipt,
  ticketMoney,
  visualOrder,
  wrap,
} from "../index";

const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join(" ");

test("control bytes match the Epson reference", () => {
  assert.equal(hex(init()), "1b 40");
  assert.equal(hex(align("center")), "1b 61 01");
  assert.equal(hex(align("right")), "1b 61 02");
  assert.equal(hex(size(2, 2)), "1d 21 11");
  assert.equal(hex(size(1)), "1d 21 00");
  assert.equal(hex(codepage("pc864")), "1b 74 25");
  assert.equal(hex(codepage("win1256")), "1b 74 32");
  assert.equal(hex(cut(true, 3)), "1d 56 42 03");
  assert.equal(hex(concat(Uint8Array.from([1]), Uint8Array.from([2, 3]))), "01 02 03");
});

test("qrCode stores the payload with a little-endian length", () => {
  const q = qrCode("INV-1");
  const store = hex(q).indexOf("1d 28 6b 08 00 31 50 30 49 4e 56 2d 31");
  assert.ok(store > 0, hex(q));
  assert.ok(hex(q).endsWith("1d 28 6b 03 00 31 51 30"));
});

test("shapeArabic produces contextual forms and the lam-alef ligature", () => {
  // محمد: meem initial, hah medial, meem medial, dal final
  assert.equal(shapeArabic("محمد"), "ﻣﺤﻤﺪ");
  // سلام: seen initial, lam-alef final ligature, meem isolated (alef never joins forward)
  assert.equal(shapeArabic("سلام"), "ﺳﻼﻡ");
  // isolated letter, harakat dropped
  assert.equal(shapeArabic("بَ"), "ﺏ");
  // alef does not join forward: "ابن" → alef isolated, beh initial, noon final
  assert.equal(shapeArabic("ابن"), "ﺍﺑﻦ");
  assert.equal(shapeArabic("ABC 12"), "ABC 12");
});

test("visualOrder reverses Arabic but keeps numbers and Latin left-to-right", () => {
  assert.equal(visualOrder("abc 123"), "abc 123");
  assert.equal(visualOrder("ابج"), "جبا");
  // amount after an Arabic label: number keeps its digits in order and ends up on the left
  assert.equal(visualOrder("الإجمالي 12.50"), "12.50 يلامجإلا");
  // Latin brand inside an Arabic name stays readable
  assert.equal(visualOrder("شاي Lipton"), "Lipton ياش");
  // brackets mirror in RTL runs
  assert.equal(visualOrder("(اب)"), "(با)");
});

test("encodeText maps PC864 with final→isolated fallbacks and win1256 nominal letters", () => {
  // "ب" isolated = 0xA9 in PC864; win1256 = 0xC8
  assert.equal(hex(encodeText("ب", "pc864")), "a9");
  assert.equal(hex(encodeText("ب", "win1256")), "c8");
  // dal final form (FEAA) is not in PC864 → isolated dal 0xCF
  assert.equal(hex(encodeText("ﺪ", "pc864", { raw: true })), "cf");
  // ASCII passes through every table; unknown glyph → "?"
  assert.equal(hex(encodeText("A1", "pc437")), "41 31");
  assert.equal(hex(encodeText("€", "pc437")), "3f");
  assert.equal(hex(encodeText("€", "win1256")), "80");
  // no byte above 0xFF ever escapes
  for (const b of encodeText("محمد 12.50 Lipton", "pc864")) assert.ok(b <= 0xff);
});

test("rowText pads to the column count on both directions", () => {
  const ltr = rowText("Tea", "12.50", 32, false);
  assert.equal(ltr.length, 32);
  assert.ok(ltr.startsWith("Tea") && ltr.endsWith("12.50"));
  const rtl = rowText("شاي", "12.50", 32, true);
  assert.equal(rtl.length, 32);
  assert.ok(rtl.startsWith("12.50") && rtl.endsWith("شاي"));
  // over-long name is truncated, never wrapped, and the amount survives
  const long = rowText("x".repeat(60), "9.99", 32, false);
  assert.equal(long.length, 32);
  assert.ok(long.endsWith(" 9.99"));
});

test("text-mode RTL rows keep the amount on the left edge whether or not the name is Arabic", () => {
  const bytes = textReceipt(
    {
      rtl: true,
      lines: [
        { kind: "row", start: "الإجمالي", end: "18.00" },
        { kind: "row", start: "2 x 12.50", end: "25.00" },
        { kind: "row", start: "Latte", end: "7.50" },
      ],
    },
    { width: 58, cut: false },
  );
  // Split the stream on LF; the three rows are the only lines with a newline.
  const rows: number[][] = [];
  let cur: number[] = [];
  for (const byte of bytes) {
    if (byte === 0x0a) {
      rows.push(cur);
      cur = [];
    } else cur.push(byte);
  }
  assert.equal(rows.length, 3);
  const ascii = (r: number[]) => String.fromCharCode(...r.filter((x) => x >= 0x20 && x < 0x7f));
  // Every row is exactly one paper line and starts with its amount at byte 0.
  for (const [i, amount] of ["18.00", "25.00", "7.50"].entries()) {
    const r = rows[i]!;
    // Skip the ESC a / ESC E prefix: the paper line starts at the first digit.
    const text = r.slice(r.findIndex((x) => x >= 0x30 && x <= 0x39));
    assert.equal(text.length, COLUMNS[58], `row ${i} spans the full column count`);
    assert.equal(ascii(text.slice(0, amount.length)), amount, `row ${i} amount is on the left edge`);
  }
  // The Latin name hugs the right edge, unreversed.
  const last = rows[2]!;
  assert.equal(ascii(last.slice(-5)), "Latte");
  const second = rows[1]!;
  assert.equal(ascii(second.slice(-9)), "2 x 12.50");
  // The Arabic name hugs the right edge too: the last byte is a PC864 glyph, not a space.
  const first = rows[0]!;
  assert.ok(first[first.length - 1]! >= 0x80, "Arabic row ends in an Arabic glyph on the right edge");
  // A plain rowText call with the identity shaper is byte-stable across both cases.
  assert.equal(rowText("شاي", "12.50", 32, true).indexOf("12.50"), 0);
  assert.equal(rowText("Tea", "12.50", 32, true).indexOf("12.50"), 0);
});

test("wrap breaks on spaces at the column count", () => {
  assert.deepEqual(wrap("one two three four", 9), ["one two", "three", "four"]);
  assert.deepEqual(wrap("", 9), [""]);
});

test("textReceipt starts with init and ends with a cut; Arabic tickets select PC864", () => {
  const bytes = textReceipt(testTicket("XP-58", 58), { width: 58 });
  assert.equal(hex(bytes.subarray(0, 2)), "1b 40");
  assert.ok(hex(bytes).includes("1b 74 25"), "PC864 selected for a ticket with Arabic");
  assert.ok(hex(bytes).endsWith("1d 56 42 03"));
  const latin = textReceipt({ rtl: false, lines: [{ kind: "text", text: "hi" }] }, { width: 80 });
  assert.ok(hex(latin).includes("1b 74 00"), "PC437 for Latin-only");
  assert.equal(COLUMNS[80], 48);
});

test("raster: packGray packs MSB-first and receiptToRasterCommands slices tall images", () => {
  // 16 px wide, 2 rows: first row black on the left 4 px, second row all white
  const gray = new Uint8Array(32).fill(255);
  for (let x = 0; x < 4; x++) gray[x] = 0;
  const bmp = packGray(gray, 16, 2);
  assert.equal(hex(bmp.data), "f0 00 00 00");
  const one = rasterImage(bmp.data, 2, 2);
  assert.equal(hex(one.subarray(0, 8)), "1d 76 30 00 02 00 02 00");

  const tall = { width: 384, height: 300, data: new Uint8Array(48 * 300) };
  const out = receiptToRasterCommands(tall, { sliceRows: 128 });
  const h = hex(out);
  // three slices: 128, 128, 44 rows
  assert.equal((h.match(/1d 76 30 00 30 00 80 00/g) ?? []).length, 2);
  assert.equal((h.match(/1d 76 30 00 30 00 2c 00/g) ?? []).length, 1);
  assert.throws(() => receiptToRasterCommands({ width: 383, height: 1, data: new Uint8Array(48) }), RangeError);
});

test("saleToTicket mirrors the web receipt blocks and money formatting", () => {
  assert.equal(ticketMoney(1234.5), "1,234.50");
  assert.equal(ticketMoney(-3), "-3.00");
  const ticket = saleToTicket(
    {
      invoiceId: "INV-42",
      saleDate: new Date(2026, 8, 18, 14, 5),
      lines: [{ productName: "شاي", brand: "Lipton", quantity: 2, pricePerUnit: 10, subtotal: 18, lineDiscountAmount: 2 }],
      cartSubtotal: 20,
      orderDiscountAmount: 0,
      totalPrice: 18,
      amountPaid: 20,
    },
    { shopName: "متجري", shopPhone: "0100", qrPayload: "https://x/i/INV-42" },
    "ar",
  );
  assert.equal(ticket.rtl, true);
  const kinds = ticket.lines.map((l) => l.kind);
  assert.ok(kinds.includes("qr") && kinds.at(-1) === "cut");
  const rows = ticket.lines.filter((l) => l.kind === "row") as { start: string; end: string }[];
  assert.ok(rows.some((r) => r.start === "الإجمالي" && r.end === "18.00"));
  assert.ok(rows.some((r) => r.start === "الباقي" && r.end === "2.00"));
  const bytes = textReceipt(ticket, { width: 80 });
  assert.ok(bytes.length > 100);
  const en = saleToTicket({ invoiceId: "1", saleDate: new Date(), lines: [], cartSubtotal: 0, orderDiscountAmount: 0, totalPrice: 0 }, { shopName: "" }, "en");
  assert.equal(en.rtl, false);
  assert.ok(!hex(textReceipt(en, { width: 58 })).includes("1b 74 25"));
});
