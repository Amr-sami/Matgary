/**
 * The automation wizard's pure rules (doc 15 spec 09 §4.6.1, §4.6.2, §4.6.6,
 * §4.6.7, §4.7). TYPE-ONLY imports: plain Node tests it
 * (__tests__/wizard.test.ts); `automation.tsx`, `VerifyStep`, `DeviceRow` and
 * the hub bind it to React.
 *
 * Nothing here calls `t()`: step descriptors are built inside the
 * components, because a module-scope `t()` freezes the locale.
 */
import type { DeviceHealth, IngestChannel } from "@matgary/domain/collections/types";

/** 09 ARCH CR 8 (03 §B.10): run by name with exactly this text, the shortcut / intent posts one `test: true` message. */
export const COLLECTIONS_SETUP_TEST_MARKER = "THESTORO-SETUP-TEST";

/** 10 D10-8: the body every test carries (06's fallback reads it as a credit → 07's `held/test`, `DeviceDTO.lastTest`). */
export const COLLECTIONS_SETUP_TEST_BODY = "THESTORO-SETUP-TEST تم استلام مبلغ 1.00 جنيه";

/** Verify polling (09 §4.6.7): every 4 s for up to 120 s → ≤ 30 GETs against `list.default`. */
export const VERIFY_POLL_MS = 4_000;
export const VERIFY_TIMEOUT_MS = 120_000;

