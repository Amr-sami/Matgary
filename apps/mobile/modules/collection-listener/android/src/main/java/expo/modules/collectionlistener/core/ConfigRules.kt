package expo.modules.collectionlistener.core

import java.net.URI

/**
 * `configure()` validation and server-config sanitising (doc 15 spec 11 §4.5.8 step 1, §4.5.6 URL
 * rule). Pure Kotlin (java.net.URI only), so it is JVM-tested; `CollectionListenerModule` and the
 * worker's config refresh both go through it.
 */
object ConfigRules {
  /** 07's token shape: `mgi_` + 32 random bytes base64url (43 characters). */
  val TOKEN_RE = Regex("^mgi_[A-Za-z0-9_-]{43}$")

  const val INGEST_PATH = "/api/v1/collections/ingest"
  const val MAX_KEYWORDS = 200
  const val MAX_PATTERNS = 50
  const val MAX_ITEM_LENGTH = 200
  const val MAX_CONFIG_VERSION = 64
  const val MIN_AGE_HOURS = 1
  const val MAX_AGE_HOURS = 168

  fun isValidToken(token: String?): Boolean = token != null && TOKEN_RE.matches(token)

  /** Local-dev hosts a DEBUGGABLE build may reach over plain http (emulator alias, loopback, RFC 1918). */
  fun isDevHost(host: String): Boolean {
    val h = host.lowercase(java.util.Locale.ROOT)
    if (h == "localhost" || h == "127.0.0.1" || h == "10.0.2.2") return true
    val parts = h.split('.')
    if (parts.size != 4) return false
    val n = parts.map { it.toIntOrNull() ?: return false }
    if (n.any { it !in 0..255 }) return false
    return n[0] == 10 || (n[0] == 172 && n[1] in 16..31) || (n[0] == 192 && n[1] == 168)
  }

  /**
   * `https://` always; `http://` only when the app is debuggable AND the host is a dev host. No user
   * info, query or fragment. With [requireIngestPath], the path must end with `/api/v1/collections/ingest`
   * (heartbeat = url + "/heartbeat", config = url + "/config").
   */
  fun isValidUrl(url: String?, debuggable: Boolean, requireIngestPath: Boolean = true): Boolean {
    if (url == null || url.length > 2048) return false
    val u = try {
      URI(url)
    } catch (_: Throwable) {
      return false
    }
    val host = u.host ?: return false
    if (u.rawUserInfo != null || u.rawQuery != null || u.rawFragment != null) return false
    val scheme = u.scheme?.lowercase(java.util.Locale.ROOT) ?: return false
    val schemeOk = scheme == "https" || (scheme == "http" && debuggable && isDevHost(host))
    if (!schemeOk) return false
    if (requireIngestPath && !(u.rawPath ?: "").trimEnd('/').endsWith(INGEST_PATH)) return false
    return true
  }

  /** The URL without a trailing slash, so `url + "/heartbeat"` never doubles it. */
  fun normalizeUrl(url: String): String = url.trimEnd('/')

  fun listOk(xs: List<String>?, max: Int): Boolean =
    xs != null && xs.size <= max && xs.all { it.length <= MAX_ITEM_LENGTH }

  /** §4.5.8 step 1. Returns null when valid, else the field that failed (never the value). */
  fun validate(
    ingestUrl: String?,
    token: String?,
    packages: List<String>?,
    keywordsAr: List<String>?,
    keywordsEn: List<String>?,
    otpPatterns: List<String>?,
    configVersion: String?,
    debuggable: Boolean,
  ): String? {
    if (!isValidToken(token)) return "token"
    if (!isValidUrl(ingestUrl, debuggable)) return "ingestUrl"
    if (packages == null || packages.size > MAX_KEYWORDS || packages.any { it.length > MAX_ITEM_LENGTH }) return "packages"
    val kw = (keywordsAr ?: return "keywords") + (keywordsEn ?: return "keywords")
    if (!listOk(kw, MAX_KEYWORDS)) return "keywords"
    if (!listOk(otpPatterns, MAX_PATTERNS)) return "otpPatterns"
    if (configVersion == null || configVersion.length > MAX_CONFIG_VERSION) return "configVersion"
    return null
  }

  /** The config's `maxAgeHours`, clamped; absent / garbage → 48. */
  fun maxAgeHours(v: Int?): Int =
    if (v == null || v <= 0) NotificationText.DEFAULT_MAX_AGE_HOURS else v.coerceIn(MIN_AGE_HOURS, MAX_AGE_HOURS)
}
