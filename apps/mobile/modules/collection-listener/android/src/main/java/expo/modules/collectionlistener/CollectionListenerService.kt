package expo.modules.collectionlistener

import android.app.Notification
import android.content.Context
import android.content.res.Resources
import android.os.Build
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import expo.modules.collectionlistener.core.CandidateFilter
import expo.modules.collectionlistener.core.Fingerprint
import expo.modules.collectionlistener.core.NotificationText
import expo.modules.collectionlistener.core.Payload
import expo.modules.collectionlistener.core.Redaction
import expo.modules.collectionlistener.store.AppInfo
import expo.modules.collectionlistener.store.CredentialStore
import expo.modules.collectionlistener.store.KeystoreFailure
import expo.modules.collectionlistener.store.Queue
import expo.modules.collectionlistener.store.State
import expo.modules.collectionlistener.work.Scheduler
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * The NotificationListenerService (doc 15 spec 11 §4.5.4, §4.5.2). It reads ONLY notifications of
 * the bank / wallet APP packages on the sanitised allowlist — never an SMS app (D11-f), never anything
 * before the owner's consent flow configured it (rule 1) — drops OTPs and non-candidates in memory, and
 * queues the rest AES-GCM-encrypted for [expo.modules.collectionlistener.work.UploadWorker].
 *
 * Every callback hands its work to one single-thread executor (Keystore + SQLite must not risk an ANR
 * on the main thread) and is wrapped in `try/catch (Throwable)`: the service never crashes the app.
 * Errors bump `State.errorCount` and store a class name, never text. `onNotificationRemoved` is not
 * overridden: a removed notification is still a received credit.
 */
class CollectionListenerService : NotificationListenerService() {
  private val executor: ExecutorService = Executors.newSingleThreadExecutor()

  override fun onListenerConnected() {
    val ctx = applicationContext
    executor.execute {
      guard(ctx) {
        val state = State(ctx)
        state.connected = true
        state.connectedAt = System.currentTimeMillis()
        if (!state.configured) return@guard
        // Backfill: what is already in the shade goes through the same pipeline; the seen table makes
        // it idempotent. `activeNotifications` can throw SecurityException.
        val active: Array<StatusBarNotification> = try {
          activeNotifications ?: emptyArray()
        } catch (_: SecurityException) {
          emptyArray()
        }
        var queued = 0
        for (sbn in active) if (Pipeline.handle(ctx, sbn, allowDrain = false)) queued++
        if (Queue.get(ctx).count() > 0) Scheduler.drain(ctx)
        // The server should see `listenerConnected: true` promptly: forced when the last heartbeat
        // said false (configure() ran before access was granted), else only when > 5 min old.
        if (!state.lastHeartbeatConnected) Scheduler.heartbeatNow(ctx) else Scheduler.heartbeatIfStale(ctx)
        AppInfo.debug(ctx, "connected backfill=${active.size} queued=$queued")
      }
    }
  }

  override fun onListenerDisconnected() {
    val ctx = applicationContext
    try {
      State(ctx).connected = false
      // The only call allowed at this point (android.md §1.1).
      requestRebind(Rebind.component(ctx))
    } catch (t: Throwable) {
      try {
        State(ctx).recordError(t)
      } catch (_: Throwable) {
      }
    }
  }

  override fun onNotificationPosted(sbn: StatusBarNotification?) {
    if (sbn == null) return
    val ctx = applicationContext
    // Debug builds only: the ranking snapshot for the A6 diagnostic line (Pipeline.diagnose).
    val ranking = if (AppInfo.isDebuggable(ctx)) {
      try {
        currentRanking
      } catch (_: Throwable) {
        null
      }
    } else {
      null
    }
    executor.execute { guard(ctx) { Pipeline.handle(ctx, sbn, allowDrain = true, ranking = ranking) } }
  }

  override fun onDestroy() {
    try {
      executor.shutdown()
    } catch (_: Throwable) {
    }
    super.onDestroy()
  }

  private inline fun guard(ctx: Context, block: () -> Unit) {
    try {
      block()
    } catch (t: Throwable) {
      try {
        State(ctx).recordError(t)
      } catch (_: Throwable) {
      }
    }
  }
}

/** §4.5.2 rules 1–7 → fp → seen/queue → drain. Shared by posts and the reconnect backfill. */
internal object Pipeline {
  @Volatile private var filterVersion: String? = null
  @Volatile private var filter: CandidateFilter? = null
  @Volatile private var allowVersion: String? = null
  @Volatile private var allow: Set<String> = emptySet()

  private fun filterFor(state: State): CandidateFilter {
    val v = state.configVersion
    val cached = filter
    if (cached != null && v == filterVersion) return cached
    val f = CandidateFilter.of(state.keywordsAr, state.keywordsEn, state.otpPatterns)
    filter = f
    filterVersion = v
    return f
  }

  private fun allowlist(state: State): Set<String> {
    val v = state.configVersion
    if (v != null && v == allowVersion) return allow
    val s = state.packages.toHashSet()
    allow = s
    allowVersion = v
    return s
  }

  @Volatile private var placeholderId: Int = -1

  /** A6: the framework's redaction placeholder in the system locale, plus the fixed en / ar strings. */
  private fun placeholders(): Set<String> {
    val resolved = try {
      val res = Resources.getSystem()
      var id = placeholderId
      if (id == -1) {
        id = res.getIdentifier("redacted_notification_message", "string", "android")
        placeholderId = id
      }
      if (id != 0) res.getString(id) else null
    } catch (_: Throwable) {
      null
    }
    return Redaction.placeholders(resolved)
  }

