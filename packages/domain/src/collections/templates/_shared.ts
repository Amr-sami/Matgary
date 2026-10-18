// Digital collections — pieces shared by every template file (spec 06 §4.10).
//
// Server-authoritative (named groups and the dotAll flag are used on purpose);
// mobile never imports templates/* (06 §4.1, hermes-safe.test.ts).

/** An amount: "64,500.00", "2700.00", "500.5", "20000". */
export const AMT = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?`;

/** A separator that may be a kept newline (normalizeText keeps "\n"). */
export const S = String.raw`\s`;

/** Every template regex: case-insensitive, "." spans the kept newlines. */
export const re = (src: string): RegExp => new RegExp(src, "is");
