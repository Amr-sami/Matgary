package expo.modules.collectionlistener.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** configure() validation (doc 15 spec 11 §4.5.8 step 1) and the §4.5.6 URL rule. */
class ConfigRulesTest {
  private val token = "mgi_" + "A".repeat(20) + "_-" + "b9".repeat(10) + "z"
  private val url = "https://thestoro.com/api/v1/collections/ingest"

  private fun v(
    u: String? = url,
    t: String? = token,
    p: List<String>? = listOf("com.egyptianbanks.instapay"),
    ar: List<String>? = listOf("استلام"),
    en: List<String>? = listOf("IPN"),
    otp: List<String>? = listOf("otp"),
    cv: String? = "abc",
    dbg: Boolean = false,
  ) = ConfigRules.validate(u, t, p, ar, en, otp, cv, dbg)

  @Test fun tokenShape() {
    assertEquals(47, token.length)
    assertTrue(ConfigRules.isValidToken(token))
    for (bad in listOf("", "mgi_", token + "x", token.dropLast(1), "mgx_" + token.drop(4), "mgi_" + "A".repeat(42) + "=", null)) {
      assertFalse(bad.toString(), ConfigRules.isValidToken(bad))
    }
  }

  @Test fun validConfig() {
    assertNull(v())
    assertNull(v(u = "$url/"))
  }

  @Test fun urlRule() {
    assertEquals("ingestUrl", v(u = "http://thestoro.com/api/v1/collections/ingest"))
    assertEquals("ingestUrl", v(u = "http://10.0.2.2:3003/api/v1/collections/ingest", dbg = false))
    assertNull(v(u = "http://10.0.2.2:3003/api/v1/collections/ingest", dbg = true))
    assertNull(v(u = "http://192.168.1.20:3003/api/v1/collections/ingest", dbg = true))
    assertNull(v(u = "http://172.20.0.5:3003/api/v1/collections/ingest", dbg = true))
    assertNull(v(u = "http://localhost:3003/api/v1/collections/ingest", dbg = true))
    assertEquals("ingestUrl", v(u = "http://8.8.8.8/api/v1/collections/ingest", dbg = true))
    assertEquals("ingestUrl", v(u = "http://172.32.0.1/api/v1/collections/ingest", dbg = true))
    assertEquals("ingestUrl", v(u = "https://thestoro.com/api/v1/collections"))
    assertEquals("ingestUrl", v(u = "https://u:p@thestoro.com/api/v1/collections/ingest"))
    assertEquals("ingestUrl", v(u = "$url?x=1"))
    assertEquals("ingestUrl", v(u = "$url#a"))
    assertEquals("ingestUrl", v(u = "ftp://thestoro.com/api/v1/collections/ingest"))
    assertEquals("ingestUrl", v(u = null))
  }

  @Test fun bounds() {
    assertEquals("token", v(t = "mgi_short"))
    assertEquals("keywords", v(ar = List(150) { "a" }, en = List(51) { "b" }))
    assertNull(v(ar = List(150) { "a" }, en = List(50) { "b" }))
    assertEquals("keywords", v(en = listOf("x".repeat(201))))
    assertEquals("otpPatterns", v(otp = List(51) { "a" }))
    assertEquals("otpPatterns", v(otp = listOf("x".repeat(201))))
    assertEquals("configVersion", v(cv = "x".repeat(65)))
    assertNull(v(cv = "x".repeat(64)))
    assertEquals("configVersion", v(cv = null))
    assertEquals("keywords", v(ar = null))
  }

  @Test fun maxAge() {
    assertEquals(48, ConfigRules.maxAgeHours(null))
    assertEquals(48, ConfigRules.maxAgeHours(0))
    assertEquals(24, ConfigRules.maxAgeHours(24))
    assertEquals(168, ConfigRules.maxAgeHours(10_000))
  }

  @Test fun normalizeUrl() {
    assertEquals(url, ConfigRules.normalizeUrl("$url/"))
  }
}
