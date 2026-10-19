/**
 * JS face of the local Expo module `CollectionsIngest` (doc 15 spec 10 §4.10, M3; 03 §B.10).
 * Autolinked from apps/mobile/modules/ like `backup-exclusion`: no package.json entry, no config
 * plugin of its own (the App Intent is copied into the app target by
 * `plugins/with-collections-intent.js`).
 *
 * iOS only. The native side keeps the phone's ingest credential (`mgi_…` token + ingest URL) in the
 * Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, never synchronised), a crash-safe
 * on-disk queue of forwarded messages, and the uploader that the `ForwardPaymentMessageIntent`
 * App Intent shares (same process, option B). On app active it drains the queue and sends an
 * `ios_app_intent` heartbeat at most once per 6 h.
 *
 * Everywhere the native module is missing — Android (the module declares `apple` only), web, a
 * build made before M3, plain-Node unit tests — every function resolves `false` / `null` and never
 * throws, so 09's wizard can call them unconditionally and gate the intent path on
 * `isCollectionsIngestAvailable()` (09 §4.6.1 `modules.iosIntent`).
 */

export type IngestCredential = { url: string; token: string };

export type IngestStatus = {
  hasCredential: boolean;
  queued: number;
  lastUploadAt: string | null;
  lastError: string | null;
  configVersion: string | null;
};

/** What `forwardForTesting` resolves with (the intent maps the same outcomes to its dialogs). */
export type IngestOutcome = "sent" | "queued" | "test" | "testFailed" | "skipped" | "notLinked";

/** 07's token shape: `mgi_` + 32 random bytes base64url (43 characters). */
export const INGEST_TOKEN_RE = /^mgi_[A-Za-z0-9_-]{43}$/;

type CollectionsIngestNative = {
  setCredential(url: string, token: string): Promise<boolean>;
  hasCredential(): Promise<boolean>;
  clearCredential(): Promise<boolean>;
  getStatus(): Promise<IngestStatus | null>;
  /** Present only in DEBUG native builds (`#if DEBUG`). */
  forwardForTesting?: (text: string, source: string, sender: string | null) => Promise<string | null>;
};

let native: CollectionsIngestNative | null | undefined;

function loadNative(): CollectionsIngestNative | null {
  if (native !== undefined) return native;
  try {
    // Lazy require: expo-modules-core (and react-native underneath it) cannot be imported in plain
    // Node, and a top-level import would take this whole file — fallback included — down with it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const core = require("expo-modules-core") as {
      requireOptionalNativeModule?: <T>(name: string) => T | null;
    };
    native = core.requireOptionalNativeModule?.<CollectionsIngestNative>("CollectionsIngest") ?? null;
  } catch {
    native = null;
  }
  return native;
}

/** True in a Metro dev bundle; false in release bundles and in plain Node (no `__DEV__` global). */
function isDev(): boolean {
  try {
    return typeof __DEV__ !== "undefined" && __DEV__ === true;
  } catch {
    return false;
  }
}

/** Test seam: replace the native module (`null` = not linked). Never used by app code. */
export function __setNativeForTests(fake: CollectionsIngestNative | null | undefined): void {
  native = fake;
}

/** The token shape 07 mints (`mgi_` + 43 base64url characters). */
export function isValidIngestToken(token: unknown): token is string {
  return typeof token === "string" && INGEST_TOKEN_RE.test(token);
}

/** `https://…` always; `http://…` only in a dev bundle (a LAN backend for the dev client). */
export function isValidIngestUrl(url: unknown, dev: boolean = isDev()): url is string {
  if (typeof url !== "string" || url.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!u.hostname || u.username || u.password || u.search || u.hash) return false;
  if (u.protocol === "https:") return true;
  return dev && u.protocol === "http:";
}

/** True iff the native module is linked into this build (an iOS build that contains M3). */
export function isCollectionsIngestAvailable(): boolean {
  return loadNative() !== null;
}

async function call<T>(fn: (m: CollectionsIngestNative) => Promise<T>, fallback: T): Promise<T> {
  const mod = loadNative();
  if (!mod) return fallback;
  try {
    return await fn(mod);
  } catch {
    return fallback;
  }
}

/**
 * Store the ingest credential in the Keychain (replacing any previous one). The URL is 07's
 * `ingest.ingestUrl` (`…/api/v1/collections/ingest`; `/config` and `/heartbeat` hang off it).
 * Resolves `false` — without touching native — for a token or URL of the wrong shape.
 */
export async function setIngestCredential(c: IngestCredential): Promise<boolean> {
  if (!c || !isValidIngestToken(c.token) || !isValidIngestUrl(c.url)) return false;
  return call(async (m) => (await m.setCredential(c.url, c.token)) === true, false);
}

export async function hasIngestCredential(): Promise<boolean> {
  return call(async (m) => (await m.hasCredential()) === true, false);
}

/** Deletes the credential AND the on-disk queue and cached config (revoke, replace, re-setup). */
export async function clearIngestCredential(): Promise<boolean> {
  return call(async (m) => (await m.clearCredential()) === true, false);
}

export async function getIngestStatus(): Promise<IngestStatus | null> {
  return call(async (m) => {
    const s = await m.getStatus();
    if (!s || typeof s !== "object") return null;
    return {
      hasCredential: s.hasCredential === true,
      queued: typeof s.queued === "number" && Number.isFinite(s.queued) ? s.queued : 0,
      lastUploadAt: typeof s.lastUploadAt === "string" ? s.lastUploadAt : null,
      lastError: typeof s.lastError === "string" ? s.lastError : null,
      configVersion: typeof s.configVersion === "string" ? s.configVersion : null,
    };
  }, null);
}

const OUTCOMES: readonly IngestOutcome[] = ["sent", "queued", "test", "testFailed", "skipped", "notLinked"];

/**
 * DEV ONLY (10 §5 step 18; doc 14 §6.3): run the intent's forward path from the Metro console.
 * `null` in a release bundle, and in a release native build (the native function exists only
 * `#if DEBUG`).
 */
export async function forwardForTesting(i: { text: string; source?: string; sender?: string }): Promise<string | null> {
  if (!isDev()) return null;
  if (!i || typeof i.text !== "string") return null;
  return call(async (m) => {
    if (typeof m.forwardForTesting !== "function") return null;
    const out = await m.forwardForTesting(i.text, i.source ?? "sms", i.sender ?? null);
    return typeof out === "string" && (OUTCOMES as readonly string[]).includes(out) ? out : null;
  }, null);
}
