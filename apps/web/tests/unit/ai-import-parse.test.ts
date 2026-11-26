/**
 * F10.1 — CSV + XLSX parser tests. Deterministic; no DB / no Gemini.
 */
import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import {
  detectFormat,
  parseBuffer,
  parseCsvBuffer,
  parseXlsxBuffer,
  ParseError,
  validateUpload,
} from "@/lib/ai/import/parse";

describe("detectFormat", () => {
  it("picks csv from .csv extension", () => {
    expect(detectFormat("products.csv")).toBe("csv");
  });

  it("picks xlsx from .xlsx extension", () => {
    expect(detectFormat("products.xlsx")).toBe("xlsx");
  });

  it("falls back to MIME when extension is ambiguous", () => {
    expect(detectFormat("file", "text/csv")).toBe("csv");
    expect(
      detectFormat("file", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ).toBe("xlsx");
  });

  it("throws on unknown format", () => {
    expect(() => detectFormat("file.jpg")).toThrow(ParseError);
  });
});

describe("validateUpload", () => {
  it("rejects a mime that contradicts the extension", () => {
    expect(() =>
      validateUpload({ fileName: "a.xlsx", mimeType: "image/png", byteLength: 100 }),
    ).toThrow(ParseError);
  });

  it("accepts csv with text/plain (browsers often mis-report)", () => {
    const r = validateUpload({ fileName: "a.csv", mimeType: "text/plain", byteLength: 100 });
    expect(r.format).toBe("csv");
  });

  it("rejects files over the size cap", () => {
    expect(() =>
      validateUpload({
        fileName: "a.csv",
        mimeType: "text/csv",
        byteLength: 20 * 1024 * 1024,
      }),
    ).toThrowError(expect.objectContaining({ code: "FILE_TOO_LARGE" }));
  });

  it("rejects empty uploads", () => {
    expect(() =>
      validateUpload({ fileName: "a.csv", mimeType: "text/csv", byteLength: 0 }),
    ).toThrowError(expect.objectContaining({ code: "EMPTY_FILE" }));
  });
});

/* ───────────────────────── CSV ────────────────────────────────────── */

describe("parseCsvBuffer", () => {
  it("parses headers + rows with UTF-8 BOM + quotes", () => {
    const csv = '﻿SKU,Name,"Sale Price"\nT1,Shirt,"3,000"\nT2,"Pink, Diva",2200\n';
    const sheet = parseCsvBuffer(Buffer.from(csv, "utf8"), "p.csv");
    expect(sheet.format).toBe("csv");
    expect(sheet.columns).toEqual(["SKU", "Name", "Sale Price"]);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0]).toEqual({ SKU: "T1", Name: "Shirt", "Sale Price": "3,000" });
    expect(sheet.rows[1]).toEqual({ SKU: "T2", Name: "Pink, Diva", "Sale Price": "2200" });
  });

  it("skips entirely-blank rows and counts them", () => {
    const csv = "A,B\n1,2\n\n\n3,4\n";
    const sheet = parseCsvBuffer(Buffer.from(csv, "utf8"), "p.csv");
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.blankRowCount).toBeGreaterThanOrEqual(2);
  });

  it("deduplicates repeated header names", () => {
    const csv = "Price,Price,Name\n100,200,A\n";
    const sheet = parseCsvBuffer(Buffer.from(csv, "utf8"), "p.csv");
    expect(sheet.columns).toEqual(["Price", "Price (2)", "Name"]);
    expect(sheet.rows[0]).toEqual({ Price: "100", "Price (2)": "200", Name: "A" });
  });

  it("rejects empty CSV content", () => {
    expect(() => parseCsvBuffer(Buffer.from("\n\n", "utf8"), "p.csv")).toThrowError(
      expect.objectContaining({ code: "EMPTY_FILE" }),
    );
  });

  it("rejects a CSV whose only row is an all-blank header", () => {
    // Note: `splitCsvLine(",")` returns `["", ""]` so the header row has two
    // empty entries — classified as MISSING_HEADERS.
    expect(() => parseCsvBuffer(Buffer.from(",\n", "utf8"), "p.csv")).toThrowError(
      expect.objectContaining({ code: "MISSING_HEADERS" }),
    );
  });

  it("parses Arabic headers", () => {
    const csv = "SKU,الاسم,السعر\nT1,قميص,100\n";
    const sheet = parseCsvBuffer(Buffer.from(csv, "utf8"), "p.csv");
    expect(sheet.columns).toEqual(["SKU", "الاسم", "السعر"]);
    expect(sheet.rows[0]).toEqual({ SKU: "T1", الاسم: "قميص", السعر: "100" });
  });
});

/* ───────────────────────── XLSX ───────────────────────────────────── */

describe("parseXlsxBuffer", () => {
  it("parses a round-tripped sheet correctly", () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ["SKU", "Name", "Sale Price", "Quantity"],
      ["T1", "Shirt", 3000, 5],
      ["T2", "Pants", 2500, 3],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, "Products");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const sheet = parseXlsxBuffer(buf, "p.xlsx");
    expect(sheet.format).toBe("xlsx");
    expect(sheet.columns).toEqual(["SKU", "Name", "Sale Price", "Quantity"]);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[0]).toEqual({ SKU: "T1", Name: "Shirt", "Sale Price": "3000", Quantity: "5" });
    expect(sheet.sourceSheet).toBe("Products");
  });

  it("handles reordered columns identically", () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ["Quantity", "Name", "SKU", "Sale Price"],
      [5, "Shirt", "T1", 3000],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, "Products");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const sheet = parseXlsxBuffer(buf, "p.xlsx");
    expect(sheet.rows[0]).toEqual({ Quantity: "5", Name: "Shirt", SKU: "T1", "Sale Price": "3000" });
  });

  it("rejects an XLSX workbook whose only sheet is empty", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), "Sheet1");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    expect(() => parseXlsxBuffer(buf, "p.xlsx")).toThrowError(
      expect.objectContaining({ name: "ParseError" }),
    );
  });

  it("parses Arabic headers in XLSX", () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ["كود المنتج", "اسم المنتج", "السعر"],
      ["T1", "قميص", 100],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, "Products");
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const sheet = parseXlsxBuffer(buf, "p.xlsx");
    expect(sheet.columns).toEqual(["كود المنتج", "اسم المنتج", "السعر"]);
    expect(sheet.rows[0]).toEqual({ "كود المنتج": "T1", "اسم المنتج": "قميص", السعر: "100" });
  });
});

/* ───────────────────────── entry point ────────────────────────────── */

describe("parseBuffer", () => {
  it("dispatches CSV + XLSX by filename", () => {
    const csv = parseBuffer({
      buffer: Buffer.from("A,B\n1,2\n"),
      fileName: "a.csv",
      mimeType: "text/csv",
    });
    expect(csv.format).toBe("csv");

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([["A", "B"], ["1", "2"]]),
      "Sheet1",
    );
    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const xlsx = parseBuffer({
      buffer: buf,
      fileName: "a.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    expect(xlsx.format).toBe("xlsx");
  });
});
