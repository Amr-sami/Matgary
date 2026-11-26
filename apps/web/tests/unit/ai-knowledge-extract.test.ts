/**
 * F10.2 — PDF/DOCX extractor unit tests.
 *
 * Covers the deterministic parts of the extractor. The DOCX path uses mammoth
 * which refuses malformed buffers; the PDF path uses pdf-parse@1 fixtures
 * shipped with the installed package.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  detectKnowledgeFormat,
  extractDocx,
  extractPdf,
  splitByFormFeed,
} from "@/lib/ai/knowledge/extract";

describe("detectKnowledgeFormat", () => {
  it("picks pdf from extension", () => {
    expect(detectKnowledgeFormat("return-policy.pdf")).toBe("pdf");
  });
  it("picks docx from extension", () => {
    expect(detectKnowledgeFormat("employee-handbook.docx")).toBe("docx");
  });
  it("picks markdown from extension", () => {
    expect(detectKnowledgeFormat("notes.md")).toBe("markdown");
    expect(detectKnowledgeFormat("notes.markdown")).toBe("markdown");
  });
  it("picks text from extension", () => {
    expect(detectKnowledgeFormat("sop.txt")).toBe("text");
  });
  it("falls back to MIME when extension is missing", () => {
    expect(detectKnowledgeFormat("blob", "application/pdf")).toBe("pdf");
    expect(
      detectKnowledgeFormat(
        "blob",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe("docx");
  });
  it("returns null for unknown formats", () => {
    expect(detectKnowledgeFormat("ignore.jpg")).toBeNull();
  });
});

describe("extractPdf", () => {
  it("extracts text from a valid fixture PDF", async () => {
    const fixturePath = path.resolve(
      __dirname,
      "../../../../node_modules/pdf-parse/test/data/01-valid.pdf",
    );
    const buffer = await readFile(fixturePath);
    const result = await extractPdf(buffer);
    expect(result.text.trim().length).toBeGreaterThan(50);
    expect(result.metadata.kind).toBe("pdf");
    expect(typeof result.metadata.pageCount === "number").toBe(true);
  });

  it("rejects garbage bytes with PDF_PARSE_FAILED", async () => {
    await expect(
      extractPdf(Buffer.from("definitely not a pdf", "utf8")),
    ).rejects.toMatchObject({ name: "ExtractError", code: "PDF_PARSE_FAILED" });
  });
});

describe("extractDocx", () => {
  it("rejects garbage bytes with DOCX_PARSE_FAILED", async () => {
    await expect(
      extractDocx(Buffer.from("definitely not a docx", "utf8")),
    ).rejects.toMatchObject({ name: "ExtractError", code: "DOCX_PARSE_FAILED" });
  });
});

describe("splitByFormFeed", () => {
  it("returns undefined when no form-feed is present", () => {
    expect(splitByFormFeed("plain text with no page breaks")).toBeUndefined();
  });

  it("splits on \\f and numbers pages 1-based", () => {
    const text = "page one\fpage two\fpage three";
    const result = splitByFormFeed(text);
    expect(result).toHaveLength(3);
    expect(result![0]).toEqual({ pageNumber: 1, text: "page one" });
    expect(result![2]).toEqual({ pageNumber: 3, text: "page three" });
  });
});
