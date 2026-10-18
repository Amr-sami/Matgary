// Run: npm test -w @matgary/domain
//
// Mobile (Hermes) imports only these collections files, so they must avoid
// the syntax and APIs Hermes may lack (spec 06 §4.1): regex lookbehind,
// Unicode property escapes, named groups, the dotAll ("s") flag, time-zone
// APIs, and String.prototype.normalize — except normalize.ts's single call,
// which must sit behind a feature test. templates/*, parse, dedupe and match
// are server-authoritative and are NOT checked here.
//
// Two layers: a plain substring scan of the whole file (comments included, so
// keep these tokens out of comments too), and a TypeScript AST walk for the
// regex flags of literals and of `new RegExp(…, flags)` / `RegExp(…, flags)`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ts from "typescript";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// filter.ts landed with part B (order 18, 2026-10-18); mobile may import it.
const FILES = ["types", "normalize", "providers", "limits", "ipa", "qr", "eta", "filter"];

const FORBIDDEN_SUBSTRINGS = ["(?<=", "(?<!", "(?<", "\\p{", "\\P{", "Intl.", ".normalize("];
const GUARD = 'typeof "".normalize === "function"';

interface Finding {
  file: string;
  line: number;
  what: string;
}

function scanText(file: string, src: string): Finding[] {
  const out: Finding[] = [];
  src.split("\n").forEach((lineText, i) => {
    for (const bad of FORBIDDEN_SUBSTRINGS) {
      if (!lineText.includes(bad)) continue;
      // The one allowed exception: normalize.ts's guarded NFKC call.
      if (bad === ".normalize(" && file === "normalize.ts" && lineText.includes(GUARD)) continue;
      out.push({ file, line: i + 1, what: `contains ${JSON.stringify(bad)}` });
    }
  });
  return out;
}

function scanAst(file: string, src: string): Finding[] {
  const out: Finding[] = [];
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const checkFlags = (flags: string, node: ts.Node) => {
    if (flags.includes("s")) out.push({ file, line: lineOf(node), what: `regex flag "s" (${flags})` });
  };
  const visit = (node: ts.Node) => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
      const text = node.getText(sf);
      checkFlags(text.slice(text.lastIndexOf("/") + 1), node);
    } else if (
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "RegExp"
    ) {
      const flagsArg = node.arguments?.[1];
      if (flagsArg) {
        if (ts.isStringLiteralLike(flagsArg)) checkFlags(flagsArg.text, node);
        else out.push({ file, line: lineOf(node), what: "RegExp flags must be a string literal (checkable)" });
      }
    } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Intl") {
      out.push({ file, line: lineOf(node), what: "uses Intl" });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

const present = FILES.filter((f) => existsSync(path.join(DIR, `${f}.ts`)));

test("the mobile-importable files exist (part A + filter.ts)", () => {
  for (const f of ["types", "normalize", "providers", "limits", "ipa", "qr", "eta", "filter"]) {
    assert.ok(present.includes(f), `${f}.ts`);
  }
});

for (const name of present) {
  test(`${name}.ts is Hermes-safe`, () => {
    const file = `${name}.ts`;
    const src = readFileSync(path.join(DIR, file), "utf8");
    const findings = [...scanText(file, src), ...scanAst(file, src)];
    assert.deepEqual(findings, [], findings.map((f) => `${f.file}:${f.line} ${f.what}`).join("\n"));
  });
}

test("normalize.ts has exactly one guarded normalize call", () => {
  const src = readFileSync(path.join(DIR, "normalize.ts"), "utf8");
  const lines = src.split("\n").filter((l) => l.includes(".normalize("));
  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(GUARD), lines[0]);
  assert.ok(lines[0].includes('.normalize("NFKC")'), lines[0]);
});

test("the scanners catch what they must (self-test)", () => {
  const bad = [
    "const a = /(?<=x)y/;",
    "const b = /(?<n>x)/;",
    "const c = /\\p{L}/u;",
    "const d = /a.b/s;",
    "const e = new RegExp(src, \"is\");",
    "const f = RegExp(src, 'gs');",
    "const g = new Intl.DateTimeFormat();",
    "const h = s.normalize(\"NFC\");",
    "const i = new RegExp(src, flags);",
  ];
  for (const snippet of bad) {
    const found = [...scanText("x.ts", snippet), ...scanAst("x.ts", snippet)];
    assert.ok(found.length > 0, `not caught: ${snippet}`);
  }
  const ok = ["const a = /^[a-z]+$/gi;", "const b = new RegExp(\"x\", \"gi\");", "const c = s.split('/s');"];
  for (const snippet of ok) {
    const found = [...scanText("x.ts", snippet), ...scanAst("x.ts", snippet)];
    assert.deepEqual(found, [], `false positive: ${snippet}`);
  }
});
