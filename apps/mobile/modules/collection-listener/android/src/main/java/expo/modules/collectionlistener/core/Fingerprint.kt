package expo.modules.collectionlistener.core

import java.security.MessageDigest

/**
 * The `android_notification` device fingerprint (doc 15 spec 11 §4.5.3 = 06 §4.12):
 * `sha256Hex(UTF-8(pkg + "|" + fpNorm(title) + "|" + fpNorm(text)))`, lower-case hex, 64 chars.
 * `postTime` is excluded (an update in place changes it) and so is `subtitle` (06's pre-image).
 * Fits 03 §B.2.6 `^[A-Za-z0-9_-]{16,64}$`.
 */
object Fingerprint {
  fun preimage(pkg: String, title: String?, text: String?): String =
    pkg + "|" + FpNorm.apply(title) + "|" + FpNorm.apply(text)

  fun of(pkg: String, title: String?, text: String?): String = sha256Hex(preimage(pkg, title, text))

  fun sha256Hex(s: String): String {
    val d = MessageDigest.getInstance("SHA-256").digest(s.toByteArray(Charsets.UTF_8))
    val hex = "0123456789abcdef"
    val sb = StringBuilder(d.size * 2)
    for (b in d) {
      val v = b.toInt() and 0xff
      sb.append(hex[v ushr 4]).append(hex[v and 0x0f])
    }
    return sb.toString()
  }
}
