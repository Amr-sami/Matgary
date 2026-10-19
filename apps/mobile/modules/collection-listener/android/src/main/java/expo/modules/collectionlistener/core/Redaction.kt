package expo.modules.collectionlistener.core

/**
 * Android 15+ sensitive-notification redaction (doc 15 audit t1-m4 finding A6; spec 11 §4.5.2 rule 6a).
 *
 * From Android 15 (API 35) the system notification assistant can classify a notification as sensitive
 * (`Ranking#hasSensitiveContent`, a `@SystemApi` that a normal listener cannot call). For every listener
 * that does not hold `RECEIVE_SENSITIVE_NOTIFICATIONS` (role|signature — never ours) the platform hands
 * over a REDACTED copy: the title becomes the app's label and the text becomes the framework string
 * `com.android.internal.R.string.redacted_notification_message` ("Sensitive notification content
 * hidden"; Arabic "تم إخفاء المحتوى الحساس في الإشعار"), in the phone's system locale. On the emulator
 * every credit text carrying an amount was flagged, so without this check the post simply has no
 * keyword and is dropped silently (rule 7).
 *
 * The signal: API ≥ 35 and the text (`EXTRA_TEXT`, or `EXTRA_BIG_TEXT` if a style survived) equals one
 * of the placeholders. A redacted post is counted per package (never its text) and reported in the
 * heartbeat (`redactedCount`, `redactedByPackage`, `lastRedactedAt`). Pure Kotlin for the JVM tests.
 */
object Redaction {
  /** `Build.VERSION_CODES.VANILLA_ICE_CREAM`: the release that added untrusted-listener redaction. */
  const val MIN_SDK = 35

  /** AOSP `frameworks/base/core/res/res/values/strings.xml` `redacted_notification_message` (API 35). */
  const val PLACEHOLDER_EN = "Sensitive notification content hidden"

  /** The same string in `values-ar` (API 35). */
  const val PLACEHOLDER_AR = "تم إخفاء المحتوى الحساس في الإشعار"

  /** Matches 07's heartbeat cap on package lists. */
  const val MAX_PACKAGES = 50

  /** The fixed placeholders plus whatever the phone's framework resolves (its system locale). */
  fun placeholders(resolved: String?): Set<String> {
    val out = linkedSetOf(PLACEHOLDER_EN, PLACEHOLDER_AR)
    val r = resolved?.trim()
    if (!r.isNullOrEmpty()) out.add(r)
    return out
  }

  /** True when the platform replaced this notification's text with its redaction placeholder. */
  fun isRedacted(sdkInt: Int, e: NotificationText.Extras, placeholders: Set<String>): Boolean {
    if (sdkInt < MIN_SDK || placeholders.isEmpty()) return false
    return hit(e.text, placeholders) || hit(e.bigText, placeholders)
  }

  private fun hit(cs: CharSequence?, placeholders: Set<String>): Boolean {
    val s = cs?.toString()?.trim() ?: return false
    return s.isNotEmpty() && s in placeholders
  }

  /**
   * `counts` with one more for [pkg]. At most [MAX_PACKAGES] keys: a package beyond the cap is folded
   * into the total only (the caller counts the total separately), never evicting a known one.
   */
  fun bump(counts: Map<String, Long>, pkg: String): Map<String, Long> {
    val out = LinkedHashMap(counts)
    val cur = out[pkg]
    if (cur != null) out[pkg] = cur + 1
    else if (out.size < MAX_PACKAGES) out[pkg] = 1L
    return out
  }
}
