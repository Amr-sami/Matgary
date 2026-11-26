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
// DB mode (--tenant, M2; README §3 order 25) reads shared, unexpired
// collection_raw_messages rows (shared_at IS NOT NULL AND expires_at > now(),
// [created_at >= --since]) per named tenant through @/lib/db's withTenant on
// the APP_DATABASE_URL NOSUPERUSER role — RLS stays on and there is no
// cross-tenant / BYPASSRLS path (03 §D.6, ARCH CR 4). title_enc ([title,
// subtitle] JSON) and body_enc are decrypted in memory with 07's
// decryptRawText; tenantRef = "T-" + sha256(tenantId)[0:6], deviceRef =
// "D-" + sha256(ingest_device_id)[0:8], or --phone-ref / null for a paste
// (a paste never counts towards "≥ 2 phones" without --phone-ref). The DB
// imports are dynamic, so file mode needs no database or SECRET_KEY. Env comes
// from the process (the migrator image), else apps/web/.env (dotenv, no
// override).
//
// Safety (§4.10.3):
//   - stdout carries JSON only; progress and counts go to stderr, never text;
//   - nothing is written to disk and no body is ever logged, even with DEBUG;
//   - refuses a TTY stdout (exit 2) unless --i-know-stdout-is-a-terminal;
//   - exits 4 (after writing the JSON) when a record has unknownWords > 20.
//
// Exit codes: 0 ok · 1 bad input · 2 TTY stdout · 3 DB unavailable / read failed · 4 review.
//
// Since order 18 (06 part B, 2026-10-18) the OTP drop is 06's isOtp and every
// record is re-parsed in memory with 06's parseMessage (the INTERIM copies of
// order 12 are gone, spec 15 §4.10.4). The parse runs with now = receivedAt,
// so the reviewer sees the FORMAT verdict even for a sample older than the
// 48 h age gate. `parserSaid` carries no payer phone / name, and its reference
// is masked to its last 4 exactly as the redaction masks it (x), so
// `fixtureDraft.expect.reference` (x → 7) matches the filled text.

import "dotenv/config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isOtp } from "@matgary/domain/collections/filter";
import { normalizeSender, senderKindOf } from "@matgary/domain/collections/normalize";
import { messageText, parseMessage } from "@matgary/domain/collections/parse";
import { packagesForProviders, sendersForProviders } from "@matgary/domain/collections/providers";
import {
  COLLECTION_PROVIDER_VALUES,
  INGEST_CHANNEL_VALUES,
  type CollectionProvider,
  type IngestChannel,
} from "@matgary/domain/collections/types";
import { buildVocabulary, redactSample, type Redacted } from "./lib/collections-redact";

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

function isOtpRecord(r: Pick<SourceRecord, "title" | "subtitle" | "body">): boolean {
  return isOtp(messageText(r));
}

/** A parsed reference masked like the redaction does: all but the last 4 → x. */
function maskReference(ref: string | null): string | null {
  if (ref == null) return null;
  return ref.length > 4 ? "x".repeat(ref.length - 4) + ref.slice(-4) : ref;
}

