/**
 * Doc 15 spec 14 §7 — digital-collections security invariants (source reads).
 *
 * Created by spec 05 step 23b with SI-1a and SI-1b only. Spec 14 at M1 (README
 * §3 order 11) added SI-2, SI-5 and SI-6, the cases that have M1 code to read;
 * spec 14 steps 6–9 (README §3 order 23) added SI-3, SI-4 and SI-7 against
 * spec 07's M2 files (ingest repo, raw-text, the v1 ingest routes).
 * Every case is `it.runIf(existsSync(path))` so it activates when the owning
 * spec lands. SI-3 / SI-4 / SI-7 are pure checkers over source text, and each
 * has a built-in negative control: the same checker run on a synthetic
 * offending snippet must report it (so a checker that silently matches
 * nothing turns the suite red instead of green).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { scrubSentryEvent } from "@matgary/domain/observability/scrub";

const WEB = path.resolve(__dirname, "../..");
const EXPORT_ROUTE = path.join(WEB, "app/api/account/export/route.ts");
const MIGRATIONS = path.join(WEB, "lib/db/migrations");
const AUTH_HELPERS = path.join(WEB, "lib/api/auth-helpers.ts");
const MOBILE = path.resolve(WEB, "../mobile");
/** SI-3 scope (14 §7 plus 07's devices repo / route and the shared route helper). */
const SI3_ANCHOR = path.join(WEB, "lib/repo/collection-ingest.ts");
const INGEST_TOKEN = path.join(WEB, "lib/api/ingest-token.ts");
const CREDITS_REPO = path.join(WEB, "lib/repo/collection-credits.ts");
const SI3_FILES = [
  SI3_ANCHOR,
  CREDITS_REPO,
  INGEST_TOKEN,
  path.join(WEB, "lib/repo/collection-devices.ts"),
  path.join(WEB, "lib/collections/raw-text.ts"),
  path.join(WEB, "lib/collections/route-helpers.ts"),
  path.join(WEB, "app/api/v1/collections/**"),
  path.join(WEB, "app/api/collections/credits/**"),
  path.join(WEB, "app/api/collections/unrecognised/**"),
  path.join(WEB, "app/api/collections/devices/**"),
];
/** SI-4: the only module allowed to produce `*_enc` values, and the server-side roots scanned. */
const RAW_TEXT = path.join(WEB, "lib/collections/raw-text.ts");
const SI4_ROOTS = [path.join(WEB, "lib"), path.join(WEB, "app"), path.join(WEB, "scripts")];
/** SI-7. */
const INGEST_ROUTE = path.join(WEB, "app/api/v1/collections/ingest/route.ts");
/** Every screen / component that renders collections data (raw message text from M2). */
const COLLECTIONS_UI = [
  path.join(WEB, "app/collections"),
  path.join(WEB, "components/collections"),
  path.join(WEB, "app/settings/collections"),
  path.join(MOBILE, "src/app/(app)/collections"),
  path.join(MOBILE, "src/app/(app)/collections.tsx"),
  path.join(MOBILE, "src/components/collections"),
  path.join(MOBILE, "src/app/(app)/settings/collections"),
  path.join(MOBILE, "src/app/(app)/settings/collections.tsx"),
];

/** .ts / .tsx files under a file-or-directory root. */
function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  if (statSync(root).isFile()) return /\.tsx?$/.test(root) ? [root] : [];
  return readdirSync(root, { withFileTypes: true }).flatMap((e) =>
    sourceFiles(path.join(root, e.name)),
  );
}

/** String literals of the `const TABLES = [ … ] as const` array. */
function exportTables(src: string): string[] {
  const m = src.match(/const TABLES = \[([\s\S]*?)\] as const/);
  if (!m) throw new Error("TABLES array not found in the export route");
  return [...m[1]!.matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1]!);
}

