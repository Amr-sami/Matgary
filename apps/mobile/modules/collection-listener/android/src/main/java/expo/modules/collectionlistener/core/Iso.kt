package expo.modules.collectionlistener.core

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Epoch ms → `yyyy-MM-dd'T'HH:mm:ss.SSS'Z'` in UTC (doc 15 spec 11 §4.6). `java.time.Instant` needs
 * API 26 and minSdk is 24. `Locale.US` is mandatory: the app runs in an Arabic locale, where the
 * default formatter writes Arabic-Indic digits that 07's `isoInstant` rejects.
 */
object Iso {
  fun format(epochMs: Long): String {
    // SimpleDateFormat is not thread-safe: one per call (cheap at notification rates).
    val f = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
    f.timeZone = TimeZone.getTimeZone("UTC")
    return f.format(Date(epochMs))
  }

  /** null / non-positive → null (a timestamp that was never set). */
  fun formatOrNull(epochMs: Long?): String? = if (epochMs == null || epochMs <= 0L) null else format(epochMs)
}
