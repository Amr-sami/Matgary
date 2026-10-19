package expo.modules.collectionlistener.core

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Doc 15 spec 11 §7.1 PayloadTest (03 §B.17 wire shapes). */
class PayloadTest {
  private val at = 1_790_499_791_402L // 2026-09-27T09:03:11.402Z
  private val fp = "d2a12863b43d6398fa279b01ea4e7a2f89e2fe778afb0fa21bb5497cc159cf5d"

  /**
   * GOLDEN: the exact bytes the phone sends for the §5 step 9 shell post. The same string is POSTed to
   * the :3003 ingest route in the order-29 proof (scratchpad/e2e-29.mts), so "Kotlin writes it" (this
   * test) + "the server accepts it" (that run) together prove the wire format.
   */
  private val golden =
    "{\"fp\":\"$fp\",\"channel\":\"android_notification\",\"sourceApp\":\"com.android.shell\",\"title\":\"Test\"," +
      "\"body\":\"IPN transfer received\",\"receivedAt\":\"2026-09-27T09:03:11.402Z\"}"

  @Test fun goldenMessage() {
    val m = Payload.Message(fp, "com.android.shell", "Test", null, "IPN transfer received", at)
    assertEquals(golden, Payload.messageJson(m))
    assertEquals("{\"v\":1,\"messages\":[$golden]}", Payload.ingestBody(listOf(golden)))
  }

  @Test fun escaping() {
    val body = "q\"b\\s\nr\rt\tu v w\u0001 تم استلام"
    val json = Payload.messageJson(Payload.Message(fp, "com.egyptianbanks.instapay", null, null, body, at))
    assertTrue(json.contains("q\\\"b\\\\s\\nr\\rt\\tu\\u2028v\\u2029w\\u0001 تم استلام"))
    assertEquals(body, JSONObject(json).getString("body")) // round trip
  }

  @Test fun omitsNullTitleSubtitleAndNeverSendsSenderOrTest() {
    val o = JSONObject(Payload.messageJson(Payload.Message(fp, "com.etisalat.flous", null, null, "x", at)))
    assertFalse(o.has("title"))
    assertFalse(o.has("subtitle"))
    assertFalse(o.has("sender"))
    assertFalse(o.has("test"))
    assertEquals("android_notification", o.getString("channel"))
    assertEquals("com.etisalat.flous", o.getString("sourceApp"))
    val withSub = JSONObject(Payload.messageJson(Payload.Message(fp, "a.b", "t", "s", "x", at)))
    assertEquals("s", withSub.getString("subtitle"))
  }

  @Test fun envelopeVersion() {
    val o = JSONObject(Payload.ingestBody(listOf(golden, golden)))
    assertEquals(1, o.getInt("v"))
    assertEquals(2, o.getJSONArray("messages").length())
  }

  @Test fun batchStopsAt50Messages() {
    val small = List(120) { golden }
    val b = Payload.batch(small)
    assertEquals(listOf(50, 50, 20), b.map { it.size })
    assertEquals((0 until 120).toList(), b.flatten())
  }

  @Test fun batchStopsAt200000Bytes() {
    // 50 Arabic bodies of 2,000 chars (2 bytes each in UTF-8) + titles → two batches.
    val msgs = List(50) {
      Payload.messageJson(Payload.Message(fp, "com.emeint.android.myservices", "ف".repeat(500), null, "ت".repeat(2000), at))
    }
    val b = Payload.batch(msgs)
    assertEquals(2, b.size)
    for (idx in b) {
      val body = Payload.ingestBody(idx.map { msgs[it] })
      assertTrue(Payload.utf8Size(body) <= Payload.MAX_BYTES)
    }
    assertEquals(50, b.sumOf { it.size })
  }

  @Test fun oversizedSingleMessageIsItsOwnBatch() {
    val big = "x".repeat(250_000)
    assertEquals(listOf(listOf(0), listOf(1)), Payload.batch(listOf(big, golden)))
  }

  @Test fun heartbeatHasExactly03Keys() {
    val body = Payload.heartbeatBody(
      Payload.Heartbeat("1.1.0", "15", true, at, null, 0, listOf("com.egyptianbanks.instapay")),
    )
    val o = JSONObject(body)
    assertEquals(
      setOf(
        "v", "platform", "appVersion", "osVersion", "listenerConnected", "lastNotificationAt", "lastUploadAt", "queued", "packagesInstalled",
        "redactedCount", "redactedByPackage", "lastRedactedAt",
      ),
      o.keys().asSequence().toSet(),
    )
    assertEquals(1, o.getInt("v"))
    assertEquals("android_listener", o.getString("platform"))
    assertEquals("2026-09-27T09:03:11.402Z", o.getString("lastNotificationAt"))
    assertTrue(o.isNull("lastUploadAt"))
    assertEquals(true, o.getBoolean("listenerConnected"))
    assertEquals(0, o.getInt("queued"))
    assertEquals("com.egyptianbanks.instapay", o.getJSONArray("packagesInstalled").getString(0))
    assertEquals(
      "{\"v\":1,\"platform\":\"android_listener\",\"appVersion\":\"1.1.0\",\"osVersion\":\"15\",\"listenerConnected\":true," +
        "\"lastNotificationAt\":\"2026-09-27T09:03:11.402Z\",\"lastUploadAt\":null,\"queued\":0,\"packagesInstalled\":[\"com.egyptianbanks.instapay\"]," +
        "\"redactedCount\":0,\"redactedByPackage\":{},\"lastRedactedAt\":null}",
      body,
    )
  }

  /** A6 (ARCH CHANGE REQUEST 7): redacted posts per allowlisted package, the total and the last time. */
  @Test fun heartbeatCarriesRedactionCounts() {
    val body = Payload.heartbeatBody(
      Payload.Heartbeat(
        "1.1.0", "15", true, at, null, 0, emptyList(),
        redactedCount = 3,
        redactedByPackage = linkedMapOf("com.android.shell" to 2L, "com.egyptianbanks.instapay" to 1L),
        lastRedactedAtMs = at,
      ),
    )
    val o = JSONObject(body)
    assertEquals(3, o.getInt("redactedCount"))
    assertEquals(2, o.getJSONObject("redactedByPackage").getInt("com.android.shell"))
    assertEquals(1, o.getJSONObject("redactedByPackage").getInt("com.egyptianbanks.instapay"))
    assertEquals("2026-09-27T09:03:11.402Z", o.getString("lastRedactedAt"))
    assertTrue(
      body.endsWith(
        ",\"redactedCount\":3,\"redactedByPackage\":{\"com.android.shell\":2,\"com.egyptianbanks.instapay\":1}," +
          "\"lastRedactedAt\":\"2026-09-27T09:03:11.402Z\"}",
      ),
    )
  }
}
