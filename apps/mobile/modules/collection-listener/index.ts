/**
 * JS face of the local Expo module `CollectionListener` (doc 15 spec 11 §4.2 = 03 §B.10, M4).
 * Autolinked from apps/mobile/modules/ like `backup-exclusion`: no package.json entry, no config
 * plugin (the library manifest — service + `<queries>` — is merged by Gradle).
 *
 * Android only. The native side is a NotificationListenerService that reads notifications ONLY from
 * the bank / wallet APP packages on the server's allowlist (never an SMS app, never an SMS
 * permission), drops OTPs and non-candidates on the phone, queues the rest AES-GCM-encrypted and
 * uploads them with WorkManager and the device's `mgi_` token — with the JS app dead. It also sends a
 * heartbeat every 15 minutes. JS only ever sees status: the token is never returned.
 *
 * Everywhere the native module is missing — iOS (the module declares `android` only), web, a build
 * made before M4, plain-Node unit tests — `isSupported()` is false, the async functions resolve their
 * zero values, and `configure()` rejects `UNAVAILABLE`. Nothing throws at import.
 *
 * Error codes (`error.code`): `NOT_CONFIGURED` (openAccessSettings before configure), `INVALID_CONFIG`,
 * `UNAVAILABLE`, `KEYSTORE_FAILED`. 09 shows its own frame text for them.
 */

/** = 03 §B.17 `config.keywords`. */
export type ListenerKeywords = { ar: readonly string[]; en: readonly string[] };

export type ListenerConfig = {
  /** Absolute; heartbeat = ingestUrl + "/heartbeat", config = ingestUrl + "/config". */
  ingestUrl: string;
  /** `^mgi_[A-Za-z0-9_-]{43}$` — never returned by any function. */
  token: string;
  /** From GET /api/v1/collections/ingest/config. */
  packages: readonly string[];
  keywords: ListenerKeywords;
  otpPatterns: readonly string[];
  /** Opaque, ≤ 64 chars (never parsed here). */
  configVersion: string;
};

export type ListenerStatus = {
  /** configure() succeeded and clearCredentials() has not run since. */
  configured: boolean;
  /** onListenerConnected seen since boot AND access granted. */
  connected: boolean;
  /** ISO; last notification from an allowlisted package (before the keyword / OTP filter). */
  lastNotificationAt: string | null;
  /** ISO; last 200 from POST …/ingest. */
  lastUploadAt: string | null;
  /** Rows waiting in the local queue. */
  queued: number;
  /** Configured packages that resolve on this phone (limited by the module's static `<queries>`). */
  packagesInstalled: string[];
};

export type ListenerErrorCode = "NOT_CONFIGURED" | "INVALID_CONFIG" | "UNAVAILABLE" | "KEYSTORE_FAILED";

export const LISTENER_ERROR_CODES: readonly ListenerErrorCode[] = ["NOT_CONFIGURED", "INVALID_CONFIG", "UNAVAILABLE", "KEYSTORE_FAILED"];

export const ZERO_STATUS: Readonly<ListenerStatus> = Object.freeze({
  configured: false,
  connected: false,
  lastNotificationAt: null,
  lastUploadAt: null,
  queued: 0,
  packagesInstalled: [],
}) as Readonly<ListenerStatus>;

type CollectionListenerNative = {
  isSupported(): boolean;
  isAccessGranted(): Promise<boolean>;
  openAccessSettings(): Promise<boolean>;
  configure(c: {
    ingestUrl: string;
    token: string;
    packages: string[];
    keywords: { ar: string[]; en: string[] };
    otpPatterns: string[];
    configVersion: string;
  }): Promise<void>;
  getStatus(): Promise<Partial<ListenerStatus> | null>;
  requestRebind(): Promise<boolean>;
  clearCredentials(): Promise<void>;
  openBatterySettings(): Promise<boolean>;
};

let native: CollectionListenerNative | null | undefined;

function loadNative(): CollectionListenerNative | null {
  if (native !== undefined) return native;
  try {
    // Lazy require: expo-modules-core (and react-native underneath it) cannot be imported in plain
    // Node, and a top-level import would take this whole file — fallback included — down with it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const core = require("expo-modules-core") as {
      requireOptionalNativeModule?: <T>(name: string) => T | null;
    };
    native = core.requireOptionalNativeModule?.<CollectionListenerNative>("CollectionListener") ?? null;
  } catch {
    native = null;
  }
  return native;
}

/** Test seam: replace the native module (`null` = not linked, `undefined` = real lazy load). Never used by app code. */
export function __setNativeForTests(fake: CollectionListenerNative | null | undefined): void {
  native = fake;
}

/** An Error carrying one of the module's codes in `.code` (the shape Expo's CodedException rejects with). */
export function listenerError(code: ListenerErrorCode, message?: string): Error & { code: ListenerErrorCode } {
  const e = new Error(message ?? code) as Error & { code: ListenerErrorCode };
  e.code = code;
  return e;
}

