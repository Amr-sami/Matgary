// Digital collections — export real bank / wallet messages as REDACTED pilot
// fixture drafts (spec 15 §4.10.3, 03 §D.6 / ARCH CR 4). IO shell around the
// pure scripts/lib/collections-redact.ts.
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/collections-export-shared-samples.ts \
//       (--tenant <uuid> [--tenant <uuid> …] | --input <file.jsonl>) \
//       [--since <YYYY-MM-DD>] [--provider <CollectionProvider>] [--allow-word <w> …] \
//       [--phone-ref <ref>] > <file>.redacted.json
//
// File mode (--input): JSONL lines in the Q9 capture format (§4.9.4–4.9.5)
//   {v:1, channel, sender?, sourceApp?, title?, subtitle?, body, receivedAt, phoneRef}
// deviceRef = the line's phoneRef (else --phone-ref). OTP lines are dropped.
//
// DB mode (--tenant) reads shared, unexpired collection_raw_messages rows per
// named tenant through withTenant (RLS on, no BYPASSRLS path) and decrypts
// them with 07's decryptRawText. Both land at M2 (0056, order 19); until then
// DB mode refuses with exit 3.
//
// Safety (§4.10.3):
//   - stdout carries JSON only; progress and counts go to stderr, never text;
//   - nothing is written to disk and no body is ever logged, even with DEBUG;
//   - refuses a TTY stdout (exit 2) unless --i-know-stdout-is-a-terminal;
//   - exits 4 (after writing the JSON) when a record has unknownWords > 20.
//
// Exit codes: 0 ok · 1 bad input · 2 TTY stdout · 3 DB mode before M2 · 4 review.
//
// M1 NOTE (as landed 2026-10-18): 06 part B (order 18) has not landed, so
// `parserSaid` is null and the OTP patterns are an INTERIM verbatim copy of
// 06 §4.9 OTP_PATTERNS. When order 18 lands: import isOtp + parseMessage and
// fill parserSaid / fixtureDraft.expect from the parse (spec 15 §4.10.3).

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { normalizeDigits, normalizeSender, senderKindOf } from "@matgary/domain/collections/normalize";
import { packagesForProviders, sendersForProviders } from "@matgary/domain/collections/providers";
import {
  COLLECTION_PROVIDER_VALUES,
  INGEST_CHANNEL_VALUES,
  type CollectionProvider,
  type IngestChannel,
} from "@matgary/domain/collections/types";
import { buildVocabulary, redactSample, type Redacted } from "./lib/collections-redact";

// = OTP_PATTERNS (06 §4.9) — INTERIM copy until order 18 lands.
const INTERIM_OTP_PATTERNS: readonly string[] = [
  "(^|[^a-z])otp([^a-z]|$)", "one[ -]?time (pass|code|pin)", "verification code", "passcode",
  "do not share", "don'?t share", "[كق]ود (ال)?(تحقق|تفعيل|سري)", "رمز (ال)?(تحقق|تفعيل|سري|المرور)",
  "كلم[ةه] (ال)?(مرور|سر)", "الرقم السري", "لا تشارك", "لا تفصح", "لمر[ةه] واحد[ةه]",
];
const OTP_RES = INTERIM_OTP_PATTERNS.map((p) => new RegExp(p, "i"));
const UNKNOWN_WORDS_REVIEW = 20;

function stderr(msg: string): void {
  process.stderr.write(`collections-export: ${msg}\n`);
}

function die(code: number, msg: string): never {
  stderr(msg);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

interface Args {
  tenants: string[];
  input: string | null;
  since: string | null;
  provider: CollectionProvider | null;
  allowWords: string[];
  phoneRef: string | null;
  ttyOk: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { tenants: [], input: null, since: null, provider: null, allowWords: [], phoneRef: null, ttyOk: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) die(1, `${flag} needs a value`);
      return v;
    };
    if (flag === "--tenant") a.tenants.push(value());
    else if (flag === "--input") a.input = value();
    else if (flag === "--since") a.since = value();
    else if (flag === "--provider") {
      const p = value();
      if (!(COLLECTION_PROVIDER_VALUES as readonly string[]).includes(p)) die(1, `unknown --provider ${p}`);
      a.provider = p as CollectionProvider;
    } else if (flag === "--allow-word") a.allowWords.push(value());
    else if (flag === "--phone-ref") a.phoneRef = value();
    else if (flag === "--i-know-stdout-is-a-terminal") a.ttyOk = true;
    else die(1, `unknown argument ${flag}`);
  }
  if ((a.tenants.length > 0) === (a.input !== null)) die(1, "give exactly one of --tenant <uuid> … or --input <file.jsonl>");
  if (a.since !== null && !/^\d{4}-\d{2}-\d{2}$/.test(a.since)) die(1, "--since must be YYYY-MM-DD");
  return a;
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

interface SourceRecord {
  rawKey: string; // hashed into exportId; never printed
  tenantRef: string | null;
  deviceRef: string | null;
  channel: IngestChannel;
  sender: string | null;
  sourceApp: string | null;
  title: string | null;
  subtitle: string | null;
  body: string;
  receivedAt: string;
  storedParseStatus: string | null;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function isOtp(...texts: Array<string | null>): boolean {
  const joined = normalizeDigits(texts.filter(Boolean).join("\n"))
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\u061C\uFEFF\u0640]/g, "")
    .replace(/\s+/g, " ");
  return OTP_RES.some((re) => re.test(joined));
}

