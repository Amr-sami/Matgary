// Text → printer bytes. Pure TS, no platform imports (doc 06 §1.4).
//
// Cheap ESC/POS printers do not speak UTF-8. They have a handful of 8-bit
// code tables selected with ESC t, print strictly left-to-right, and — with
// the exception of a few Arabic-firmware Xprinters — do not shape Arabic.
// So text mode for Arabic means: contextual shaping into Presentation
// Forms-B here, visual (pre-reversed) ordering here, and a code table that
// actually contains shaped glyphs — that is PC864. Windows-1256 only has the
// nominal letters, so on a non-shaping printer it prints isolated letters;
// it is offered for the printers whose firmware does shape.
//
// For anything the tables cannot express (Persian letters, emoji, CJK) the
// raster path in ./receipt.ts is the answer, exactly as the doc says.

export type Codepage = "pc437" | "pc864" | "win1256";

// ---------------------------------------------------------------------------
// Windows-1256 — bytes 0x80..0xFF. Index = byte - 0x80; -1 = undefined.

const WIN1256_HIGH: readonly number[] = [
  0x20ac, 0x067e, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0679, 0x2039, 0x0152, 0x0686, 0x0698, 0x0688,
  0x06af, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x06a9, 0x2122, 0x0691, 0x203a, 0x0153, 0x200c, 0x200d, 0x06ba,
  0x00a0, 0x060c, 0x00a2, 0x00a3, 0x00a4, 0x00a5, 0x00a6, 0x00a7, 0x00a8, 0x00a9, 0x06be, 0x00ab, 0x00ac, 0x00ad, 0x00ae, 0x00af,
  0x00b0, 0x00b1, 0x00b2, 0x00b3, 0x00b4, 0x00b5, 0x00b6, 0x00b7, 0x00b8, 0x00b9, 0x061b, 0x00bb, 0x00bc, 0x00bd, 0x00be, 0x061f,
  0x06c1, 0x0621, 0x0622, 0x0623, 0x0624, 0x0625, 0x0626, 0x0627, 0x0628, 0x0629, 0x062a, 0x062b, 0x062c, 0x062d, 0x062e, 0x062f,
  0x0630, 0x0631, 0x0632, 0x0633, 0x0634, 0x0635, 0x0636, 0x00d7, 0x0637, 0x0638, 0x0639, 0x063a, 0x0640, 0x0641, 0x0642, 0x0643,
  0x00e0, 0x0644, 0x00e2, 0x0645, 0x0646, 0x0647, 0x0648, 0x00e7, 0x00e8, 0x00e9, 0x00ea, 0x00eb, 0x0649, 0x064a, 0x00ee, 0x00ef,
  0x064b, 0x064c, 0x064d, 0x064e, 0x00f4, 0x064f, 0x0650, 0x00f7, 0x0651, 0x00f9, 0x0652, 0x00fb, 0x00fc, 0x200e, 0x200f, 0x06d2,
];

// ---------------------------------------------------------------------------
// PC864 (IBM Arabic) — bytes 0x80..0xFF, from unicode.org CP864.TXT.
// Holds *shaped* glyphs: isolated forms, and initial forms for the letters
// that join forward. Final ≈ isolated and medial ≈ initial in this table —
// the glyphs were drawn with the joining stroke, so the fallback is exact.

const PC864_HIGH: readonly number[] = [
  0x00b0, 0x00b7, 0x2219, 0x221a, 0x2592, 0x2500, 0x2502, 0x253c, 0x2524, 0x252c, 0x251c, 0x2534, 0x2510, 0x250c, 0x2514, 0x2518,
  0x03b2, 0x221e, 0x03c6, 0x00b1, 0x00bd, 0x00bc, 0x2248, 0x00ab, 0x00bb, 0xfef7, 0xfef8, -1, -1, 0xfefb, 0xfefc, -1,
  0x00a0, 0x00ad, 0xfe82, 0x00a3, 0x00a4, 0xfe84, -1, -1, 0xfe8e, 0xfe8f, 0xfe95, 0xfe99, 0x060c, 0xfe9d, 0xfea1, 0xfea5,
  0x0660, 0x0661, 0x0662, 0x0663, 0x0664, 0x0665, 0x0666, 0x0667, 0x0668, 0x0669, 0xfed1, 0x061b, 0xfeb1, 0xfeb5, 0xfeb9, 0x061f,
  0x00a2, 0xfe80, 0xfe81, 0xfe83, 0xfe85, 0xfeca, 0xfe8b, 0xfe8d, 0xfe91, 0xfe93, 0xfe97, 0xfe9b, 0xfe9f, 0xfea3, 0xfea7, 0xfea9,
  0xfeab, 0xfead, 0xfeaf, 0xfeb3, 0xfeb7, 0xfebb, 0xfebf, 0xfec1, 0xfec5, 0xfecb, 0xfecf, 0x00a6, 0x00ac, 0x00f7, 0x00d7, 0xfec9,
  0x0640, 0xfed3, 0xfed7, 0xfedb, 0xfedf, 0xfee3, 0xfee7, 0xfeeb, 0xfeed, 0xfeef, 0xfef3, 0xfebd, 0xfecc, 0xfece, 0xfecd, 0xfee1,
  0xfe7d, 0x0651, 0xfee5, 0xfee9, 0xfeec, 0xfef0, 0xfef2, 0xfed0, 0xfed5, 0xfef5, 0xfef6, 0xfedd, 0xfed9, 0xfef1, 0x25a0, -1,
];

