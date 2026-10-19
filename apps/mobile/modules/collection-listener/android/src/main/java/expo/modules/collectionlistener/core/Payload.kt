package expo.modules.collectionlistener.core

/**
 * The wire payloads of 03 §B.17 (doc 15 spec 11 §4.6), written by hand so the bytes are exact and the
 * JVM tests need no Android `org.json`:
 *
 * ```
 * POST {ingestUrl}            {"v":1,"messages":[{"fp","channel":"android_notification","sourceApp","title"?,"subtitle"?,"body","receivedAt"}]}
 * POST {ingestUrl}/heartbeat  {"v":1,"platform":"android_listener","appVersion","osVersion","listenerConnected",
 *                              "lastNotificationAt","lastUploadAt","queued","packagesInstalled",
 *                              "redactedCount","redactedByPackage","lastRedactedAt"}
 * ```
 *
 * The last three are A6 (Android 15+ sensitive-content redaction, spec 11 ARCH CHANGE REQUEST 7): how many
 * allowlisted posts the platform handed over redacted since configure(), per package, and when the last one was.
 *
 * `sender` and `test` are never sent (the server sets `sender_kind = 'app'` for `*_notification`;
 * 09's Android verify uses the heartbeat). Null `title` / `subtitle` are omitted.
 */
object Payload {
  const val CHANNEL = "android_notification"
  const val PLATFORM = "android_listener"

  /** 03 §B.17: ≤ 50 messages per POST. */
  const val MAX_MESSAGES = 50

  /** The server rejects bodies over 262,144 bytes (07 §4.5); the client stays well under. */
  const val MAX_BYTES = 200_000

  private const val ENVELOPE_HEAD = "{\"v\":1,\"messages\":["
  private const val ENVELOPE_TAIL = "]}"

  /** One queued message (what the queue encrypts at rest). */
  data class Message(
    val fp: String,
    val sourceApp: String,
    val title: String?,
    val subtitle: String?,
    val body: String,
    val receivedAtMs: Long,
  )

  /** JSON string literal: `"` `\` and C0 controls escaped, U+2028/U+2029 as ` `/` `, the rest (Arabic) raw. */
  fun quote(s: String): String {
    val sb = StringBuilder(s.length + 2)
    sb.append('"')
    for (c in s) {
      when (c) {
        '"' -> sb.append("\\\"")
        '\\' -> sb.append("\\\\")
        '\n' -> sb.append("\\n")
        '\r' -> sb.append("\\r")
        '\t' -> sb.append("\\t")
        '\b' -> sb.append("\\b")
        '\u000C' -> sb.append("\\f")
        ' ' -> sb.append("\\u2028")
        ' ' -> sb.append("\\u2029")
        else -> if (c < ' ') sb.append(String.format(java.util.Locale.US, "\\u%04x", c.code)) else sb.append(c)
      }
    }
    sb.append('"')
    return sb.toString()
  }

  fun messageJson(m: Message): String {
    val sb = StringBuilder(m.body.length + 256)
    sb.append("{\"fp\":").append(quote(m.fp))
    sb.append(",\"channel\":").append(quote(CHANNEL))
    sb.append(",\"sourceApp\":").append(quote(m.sourceApp))
    if (m.title != null) sb.append(",\"title\":").append(quote(m.title))
    if (m.subtitle != null) sb.append(",\"subtitle\":").append(quote(m.subtitle))
    sb.append(",\"body\":").append(quote(m.body))
    sb.append(",\"receivedAt\":").append(quote(Iso.format(m.receivedAtMs)))
    sb.append('}')
    return sb.toString()
  }

  fun utf8Size(s: String): Int = s.toByteArray(Charsets.UTF_8).size

  /** `{"v":1,"messages":[a,b,…]}` around already-serialised message objects. */
  fun ingestBody(messageJsons: List<String>): String =
    messageJsons.joinToString(separator = ",", prefix = ENVELOPE_HEAD, postfix = ENVELOPE_TAIL)

  /**
   * Byte-bounded batching (§4.5.6 step 3): consecutive groups of indexes, each ≤ [maxMessages] messages
   * and ≤ [maxBytes] UTF-8 bytes for the whole body — whichever comes first. A single message larger
   * than the bound still forms its own batch (the server answers 413 and §4.5.6 drops it).
   */
  fun batch(messageJsons: List<String>, maxMessages: Int = MAX_MESSAGES, maxBytes: Int = MAX_BYTES): List<List<Int>> {
    val out = ArrayList<List<Int>>()
    var cur = ArrayList<Int>()
    val envelope = utf8Size(ENVELOPE_HEAD) + utf8Size(ENVELOPE_TAIL)
    var bytes = envelope
    for ((i, m) in messageJsons.withIndex()) {
      val size = utf8Size(m) + if (cur.isEmpty()) 0 else 1 // the comma
      if (cur.isNotEmpty() && (cur.size >= maxMessages || bytes + size > maxBytes)) {
        out.add(cur)
        cur = ArrayList()
        bytes = envelope
      }
      bytes += utf8Size(m) + if (cur.isEmpty()) 0 else 1
      cur.add(i)
    }
    if (cur.isNotEmpty()) out.add(cur)
    return out
  }

  data class Heartbeat(
    val appVersion: String?,
    val osVersion: String?,
    val listenerConnected: Boolean,
    val lastNotificationAtMs: Long?,
    val lastUploadAtMs: Long?,
    val queued: Int,
    val packagesInstalled: List<String>,
    val redactedCount: Long = 0L,
    val redactedByPackage: Map<String, Long> = emptyMap(),
    val lastRedactedAtMs: Long? = null,
  )

  /**
   * The 03 §B.17 keys in that order, then the A6 keys (ARCH CHANGE REQUEST 7); null versions /
   * timestamps are sent as JSON null. `redactedByPackage` holds ≤ 50 allowlisted package ids → counts.
   */
  fun heartbeatBody(h: Heartbeat): String {
    val sb = StringBuilder(256)
    sb.append("{\"v\":1")
    sb.append(",\"platform\":").append(quote(PLATFORM))
    sb.append(",\"appVersion\":").append(h.appVersion?.let { quote(it.take(40)) } ?: "null")
    sb.append(",\"osVersion\":").append(h.osVersion?.let { quote(it.take(40)) } ?: "null")
    sb.append(",\"listenerConnected\":").append(if (h.listenerConnected) "true" else "false")
    sb.append(",\"lastNotificationAt\":").append(Iso.formatOrNull(h.lastNotificationAtMs)?.let { quote(it) } ?: "null")
    sb.append(",\"lastUploadAt\":").append(Iso.formatOrNull(h.lastUploadAtMs)?.let { quote(it) } ?: "null")
    sb.append(",\"queued\":").append(h.queued.coerceIn(0, 100_000).toString())
    sb.append(",\"packagesInstalled\":")
    sb.append(h.packagesInstalled.take(50).joinToString(separator = ",", prefix = "[", postfix = "]") { quote(it) })
    sb.append(",\"redactedCount\":").append(h.redactedCount.coerceIn(0L, 1_000_000_000L).toString())
    sb.append(",\"redactedByPackage\":")
    sb.append(
      h.redactedByPackage.entries.take(Redaction.MAX_PACKAGES).joinToString(separator = ",", prefix = "{", postfix = "}") {
        quote(it.key.take(200)) + ":" + it.value.coerceIn(0L, 1_000_000_000L).toString()
      },
    )
    sb.append(",\"lastRedactedAt\":").append(Iso.formatOrNull(h.lastRedactedAtMs)?.let { quote(it) } ?: "null")
    sb.append('}')
    return sb.toString()
  }
}
