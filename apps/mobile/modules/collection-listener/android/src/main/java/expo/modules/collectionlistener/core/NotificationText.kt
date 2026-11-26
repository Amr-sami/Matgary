package expo.modules.collectionlistener.core

/**
 * Skip rules 4–6 and text extraction (doc 15 spec 11 §4.5.2). Pure Kotlin: the service copies what
 * it needs out of `StatusBarNotification` into these plain types, and only AFTER the package check
 * (rule 2) — notifications of other apps are never read, stored, counted or logged.
 */
object NotificationText {
  /** `android.app.Notification.FLAG_ONGOING_EVENT` (API 1). Copied so this file stays Android-free. */
  const val FLAG_ONGOING_EVENT = 0x00000002

  /** `android.app.Notification.FLAG_GROUP_SUMMARY` (API 20). */
  const val FLAG_GROUP_SUMMARY = 0x00000200

  /** 03 §B.17 / 07 truncation. */
  const val MAX_TITLE = 500
  const val MAX_SUBTITLE = 500
  const val MAX_TEXT = 2000

  /** 03 §C.9 age gate; the config's `maxAgeHours` overrides it. */
  const val DEFAULT_MAX_AGE_HOURS = 48

  enum class Skip { GROUP_SUMMARY, ONGOING, TOO_OLD }

  /**
   * Rules 4–5, from the flags and post time only (no extras touched). A group summary repeats its
   * children; an ongoing notification is skipped here too because API < 31 ignores the manifest's
   * `disabled_filter_types`. `now − postTime > maxAgeHours` → too old (47:59 kept, 48:01 skipped).
   */
  fun skipReason(flags: Int, postTimeMs: Long, nowMs: Long, maxAgeHours: Int): Skip? {
    if ((flags and FLAG_GROUP_SUMMARY) != 0) return Skip.GROUP_SUMMARY
    if ((flags and FLAG_ONGOING_EVENT) != 0) return Skip.ONGOING
    val hours = if (maxAgeHours > 0) maxAgeHours else DEFAULT_MAX_AGE_HOURS
    if (nowMs - postTimeMs > hours * 3_600_000L) return Skip.TOO_OLD
    return null
  }

  /** The `extras` values the service read (each a `CharSequence?` as Android hands them over). */
  data class Extras(
    val title: CharSequence? = null,
    val subText: CharSequence? = null,
    val bigText: CharSequence? = null,
    val textLines: List<CharSequence?>? = null,
    val text: CharSequence? = null,
  )

  data class Text(val title: String?, val subtitle: String?, val text: String)

  private fun clean(cs: CharSequence?, max: Int): String? {
    val s = cs?.toString() ?: return null
    if (s.isBlank()) return null
    return if (s.length <= max) s else s.substring(0, max)
  }

  /**
   * Rule 6: `title = EXTRA_TITLE`, `subtitle = EXTRA_SUB_TEXT`,
   * `text = EXTRA_BIG_TEXT ?: EXTRA_TEXT_LINES.joinToString("\n") ?: EXTRA_TEXT`, blank → null;
   * truncated 500 / 500 / 2000. A null text → null (the notification is skipped).
   */
  fun extract(e: Extras): Text? {
    val big = clean(e.bigText, Int.MAX_VALUE)
    val lines = e.textLines
      ?.mapNotNull { it?.toString() }
      ?.filter { it.isNotBlank() }
      ?.takeIf { it.isNotEmpty() }
      ?.joinToString("\n")
    val raw = big ?: clean(lines, Int.MAX_VALUE) ?: clean(e.text, Int.MAX_VALUE) ?: return null
    val text = if (raw.length <= MAX_TEXT) raw else raw.substring(0, MAX_TEXT)
    return Text(clean(e.title, MAX_TITLE), clean(e.subText, MAX_SUBTITLE), text)
  }
}
