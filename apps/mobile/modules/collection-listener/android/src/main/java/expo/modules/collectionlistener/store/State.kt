package expo.modules.collectionlistener.store

import android.content.Context
import android.content.SharedPreferences
import expo.modules.collectionlistener.core.ConfigRules
import expo.modules.collectionlistener.core.NotificationText
import org.json.JSONArray
import org.json.JSONObject

/**
 * Non-secret listener state (doc 15 spec 11 §4.5.5): SharedPreferences `collection_listener_state`.
 * Timestamps are epoch ms (0 = never). Counters only, never text: the privacy invariants (§4.7) allow
 * class names and counts here, never titles, bodies, packages outside the allowlist, or the token.
 */
class State(context: Context) {
  private val prefs: SharedPreferences =
    context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  companion object {
    const val PREFS = "collection_listener_state"
  }

  var configured: Boolean
    get() = prefs.getBoolean("configured", false)
    set(v) = edit { putBoolean("configured", v) }

  /** The sanitised allowlist (PackagePolicy.sanitize already applied). */
  var packages: List<String>
    get() = readList("packages")
    set(v) = edit { putString("packages", JSONArray(v).toString()) }

  var keywordsAr: List<String>
    get() = readKeywords("ar")
    set(v) = writeKeywords(v, keywordsEn)

  var keywordsEn: List<String>
    get() = readKeywords("en")
    set(v) = writeKeywords(keywordsAr, v)

  var otpPatterns: List<String>
    get() = readList("otp_patterns")
    set(v) = edit { putString("otp_patterns", JSONArray(v).toString()) }

  var configVersion: String?
    get() = prefs.getString("config_version", null)
    set(v) = edit { putString("config_version", v) }

  var maxAgeHours: Int
    get() = ConfigRules.maxAgeHours(prefs.getInt("max_age_hours", NotificationText.DEFAULT_MAX_AGE_HOURS))
    set(v) = edit { putInt("max_age_hours", ConfigRules.maxAgeHours(v)) }

  var connected: Boolean
    get() = prefs.getBoolean("connected", false)
    set(v) = edit { putBoolean("connected", v) }

  /** What the last 200 heartbeat told the server (`listenerConnected`); a change forces the next one. */
  var lastHeartbeatConnected: Boolean
    get() = prefs.getBoolean("last_heartbeat_connected", false)
    set(v) = edit { putBoolean("last_heartbeat_connected", v) }

  var connectedAt: Long by long("connected_at")
  var lastNotificationAt: Long by long("last_notification_at")
  var lastUploadAt: Long by long("last_upload_at")
  var lastHeartbeatAt: Long by long("last_heartbeat_at")
  var pausedAt: Long by long("paused_at")
  var authFailedAt: Long by long("auth_failed_at")
  var rebindRequestedAt: Long by long("rebind_requested_at")

  var errorCount: Long by long("error_count")
  var droppedOverflow: Long by long("dropped_overflow")
  var droppedAttempts: Long by long("dropped_attempts")
  var droppedRejected: Long by long("dropped_rejected")
  var badPatterns: Long by long("bad_patterns")

  // A6 (Android 15+ sensitive-content redaction): counts and a time only, never text.
  var redactedCount: Long by long("redacted_count")
  var lastRedactedAt: Long by long("last_redacted_at")

  /** `redactedCount` as of the last 200 heartbeat; the first redaction after a 0 forces one. */
  var lastHeartbeatRedacted: Long by long("last_heartbeat_redacted")

  /** Allowlisted package → redacted posts (≤ 50 keys, `Redaction.bump`). */
  val redactedByPackage: Map<String, Long>
    get() {
      val s = prefs.getString("redacted_by_package", null) ?: return emptyMap()
      return try {
        val o = JSONObject(s)
        val out = LinkedHashMap<String, Long>()
        val it = o.keys()
        while (it.hasNext()) {
          val k = it.next()
          out[k] = o.optLong(k, 0L)
        }
        out
      } catch (_: Throwable) {
        emptyMap()
      }
    }

