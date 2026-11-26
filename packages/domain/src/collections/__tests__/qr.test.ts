// Run: npm test -w @matgary/domain
import { test } from "node:test";
import assert from "node:assert/strict";

import { qrMatrix, qrSvgPath, type QrMatrix } from "../qr";

const LINK = "https://ipn.eg/S/shop/instapay/AbC123";

const dark = (m: QrMatrix, r: number, c: number) => m.modules[r * m.size + c] === 1;

function assertFinder(m: QrMatrix, top: number, left: number, where: string) {
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3)); // 3 = outer ring, 2 = light ring, 0–1 = centre
      const expected = ring !== 2;
      assert.equal(dark(m, top + r, left + c), expected, `${where} finder (${r},${c})`);
    }
  }
}

test("acceptance 8: an IPA link gives version 3, size 29, 841 modules and three finder patterns", () => {
  const m = qrMatrix(LINK);
  assert.equal(m.version, 3);
  assert.equal(m.size, 29);
  assert.equal(m.modules.length, 841);
  assert.ok(m.modules instanceof Uint8Array);
  assert.ok(m.modules.every((v) => v === 0 || v === 1), "modules are 0/1");
  assertFinder(m, 0, 0, "top-left");
  assertFinder(m, 0, m.size - 7, "top-right");
  assertFinder(m, m.size - 7, 0, "bottom-left");
});

test("deterministic: two calls give equal matrices, and the data is a copy", () => {
  const a = qrMatrix(LINK);
  const b = qrMatrix(LINK);
  assert.deepEqual(a, b);
  a.modules[0] = 0;
  assert.equal(qrMatrix(LINK).modules[0], 1, "mutating a result does not leak into the next call");
});

test("ECC H needs a higher version than L for the same text; default is M", () => {
  const l = qrMatrix(LINK, { ecc: "L" });
  const h = qrMatrix(LINK, { ecc: "H" });
  assert.ok(h.version > l.version, `H v${h.version} > L v${l.version}`);
  assert.deepEqual(qrMatrix(LINK, { ecc: "M" }), qrMatrix(LINK));
  assert.equal(l.size, 21 + 4 * (l.version - 1));
});

test("empty and over-capacity text throw RangeError", () => {
  assert.throws(() => qrMatrix(""), RangeError);
  assert.throws(() => qrMatrix("a".repeat(3000), { ecc: "H" }), RangeError);
});

// Parse the path back into a grid: every run is "M{x} {y}h{n}v1h-{n}z".
function rasterise(d: string, viewBox: number): number[] {
  const grid = new Array<number>(viewBox * viewBox).fill(0);
  const runRe = /M(\d+) (\d+)h(\d+)v1h-(\d+)z/g;
  let consumed = 0;
  for (let m = runRe.exec(d); m; m = runRe.exec(d)) {
    const [, xs, ys, ns, back] = m;
    assert.equal(ns, back, "each run closes on itself");
    const x = Number(xs);
    const y = Number(ys);
    const n = Number(ns);
    for (let i = 0; i < n; i++) grid[y * viewBox + x + i] += 1;
    consumed += m[0].length;
  }
  assert.equal(consumed, d.length, "the path contains only runs");
  return grid;
}

test("qrSvgPath covers each dark module exactly once, offset by the quiet zone", () => {
  const m = qrMatrix(LINK);
  const { d, viewBox } = qrSvgPath(m);
  assert.ok(d.length > 0);
  assert.equal(viewBox, m.size + 8);
  const grid = rasterise(d, viewBox);
  for (let y = 0; y < viewBox; y++) {
    for (let x = 0; x < viewBox; x++) {
      const inside = x >= 4 && y >= 4 && x < 4 + m.size && y < 4 + m.size;
      const expected = inside && dark(m, y - 4, x - 4) ? 1 : 0;
      assert.equal(grid[y * viewBox + x], expected, `(${x},${y})`);
    }
  }
});

test("qrSvgPath with a custom quiet zone", () => {
  const m = qrMatrix(LINK);
  const { d, viewBox } = qrSvgPath(m, 0);
  assert.equal(viewBox, m.size);
  assert.ok(d.startsWith("M0 0h7v1h-7z"), "the top-left finder's first row is a 7-module run at the origin");
  assert.throws(() => qrSvgPath(m, -1), RangeError);
});
