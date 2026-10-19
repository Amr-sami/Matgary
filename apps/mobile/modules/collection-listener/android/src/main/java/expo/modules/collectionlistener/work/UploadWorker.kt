package expo.modules.collectionlistener.work

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import expo.modules.collectionlistener.Rebind
import expo.modules.collectionlistener.core.ConfigRules
import expo.modules.collectionlistener.core.Payload
import expo.modules.collectionlistener.core.ResponsePolicy
import expo.modules.collectionlistener.core.ResponsePolicy.HeartbeatAction
import expo.modules.collectionlistener.core.ResponsePolicy.IngestAction
import expo.modules.collectionlistener.net.IngestClient
import expo.modules.collectionlistener.store.AppInfo
import expo.modules.collectionlistener.store.CredentialStore
import expo.modules.collectionlistener.store.KeystoreFailure
import expo.modules.collectionlistener.store.Queue
import expo.modules.collectionlistener.store.State
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/**
 * Drain / heartbeat / periodic (doc 15 spec 11 §4.5.6 `doWork()`):
 *
 * 1. Not configured → success.
 * 2. Purge rows and seen entries older than `maxAgeHours`.
 * 3. Drain (every mode except `heartbeat_forced`), unless paused (403): ≤ 10 rounds of the oldest
 *    ≤ 50 rows, decrypted, byte-bounded batches (≤ 200,000 bytes), the [ResponsePolicy] per answer.
 * 4. Heartbeat: forced (≥ 60 s since the last) or ≥ 10 min since the last. A new `configVersion` in
 *    the answer → `GET …/config`, re-sanitise, store.
 * 5. Rebind check (§4.5.7).
 * 6. success, or retry when step 3/4 recorded a network / 5xx / 429 outcome.
 *
 * The worker never overrides `getForegroundInfo()` and never calls `setForeground()` (D11-d). Every
 * failure is contained: the app process never crashes because of it.
 */
class UploadWorker(appContext: Context, params: WorkerParameters) : CoroutineWorker(appContext, params) {
  private enum class Drain { OK, RETRY, PAUSED, CLEARED }

  companion object {
    const val MAX_ROUNDS = 10
    const val ROWS_PER_ROUND = 50
    const val FORCED_MIN_GAP_MS = 60_000L
    const val PERIODIC_GAP_MS = 10 * 60_000L
  }

