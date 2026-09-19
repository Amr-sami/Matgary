/**
 * JS face of the local Expo module in this folder (autolinked from
 * apps/mobile/modules/ — no package.json entry, no config plugin).
 *
 * `setExcludedFromBackup(path, true)` flags a file with
 * NSURLIsExcludedFromBackupKey on iOS so it never lands in an iCloud / Finder
 * backup. On Android the native side is a no-op that returns true (the app
 * already sets android:allowBackup="false"). Everywhere the native module is
 * missing — web, a build made before `npm run ios:prebuild`, plain-Node unit
 * tests — it returns false and never throws, so callers can treat it as
 * best-effort hardening rather than a precondition.
 */
type BackupExclusionNative = {
  setExcluded(path: string, excluded: boolean): boolean;
};

let native: BackupExclusionNative | null | undefined;

function loadNative(): BackupExclusionNative | null {
  if (native !== undefined) return native;
  try {
    // Lazy require: expo-modules-core (and react-native underneath it) cannot
    // be imported in plain Node, and a top-level import would take this whole
    // file — fallback included — down with it.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const core = require("expo-modules-core") as {
      requireOptionalNativeModule?: <T>(name: string) => T | null;
    };
    native = core.requireOptionalNativeModule?.<BackupExclusionNative>("BackupExclusion") ?? null;
  } catch {
    native = null;
  }
  return native;
}

/** True iff the native module is linked into this build. */
export function isBackupExclusionAvailable(): boolean {
  return loadNative() !== null;
}

/**
 * Mark `path` (plain path or file:// URI) as excluded from / included in
 * device backups. Returns true only when the native side confirmed the
 * attribute was set; false when the file is missing, the call failed, or the
 * module is not available on this platform/build.
 */
export function setExcludedFromBackup(path: string, excluded: boolean): boolean {
  const mod = loadNative();
  if (!mod) return false;
  try {
    return mod.setExcluded(path, excluded) === true;
  } catch {
    return false;
  }
}
