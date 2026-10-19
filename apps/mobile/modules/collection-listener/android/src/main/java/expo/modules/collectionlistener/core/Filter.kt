package expo.modules.collectionlistener.core

import java.util.Locale

/**
 * The on-phone pre-filter (doc 15 spec 11 §4.5.2 rule 7, 06 §4.9): a message is forwarded only when
 * it carries a candidate keyword AND does not look like an OTP. Everything else is dropped in memory —
 * nothing is stored and nothing is uploaded. The constants come from the server
 * (`GET …/ingest/config` `keywords` / `otpPatterns`), so a filter fix ships without an app release.
 *
 * Built once per config: the OTP patterns are compiled here, a pattern that does not compile under
 * `java.util.regex` is skipped and counted in [badPatterns] (never logged with text).
 */
class CandidateFilter(keywords: List<String>, otpPatterns: List<String>) {
  private val keywordsLower: List<String> =
    keywords.map { it.lowercase(Locale.ROOT) }.filter { it.isNotEmpty() }

  private val otp: List<Regex>

  /** How many server patterns failed to compile (State.badPatterns). */
  val badPatterns: Int

  init {
    val ok = ArrayList<Regex>(otpPatterns.size)
    var bad = 0
    for (p in otpPatterns) {
      try {
        ok.add(Regex(p, setOf(RegexOption.IGNORE_CASE)))
      } catch (_: Throwable) {
        bad++
      }
    }
    otp = ok
    badPatterns = bad
  }

  /** Any keyword is a substring of the RAW text, both sides `lowercase(Locale.ROOT)` (06 lists every Arabic spelling raw). */
  fun keywordHit(text: String): Boolean {
    val s = text.lowercase(Locale.ROOT)
    for (k in keywordsLower) if (s.contains(k)) return true
    return false
  }

  fun otpHit(text: String): Boolean {
    for (re in otp) if (re.containsMatchIn(text)) return true
    return false
  }

  /** Title, subtitle and text joined with "\n" (nulls skipped, as 06's `joinParts`), then keyword && !otp. */
  fun isCandidate(title: String?, subtitle: String?, text: String?): Boolean {
    val joined = listOfNotNull(title, subtitle, text).filter { it.isNotEmpty() }.joinToString("\n")
    if (joined.isEmpty()) return false
    return keywordHit(joined) && !otpHit(joined)
  }

  companion object {
    /** `keywords.ar + keywords.en` of the config, in that order. */
    fun of(keywordsAr: List<String>, keywordsEn: List<String>, otpPatterns: List<String>): CandidateFilter =
      CandidateFilter(keywordsAr + keywordsEn, otpPatterns)
  }
}

/**
 * 06 §4.12 `fpNorm`: runs of ASCII white space `[ \t\n\r\f\u000B]` collapse to one space, then one
 * leading and one trailing space go — byte-identical to the domain's JS (U+00A0 and other Unicode
 * spaces are left alone on purpose). `fpNorm(null) = ""`.
 */
object FpNorm {
  private val WS = Regex("[ \\t\\n\\r\\f\\u000B]+")

  fun apply(s: String?): String {
    if (s == null) return ""
    var out = WS.replace(s, " ")
    if (out.startsWith(" ")) out = out.substring(1)
    if (out.endsWith(" ")) out = out.substring(0, out.length - 1)
    return out
  }
}