/** What 06's parser concluded, without any personal field (spec 15 §4.10.3). */
function parserSaid(r: SourceRecord) {
  const p = parseMessage(
    {
      channel: r.channel,
      sender: r.sender,
      sourceApp: r.sourceApp,
      title: r.title,
      subtitle: r.subtitle,
      body: r.body,
      receivedAt: r.receivedAt,
    },
    { now: new Date(r.receivedAt) },
  );
  return {
    status: p.status,
    templateId: p.templateId,
    direction: p.direction,
    amount: p.fields?.amount ?? null,
    balanceAfter: p.fields?.balanceAfter ?? null,
    reference: maskReference(p.fields?.reference ?? null),
    receivingHint: p.fields?.receivingHint ?? null,
  };
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RawRow {
  id: string;
  ingest_device_id: string | null;
  channel: string;
  source_app: string | null;
  sender: string | null;
  title_enc: string | null;
  body_enc: string | null;
  parse_status: string;
  received_at: string | Date;
}

/** DB mode: the shared rows of each named tenant, decrypted in memory only. */
async function readShared(args: Args): Promise<{ records: SourceRecord[]; undecryptable: number }> {
  for (const t of args.tenants) if (!UUID_RE.test(t)) die(1, "--tenant must be a uuid");
  let dbMod: typeof import("@/lib/db");
  let rawText: typeof import("@/lib/collections/raw-text");
  let sqlTag: typeof import("drizzle-orm").sql;
  try {
    dbMod = await import("@/lib/db");
    rawText = await import("@/lib/collections/raw-text");
    sqlTag = (await import("drizzle-orm")).sql;
  } catch (e) {
    die(3, `DB mode needs APP_DATABASE_URL (or DATABASE_URL) and SECRET_KEY (${(e as Error).message.split("\n")[0]})`);
  }
  const out: SourceRecord[] = [];
  let undecryptable = 0;
  try {
    for (const tenantId of args.tenants) {
      const since = args.since ? `${args.since}T00:00:00Z` : null;
      const rows = (await dbMod.withTenant(tenantId, (tx) =>
        tx.execute(sqlTag`
          SELECT id, ingest_device_id, channel, source_app, sender, title_enc, body_enc, parse_status, received_at
          FROM collection_raw_messages
          WHERE tenant_id = ${tenantId}
            AND shared_at IS NOT NULL
            AND expires_at > now()
            AND (${since}::timestamptz IS NULL OR created_at >= ${since}::timestamptz)
          ORDER BY created_at
        `),
      )) as unknown as RawRow[];
      const tenantRef = `T-${sha256(tenantId).slice(0, 6)}`;
      for (const r of rows) {
        let body: string | null;
        let ts: { title: string | null; subtitle: string | null };
        try {
          body = rawText.decryptRawText(r.body_enc);
          ts = rawText.decodeTitleSubtitle(rawText.decryptRawText(r.title_enc));
        } catch {
          undecryptable++; // another key (wrong SECRET_KEY); never print the value
          continue;
        }
        if (!body) continue; // an OTP row stores no body (03 §E.4)
        if (!(INGEST_CHANNEL_VALUES as readonly string[]).includes(r.channel)) continue;
        out.push({
          rawKey: r.id,
          tenantRef,
          deviceRef: r.ingest_device_id ? `D-${sha256(r.ingest_device_id).slice(0, 8)}` : args.phoneRef,
          channel: r.channel as IngestChannel,
          sender: r.sender,
          sourceApp: r.source_app,
          title: ts.title,
          subtitle: ts.subtitle,
          body,
          receivedAt: new Date(r.received_at).toISOString(),
          storedParseStatus: r.parse_status,
        });
      }
      stderr(`tenant ${tenantRef}: ${rows.length} shared row(s)`);
    }
  } catch (e) {
    die(3, `DB read failed (${(e as { code?: string }).code ?? (e as Error).name})`);
  } finally {
    await dbMod.db.$client.end({ timeout: 5 }).catch(() => undefined);
  }
  return { records: out, undecryptable };
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
  const said = parserSaid(r);
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
    parserSaid: said,
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
      // From parserSaid, marked: a human checks every field against the phone's app (06 §4.15 step 1).
      expect: {
        status: said.status,
        templateId: said.templateId,
        ...(said.direction ? { direction: said.direction } : {}),
        ...(said.amount ? { amount: said.amount } : {}),
        balanceAfter: said.balanceAfter,
        reference: said.reference === null ? null : said.reference.replace(/x/g, "7"),
        receivingHint: said.receivingHint,
        needsHumanCheck: true,
      },
      pilot: { phoneId: r.deviceRef, observedSender: red.sender, observedPackage: r.sourceApp, capturedAt: r.receivedAt },
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (process.stdout.isTTY && !args.ttyOk) {
    die(2, "refusing to print to a terminal (scrollback keeps copies); redirect stdout to a file, " +
      "or pass --i-know-stdout-is-a-terminal");
  }
  const fromDb = args.tenants.length > 0;
  let records: SourceRecord[];
  if (fromDb) {
    const got = await readShared(args);
    records = got.records;
    if (got.undecryptable > 0) stderr(`skipped ${got.undecryptable} row(s) that do not decrypt with this SECRET_KEY`);
  } else {
    records = readJsonl(args.input as string, args);
  }
  const read = records.length;
  records = records.filter((r) => !isOtpRecord(r));
  const otp = read - records.length;
  // DB mode filters --since on created_at in SQL; file mode on receivedAt.
  if (args.since && !fromDb) records = records.filter((r) => r.receivedAt.slice(0, 10) >= (args.since as string));
  if (args.provider) records = records.filter((r) => matchesProvider(r, args.provider as CollectionProvider));

  const vocab = buildVocabulary();
  const out = records.map((r) => exportRecord(r, vocab, args.allowWords));
  process.stdout.write(
    JSON.stringify(
      {
        exportVersion: 1,
        exportedAt: new Date().toISOString(),
        source: fromDb ? "db" : "file",
        vocabularySize: vocab.size,
        records: out,
      },
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

main().catch((e: unknown) => die(1, `failed (${(e as Error).name})`));
