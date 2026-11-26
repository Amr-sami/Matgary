package expo.modules.backupexclusion

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Android counterpart of the iOS module. Per-file backup exclusion has no
 * equivalent here: the app sets `android:allowBackup="false"` (app.config.ts),
 * which keeps every app file out of Auto Backup / D2D transfer, so this is a
 * no-op that reports success and keeps the JS API identical on both platforms.
 */
class BackupExclusionModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("BackupExclusion")

    Function("setExcluded") { _: String, _: Boolean -> true }
  }
}
