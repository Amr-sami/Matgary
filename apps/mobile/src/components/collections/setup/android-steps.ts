/**
 * The Android branch's pure rules (doc 15 spec 09 §4.6.5 `android_listener`, §4.6.7, step 19; the
 * copy is spec 11 §4.9 `mobile.collections.android.*`). Import-free (types only), so plain Node
 * tests it (__tests__/android-steps.test.ts); `AndroidSteps`, `OemChecklist` and `automation.tsx`
 * render it with `t(key, params)` — never at module scope.
 *
 * Every returned `key` is a full i18n path. Whether a given bank / wallet app posts a credit
 * notification at all is UNVERIFIED (11 A4, Q9): the copy never promises it.
 */
import type { CollectionProvider, CollectionRail } from "@matgary/domain/collections/types";

const NS = "mobile.collections.android.";

/** 06's InstaPay app package (= `INSTAPAY_APP_PACKAGE`; repeated here so this file stays import-free — the test pins it). */
export const INSTAPAY_APP_PACKAGE = "com.egyptianbanks.instapay";

/** 11 §4.9: section picking by `expo-device` `manufacturer` (09's job). Transsion (Infinix, Tecno, itel) has none yet. */
export type OemSection = "xiaomi" | "samsung" | "oppo" | "realme" | "generic";

const OEM_STEPS: Record<OemSection, number> = { xiaomi: 3, samsung: 2, oppo: 3, realme: 2, generic: 2 };

/** "Xiaomi" / "Redmi" / "POCO" (Xiaomi reports `Xiaomi`), "samsung", "OPPO", "realme"; anything else → generic. */
export function oemSection(manufacturer: string | null | undefined): OemSection {
  const m = (manufacturer ?? "").trim().toLowerCase();
  if (!m) return "generic";
  if (m.includes("xiaomi") || m === "redmi" || m === "poco") return "xiaomi";
  if (m.includes("samsung")) return "samsung";
  if (m.includes("oppo")) return "oppo";
  if (m.includes("realme")) return "realme";
  return "generic";
}

/** The `enable` step's checklist keys for a section, in order. */
export function oemStepKeys(section: OemSection): string[] {
  const n = OEM_STEPS[section];
  return Array.from({ length: n }, (_, i) => `${NS}oem.${section}.step${i + 1}`);
}

/** 11 §4.9 troubleshooting list, shown under `verify.timeout` (after 09's frame check `verify.checks.online`). */
export const ANDROID_TROUBLESHOOT_KEYS: readonly string[] = [
  "accessOff",
  "toggleAccess",
  "bankNotifications",
  "afterRestart",
  "afterUpdate",
  "battery",
  "workProfile",
].map((k) => `${NS}troubleshoot.${k}`);

/** The registry slice the app list needs (inject `COLLECTION_PROVIDERS`; Node tests pass a fixture). */
export type ProviderPackages = Readonly<Record<string, { rail: CollectionRail; androidPackages: readonly string[] }>>;

export type RequiredApp = {
  pkg: string;
  /** i18n key that fills `{app}`: 05's provider name, or `instapayApp` for the InstaPay app. */
  labelKey: string;
};

/**
 * The apps the owner should have on this phone for the scoped accounts' providers (09 §4.6.5 item 5):
 * each provider's `androidPackages`, plus the InstaPay app when any account is on the instapay rail
 * (the same rule as 06's `packagesForProviders`). Deduped, InstaPay first, then registry order.
 */
export function requiredApps(providers: readonly (CollectionProvider | string)[], registry: ProviderPackages): RequiredApp[] {
  const out: RequiredApp[] = [];
  const seen = new Set<string>();
  const add = (pkg: string, labelKey: string) => {
    if (seen.has(pkg)) return;
    seen.add(pkg);
    out.push({ pkg, labelKey });
  };
  const uniq = [...new Set(providers)];
  if (uniq.some((p) => registry[p]?.rail === "instapay")) add(INSTAPAY_APP_PACKAGE, `${NS}instapayApp`);
  for (const p of uniq) {
    const info = registry[p];
    if (!info) continue;
    for (const pkg of info.androidPackages) add(pkg, `app.collections.vocab.providers.${p}`);
  }
  return out;
}

