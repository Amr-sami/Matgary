package expo.modules.collectionlistener.net

import android.os.Build
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/**
 * HTTP for the listener (doc 15 spec 11 §4.5.6, D11-b): `java.net.HttpURLConnection` + `org.json`,
 * both part of Android — no OkHttp (not on a local module's compile classpath) and no new runtime
 * dependency. Timeouts: connect 15 s, read 20 s. The token goes only into the `Authorization` header;
 * it is never logged.
 *
 * Every call returns a [Response]; `status == null` means an `IOException` / timeout (the policy
 * treats it as RETRY). The error body is read for 07's `error` code only.
 */
class IngestClient(private val ingestUrl: String, private val token: String, private val appVersion: String?) {
  data class Response(val status: Int?, val errorCode: String?, val body: String?)

  private val userAgent: String =
    "TheStoro-Listener/${appVersion ?: "0"} (Android ${Build.VERSION.RELEASE ?: "?"})"

  fun postIngest(json: String): Response = request("POST", ingestUrl, json)

  fun postHeartbeat(json: String): Response = request("POST", "$ingestUrl/heartbeat", json)

  fun getConfig(): Response = request("GET", "$ingestUrl/config", null)

  private fun request(method: String, url: String, json: String?): Response {
    var conn: HttpURLConnection? = null
    try {
      conn = (URL(url).openConnection() as HttpURLConnection).apply {
        requestMethod = method
        connectTimeout = 15_000
        readTimeout = 20_000
        instanceFollowRedirects = false // a redirect would drop the Authorization header anyway
        useCaches = false
        setRequestProperty("Authorization", "Bearer $token")
        setRequestProperty("Accept", "application/json")
        setRequestProperty("User-Agent", userAgent)
        if (json != null) {
          doOutput = true
          setRequestProperty("Content-Type", "application/json; charset=utf-8")
        }
      }
      if (json != null) {
        val bytes = json.toByteArray(Charsets.UTF_8)
        conn.setFixedLengthStreamingMode(bytes.size)
        conn.outputStream.use { it.write(bytes) }
      }
      val status = conn.responseCode
      val stream: InputStream? = if (status in 200..299) conn.inputStream else conn.errorStream
      val body = stream?.use { readCapped(it, 1_048_576) }
      val code = if (status in 200..299) null else errorCodeOf(body)
      return Response(status, code, body)
    } catch (_: IOException) {
      return Response(null, null, null)
    } catch (_: SecurityException) {
      return Response(null, null, null)
    } finally {
      try {
        conn?.disconnect()
      } catch (_: Throwable) {
      }
    }
  }

  private fun readCapped(input: InputStream, cap: Int): String {
    val out = ByteArrayOutputStream()
    val buf = ByteArray(8192)
    var total = 0
    while (true) {
      val n = input.read(buf)
      if (n < 0) break
      total += n
      if (total > cap) break
      out.write(buf, 0, n)
    }
    return String(out.toByteArray(), Charsets.UTF_8)
  }

  companion object {
    /** 07's error envelope `{error: "<CODE>", …}`; anything else → null. */
    fun errorCodeOf(body: String?): String? {
      if (body.isNullOrEmpty()) return null
      return try {
        JSONObject(body).optString("error", "").takeIf { it.isNotEmpty() && it.length <= 64 }
      } catch (_: Throwable) {
        null
      }
    }

    /** The `fp`s in a 200 `{results:[{fp,status,reason?}]}`; a malformed body → empty (every row is bumped). */
    fun resultFps(body: String?): Set<String> {
      if (body.isNullOrEmpty()) return emptySet()
      return try {
        val a = JSONObject(body).optJSONArray("results") ?: return emptySet()
        val out = HashSet<String>()
        for (i in 0 until a.length()) {
          val fp = a.optJSONObject(i)?.optString("fp", "") ?: ""
          if (fp.isNotEmpty()) out.add(fp)
        }
        out
      } catch (_: Throwable) {
        emptySet()
      }
    }

    /** `{configVersion}` of a 200 heartbeat. */
    fun configVersionOf(body: String?): String? {
      if (body.isNullOrEmpty()) return null
      return try {
        JSONObject(body).optString("configVersion", "").takeIf { it.isNotEmpty() }
      } catch (_: Throwable) {
        null
      }
    }
  }
}