function optString(v: unknown, field: string, line: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") die(1, `line ${line}: ${field} must be a string`);
  return v;
}

function readJsonl(path: string, args: Args): SourceRecord[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    die(1, `cannot read --input (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  const out: SourceRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    const n = i + 1;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      die(1, `line ${n}: not JSON`); // never echo the line: it is raw text
    }
    if (o.v !== 1) die(1, `line ${n}: v must be 1`);
    const channel = o.channel;
    if (typeof channel !== "string" || !(INGEST_CHANNEL_VALUES as readonly string[]).includes(channel)) {
      die(1, `line ${n}: unknown channel`);
    }
    if (typeof o.body !== "string" || o.body.length === 0) die(1, `line ${n}: body is required`);
    const receivedAt = optString(o.receivedAt, "receivedAt", n);
    if (!receivedAt || Number.isNaN(Date.parse(receivedAt))) die(1, `line ${n}: receivedAt must be an ISO date`);
    const phoneRef = optString(o.phoneRef, "phoneRef", n) ?? args.phoneRef;
    if (!phoneRef) die(1, `line ${n}: no phoneRef (add it to the line or pass --phone-ref)`);
    out.push({
      rawKey: `file|${raw}`,
      tenantRef: null,
      deviceRef: phoneRef,
      channel: channel as IngestChannel,
      sender: optString(o.sender, "sender", n),
      sourceApp: optString(o.sourceApp, "sourceApp", n),
      title: optString(o.title, "title", n),
      subtitle: optString(o.subtitle, "subtitle", n),
      body: o.body,
      receivedAt: new Date(receivedAt).toISOString(),
      storedParseStatus: null,
    });
  }
  return out;
}

function matchesProvider(r: SourceRecord, provider: CollectionProvider): boolean {
  const senders = sendersForProviders([provider]).map(normalizeSender);
  if (r.sender && senders.includes(normalizeSender(r.sender))) return true;
  return !!r.sourceApp && packagesForProviders([provider]).includes(r.sourceApp);
}

function exportRecord(r: SourceRecord, vocab: Set<string>, allowWords: string[]) {
  const senderKind = senderKindOf(r.channel, r.sender);
  const red: Redacted = redactSample(
    { title: r.title, subtitle: r.subtitle, body: r.body, sender: r.sender, senderKind },
    vocab,
    allowWords,
  );
  const exportId = `SHR-${sha256(r.rawKey).slice(0, 8)}`;
  return {
    exportId,
    tenantRef: r.tenantRef,
    deviceRef: r.deviceRef,
    channel: r.channel,
    sourceApp: r.sourceApp,
    sender: red.sender,
    senderKind,
    receivedAt: r.receivedAt,
    storedParseStatus: r.storedParseStatus,
    parserSaid: null, // 06 parseMessage lands with order 18 (M2)
    redacted: { title: red.title, subtitle: red.subtitle, body: red.body, sender: red.sender },
    redactions: red.redactions,
    unknownWords: red.unknownWords,
    fixtureDraft: {
      id: "PILOT-?-?",
      kind: "pilot" as const,
      source: "pilot",
      sourceUrl: `pilot://${r.tenantRef ?? "file"}/${exportId}`,
      researchRef: "15 §4.9",
      channel: r.channel,
      sender: red.sender,
      sourceApp: r.sourceApp,
      published: red.body,
      fills: red.fills,
      receivedAt: r.receivedAt,
      expect: { needsHumanCheck: true },
      pilot: { phoneId: r.deviceRef, observedSender: red.sender, observedPackage: r.sourceApp, capturedAt: r.receivedAt },
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (process.stdout.isTTY && !args.ttyOk) {
    die(2, "refusing to print to a terminal (scrollback keeps copies); redirect stdout to a file, " +
      "or pass --i-know-stdout-is-a-terminal");
  }
  if (args.tenants.length > 0) {
    die(3, "DB mode (--tenant) lands at M2 with migration 0056 and 07's decryptRawText (spec 15 §4.10.3); " +
      "use --input <file.jsonl>");
  }

  let records = readJsonl(args.input as string, args);
  const read = records.length;
  records = records.filter((r) => !isOtp(r.title, r.subtitle, r.body));
  const otp = read - records.length;
  if (args.since) records = records.filter((r) => r.receivedAt.slice(0, 10) >= (args.since as string));
  if (args.provider) records = records.filter((r) => matchesProvider(r, args.provider as CollectionProvider));

  const vocab = buildVocabulary();
  const out = records.map((r) => exportRecord(r, vocab, args.allowWords));
  process.stdout.write(
    JSON.stringify(
      { exportVersion: 1, exportedAt: new Date().toISOString(), source: "file", vocabularySize: vocab.size, records: out },
      null,
      2,
    ) + "\n",
  );
  stderr(`read ${read}, dropped ${otp} OTP, filtered ${read - otp - out.length}, exported ${out.length}`);
  const review = out.filter((r) => r.unknownWords > UNKNOWN_WORDS_REVIEW).map((r) => r.exportId);
  if (review.length > 0) {
    stderr(`review: ${review.length} record(s) with > ${UNKNOWN_WORDS_REVIEW} unknown words: ${review.join(", ")}`);
    process.exitCode = 4;
  }
}

main();