function reverseTable(high: readonly number[]): Map<number, number> {
  const m = new Map<number, number>();
  high.forEach((cp, i) => {
    if (cp >= 0) m.set(cp, 0x80 + i);
  });
  return m;
}

const WIN1256 = reverseTable(WIN1256_HIGH);
const PC864 = reverseTable(PC864_HIGH);

// ---------------------------------------------------------------------------
// Arabic contextual shaping (U+0621..U+064A → Presentation Forms-B).
// [isolated, final, initial, medial]; two entries = right-joining only.

const FORMS: Record<number, readonly number[]> = {
  0x0621: [0xfe80],
  0x0622: [0xfe81, 0xfe82],
  0x0623: [0xfe83, 0xfe84],
  0x0624: [0xfe85, 0xfe86],
  0x0625: [0xfe87, 0xfe88],
  0x0626: [0xfe89, 0xfe8a, 0xfe8b, 0xfe8c],
  0x0627: [0xfe8d, 0xfe8e],
  0x0628: [0xfe8f, 0xfe90, 0xfe91, 0xfe92],
  0x0629: [0xfe93, 0xfe94],
  0x062a: [0xfe95, 0xfe96, 0xfe97, 0xfe98],
  0x062b: [0xfe99, 0xfe9a, 0xfe9b, 0xfe9c],
  0x062c: [0xfe9d, 0xfe9e, 0xfe9f, 0xfea0],
  0x062d: [0xfea1, 0xfea2, 0xfea3, 0xfea4],
  0x062e: [0xfea5, 0xfea6, 0xfea7, 0xfea8],
  0x062f: [0xfea9, 0xfeaa],
  0x0630: [0xfeab, 0xfeac],
  0x0631: [0xfead, 0xfeae],
  0x0632: [0xfeaf, 0xfeb0],
  0x0633: [0xfeb1, 0xfeb2, 0xfeb3, 0xfeb4],
  0x0634: [0xfeb5, 0xfeb6, 0xfeb7, 0xfeb8],
  0x0635: [0xfeb9, 0xfeba, 0xfebb, 0xfebc],
  0x0636: [0xfebd, 0xfebe, 0xfebf, 0xfec0],
  0x0637: [0xfec1, 0xfec2, 0xfec3, 0xfec4],
  0x0638: [0xfec5, 0xfec6, 0xfec7, 0xfec8],
  0x0639: [0xfec9, 0xfeca, 0xfecb, 0xfecc],
  0x063a: [0xfecd, 0xfece, 0xfecf, 0xfed0],
  0x0640: [0x0640, 0x0640, 0x0640, 0x0640], // tatweel joins both ways
  0x0641: [0xfed1, 0xfed2, 0xfed3, 0xfed4],
  0x0642: [0xfed5, 0xfed6, 0xfed7, 0xfed8],
  0x0643: [0xfed9, 0xfeda, 0xfedb, 0xfedc],
  0x0644: [0xfedd, 0xfede, 0xfedf, 0xfee0],
  0x0645: [0xfee1, 0xfee2, 0xfee3, 0xfee4],
  0x0646: [0xfee5, 0xfee6, 0xfee7, 0xfee8],
  0x0647: [0xfee9, 0xfeea, 0xfeeb, 0xfeec],
  0x0648: [0xfeed, 0xfeee],
  0x0649: [0xfeef, 0xfef0],
  0x064a: [0xfef1, 0xfef2, 0xfef3, 0xfef4],
};

/** Lam + (آ أ إ ا) → [isolated, final] ligature. */
const LAM_ALEF: Record<number, readonly [number, number]> = {
  0x0622: [0xfef5, 0xfef6],
  0x0623: [0xfef7, 0xfef8],
  0x0625: [0xfef9, 0xfefa],
  0x0627: [0xfefb, 0xfefc],
};