  override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
    val ctx = applicationContext
    try {
      run(ctx, inputData.getString(Scheduler.KEY_MODE) ?: Scheduler.MODE_PERIODIC)
    } catch (t: Throwable) {
      try {
        State(ctx).recordError(t)
      } catch (_: Throwable) {
      }
      Result.success()
    }
  }

  private fun run(ctx: Context, mode: String): Result {
    val state = State(ctx)
    if (!state.configured) return Result.success() // 1

    val creds = CredentialStore(ctx)
    val token: String?
    val url: String?
    try {
      token = creds.token()
      url = creds.ingestUrl()
    } catch (_: KeystoreFailure) {
      // A later decrypt failure clears everything and marks auth_failed (§4.5.5): 09 offers "Set up again".
      Scheduler.clearEverything(ctx, authFailed = true)
      return Result.success()
    }
    if (token == null || url == null) {
      Scheduler.clearEverything(ctx, authFailed = true)
      return Result.success()
    }

    val now = System.currentTimeMillis()
    val maxAgeMs = state.maxAgeHours * 3_600_000L
    val queue = Queue.get(ctx)
    queue.purge(now, maxAgeMs) // 2

    val client = IngestClient(url, token, AppInfo.versionName(ctx))
    var retry = false

    if (mode != Scheduler.MODE_HEARTBEAT_FORCED && state.pausedAt == 0L) { // 3
      when (drain(ctx, state, creds, queue, client)) {
        Drain.CLEARED -> return Result.success()
        Drain.RETRY -> retry = true
        Drain.PAUSED, Drain.OK -> Unit
      }
    }

    val sinceHb = now - state.lastHeartbeatAt // 4
    // A forced heartbeat also goes out inside the 60-s gap when `listenerConnected` changed since the
    // last one (access granted right after configure()), so the server's health leaves `listener_off`
    // without waiting for the periodic run.
    val connectedChanged = Rebind.connected(ctx, state) != state.lastHeartbeatConnected
    // A6: the first redacted post since the server last heard 0 also waives the gap (once per change),
    // so the owner's "Android is hiding bank notifications" warning appears within seconds.
    val firstRedaction = state.redactedCount > 0L && state.lastHeartbeatRedacted == 0L
    val wantHb = if (mode == Scheduler.MODE_HEARTBEAT_FORCED) {
      sinceHb >= FORCED_MIN_GAP_MS || connectedChanged || firstRedaction
    } else {
      sinceHb >= PERIODIC_GAP_MS
    }
    if (wantHb) {
      when (heartbeat(ctx, state, queue, client)) {
        HeartbeatAction.CLEAR -> return Result.success()
        HeartbeatAction.RETRY -> retry = true
        else -> Unit
      }
    }

    try {
      Rebind.check(ctx) // 5
    } catch (t: Throwable) {
      state.recordError(t)
    }
    return if (retry) Result.retry() else Result.success() // 6
  }

  private fun drain(ctx: Context, state: State, creds: CredentialStore, queue: Queue, client: IngestClient): Drain {
    var uploaded = 0
    for (round in 0 until MAX_ROUNDS) {
      val rows = queue.oldest(ROWS_PER_ROUND)
      if (rows.isEmpty()) break
      val jsons = ArrayList<String>(rows.size)
      try {
        for (r in rows) jsons.add(String(creds.decrypt(r.payload), Charsets.UTF_8))
      } catch (_: KeystoreFailure) {
        Scheduler.clearEverything(ctx, authFailed = true)
        return Drain.CLEARED
      }
      val before = queue.count()
      for (idx in Payload.batch(jsons)) {
        val batchRows = idx.map { rows[it] }
        val batchJsons = idx.map { jsons[it] }
        when (val d = send(ctx, state, queue, client, batchRows, batchJsons)) {
          Drain.OK -> uploaded += batchRows.size
          else -> return d
        }
      }
      // No progress (a 200 that listed none of the rows only bumps attempts): stop for this run.
      if (queue.count() >= before) break
    }
    AppInfo.debug(ctx, "drain sent=$uploaded queued=${queue.count()}")
    return Drain.OK
  }

  private fun send(
    ctx: Context,
    state: State,
    queue: Queue,
    client: IngestClient,
    rows: List<Queue.Row>,
    jsons: List<String>,
  ): Drain {
    val resp = client.postIngest(Payload.ingestBody(jsons))
    return when (ResponsePolicy.forIngest(resp.status, resp.errorCode, rows.size)) {
      IngestAction.APPLY -> {
        val out = ResponsePolicy.applyResults(rows.map { it.fp to it.attempts }, IngestClient.resultFps(resp.body))
        queue.delete(out.delete + out.dropAfterAttempts)
        queue.bumpAttempts(out.bump)
        if (out.dropAfterAttempts.isNotEmpty()) state.droppedAttempts = state.droppedAttempts + out.dropAfterAttempts.size
        state.lastUploadAt = System.currentTimeMillis()
        Drain.OK
      }
      IngestAction.CLEAR -> {
        // 401 INGEST_TOKEN_INVALID / INGEST_DEVICE_REVOKED: stop and clear natively (02 US-M4-05).
        Scheduler.clearEverything(ctx, authFailed = true)
        Drain.CLEARED
      }
      IngestAction.PAUSE -> {
        if (state.pausedAt == 0L) state.pausedAt = System.currentTimeMillis()
        Drain.PAUSED
      }
      IngestAction.SPLIT -> {
        for (i in rows.indices) {
          val d = send(ctx, state, queue, client, listOf(rows[i]), listOf(jsons[i]))
          if (d != Drain.OK) return d
        }
        Drain.OK
      }
      IngestAction.DROP -> {
        queue.delete(rows.map { it.fp })
        state.droppedRejected = state.droppedRejected + rows.size
        Drain.OK
      }
      IngestAction.RETRY -> Drain.RETRY
    }
  }

  private fun heartbeat(ctx: Context, state: State, queue: Queue, client: IngestClient): HeartbeatAction {
    val connectedNow = Rebind.connected(ctx, state)
    val redactedSent = state.redactedCount
    val body = Payload.heartbeatBody(
      Payload.Heartbeat(
        appVersion = AppInfo.versionName(ctx),
        osVersion = AppInfo.osVersion(),
        listenerConnected = connectedNow,
        lastNotificationAtMs = state.lastNotificationAt,
        lastUploadAtMs = state.lastUploadAt,
        queued = queue.count(),
        packagesInstalled = Rebind.packagesInstalled(ctx, state.packages),
        redactedCount = redactedSent,
        redactedByPackage = state.redactedByPackage,
        lastRedactedAtMs = state.lastRedactedAt,
      ),
    )
    val resp = client.postHeartbeat(body)
    val action = ResponsePolicy.forHeartbeat(resp.status, resp.errorCode)
    when (action) {
      HeartbeatAction.OK -> {
        state.lastHeartbeatAt = System.currentTimeMillis()
        state.lastHeartbeatConnected = connectedNow
        state.lastHeartbeatRedacted = redactedSent
        if (state.pausedAt != 0L) {
          state.pausedAt = 0L
          Scheduler.drain(ctx)
        }
        val cv = IngestClient.configVersionOf(resp.body)
        if (cv != null && cv != state.configVersion) refreshConfig(ctx, state, client)
      }
      HeartbeatAction.CLEAR -> Scheduler.clearEverything(ctx, authFailed = true)
      HeartbeatAction.PAUSE -> if (state.pausedAt == 0L) state.pausedAt = System.currentTimeMillis()
      HeartbeatAction.SKIP, HeartbeatAction.RETRY -> Unit
    }
    AppInfo.debug(ctx, "heartbeat ${resp.status ?: "io"} $action")
    return action
  }

  private fun strings(a: JSONArray?): List<String>? {
    if (a == null) return null
    return List(a.length()) { a.optString(it, "") }.filter { it.isNotEmpty() }
  }

  /** `GET {ingestUrl}/config` → re-sanitise and store (the service recompiles its filter on the new version). */
  private fun refreshConfig(ctx: Context, state: State, client: IngestClient) {
    val resp = client.getConfig()
    val status = resp.status ?: return
    if (status == 401) {
      Scheduler.clearEverything(ctx, authFailed = true)
      return
    }
    if (status !in 200..299) return
    try {
      val o = JSONObject(resp.body ?: return)
      val version = o.optString("configVersion", "")
      val packages = strings(o.optJSONArray("packages")) ?: return
      val kw = o.optJSONObject("keywords") ?: return
      val ar = strings(kw.optJSONArray("ar")) ?: return
      val en = strings(kw.optJSONArray("en")) ?: return
      val otp = strings(o.optJSONArray("otpPatterns")) ?: return
      val maxAge = if (o.has("maxAgeHours")) o.optInt("maxAgeHours", 0) else null
      if (version.isEmpty() || version.length > ConfigRules.MAX_CONFIG_VERSION) return
      if (!ConfigRules.listOk(ar + en, ConfigRules.MAX_KEYWORDS) || !ConfigRules.listOk(otp, ConfigRules.MAX_PATTERNS)) return
      state.saveConfig(packages, ar, en, otp, version, maxAge, AppInfo.isDebuggable(ctx))
    } catch (t: Throwable) {
      state.recordError(t)
    }
  }
}