export type AppRow = RequiredApp & { installed: boolean; key: string };

/** One row per required app: `install.appInstalled` / `install.appMissing` with `{app}`. */
export function appRows(required: readonly RequiredApp[], packagesInstalled: readonly string[]): AppRow[] {
  const have = new Set(packagesInstalled);
  return required.map((r) => {
    const installed = have.has(r.pkg);
    return { ...r, installed, key: `${NS}install.${installed ? "appInstalled" : "appMissing"}` };
  });
}

/** `install.noneInstalled` shows when apps are required and none of them is on this phone. */
export function noneInstalled(rows: readonly AppRow[]): boolean {
  return rows.length > 0 && rows.every((r) => !r.installed);
}

/** The static lines of the `install` step, in render order (after the access button and the app list). */
export const ANDROID_INSTALL_NOTE_KEYS: readonly string[] = ["keepNotificationsOn", "smsNote", "restricted"].map(
  (k) => `${NS}install.${k}`,
);

/** Every key this branch renders (for the dictionary test). */
export function allAndroidKeys(): string[] {
  const sections: OemSection[] = ["xiaomi", "samsung", "oppo", "realme", "generic"];
  return [
    `${NS}instapayApp`,
    `${NS}install.heading`,
    `${NS}install.body`,
    `${NS}install.systemWarning`,
    `${NS}install.appsHeading`,
    `${NS}install.appInstalled`,
    `${NS}install.appMissing`,
    `${NS}install.noneInstalled`,
    ...ANDROID_INSTALL_NOTE_KEYS,
    `${NS}enable.heading`,
    `${NS}enable.body`,
    `${NS}enable.stepsVary`,
    ...sections.flatMap(oemStepKeys),
    `${NS}troubleshoot.title`,
    ...ANDROID_TROUBLESHOOT_KEYS,
    `${NS}unsupported.lowRam`,
  ];
}

/** Like 09's `arrived`, injected so this file stays import-free. */
type Arrived = (base: string | null | undefined, now: string | null | undefined) => boolean;

/**
 * 09 §4.6.7 Android pass rule: `connected && (arrived(baselineSeenAt, lastSeenAt) || arrived(baselineMessageAt, lastMessageAt))`.
 * Proves native token storage, the WorkManager worker and the server; the bank-app path is proven by
 * the first real credit.
 */
export function androidVerifyPassed(
  i: {
    connected: boolean;
    baselineSeenAt: string | null;
    baselineMessageAt: string | null;
    lastSeenAt: string | null;
    lastMessageAt: string | null;
  },
  arrived: Arrived,
): boolean {
  return i.connected && (arrived(i.baselineSeenAt, i.lastSeenAt) || arrived(i.baselineMessageAt, i.lastMessageAt));
}

/**
 * The URL handed to the native module. The device POST's `ingestUrl` wins (09 §4.6.4). In a dev
 * bundle only, its path is re-based onto the app's own API base when the origins differ (the server
 * may build `http://localhost:3003/…`, which an emulator reaches as `10.0.2.2`). Release keeps the
 * server's URL untouched.
 */
export function listenerIngestUrl(serverUrl: string | null | undefined, apiBase: string, dev: boolean): string {
  const base = apiBase.replace(/\/+$/, "");
  const fallback = `${base}/api/v1/collections/ingest`;
  if (!serverUrl) return fallback;
  if (!dev) return serverUrl;
  const m = /^([a-z][a-z0-9+.-]*:\/\/[^/]+)(\/.*)?$/i.exec(serverUrl);
  const b = /^([a-z][a-z0-9+.-]*:\/\/[^/]+)/i.exec(base);
  if (!m || !b) return serverUrl;
  return m[1].toLowerCase() === b[1].toLowerCase() ? serverUrl : `${b[1]}${m[2] ?? "/api/v1/collections/ingest"}`;
}

/** The device-scoped config GET path (`<ingestUrl>/config`), relative to the API client's base. */
export function configPathOf(ingestUrl: string): string {
  const path = ingestUrl.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "") || "/api/v1/collections/ingest";
  return `${path.replace(/\/+$/, "")}/config`;
}