/** Harakat and other marks that neither join nor occupy a cell. */
const isTransparent = (cp: number) => (cp >= 0x064b && cp <= 0x065f) || cp === 0x0670 || cp === 0x0610 || cp === 0x0611;
const joinsForward = (cp: number) => (FORMS[cp]?.length ?? 0) === 4;
const joinsBackward = (cp: number) => (FORMS[cp]?.length ?? 0) >= 2;

/**
 * Contextual shaping. Harakat are dropped (cheap fonts overlay them badly),
 * lam-alef becomes its ligature. Non-Arabic characters pass through.
 */
export function shapeArabic(text: string): string {
  const cps = Array.from(text, (c) => c.codePointAt(0) as number).filter((cp) => !isTransparent(cp));
  const out: number[] = [];
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i]!;
    const forms = FORMS[cp];
    if (!forms) {
      out.push(cp);
      continue;
    }
    const prev = i > 0 ? cps[i - 1]! : -1;
    const next = i + 1 < cps.length ? cps[i + 1]! : -1;
    const fromPrev = prev >= 0 && joinsForward(prev);

    if (cp === 0x0644 && next >= 0 && LAM_ALEF[next]) {
      out.push(LAM_ALEF[next]![fromPrev ? 1 : 0]);
      i++; // the alef is consumed by the ligature
      continue;
    }
    const toNext = forms.length === 4 && next >= 0 && joinsBackward(next);
    const idx = fromPrev && toNext ? 3 : fromPrev ? 1 : toNext ? 2 : 0;
    out.push(forms[Math.min(idx, forms.length - 1)]!);
  }
  return String.fromCodePoint(...out);
}

// ---------------------------------------------------------------------------
// Visual ordering — a receipt-sized subset of the bidi algorithm.
// Printers draw left→right, so an RTL line is emitted reversed, while runs of
// Latin letters and numbers inside it keep their own left→right order.

const isArabicLetter = (cp: number) =>
  (cp >= 0x0600 && cp <= 0x06ff && !isTransparent(cp)) || (cp >= 0xfb50 && cp <= 0xfdff) || (cp >= 0xfe70 && cp <= 0xfeff);
const isLatinLetter = (cp: number) => (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x24f);
const isDigit = (cp: number) => (cp >= 0x30 && cp <= 0x39) || (cp >= 0x0660 && cp <= 0x0669);
const isNumberInner = (cp: number) => cp === 0x2e || cp === 0x2c || cp === 0x3a || cp === 0x2f || cp === 0x25 || cp === 0x2d || cp === 0x066b || cp === 0x066c;

const MIRROR: Record<number, number> = { 0x28: 0x29, 0x29: 0x28, 0x5b: 0x5d, 0x5d: 0x5b, 0x7b: 0x7d, 0x7d: 0x7b, 0x3c: 0x3e, 0x3e: 0x3c };

type RunKind = "R" | "L" | "EN" | "N";

export function hasArabic(text: string): boolean {
  for (const c of text) if (isArabicLetter(c.codePointAt(0) as number)) return true;
  return false;
}

/**
 * Reorder a single logical line into the left→right order a printer draws.
 * Lines without Arabic are returned unchanged.
 */
