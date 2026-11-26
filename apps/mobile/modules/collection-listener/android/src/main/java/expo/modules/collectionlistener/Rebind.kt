package expo.modules.collectionlistener

import android.app.Activity
import android.app.ActivityManager
import android.app.NotificationManager
import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import android.service.notification.NotificationListenerService
import expo.modules.collectionlistener.store.AppInfo
import expo.modules.collectionlistener.store.State

/**
 * Access, "connected" and rebind (doc 15 spec 11 §4.5.7). No Expo import (the M5 Collector may reuse it).
 */
object Rebind {
  fun component(ctx: Context): ComponentName = ComponentName(ctx.applicationContext, CollectionListenerService::class.java)

  /** API ≥ 27: `isNotificationListenerAccessGranted`; API 24–26: `enabled_notification_listeners`. */
  fun isAccessGranted(ctx: Context): Boolean = try {
    val cn = component(ctx)
    if (Build.VERSION.SDK_INT >= 27) {
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      nm.isNotificationListenerAccessGranted(cn)
    } else {
      val flat = Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners") ?: ""
      flat.split(':').any { ComponentName.unflattenFromString(it) == cn }
    }
  } catch (_: Throwable) {
    false
  }

  /** Wall-clock boot time; a `connected` flag left over from before a reboot does not count. */
  fun bootTimeMs(): Long = System.currentTimeMillis() - SystemClock.elapsedRealtime()

  /** `State.connected && State.connectedAt > bootTime && isAccessGranted()` (heartbeat `listenerConnected`). */
  fun connected(ctx: Context, state: State = State(ctx)): Boolean =
    state.connected && state.connectedAt > bootTimeMs() && isAccessGranted(ctx)

  /** Configured + access granted but not connected → `requestRebind(cn)`. Returns true when requested. */
  fun check(ctx: Context): Boolean {
    val state = State(ctx)
    if (!state.configured) return false
    if (!isAccessGranted(ctx)) return false
    if (connected(ctx, state)) return false
    return request(ctx, state)
  }

  /** `requestRebind()` from JS: true = rebind requested (access granted). */
  fun request(ctx: Context, state: State = State(ctx)): Boolean {
    if (!isAccessGranted(ctx)) return false
    return try {
      NotificationListenerService.requestRebind(component(ctx))
      state.rebindRequestedAt = System.currentTimeMillis()
      true
    } catch (t: Throwable) {
      state.recordError(t)
      false
    }
  }

  /** Notification listeners cannot be bound on low-RAM devices running Android 10 (Q) and below. */
  fun isSupported(ctx: Context): Boolean = try {
    val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
    val lowRamOld = am.isLowRamDevice && Build.VERSION.SDK_INT <= 29
    lowRamOld == false
  } catch (_: Throwable) {
    true
  }

  private fun start(ctx: Context, activity: Activity?, intent: Intent): Boolean {
    return if (activity != null) {
      activity.startActivity(intent)
      true
    } else {
      ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      true
    }
  }

  /**
   * API ≥ 30: the detail screen for our component; otherwise (or when that Activity is missing) the
   * notification-access list. The caller has already refused this before `configure()` (NOT_CONFIGURED).
   */
  fun openAccessSettings(ctx: Context, activity: Activity?): Boolean {
    if (Build.VERSION.SDK_INT >= 30) {
      try {
        val i = Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
          .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, component(ctx).flattenToString())
        return start(ctx, activity, i)
      } catch (_: ActivityNotFoundException) {
        // fall through to the list screen
      } catch (_: SecurityException) {
      }
    }
    return try {
      start(ctx, activity, Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
    } catch (_: Throwable) {
      false
    }
  }

  /**
   * The battery-optimisation LIST screen; on `ActivityNotFoundException` our App info screen. Never
   * `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, never the `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`
   * permission (A9), no OEM-private intents (the OEM checklist gives the steps as text).
   */
  fun openBatterySettings(ctx: Context, activity: Activity?): Boolean {
    return try {
      start(ctx, activity, Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
    } catch (_: ActivityNotFoundException) {
      try {
        start(
          ctx,
          activity,
          Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", ctx.packageName, null)),
        )
      } catch (_: Throwable) {
        false
      }
    } catch (_: Throwable) {
      false
    }
  }

  /**
   * Configured packages that resolve on this phone. Visibility is limited to the module's static
   * `<queries>` (no QUERY_ALL_PACKAGES): an allowlisted package outside it is still listened to but
   * shows as not installed here. `com.android.shell` (debug) is never reported.
   */
  fun packagesInstalled(ctx: Context, packages: List<String>): List<String> {
    val pm = ctx.packageManager
    val out = ArrayList<String>()
    for (p in packages) {
      if (p == expo.modules.collectionlistener.core.PackagePolicy.DEBUG_SHELL_PACKAGE) continue
      try {
        @Suppress("DEPRECATION")
        pm.getPackageInfo(p, 0)
        out.add(p)
      } catch (_: PackageManager.NameNotFoundException) {
      } catch (_: Throwable) {
      }
      if (out.size >= 50) break
    }
    AppInfo.debug(ctx, "packagesInstalled ${out.size}/${packages.size}")
    return out
  }
}
