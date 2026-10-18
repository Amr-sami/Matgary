/**
 * iOS automation step lists (doc 15 spec 10 §4.13, M2; 09's `IosSteps` renders them).
 *
 * Pure and import-free so `node --test --experimental-strip-types` loads it.
 * Every returned `key` is a full i18n path under `mobile.collections.ios.`;
 * the caller renders `t(step.key, step.params)` — never at module scope.
 *
 * Selection (10 §4.13):
 *  - install      → `install.<mode>.s*`
 *  - enable ios27 → `enable.ios27.s1–s4`, `enable.alwaysAllow.<mode>`, `enable.optionalNotification.s1–s2`
 *  - enable legacy, iOS < 27  → `enable.legacy.s1–s6`, `enable.alwaysAllow.<mode>`, `runningNote`
 *  - enable legacy, iOS ≥ 27  → `enable.legacy27.s1–s4`, `enable.alwaysAllow.<mode>`
 *  - troubleshoot → `troubleshoot.common.s1–s5`, `troubleshoot.<variant>.s1`, `troubleshoot.<mode>.s*`
 *
 * `runningNote` is only on the iOS 17–26 legacy list: there a Run Immediately
 * Message automation always shows a banner. On iOS 27 Apple says a locked-run
 * automation "will not notify you" (UNVERIFIED until 10's T1).
 */

/** D10-1: the one installed name, every locale (= `mobile.collections.ios.shortcutName` in ar AND en). */
export const IOS_SHORTCUT_NAME = "ستورو — تأكيد التحويلات";

/** D10-2: the two Message-trigger phrases (`مبلغ` 8/10 published credits, `EGP` 3/10, together 10/10). */
export const IOS_TRIGGER_KEYWORDS = { primary: "مبلغ", english: "EGP" } as const;

export type IosMode = "http" | "intent";
export type IosVariant = "ios27" | "legacy";
export type IosPhase = "install" | "enable" | "troubleshoot";
export type IosStep = { key: string; params?: Record<string, string> };

const NS = "mobile.collections.ios.";

const step = (key: string, params?: Record<string, string>): IosStep =>
  params ? { key: NS + key, params } : { key: NS + key };

const NAME = { name: IOS_SHORTCUT_NAME };
const PRIMARY = { keyword: IOS_TRIGGER_KEYWORDS.primary };
const ENGLISH = { keyword: IOS_TRIGGER_KEYWORDS.english };

function installSteps(mode: IosMode): IosStep[] {
  if (mode === "intent") {
    return [step("install.intent.s1", NAME), step("install.intent.s2"), step("install.intent.s3")];
  }
  return [step("install.http.s1"), step("install.http.s2"), step("install.http.s3"), step("install.http.s4")];
}

function enableSteps(mode: IosMode, variant: IosVariant, iosMajor: number): IosStep[] {
  const alwaysAllow = step(`enable.alwaysAllow.${mode}`);
  if (variant === "ios27") {
    return [
      step("enable.ios27.s1"),
      step("enable.ios27.s2"),
      step("enable.ios27.s3"),
      step("enable.ios27.s4"),
      alwaysAllow,
      step("enable.optionalNotification.s1"),
      step("enable.optionalNotification.s2"),
    ];
  }
  if (iosMajor >= 27) {
    // 09 rule 6: an iOS 27 phone on the legacy link builds the automation inside the shortcut.
    return [
      step("enable.legacy27.s1"),
      step("enable.legacy27.s2", PRIMARY),
      step("enable.legacy27.s3"),
      step("enable.legacy27.s4", ENGLISH),
      alwaysAllow,
    ];
  }
  return [
    step("enable.legacy.s1"),
    step("enable.legacy.s2", PRIMARY),
    step("enable.legacy.s3"),
    step("enable.legacy.s4", NAME),
    step("enable.legacy.s5"),
    step("enable.legacy.s6", ENGLISH),
    alwaysAllow,
    step("runningNote"),
  ];
}

function troubleshootSteps(mode: IosMode, variant: IosVariant): IosStep[] {
  const out: IosStep[] = [
    step("troubleshoot.common.s1"),
    step("troubleshoot.common.s2", NAME),
    step("troubleshoot.common.s3"),
    step("troubleshoot.common.s4"),
    step("troubleshoot.common.s5"),
    variant === "legacy" ? step("troubleshoot.legacy.s1", PRIMARY) : step("troubleshoot.ios27.s1"),
  ];
  if (mode === "intent") out.push(step("troubleshoot.intent.s1"), step("troubleshoot.intent.s2"));
  else out.push(step("troubleshoot.http.s1"));
  return out;
}

export function iosStepKeys(i: { phase: IosPhase; mode: IosMode; variant: IosVariant; iosMajor: number }): readonly IosStep[] {
  if (i.phase === "install") return installSteps(i.mode);
  if (i.phase === "enable") return enableSteps(i.mode, i.variant, i.iosMajor);
  return troubleshootSteps(i.mode, i.variant);
}