/** Keys of the `EXPLICIT_TENANT_FILTER` map with a `tenant_id` / `id` column. */
function explicitlyFiltered(src: string): Set<string> {
  const m = src.match(/const EXPLICIT_TENANT_FILTER[^=]*=\s*\{([\s\S]*?)\};/);
  if (!m) return new Set();
  return new Set(
    [...m[1]!.matchAll(/([a-z0-9_]+)\s*:\s*"(tenant_id|id)"/g)].map((x) => x[1]!),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Source scanning for SI-3 / SI-4 / SI-7
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The source with every comment and every string-literal character replaced
 * by a space, length preserved (so an index in the result is the same index
 * in the source). Template-literal `${…}` expressions stay as code, because an
 * identifier inside one is a real value. Regex literals are not special-cased:
 * `assertBalanced` below catches a file where that would confuse the scan.
 */
function blankStringsAndComments(src: string): string {
  const out = src.split("");
  type Mode = "code" | "line" | "block" | "sq" | "dq" | "tpl";
  // Each `${` inside a template pushes a code frame that remembers its brace depth.
  const stack: { mode: Mode; depth: number }[] = [{ mode: "code", depth: 0 }];
  const blank = (i: number) => {
    if (out[i] !== "\n") out[i] = " ";
  };
  for (let i = 0; i < src.length; i++) {
    const top = stack[stack.length - 1]!;
    const c = src[i]!;
    const n = src[i + 1];
    switch (top.mode) {
      case "code":
        if (c === "/" && n === "/") {
          stack.push({ mode: "line", depth: 0 });
          blank(i);
        } else if (c === "/" && n === "*") {
          stack.push({ mode: "block", depth: 0 });
          blank(i);
        } else if (c === "'") stack.push({ mode: "sq", depth: 0 });
        else if (c === '"') stack.push({ mode: "dq", depth: 0 });
        else if (c === "`") stack.push({ mode: "tpl", depth: 0 });
        else if (c === "{") top.depth++;
        else if (c === "}") {
          if (top.depth === 0 && stack.length > 1) stack.pop(); // end of a `${…}`
          else top.depth--;
        }
        break;
      case "line":
        if (c === "\n") stack.pop();
        else blank(i);
        break;
      case "block":
        blank(i);
        if (c === "*" && n === "/") {
          blank(i + 1);
          i++;
          stack.pop();
        }
        break;
      case "sq":
      case "dq":
        if (c === "\\") {
          blank(i);
          blank(i + 1);
          i++;
        } else if ((top.mode === "sq" && c === "'") || (top.mode === "dq" && c === '"')) stack.pop();
        else blank(i);
        break;
      case "tpl":
        if (c === "\\") {
          blank(i);
          blank(i + 1);
          i++;
        } else if (c === "`") stack.pop();
        else if (c === "$" && n === "{") {
          i++;
          stack.push({ mode: "code", depth: 0 });
        } else blank(i);
        break;
    }
  }
  return out.join("");
}

/** Throw when the blanked source has unbalanced brackets: the scan lost track
 *  of a string or comment, and every result from it would be unreliable. */
function assertBalanced(blanked: string, label: string): void {
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const st: string[] = [];
  for (const c of blanked) {
    if (c === "(" || c === "[" || c === "{") st.push(c);
    else if (c in pairs) {
      if (st.pop() !== pairs[c]) throw new Error(`${label}: unbalanced "${c}" after blanking strings`);
    }
  }
  if (st.length) throw new Error(`${label}: ${st.length} unclosed bracket(s) after blanking strings`);
}

/** Index just past the bracket that closes the one at `open` (in blanked text). */
function closeOf(blanked: string, open: number): number {
  const o = blanked[open]!;
  const cl = o === "(" ? ")" : o === "{" ? "}" : "]";
  let d = 0;
  for (let i = open; i < blanked.length; i++) {
    if (blanked[i] === o) d++;
    else if (blanked[i] === cl && --d === 0) return i + 1;
  }
  throw new Error("unclosed bracket");
}

/** Split `text` (an argument list or object body, blanked twin `bl`) on its
 *  top-level commas. Returns raw slices. */
function topLevelSplit(text: string, bl: string): string[] {
  const parts: string[] = [];
  let d = 0;
  let from = 0;
  for (let i = 0; i < bl.length; i++) {
    const c = bl[i]!;
    if (c === "(" || c === "[" || c === "{") d++;
    else if (c === ")" || c === "]" || c === "}") d--;
    else if (c === "," && d === 0) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Line number (1-based) of an index. */
function lineOf(src: string, idx: number): number {
  return src.slice(0, idx).split("\n").length;
}

/** SI-3: identifiers that must never reach a log line or an activity row. */
const SI3_BANNED = /\b(body|title|subtitle|text|messages|token|raw)\b/;
/** SI-3: the calls that write a log line, a Sentry event or an activity row. */
const SI3_CALLS =
  /\b(?:console\s*\.\s*(?:log|info|warn|error|debug|trace)|logger\s*\.\s*(?:debug|info|warn|error)|captureException|captureMessage|logActivity)\s*\(/g;

/** SI-3 checker: every logging call whose argument names a banned identifier
 *  (string contents and comments do not count; property keys and values do). */
function si3Offences(src: string, label: string): string[] {
  const bl = blankStringsAndComments(src);
  assertBalanced(bl, label);
  const out: string[] = [];
  for (const m of bl.matchAll(SI3_CALLS)) {
    const open = m.index! + m[0].length - 1;
    const args = bl.slice(open + 1, closeOf(bl, open) - 1);
    const hit = args.match(SI3_BANNED);
    if (hit) out.push(`${label}:${lineOf(src, m.index!)} ${m[0].replace(/\s+/g, "")}… passes \`${hit[1]}\``);
  }
  return out;
}

/** The value expression passes SI-4: it comes from `encryptRawText(`, or it
 *  clears the column. */
function si4ValueOk(expr: string, col: string): boolean {
  const e = expr.trim();
  if (/encryptRawText\s*\(/.test(e)) return true;
  if (/^(?:null|NULL|undefined)$/.test(e)) return true;
  // ON CONFLICT … DO UPDATE SET body_enc = EXCLUDED.body_enc re-uses the inserted (encrypted) value.
  if (new RegExp(`^EXCLUDED\\.${col}$`, "i").test(e)) return true;
  return false;
}

/** SI-4 checker: every write of the raw text columns (raw SQL `SET col =`,
 *  `INSERT INTO collection_raw_messages (…) VALUES (…)`, Drizzle `.values({…})`
 *  / `.set({…})`) takes its value from `encryptRawText(`. Returns
 *  `{writes, offences}` so the caller can also assert the scan found writes. */
function si4Scan(src: string, label: string): { writes: number; offences: string[] } {
  const bl = blankStringsAndComments(src);
  assertBalanced(bl, label);
  const offences: string[] = [];
  let writes = 0;
  const COLS = /\b(title_enc|body_enc|titleEnc|bodyEnc)\b/g;

  // (1) SQL assignment `title_enc = <value>` (UPDATE … SET, DO UPDATE SET). The
  //     SQL lives in template text, so this reads the raw source.
  for (const m of src.matchAll(/\b(title_enc|body_enc)\s*=(?!=)/g)) {
    const before = src[m.index! - 1];
    if (before === "." || before === "!" || before === "<" || before === ">") continue;
    writes++;
    let i = m.index! + m[0].length;
    while (src[i] === " " || src[i] === "\t" || src[i] === "\n") i++;
    let expr: string;
    if (src.startsWith("${", i)) {
      expr = src.slice(i + 2, closeOf(bl, i + 1) - 1);
    } else {
      expr = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.]*/)?.[0] ?? src.slice(i, i + 20);
    }
    if (!si4ValueOk(expr, m[1]!)) offences.push(`${label}:${lineOf(src, m.index!)} ${m[1]} = ${expr.trim()}`);
  }

  // (2) INSERT column lists into collection_raw_messages.
  for (const m of src.matchAll(/INSERT\s+INTO\s+"?collection_raw_messages"?\s*\(([^)]*)\)\s*VALUES\s*\(/gi)) {
    const cols = m[1]!.split(",").map((c) => c.trim().replace(/"/g, ""));
    const open = m.index! + m[0].length - 1;
    // The VALUES tuple mixes SQL and `${…}`; bracket depth is read from the
    // raw text with `${` / `}` counted as brackets (the SQL here has no braces).
    const tupleRaw = src.slice(open + 1, closeOf(src, open) - 1);
    const vals = topLevelSplit(tupleRaw, tupleRaw.replace(/\$\{/g, " {"));
    cols.forEach((c, k) => {
      if (c !== "title_enc" && c !== "body_enc") return;
      writes++;
      const v = (vals[k] ?? "").replace(/^\$\{([\s\S]*)\}$/, "$1");
      if (!si4ValueOk(v, c)) offences.push(`${label}:${lineOf(src, m.index!)} INSERT ${c} ← ${v}`);
    });
  }

  // (3) Drizzle `.values({…})` / `.set({…})` objects.
  for (const m of bl.matchAll(/\.\s*(?:values|set)\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const end = closeOf(bl, open);
    const argRaw = src.slice(open + 1, end - 1);
    const argBl = bl.slice(open + 1, end - 1);
    for (const c of argBl.matchAll(COLS)) {
      const at = c.index!;
      const rest = argBl.slice(at + c[0].length);
      const colon = rest.match(/^\s*:/);
      writes++;
      if (!colon) {
        offences.push(`${label}:${lineOf(src, open + 1 + at)} shorthand \`${c[1]}\` (value not from encryptRawText)`);
        continue;
      }
      const from = at + c[0].length + colon[0].length;
      const tailRaw = argRaw.slice(from);
      const tailBl = argBl.slice(from);
      // The value runs to the next top-level `,` or the closing `}` of its object.
      let d = 0;
      let stop = tailBl.length;
      for (let i = 0; i < tailBl.length; i++) {
        const ch = tailBl[i]!;
        if (ch === "(" || ch === "[" || ch === "{") d++;
        else if (ch === ")" || ch === "]" || ch === "}") {
          if (d === 0) {
            stop = i;
            break;
          }
          d--;
        } else if (ch === "," && d === 0) {
          stop = i;
          break;
        }
      }
      const expr = tailRaw.slice(0, stop);
      if (!si4ValueOk(expr, c[1]!)) offences.push(`${label}:${lineOf(src, open + 1 + at)} ${c[1]}: ${expr.trim()}`);
    }
  }
  return { writes, offences };
}

/** Names an ingest-token route must never import: they resolve a USER session. */
const SI7_BANNED_IMPORTS = [
  "requireTenant",
  "requireTenantWithBranch",
  "requirePermission",
  "requirePermissionWithBranch",
  "requirePermissionWithBranchEnforced",
  "requirePermissionAudited",
  "resolveSession",
];

/** SI-7 checker for one v1 ingest route. */
function si7Offences(src: string, label: string): string[] {
  const out: string[] = [];
  const imported = new Map<string, string>(); // name → module
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g)) {
    for (const spec of m[1]!.split(",")) {
      const name = spec.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!.trim();
      if (name) imported.set(name, m[2]!);
    }
  }
  if (imported.get("requireIngestDevice") !== "@/lib/api/ingest-token") {
    out.push(`${label}: does not import requireIngestDevice from @/lib/api/ingest-token`);
  }
  for (const b of SI7_BANNED_IMPORTS) {
    if (imported.has(b)) out.push(`${label}: imports ${b} (a user-session helper)`);
  }
  if (/from\s+["']@\/lib\/auth["']|from\s+["']next-auth/.test(src)) out.push(`${label}: imports the cookie session`);
  const bl = blankStringsAndComments(src);
  const handlers = [...bl.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g)];
  if (handlers.length === 0) out.push(`${label}: no route handler found`);
  for (const h of handlers) {
    const bodyOpen = bl.indexOf("{", h.index! + h[0].length);
    const body = bl.slice(bodyOpen, closeOf(bl, bodyOpen));
    const auth = body.search(/\brequireIngestDevice\s*\(/);
    const read = body.search(/\breq\s*\.\s*(?:text|json|formData|arrayBuffer|blob)\s*\(/);
    if (auth === -1) out.push(`${label}: ${h[1]} never calls requireIngestDevice`);
    else if (read !== -1 && read < auth) out.push(`${label}: ${h[1]} reads the body before requireIngestDevice`);
  }
  return out;
}

/** Every file a glob-ish root expands to (`dir/**\/route.ts` style). */
function routeFiles(dir: string): string[] {
  return sourceFiles(dir).filter((f) => path.basename(f) === "route.ts");
}

function tablesWithRlsEnabled(): Set<string> {
  const out = new Set<string>();
  for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql"))) {
    const sqlText = readFileSync(path.join(MIGRATIONS, f), "utf8");
    for (const m of sqlText.matchAll(
      /ALTER TABLE\s+(?:IF EXISTS\s+)?(?:"?public"?\.)?"?([a-z0-9_]+)"?\s+ENABLE ROW LEVEL SECURITY/gi,
    )) {
      out.add(m[1]!.toLowerCase());
    }
  }
  return out;
}

describe("collections security invariants (spec 14 §7)", () => {
  it.runIf(existsSync(EXPORT_ROUTE))(
    "SI-1a: the owner export never carries collection_ingest_devices, collection_raw_messages or auth_devices",
    () => {
      const tables = exportTables(readFileSync(EXPORT_ROUTE, "utf8"));
      expect(tables.length).toBeGreaterThan(0);
      for (const banned of ["collection_ingest_devices", "collection_raw_messages", "auth_devices"]) {
        expect(tables).not.toContain(banned);
      }
    },
  );

  it.runIf(existsSync(EXPORT_ROUTE))(
    "SI-1b: every exported table has ENABLE ROW LEVEL SECURITY in a migration or an explicit tenant filter (SEC14-F1)",
    () => {
      const src = readFileSync(EXPORT_ROUTE, "utf8");
      const rls = tablesWithRlsEnabled();
      const filtered = explicitlyFiltered(src);
      const unguarded = exportTables(src).filter((t) => !rls.has(t) && !filtered.has(t));
      expect(unguarded).toEqual([]);
      // The filter must be applied as a parameterised WHERE, not merely declared.
      expect(src).toMatch(/WHERE \$\{sql\.identifier\(filterCol\)\} = \$\{r\.ctx\.tenantId\}/);
    },
  );

  it.runIf(existsSync(AUTH_HELPERS))(
    "SI-2: resolveSession refuses an mgi_ ingest bearer before any JWT parse",
    () => {
      const src = readFileSync(AUTH_HELPERS, "utf8");
      const start = src.search(/async function resolveSession\(/);
      expect(start).toBeGreaterThan(-1);
      const body = src.slice(start);
      const refuse = body.search(/startsWith\(\s*["']mgi_["']\s*\)/);
      const verify = body.indexOf("verifyAccessToken(");
      expect(refuse).toBeGreaterThan(-1);
      expect(verify).toBeGreaterThan(-1);
      expect(refuse).toBeLessThan(verify);
    },
  );

  describe("SI-3: no log line, Sentry call or activity row carries message text or a token (07 §4.10)", () => {
    it("negative control: the checker reports a banned identifier and ignores strings / comments", () => {
      const bad = [
        "logger.warn({ event: 'x', body: m.body });",
        "console.log(`got ${token}`);",
        "logActivity({ metadata: { messages } });",
        "Sentry.captureException(err, { extra: { raw } });",
        "logger.info({ n: await req.text() });",
      ];
      for (const line of bad) expect(si3Offences(line, "probe")).toHaveLength(1);
      const fine = [
        "logger.warn({ event: 'collections.body_dropped', count: n }); // the body itself is never logged",
        "console.error('token rejected', { prefix: tokenPrefix, bodyLength: len });",
        "logActivity({ action: 'collection.raw_view', metadata: { count: 1 } });",
        "const text = body; doSomething(text);",
      ];
      for (const line of fine) expect(si3Offences(line, "probe")).toEqual([]);
    });

    it.runIf(existsSync(SI3_ANCHOR))("07's ingest, credits, devices and unrecognised code passes the checker", () => {
      const files = SI3_FILES.flatMap((p) => (p.endsWith("/**") ? routeFiles(p.slice(0, -3)) : existsSync(p) ? [p] : []));
      // Not vacuous: the three named repo/token files and at least the three v1 routes are read.
      expect(files).toEqual(expect.arrayContaining([SI3_ANCHOR, INGEST_TOKEN, CREDITS_REPO]));
      expect(files.filter((f) => f.includes("/api/v1/collections/")).length).toBeGreaterThanOrEqual(3);
      const offences = files.flatMap((f) => si3Offences(readFileSync(f, "utf8"), path.relative(WEB, f)));
      expect(offences).toEqual([]);
    });
  });

  describe("SI-4: raw message text is only ever written encrypted (03 §E.4)", () => {
    it("negative control: plain writes are reported, encrypted / null / EXCLUDED writes are not", () => {
      const bad = [
        "await tx.execute(sql`UPDATE collection_raw_messages SET body_enc = ${body} WHERE id = ${id}`);",
        "await tx.execute(sql`UPDATE collection_raw_messages SET title_enc = 'x' WHERE id = ${id}`);",
        "await tx.execute(sql`INSERT INTO collection_raw_messages (tenant_id, body_enc) VALUES (${t}, ${m.body})`);",
        "await tx.insert(collectionRawMessages).values({ tenantId: t, bodyEnc: m.body });",
        "await tx.update(collectionRawMessages).set({ titleEnc }).where(eq(collectionRawMessages.id, id));",
      ];
      for (const s of bad) {
        const r = si4Scan(s, "probe");
        expect(r.writes).toBeGreaterThan(0);
        expect(r.offences).toHaveLength(1);
      }
      const fine = [
        "await tx.execute(sql`UPDATE collection_raw_messages SET body_enc = ${opts.text ? encryptRawText(opts.text.body) : null} WHERE id = ${id}`);",
        "await tx.execute(sql`UPDATE collection_raw_messages SET title_enc = NULL, body_enc = NULL WHERE id = ${id}`);",
        "await tx.execute(sql`INSERT INTO collection_raw_messages (tenant_id, body_enc) VALUES (${t}, ${encryptRawText(b)}) ON CONFLICT DO UPDATE SET body_enc = EXCLUDED.body_enc`);",
        "await tx.insert(collectionRawMessages).values({ tenantId: t, bodyEnc: encryptRawText(b), titleEnc: null });",
        "const rows = await tx.execute(sql`SELECT title_enc, body_enc FROM collection_raw_messages`); if (!r.body_enc) return;",
      ];
      for (const s of fine) expect(si4Scan(s, "probe").offences).toEqual([]);
    });

    it.runIf(existsSync(RAW_TEXT))("every write outside lib/collections/raw-text.ts takes encryptRawText(", () => {
      const files = SI4_ROOTS.flatMap(sourceFiles).filter(
        (f) => f !== RAW_TEXT && /\b(?:title_enc|body_enc|titleEnc|bodyEnc)\b/.test(readFileSync(f, "utf8")),
      );
      let writes = 0;
      const offences: string[] = [];
      for (const f of files) {
        const r = si4Scan(readFileSync(f, "utf8"), path.relative(WEB, f));
        writes += r.writes;
        offences.push(...r.offences);
      }
      // Not vacuous: 07's finishRaw writes both columns.
      expect(writes).toBeGreaterThanOrEqual(2);
      expect(offences).toEqual([]);
    });
  });

  it.runIf(COLLECTIONS_UI.some((p) => existsSync(p)))(
    "SI-5: collections UI never renders HTML or auto-links text (web + mobile)",
    () => {
      const files = COLLECTIONS_UI.flatMap(sourceFiles);
      expect(files.length).toBeGreaterThan(0);
      const offences: string[] = [];
      for (const f of files) {
        const src = readFileSync(f, "utf8");
        const rel = path.relative(path.resolve(WEB, "../.."), f);
        if (src.includes("dangerouslySetInnerHTML")) offences.push(`${rel}: dangerouslySetInnerHTML`);
        if (/(?:from\s+|require\(\s*|import\(\s*)["'][^"']*(?:linkify|autolink)[^"']*["']/i.test(src)) {
          offences.push(`${rel}: linkify/autolink import`);
        }
        for (const m of src.matchAll(/dataDetectorTypes?\s*=\s*(\{[^}]*\}|"[^"]*"|'[^']*')/g)) {
          if (!/^(?:"none"|'none'|\{\s*["']none["']\s*\})$/.test(m[1]!)) offences.push(`${rel}: ${m[0]}`);
        }
      }
      expect(offences).toEqual([]);
    },
  );

  describe("SI-6: the Sentry scrubber drops collections data (14 step 6, SEC14-F2)", () => {
    const ARABIC_CREDIT = "تم استلام مبلغ";

    it("a string JSON body on the ingest URL leaves no message text (14 §6 criterion 6)", () => {
      const event = scrubSentryEvent({
        request: {
          url: "https://thestoro.com/api/v1/collections/ingest",
          data: JSON.stringify({ v: 1, messages: [{ body: ARABIC_CREDIT }] }),
        },
      });
      expect(JSON.stringify(event)).not.toContain(ARABIC_CREDIT);
      expect(event.request?.data).toEqual({ v: 1, messages: "[REDACTED]" });
    });

    it("an object body {messages:[{body}]} is redacted", () => {
      const event = scrubSentryEvent({
        request: { data: { v: 1, messages: [{ sender: "VF-Cash", body: ARABIC_CREDIT }] } },
      });
      expect(JSON.stringify(event)).not.toContain(ARABIC_CREDIT);
      expect(JSON.stringify(event)).not.toContain("VF-Cash");
    });

    it("a body that is not a JSON object is dropped on a collections route, kept elsewhere", () => {
      const onCollections = scrubSentryEvent({
        request: { url: "/api/collections/credits/paste", data: `${ARABIC_CREDIT} 150.00` },
      });
      expect(onCollections.request?.data).toBe("[REDACTED]");
      const elsewhere = scrubSentryEvent({ request: { url: "/api/products", data: "plain" } });
      expect(elsewhere.request?.data).toBe("plain");
      const nested = scrubSentryEvent({
        request: { url: "/api/sales/cart", data: JSON.stringify({ payerName: "AHMED MOHAMED" }) },
      });
      expect(nested.request?.data).toEqual({ payerName: "[REDACTED]" });
    });

    it("receiving-account and payer fields in extra are redacted in any casing", () => {
      const event = scrubSentryEvent({
        extra: {
          account: {
            id: "a1",
            iban: "EG380019000500000000263180002",
            walletMsisdn: "01012345678",
            wallet_msisdn: "01012345678",
            ipaLink: "https://ipn.eg/S/shop/instapay/abc",
            ipaHandle: "shop@instapay",
            accountLast4: "1234",
          },
          credit: { payerName: "AHMED MOHAMED", payer_phone: "01099999999", rawText: ARABIC_CREDIT, text: ARABIC_CREDIT },
        },
      });
      const out = JSON.stringify(event);
      for (const leak of ["EG38", "01012345678", "ipn.eg", "shop@instapay", "AHMED", "01099999999", ARABIC_CREDIT]) {
        expect(out).not.toContain(leak);
      }
      // Minimised fields the product shows anyway keep their value, so triage still works.
      expect((event.extra as { account: { accountLast4: string } }).account.accountLast4).toBe("1234");
    });

    it("an Authorization: Bearer mgi_… header is redacted", () => {
      const token = `mgi_${"A".repeat(43)}`;
      const event = scrubSentryEvent({ request: { headers: { Authorization: `Bearer ${token}` } } });
      expect(JSON.stringify(event)).not.toContain(token);
    });
  });

  describe("SI-7: the v1 ingest routes authenticate with the ingest token only (05 §4.17, 07 §4.4)", () => {
    it("negative control: a user-session import, a missing guard or a body read before it is reported", () => {
      const good = [
        'import { NextRequest } from "next/server";',
        'import { requireIngestDevice } from "@/lib/api/ingest-token";',
        "export async function POST(req: NextRequest) {",
        '  const auth = await requireIngestDevice(req, "ingest.device");',
        "  if (!auth.ok) return auth.response;",
        "  const raw = await req.text();",
        "}",
      ].join("\n");
      expect(si7Offences(good, "probe")).toEqual([]);
      expect(
        si7Offences(good.replace("import { NextRequest }", "import { requireTenant } from \"@/lib/api/auth-helpers\";\nimport { NextRequest }"), "probe"),
      ).toHaveLength(1);
      expect(si7Offences(good.replace('"@/lib/api/ingest-token"', '"@/lib/api/other"'), "probe")).toHaveLength(1);
      const bodyFirst = good.replace("  const raw = await req.text();\n", "").replace("  const auth", "  const raw = await req.text();\n  const auth");
      expect(si7Offences(bodyFirst, "probe")).toEqual(["probe: POST reads the body before requireIngestDevice"]);
      expect(si7Offences(good.replace(/  const auth = await requireIngestDevice\(req, "ingest.device"\);\n/, ""), "probe")).toEqual([
        "probe: POST never calls requireIngestDevice",
      ]);
    });

    it.runIf(existsSync(INGEST_ROUTE))("ingest, ingest/config and ingest/heartbeat use requireIngestDevice and never a user session", () => {
      const files = routeFiles(path.join(WEB, "app/api/v1/collections"));
      expect(files).toContain(INGEST_ROUTE);
      const offences = files.flatMap((f) => si7Offences(readFileSync(f, "utf8"), path.relative(WEB, f)));
      expect(offences).toEqual([]);
    });
  });
});
