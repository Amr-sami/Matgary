package expo.modules.collectionlistener.store

import android.content.Context
import android.content.pm.ApplicationInfo
import android.os.Build
import android.util.Log

/**
 * Facts about the host APP (not this library): debuggable (D11-g reads the app's `ApplicationInfo`,
 * never the library `BuildConfig`), `versionName`, and the debug-only logger of §4.7 item 5 (counts
 * and codes only — never text, titles, packages outside the allowlist, or the token).
 */
object AppInfo {
  private const val TAG = "CollectionListener"

  fun isDebuggable(ctx: Context): Boolean =
    (ctx.applicationContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

  fun versionName(ctx: Context): String? = try {
    val pm = ctx.packageManager
    @Suppress("DEPRECATION")
    pm.getPackageInfo(ctx.packageName, 0).versionName
  } catch (_: Throwable) {
    null
  }

  fun osVersion(): String = Build.VERSION.RELEASE ?: Build.VERSION.SDK_INT.toString()

  /** Debuggable builds only. Callers pass counts / codes / enum names — never message content. */
  fun debug(ctx: Context, msg: String) {
    if (isDebuggable(ctx)) Log.d(TAG, msg)
  }
}