/** `Platform.Version` → the iOS major: "26.5"→26, 27→27, "17.0.1"→17, ""→0, undefined→0. */
export function iosMajor(v: string | number | undefined | null): number {
  if (v == null) return 0;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export type IosVariantId = "ios27" | "legacy";
export type UnsupportedReason = "ingest_off" | "no_accounts" | "ios_too_old" | "android_pending" | "link_missing" | "platform";

export type AutomationPath =
  | { kind: "ios_shortcut"; platform: "ios_shortcut"; variant: IosVariantId; url: string; channels: IngestChannel[]; minutes: 2 | 4 }
  | { kind: "ios_app_intent"; platform: "ios_app_intent"; variant: IosVariantId; url: string; channels: IngestChannel[]; minutes: 2 | 4 }
  | { kind: "android_listener"; platform: "android_listener"; channels: ["android_notification"]; minutes: 3 }
  | { kind: "unsupported"; reason: UnsupportedReason };

/** `config.ingest ?? {}` of GET /api/collections/config (07 §4.6 nested block). */
export interface ShortcutLinks {
  iosShortcutUrl?: string | null;
  iosShortcutUrlLegacy?: string | null;
  iosIntentShortcutUrl?: string | null;
  iosIntentShortcutUrlLegacy?: string | null;
}

export interface PathInput {
  os: string;
  osVersion: string | number;
  ingest: boolean;
  activeAccounts: number;
  config: ShortcutLinks;
  modules: { iosIntent: boolean; androidListener: boolean };
}

const nonEmpty = (s: string | null | undefined): string | null => (typeof s === "string" && s.trim() ? s.trim() : null);

/** 03 §A channel table: what the device row may forward. */
function iosChannels(variant: IosVariantId): IngestChannel[] {
  return variant === "ios27" ? ["ios_notification", "ios_sms"] : ["ios_sms"];
}

/** 09 §4.6.1 rules 1–11, in order (10 §4.2 is the authority on the iOS rows). */
export function resolveAutomationPath(i: PathInput): AutomationPath {
  if (!i.ingest) return { kind: "unsupported", reason: "ingest_off" }; // 1
  if (i.activeAccounts === 0) return { kind: "unsupported", reason: "no_accounts" }; // 2
  if (i.os === "ios") {
    const major = iosMajor(i.osVersion);
    if (major <= 16) return { kind: "unsupported", reason: "ios_too_old" }; // 3
    let variant: IosVariantId = major >= 27 ? "ios27" : "legacy"; // 4
    const minutes = (v: IosVariantId): 2 | 4 => (v === "ios27" ? 2 : 4);
    // 5 — M3: the intent shortcut (ios27 falls back to the legacy intent link).
    if (i.modules.iosIntent) {
      const intentUrl =
        variant === "ios27"
          ? nonEmpty(i.config.iosIntentShortcutUrl) ?? nonEmpty(i.config.iosIntentShortcutUrlLegacy)
          : nonEmpty(i.config.iosIntentShortcutUrlLegacy);
      if (intentUrl) {
        const v: IosVariantId = variant === "ios27" && nonEmpty(i.config.iosIntentShortcutUrl) ? "ios27" : "legacy";
        return { kind: "ios_app_intent", platform: "ios_app_intent", variant: v, url: intentUrl, channels: iosChannels(v), minutes: minutes(v) };
      }
    }
    // 6 — an empty iOS 27 link hides that path; the Message trigger still exists on 27.
    if (variant === "ios27" && !nonEmpty(i.config.iosShortcutUrl)) variant = "legacy";
    const url = variant === "ios27" ? nonEmpty(i.config.iosShortcutUrl) : nonEmpty(i.config.iosShortcutUrlLegacy);
    if (!url) return { kind: "unsupported", reason: "link_missing" }; // 7
    return { kind: "ios_shortcut", platform: "ios_shortcut", variant, url, channels: iosChannels(variant), minutes: minutes(variant) }; // 8
  }
  if (i.os === "android") {
    if (i.modules.androidListener) {
      return { kind: "android_listener", platform: "android_listener", channels: ["android_notification"], minutes: 3 }; // 9
    }
    return { kind: "unsupported", reason: "android_pending" }; // 10
  }
  return { kind: "unsupported", reason: "platform" }; // 11
}

export type WizardStep = "intro" | "consent" | "device" | "install" | "enable" | "verify" | "done" | "unsupported";

const FULL: readonly WizardStep[] = ["intro", "consent", "device", "install", "enable", "verify", "done"];

/** 09 §4.6.2: the same seven steps on every supported path; `unsupported` alone otherwise. */
export function stepsFor(path: AutomationPath): readonly WizardStep[] {
  return path.kind === "unsupported" ? ["unsupported"] : FULL;
}

/** The i18n leaf of `mobile.collections.setup.unsupported.*` for a reason. */
export function unsupportedKey(reason: UnsupportedReason): string {
  const leaf: Record<UnsupportedReason, string> = {
    ingest_off: "ingestOff",
    no_accounts: "noAccounts",
    ios_too_old: "iosTooOld",
    android_pending: "androidPending",
    link_missing: "linkMissing",
    platform: "platform",
  };
  return `mobile.collections.setup.unsupported.${leaf[reason]}`;
}

/** Postgres text timestamps ("2026-09-18 02:34:20.571236+00") → ISO; Hermes rejects the former. */
export function normalizeTs(x: string): string {
  let s = x.trim();
  if (/^\d{4}-\d{2}-\d{2} \d/.test(s)) s = s.replace(" ", "T");
  // "+00" / "+0300" → "+00:00" / "+03:00"
  s = s.replace(/([+-]\d{2})$/, "$1:00").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  // Fractions beyond milliseconds are not ISO-8601 for every parser.
  s = s.replace(/(\.\d{3})\d+/, "$1");
  return s;
}

function ms(x: string | null | undefined): number {
  if (x == null) return NaN;
  return Date.parse(normalizeTs(x));
}

/** 09 §4.6.7: `now != null && (base == null || t(now) > t(base))`. */
export function arrived(base: string | null | undefined, now: string | null | undefined): boolean {
  if (now == null) return false;
  const n = ms(now);
  if (!Number.isFinite(n)) return false;
  if (base == null) return true;
  const b = ms(base);
  return !Number.isFinite(b) || n > b;
}

/** 07's `DeviceHealth` values this build knows; a newer server value shows no badge. */
export const KNOWN_HEALTH: readonly DeviceHealth[] = ["ok", "never_seen", "silent", "listener_off", "heartbeat_late", "revoked"];

export interface HealthDevice {
  id: string;
  platform: string;
  health: string;
  revokedAt?: string | null;
}

/** Local facts about THIS phone (09 §4.7 row 2). */
export interface LocalHealth {
  thisDeviceId: string | null;
  os: string;
  accessGranted?: boolean;
}

/**
 * 09 §4.7: the server's `health` unchanged, except row 2 — this Android phone
 * with notification access off reads `listener_off` (never over `revoked`).
 * The 45-minute boundary and the server precedence are 07's.
 */
export function deviceHealth(d: HealthDevice, _nowMs: number, local?: LocalHealth): string {
  if (d.health === "revoked" || d.revokedAt) return "revoked";
  if (
    local &&
    local.os === "android" &&
    d.platform === "android_listener" &&
    local.thisDeviceId != null &&
    d.id === local.thisDeviceId &&
    local.accessGranted === false
  ) {
    return "listener_off";
  }
  return d.health;
}

/** Badge tone per health (09 §4.7 table); null = no badge (revoked or unknown). */
export function healthTone(h: string): "danger" | "warning" | "neutral" | "success" | null {
  switch (h) {
    case "listener_off":
    case "silent":
      return "danger";
    case "heartbeat_late":
      return "warning";
    case "never_seen":
      return "neutral";
    case "ok":
      return "success";
    default:
      return null;
  }
}

/** The server's `DeviceDTO.warnings` this build has copy for (A6: `notifications_hidden`). */
export const KNOWN_DEVICE_WARNINGS: readonly string[] = ["notifications_hidden"];

/**
 * 03 §B.1 `DeviceWarning`s to render beside the health badge: only known values (a newer server's
 * value renders nothing), deduped, none for a revoked phone, [] from a server older than A6.
 */
export function knownWarnings(d: { warnings?: readonly unknown[] | null; revokedAt?: string | null }): string[] {
  if (d.revokedAt || !Array.isArray(d.warnings)) return [];
  const out: string[] = [];
  for (const w of d.warnings) {
    if (typeof w === "string" && KNOWN_DEVICE_WARNINGS.includes(w) && !out.includes(w)) out.push(w);
  }
  return out;
}

/** The non-secret MMKV record of this phone's link (09 §4.6.4 rule 4). Never a token. */
export interface SetupRecord {
  deviceId: string | null;
  platform: string | null;
  variant: IosVariantId | null;
  tokenDelivered: boolean;
  baselineSeenAt: string | null;
  baselineMessageAt: string | null;
  createdAt: string | null;
  completedAt: string | null;
  replacesDeviceId: string | null;
  accountLabels: string[];
}

export const EMPTY_RECORD: SetupRecord = Object.freeze({
  deviceId: null,
  platform: null,
  variant: null,
  tokenDelivered: false,
  baselineSeenAt: null,
  baselineMessageAt: null,
  createdAt: null,
  completedAt: null,
  replacesDeviceId: null,
  accountLabels: [],
}) as SetupRecord;

/** The devices list as the reconcile sees it: a 200 list, or "unknown" (offline, 5xx, 403). */
export type DevicesListState = { ok: true; liveIds: readonly string[] } | { ok: false };

export type ResumeAction =
  | { kind: "start" } // no record → intro
  | { kind: "keep" } // the list is unknown → change nothing
  | { kind: "clear" } // absent on a 200 list → clear the record (+ native credential at M3/M4)
  | { kind: "token_lost"; replacesDeviceId: string } // token was in memory only → consent again
  | { kind: "resume_enable" } // token delivered, not verified → enable
  | { kind: "summary" }; // completed → health + re-verify + set up again

/** 09 §4.6.6 table. `replacesDeviceId` already pending (a lost token seen earlier) restarts at consent too. */
export function resumeAction(rec: SetupRecord | null, list: DevicesListState): ResumeAction {
  if (!rec || (!rec.deviceId && !rec.replacesDeviceId)) return { kind: "start" };
  if (!rec.deviceId && rec.replacesDeviceId) return { kind: "token_lost", replacesDeviceId: rec.replacesDeviceId };
  if (!list.ok) return { kind: "keep" };
  const id = rec.deviceId as string;
  if (!list.liveIds.includes(id)) return { kind: "clear" };
  if (!rec.tokenDelivered) return { kind: "token_lost", replacesDeviceId: id };
  if (!rec.completedAt) return { kind: "resume_enable" };
  return { kind: "summary" };
}

/** The hub's automation-entry hint (09 §4.3 item 5), from the record after reconcile. */
export function entryHint(rec: SetupRecord | null): "hintOn" | "hintPending" | "hintOff" {
  if (!rec?.deviceId) return "hintOff";
  return rec.completedAt ? "hintOn" : "hintPending";
}

/** 09 §4.6.5: open the installed shortcut by name. */
export function shortcutOpenUrl(name: string): string {
  return "shortcuts://open-shortcut?name=" + encodeURIComponent(name);
}

/** 09 §4.6.7: run it by name with the test marker as text input. */
export function shortcutRunTestUrl(name: string): string {
  return (
    "shortcuts://run-shortcut?name=" +
    encodeURIComponent(name) +
    "&input=text&text=" +
    encodeURIComponent(COLLECTIONS_SETUP_TEST_MARKER)
  );
}

/** `token.shown` prefix: `mgi_` + the first 8 secret chars (= `token_prefix`). */
export function tokenPrefix(token: string): string {
  return token.slice(0, 12);
}

/** 09 §4.6.7 dev simulate body (`__DEV__` only): one `test: true` message, D10-8 body. */
export function simulateTestBody(channel: IngestChannel, fpHex: string, now: Date) {
  return {
    v: 1 as const,
    messages: [
      {
        fp: fpHex,
        channel,
        sender: "TheStoro",
        body: COLLECTIONS_SETUP_TEST_BODY,
        receivedAt: now.toISOString(),
        test: true,
      },
    ],
  };
}

/**
 * 14 §4.2 render contract, in binding order, for `ConsentScreen` (keys under
 * `mobile.collections.consent.`): title; the variant's lead → reads → sends
 * → key; common.neverSends → purpose → payers → retention → control → law;
 * privacyLink; common.statement; the agree / decline buttons; the version
 * footer.
 */
export function consentOrder(variant: "ios" | "android"): readonly string[] {
  return [
    "title",
    `${variant}.lead`,
    `${variant}.reads`,
    `${variant}.sends`,
    `${variant}.key`,
    "common.neverSends",
    "common.purpose",
    "common.payers",
    "common.retention",
    "common.control",
    "common.law",
    "privacyLink",
    "common.statement",
    "agree",
    "decline",
    "versionLabel",
    "version",
  ];
}

/** Label ≤ 60 chars (07's zod), trimmed. */
export function clampLabel(s: string, max = 60): string {
  const t = s.trim();
  return t.length <= max ? t : t.slice(0, max).trimEnd();
}

/**
 * The Settings-root line `collection-this-phone-forwards` (09 §4.2, US-M4-04):
 * any signed-in user, whenever this phone holds a link. On the M2 shortcut
 * path the credential lives inside the shortcut, so `completedAt` stands in
 * for it; M3/M4 pass the native module's answer (`hasIngestCredential()` /
 * `getStatus().configured`) as `nativeCredential`.
 */
export function forwardsLineVisible(rec: SetupRecord | null, nativeCredential?: boolean): boolean {
  if (!rec?.deviceId) return false;
  if (nativeCredential !== undefined) return nativeCredential;
  return rec.completedAt != null;
}