export function visualOrder(text: string): string {
  if (!hasArabic(text)) return text;
  const cps = Array.from(text, (c) => c.codePointAt(0) as number);
  const runs: { kind: RunKind; cps: number[] }[] = [];
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i]!;
    let kind: RunKind = isArabicLetter(cp) ? "R" : isLatinLetter(cp) ? "L" : isDigit(cp) ? "EN" : "N";
    // "12.50" / "10:30" / "1/2": keep separators inside the number run.
    if (kind === "N" && isNumberInner(cp) && runs.length && runs[runs.length - 1]!.kind === "EN" && i + 1 < cps.length && isDigit(cps[i + 1]!)) {
      kind = "EN";
    }
    const last = runs[runs.length - 1];
    if (last && last.kind === kind) last.cps.push(cp);
    else runs.push({ kind, cps: [cp] });
  }
  // Neutrals take the direction of matching neighbours, else the paragraph (R).
  // Numbers glued to Latin behave as Latin so "SKU 123" stays one L block.
  const resolved: ("R" | "L" | "EN")[] = runs.map((r) => (r.kind === "N" ? "R" : r.kind));
  for (let i = 0; i < runs.length; i++) {
    if (runs[i]!.kind !== "N") continue;
    const before = i > 0 ? resolved[i - 1] : undefined;
    const after = i + 1 < runs.length ? resolved[i + 1] : undefined;
    resolved[i] = before === "L" && after === "L" ? "L" : before === "L" && after === "EN" ? "L" : before === "EN" && after === "L" ? "L" : "R";
  }
  // Merge adjacent L/EN into one LTR block so their internal order survives.
  const blocks: { ltr: boolean; cps: number[] }[] = [];
  for (let i = 0; i < runs.length; i++) {
    const ltr = resolved[i] !== "R";
    const prevBlock = blocks[blocks.length - 1];
    if (prevBlock && prevBlock.ltr && ltr) prevBlock.cps.push(...runs[i]!.cps);
    else blocks.push({ ltr, cps: [...runs[i]!.cps] });
  }
  // RTL paragraph: blocks appear right→left, so emit them reversed; RTL
  // blocks are reversed character-wise (with mirrored brackets), LTR kept.
  const out: number[] = [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    const blk = blocks[i]!;
    if (blk.ltr) out.push(...blk.cps);
    else for (let j = blk.cps.length - 1; j >= 0; j--) out.push(MIRROR[blk.cps[j]!] ?? blk.cps[j]!);
  }
  return String.fromCodePoint(...out);
}

// ---------------------------------------------------------------------------
// Encoding

export interface EncodeOptions {
  /** Byte used for characters the table cannot express. Default "?" */
  replacement?: number;
  /** Skip shaping + reordering (text is already visual / the printer shapes). */
  raw?: boolean;
}

/**
 * Logical → visual for one self-contained paragraph: shaped + reordered for
 * pc864, reordered only for win1256 (the printer shapes), untouched for pc437.
 * Feed the result to encodeText with `raw: true`. Used to shape each cell of
 * a two-column row on its own so the row's layout is not reordered again.
 */
export function toVisual(text: string, codepage: Codepage): string {
  return codepage === "pc864" ? visualOrder(shapeArabic(text)) : codepage === "win1256" ? visualOrder(text) : text;
}

/**
 * Encode one logical line for the given code table.
 *  - pc437: ASCII only; anything else becomes the replacement byte.
 *  - pc864: Arabic is shaped and reordered here, glyphs mapped with the
 *    final→isolated / medial→initial fallbacks the table was drawn for.
 *  - win1256: nominal letters, reordered; shaping is left to the printer.
 */
export function encodeText(text: string, codepage: Codepage, opts: EncodeOptions = {}): Uint8Array {
  const repl = opts.replacement ?? 0x3f;
  const prepared = opts.raw ? text : toVisual(text, codepage);
  const out: number[] = [];
  for (const ch of prepared) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) {
      out.push(cp);
      continue;
    }
    if (codepage === "pc437") {
      out.push(repl);
      continue;
    }
    const table = codepage === "pc864" ? PC864 : WIN1256;
    let byte = table.get(cp);
    if (byte === undefined && codepage === "pc864") byte = pc864Fallback(cp);
    if (byte === undefined && codepage === "win1256") byte = WIN1256.get(deshape(cp));
    out.push(byte ?? repl);
  }
  return Uint8Array.from(out);
}

/** Final → isolated, medial → initial: the glyphs PC864 was drawn with. */
function pc864Fallback(cp: number): number | undefined {
  for (const [nominal, forms] of Object.entries(FORMS)) {
    const idx = forms.indexOf(cp);
    if (idx < 0) continue;
    const alt = idx === 1 ? forms[0] : idx === 3 ? forms[2] : undefined;
    const byte = alt !== undefined ? PC864.get(alt) : undefined;
    if (byte !== undefined) return byte;
    // Some letters (yeh, heh) only have odd forms in PC864 — try any form.
    for (const f of forms) {
      const b = PC864.get(f);
      if (b !== undefined) return b;
    }
    void nominal;
  }
  for (const [nominal, lig] of Object.entries(LAM_ALEF)) {
    if (lig[1] === cp) return PC864.get(lig[0]) ?? PC864.get(0xfedd);
    void nominal;
  }
  return undefined;
}

/** Presentation form → nominal letter (for the win1256 table). */
function deshape(cp: number): number {
  for (const [nominal, forms] of Object.entries(FORMS)) if (forms.includes(cp)) return Number(nominal);
  return cp;
}

/** Character cell width — Arabic presentation forms are one cell each; harakat none. */
export function cellWidth(text: string): number {
  let n = 0;
  for (const c of text) if (!isTransparent(c.codePointAt(0) as number)) n++;
  return n;
}
