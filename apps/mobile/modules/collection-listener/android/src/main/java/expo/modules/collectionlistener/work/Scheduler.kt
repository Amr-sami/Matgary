package expo.modules.collectionlistener.work

import android.content.Context
import android.os.Build
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import expo.modules.collectionlistener.store.CredentialStore
import expo.modules.collectionlistener.store.Queue
import expo.modules.collectionlistener.store.State
import java.util.concurrent.TimeUnit

/**
 * The three unique works (doc 15 spec 11 §4.5.6), prefixed so they never collide with
 * `expo-background-task`'s own WorkManager jobs:
 *
 * | Name | Request | Policy |
 * |---|---|---|
 * | `thestoro.collection-listener.drain` | one-time, `mode=drain`, CONNECTED, EXPONENTIAL 30 s | APPEND_OR_REPLACE (a new offer never cancels an upload in flight) |
 * | `thestoro.collection-listener.heartbeat` | one-time, `mode=heartbeat_forced` | REPLACE |
 * | `thestoro.collection-listener.periodic` | periodic 15 min, `mode=periodic`, CONNECTED | UPDATE |
 *
 * D11-d: `setExpedited(RUN_AS_NON_EXPEDITED_WORK_REQUEST)` only on API ≥ 31. Below Android 12
 * WorkManager would need `getForegroundInfo()` for expedited work, which this module never provides:
 * no foreground service is ever started and no FGS type is ever declared. Input `Data` carries the mode
 * only — never the token (§4.7 item 4).
 */
object Scheduler {
  const val DRAIN = "thestoro.collection-listener.drain"
  const val HEARTBEAT = "thestoro.collection-listener.heartbeat"
  const val PERIODIC = "thestoro.collection-listener.periodic"

  const val KEY_MODE = "mode"
  const val MODE_DRAIN = "drain"
  const val MODE_HEARTBEAT_FORCED = "heartbeat_forced"
  const val MODE_PERIODIC = "periodic"

  private fun connected() = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

  private val expeditedAllowed: Boolean get() = Build.VERSION.SDK_INT >= 31

  fun drain(ctx: Context) {
    val b = OneTimeWorkRequestBuilder<UploadWorker>()
      .setInputData(workDataOf(KEY_MODE to MODE_DRAIN))
      .setConstraints(connected())
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
    if (expeditedAllowed) b.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
    WorkManager.getInstance(ctx.applicationContext).enqueueUniqueWork(DRAIN, ExistingWorkPolicy.APPEND_OR_REPLACE, b.build())
  }

  fun heartbeatNow(ctx: Context) {
    val b = OneTimeWorkRequestBuilder<UploadWorker>()
      .setInputData(workDataOf(KEY_MODE to MODE_HEARTBEAT_FORCED))
      .setConstraints(connected())
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
    if (expeditedAllowed) b.setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
    WorkManager.getInstance(ctx.applicationContext).enqueueUniqueWork(HEARTBEAT, ExistingWorkPolicy.REPLACE, b.build())
  }

  /** After a reconnect: a forced heartbeat only when the last one is older than [staleMs] (5 min). */
  fun heartbeatIfStale(ctx: Context, staleMs: Long = 5 * 60_000L) {
    val last = State(ctx).lastHeartbeatAt
    if (System.currentTimeMillis() - last > staleMs) heartbeatNow(ctx)
  }

  /** Idempotent: `UPDATE` keeps the existing schedule. The 15-minute period is WorkManager's minimum. */
  fun periodic(ctx: Context) {
    val r = PeriodicWorkRequestBuilder<UploadWorker>(15, TimeUnit.MINUTES)
      .setInputData(workDataOf(KEY_MODE to MODE_PERIODIC))
      .setConstraints(connected())
      .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
      .build()
    WorkManager.getInstance(ctx.applicationContext).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.UPDATE, r)
  }

  fun cancelAll(ctx: Context) {
    val wm = WorkManager.getInstance(ctx.applicationContext)
    wm.cancelUniqueWork(DRAIN)
    wm.cancelUniqueWork(HEARTBEAT)
    wm.cancelUniqueWork(PERIODIC)
  }

  /**
   * `clearCredentials()` natively (§4.5.8): cancel the three works, delete the Keystore entry, clear
   * both preference files and delete the database. The OS notification-access grant stays (only the
   * owner can switch it off). [authFailed] (a 401, or a decrypt failure) keeps `auth_failed_at` so 09's
   * reconcile can offer "Set up again".
   */
  fun clearEverything(ctx: Context, authFailed: Boolean) {
    val now = System.currentTimeMillis()
    try {
      cancelAll(ctx)
    } catch (_: Throwable) {
    }
    CredentialStore(ctx).clear()
    Queue.destroy(ctx)
    State(ctx).clearAll(keepAuthFailedAt = if (authFailed) now else 0L)
  }
}