  /**
   * Debug builds only: one line per allowlisted post with booleans — never text — so a device run can
   * see what the platform handed over (spec 11 §7.3 A6). `rankingSensitive` reads the @SystemApi
   * `Ranking#hasSensitiveContent` by reflection when the platform allows it, else `n/a`.
   */
  private fun diagnose(
    ctx: Context,
    sbn: StatusBarNotification,
    e: NotificationText.Extras,
    ph: Set<String>,
    redacted: Boolean,
    ranking: NotificationListenerService.RankingMap?,
  ) {
    if (!AppInfo.isDebuggable(ctx)) return
    fun isPh(cs: CharSequence?) = cs?.toString()?.trim()?.let { it in ph } == true
    val sensitive = try {
      val r = NotificationListenerService.Ranking()
      if (ranking != null && ranking.getRanking(sbn.key, r)) {
        r.javaClass.getMethod("hasSensitiveContent").invoke(r)?.toString() ?: "n/a"
      } else {
        "no-ranking"
      }
    } catch (_: Throwable) {
      "n/a"
    }
    AppInfo.debug(
      ctx,
      "post sdk=${Build.VERSION.SDK_INT} redacted=$redacted textIsPlaceholder=${isPh(e.text)} " +
        "bigTextIsPlaceholder=${isPh(e.bigText)} hasBigText=${e.bigText != null} hasLines=${e.textLines != null} " +
        "titleLen=${e.title?.length ?: -1} textLen=${e.text?.length ?: -1} rankingSensitive=$sensitive",
    )
  }

  /** Forget the compiled config (configure() / clearCredentials()). */
  fun reset() {
    filter = null
    filterVersion = null
    allow = emptySet()
    allowVersion = null
  }

  /** True when a new row was queued. */
  fun handle(
    ctx: Context,
    sbn: StatusBarNotification,
    allowDrain: Boolean,
    ranking: NotificationListenerService.RankingMap? = null,
  ): Boolean {
    val state = State(ctx)
    // 1. Not configured → nothing is read (covers access granted from Settings without the consent flow).
    if (!state.configured) return false
    // 2. Allowlist BEFORE notification.extras is touched. (The stored list is already sanitised with the
    //    SMS-app denylist; it is re-checked here so even a stale store can never admit an SMS app.)
    val pkg = sbn.packageName ?: return false
    if (pkg !in allowlist(state)) return false
    if (expo.modules.collectionlistener.core.PackagePolicy.isDenied(pkg)) return false
    if (pkg == expo.modules.collectionlistener.core.PackagePolicy.DEBUG_SHELL_PACKAGE && !AppInfo.isDebuggable(ctx)) return false
    val now = System.currentTimeMillis()
    // 3. Health signal: an allowlisted app posted something.
    state.lastNotificationAt = now
    val n: Notification = sbn.notification ?: return false
    // 4–5. Group summary, ongoing, too old — from flags and postTime only.
    val maxAge = state.maxAgeHours
    if (NotificationText.skipReason(n.flags, sbn.postTime, now, maxAge) != null) return false
    // 6. Text.
    val x = n.extras ?: return false
    val extras = NotificationText.Extras(
      title = x.getCharSequence(Notification.EXTRA_TITLE),
      subText = x.getCharSequence(Notification.EXTRA_SUB_TEXT),
      bigText = x.getCharSequence(Notification.EXTRA_BIG_TEXT),
      textLines = x.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)?.toList(),
      text = x.getCharSequence(Notification.EXTRA_TEXT),
    )
    // 6a. A6: Android 15+ handed over a redacted copy (sensitive content, untrusted listener). Count it
    //     once per shade entry (key + postTime, hashed into the seen table so the reconnect backfill does
    //     not count it again), never its text; the heartbeat reports it. The first one forces a heartbeat.
    val ph = placeholders()
    val redacted = Redaction.isRedacted(Build.VERSION.SDK_INT, extras, ph)
    diagnose(ctx, sbn, extras, ph, redacted, ranking)
    if (redacted) {
      val key = Fingerprint.sha256Hex("redacted|" + (sbn.key ?: pkg) + "|" + sbn.postTime)
      if (Queue.get(ctx).markSeen(key, now, maxAge * 3_600_000L)) {
        state.recordRedacted(pkg, now)
        if (state.lastHeartbeatRedacted == 0L) Scheduler.heartbeatNow(ctx)
        AppInfo.debug(ctx, "redacted total=${state.redactedCount}")
      }
      return false
    }
    val text = NotificationText.extract(extras) ?: return false
    // 7. Candidate = keyword && !OTP; otherwise dropped in memory.
    if (!filterFor(state).isCandidate(text.title, text.subtitle, text.text)) return false

    val fp = Fingerprint.of(pkg, text.title, text.text)
    val json = Payload.messageJson(
      Payload.Message(fp, pkg, text.title, text.subtitle, text.text, receivedAtMs = sbn.postTime),
    )
    val cipher = try {
      CredentialStore(ctx).encrypt(json.toByteArray(Charsets.UTF_8))
    } catch (e: KeystoreFailure) {
      state.recordError(e)
      return false
    }
    val (offer, dropped) = Queue.get(ctx).offer(fp, cipher, now, maxAge * 3_600_000L)
    if (dropped > 0) state.droppedOverflow = state.droppedOverflow + dropped
    if (offer != Queue.Offer.QUEUED) return false
    if (allowDrain) Scheduler.drain(ctx)
    return true
  }
}
