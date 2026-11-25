/**
 * F9 — Chunker for knowledge ingestion.
 *
 * Strategy: paragraph-first, then size-bounded. Markdown headings (# / ## /
 * ###) are preserved as `section` metadata so retrieval can surface a
 * headline-sized citation ("Return Policy › Damaged Products").
 *
 * Bounds (approx — char-based, not token-based):
 *   • target 500-800 chars per chunk
 *   • hard cap 1,500 chars (never ship a chunk past this)
 *   • minimum 40 chars (drop tiny chunks that only contain a heading)
 */

export interface Chunk {
  index: number;
  section: string | null;
  content: string;
}

const TARGET = 800;
const HARD_CAP = 1500;
const MIN = 40;

export function chunkText(raw: string): Chunk[] {
  const text = normalise(raw);
  if (!text) return [];

  const lines = text.split(/\n/);
  const chunks: Chunk[] = [];
  let section: string | null = null;
  let buffer = "";
  let bufferSection: string | null = null;

  const flush = () => {
    const trimmed = buffer.trim();
    if (trimmed.length >= MIN) {
      chunks.push({
        index: chunks.length,
        section: bufferSection,
        content: trimmed,
      });
    }
    buffer = "";
    bufferSection = section;
  };

  for (const line of lines) {
    const heading = matchHeading(line);
    if (heading) {
      flush();
      section = heading;
      bufferSection = heading;
      continue;
    }
    const candidate = buffer ? `${buffer}\n${line}` : line;
    if (candidate.length >= TARGET) {
      // Try to end on a paragraph boundary when we cross the target — but
      // never exceed HARD_CAP.
      if (candidate.length > HARD_CAP) {
        // Emit current buffer, start fresh with the long line (which will
        // itself be split below if still too long).
        flush();
        buffer = line;
        bufferSection = section;
        continue;
      }
      // The paragraph (next blank line) would be nicer, but we don't peek —
      // flush here on the first line that pushes us past TARGET.
      buffer = candidate;
      flush();
    } else {
      buffer = candidate;
      if (bufferSection === null) bufferSection = section;
    }
  }
  flush();

  // Secondary pass — any oversized chunk (shouldn't happen but belt-and-braces)
  // gets split on sentence boundaries.
  const expanded: Chunk[] = [];
  for (const c of chunks) {
    if (c.content.length <= HARD_CAP) {
      expanded.push(c);
      continue;
    }
    for (const piece of splitBySentence(c.content, HARD_CAP)) {
      expanded.push({ index: expanded.length, section: c.section, content: piece });
    }
  }
  // Renumber to make indices contiguous.
  return expanded.map((c, i) => ({ ...c, index: i }));
}

function normalise(s: string): string {
  // Strip BOM, normalise CRLF, collapse whitespace runs within a line.
  return s
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function matchHeading(line: string): string | null {
  // Markdown ATX heading (# … ######).
  const md = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
  if (md) return md[2]!.trim();
  // Markdown Setext heading would require lookahead — skip.
  return null;
}

function splitBySentence(text: string, cap: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const slice = text.slice(i, i + cap);
    // Prefer to break at the last sentence terminator within the cap.
    const lastEnd = Math.max(
      slice.lastIndexOf("."),
      slice.lastIndexOf("!"),
      slice.lastIndexOf("?"),
      slice.lastIndexOf("؟"), // Arabic
      slice.lastIndexOf("۔"),
    );
    const cut = lastEnd > cap / 2 ? lastEnd + 1 : slice.length;
    out.push(text.slice(i, i + cut).trim());
    i += cut;
  }
  return out.filter(Boolean);
}