  /** One more redacted post from [pkg] (an allowlisted package) at [nowMs]. */
  fun recordRedacted(pkg: String, nowMs: Long) {
    val next = expo.modules.collectionlistener.core.Redaction.bump(redactedByPackage, pkg)
    val o = JSONObject()
    for ((k, v) in next) o.put(k, v)
    val e = prefs.edit()
    e.putLong("redacted_count", redactedCount + 1)
    e.putLong("last_redacted_at", nowMs)
    e.putString("redacted_by_package", o.toString())
    e.commit()
  }

  /** A class name, never a message. */
  var lastErrorCode: String?
    get() = prefs.getString("last_error_code", null)
    set(v) = edit { putString("last_error_code", v?.take(80)) }

  fun recordError(t: Throwable) {
    errorCount = errorCount + 1
    lastErrorCode = t.javaClass.simpleName
  }

  /**
   * Store a server config (configure(), or the worker's refresh after a new `configVersion`):
   * the allowlist re-sanitised (SMS-app denylist, debug shell), keywords, OTP patterns (their compile
   * failures counted), version and age gate.
   */
  fun saveConfig(
    packages: List<String>,
    keywordsAr: List<String>,
    keywordsEn: List<String>,
    otpPatterns: List<String>,
    configVersion: String,
    maxAgeHours: Int?,
    debuggable: Boolean,
  ) {
    val e = prefs.edit()
    e.putString("packages", JSONArray(expo.modules.collectionlistener.core.PackagePolicy.sanitize(packages, debuggable)).toString())
    e.putString("keywords", JSONObject().put("ar", JSONArray(keywordsAr)).put("en", JSONArray(keywordsEn)).toString())
    e.putString("otp_patterns", JSONArray(otpPatterns).toString())
    e.putString("config_version", configVersion)
    e.putInt("max_age_hours", ConfigRules.maxAgeHours(maxAgeHours))
    e.putLong(
      "bad_patterns",
      expo.modules.collectionlistener.core.CandidateFilter(emptyList(), otpPatterns).badPatterns.toLong(),
    )
    e.commit()
  }

  /** Everything — configure() of a new device, and clearCredentials(). `keepAuthFailed` keeps the 401 marker. */
  fun clearAll(keepAuthFailedAt: Long = 0L) {
    prefs.edit().clear().commit()
    if (keepAuthFailedAt > 0L) authFailedAt = keepAuthFailedAt
  }

  private fun edit(block: SharedPreferences.Editor.() -> Unit) {
    val e = prefs.edit()
    e.block()
    e.apply()
  }

  private fun readList(key: String): List<String> {
    val s = prefs.getString(key, null) ?: return emptyList()
    return try {
      val a = JSONArray(s)
      List(a.length()) { a.optString(it) }.filter { it.isNotEmpty() }
    } catch (_: Throwable) {
      emptyList()
    }
  }

  private fun readKeywords(lang: String): List<String> {
    val s = prefs.getString("keywords", null) ?: return emptyList()
    return try {
      val a = JSONObject(s).optJSONArray(lang) ?: return emptyList()
      List(a.length()) { a.optString(it) }.filter { it.isNotEmpty() }
    } catch (_: Throwable) {
      emptyList()
    }
  }

  private fun writeKeywords(ar: List<String>, en: List<String>) {
    val o = JSONObject().put("ar", JSONArray(ar)).put("en", JSONArray(en))
    edit { putString("keywords", o.toString()) }
  }

  private fun long(key: String) = object : kotlin.properties.ReadWriteProperty<Any?, Long> {
    override fun getValue(thisRef: Any?, property: kotlin.reflect.KProperty<*>): Long = prefs.getLong(key, 0L)
    override fun setValue(thisRef: Any?, property: kotlin.reflect.KProperty<*>, value: Long) = edit { putLong(key, value) }
  }
}