/** The module's code of a rejection, or null (anything else). */
export function listenerErrorCode(e: unknown): ListenerErrorCode | null {
  const c = e && typeof e === "object" ? (e as { code?: unknown }).code : undefined;
  return typeof c === "string" && (LISTENER_ERROR_CODES as readonly string[]).includes(c) ? (c as ListenerErrorCode) : null;
}

/** True iff the native module is linked into this build (an Android build that contains M4). */
export function isListenerModuleAvailable(): boolean {
  return loadNative() !== null;
}

/** Sync, never throws: native present && !(low-RAM && API ≤ 29). */
export function isSupported(): boolean {
  const m = loadNative();
  if (!m) return false;
  try {
    return m.isSupported() === true;
  } catch {
    return false;
  }
}

async function call<T>(fn: (m: CollectionListenerNative) => Promise<T>, fallback: T): Promise<T> {
  const m = loadNative();
  if (!m) return fallback;
  try {
    return await fn(m);
  } catch {
    return fallback;
  }
}

export function isAccessGranted(): Promise<boolean> {
  return call(async (m) => (await m.isAccessGranted()) === true, false);
}

/**
 * Rejects `NOT_CONFIGURED` before configure() (the Play rule that the in-app disclosure immediately
 * precedes the OS screen is a code property). true = a settings screen opened. Without the module: false.
 */
export async function openAccessSettings(): Promise<boolean> {
  const m = loadNative();
  if (!m) return false;
  try {
    return (await m.openAccessSettings()) === true;
  } catch (e) {
    if (listenerErrorCode(e) === "NOT_CONFIGURED") throw e;
    return false;
  }
}

/** Rejects `INVALID_CONFIG` | `UNAVAILABLE` | `KEYSTORE_FAILED`; a failure leaves the previous state untouched. */
export async function configure(c: ListenerConfig): Promise<void> {
  const m = loadNative();
  if (!m) throw listenerError("UNAVAILABLE", "collection-listener is not linked in this build");
  if (!c || typeof c !== "object" || !c.keywords) throw listenerError("INVALID_CONFIG");
  try {
    await m.configure({
      ingestUrl: String(c.ingestUrl),
      token: String(c.token),
      packages: [...(c.packages ?? [])].map(String),
      keywords: { ar: [...(c.keywords.ar ?? [])].map(String), en: [...(c.keywords.en ?? [])].map(String) },
      otpPatterns: [...(c.otpPatterns ?? [])].map(String),
      configVersion: String(c.configVersion),
    });
  } catch (e) {
    const code = listenerErrorCode(e);
    // Keep the module's own code; anything unexpected surfaces as UNAVAILABLE (never the token).
    throw code ? listenerError(code) : listenerError("UNAVAILABLE");
  }
}

const isIso = (x: unknown): x is string => typeof x === "string" && x.length > 0;

export function getStatus(): Promise<ListenerStatus> {
  return call(async (m) => {
    const s = await m.getStatus();
    if (!s || typeof s !== "object") return { ...ZERO_STATUS, packagesInstalled: [] };
    return {
      configured: s.configured === true,
      connected: s.connected === true,
      lastNotificationAt: isIso(s.lastNotificationAt) ? s.lastNotificationAt : null,
      lastUploadAt: isIso(s.lastUploadAt) ? s.lastUploadAt : null,
      queued: typeof s.queued === "number" && Number.isFinite(s.queued) && s.queued >= 0 ? Math.floor(s.queued) : 0,
      packagesInstalled: Array.isArray(s.packagesInstalled) ? s.packagesInstalled.filter((p): p is string => typeof p === "string") : [],
    };
  }, { ...ZERO_STATUS, packagesInstalled: [] });
}

/** true = rebind requested (configured and access granted). */
export function requestRebind(): Promise<boolean> {
  return call(async (m) => (await m.requestRebind()) === true, false);
}

/** Token, config, queue, seen and scheduled work — all gone. Resolves without the module. */
export async function clearCredentials(): Promise<void> {
  await call(async (m) => {
    await m.clearCredentials();
  }, undefined);
}

/** The battery-optimisation list screen (never the direct-request dialog). */
export function openBatterySettings(): Promise<boolean> {
  return call(async (m) => (await m.openBatterySettings()) === true, false);
}

/** True in a Metro dev bundle; false in release bundles and in plain Node (no `__DEV__` global). */
function isDev(): boolean {
  try {
    return typeof __DEV__ !== "undefined" && __DEV__ === true;
  } catch {
    return false;
  }
}

/**
 * `__DEV__` only (11 §4.2): the RN DevTools console can drive the module before / beside 09's wizard
 * (11 §5 step 9). Dead code in release bundles — 11 step 16 proves `globalThis.__collectionListener`
 * is undefined there.
 */
if (isDev()) {
  (globalThis as Record<string, unknown>).__collectionListener = {
    isSupported,
    isAccessGranted,
    openAccessSettings,
    configure,
    getStatus,
    requestRebind,
    clearCredentials,
    openBatterySettings,
  };
}
