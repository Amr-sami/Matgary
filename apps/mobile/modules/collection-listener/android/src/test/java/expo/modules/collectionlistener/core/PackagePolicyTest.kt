package expo.modules.collectionlistener.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Doc 15 spec 11 §7.1 PackagePolicyTest. */
class PackagePolicyTest {
  private val ok = listOf("com.egyptianbanks.instapay", "com.emeint.android.myservices", "eg.com.qnb.eazymobile")

  @Test fun keepsAllowlistedIds() {
    assertEquals(ok, PackagePolicy.sanitize(ok, debuggable = false))
  }

  @Test fun dropsSmsAppsAndOwnPackageEvenWhenServerSendsThem() {
    val sms = listOf(
      "com.google.android.apps.messaging",
      "com.samsung.android.messaging",
      "com.android.mms",
      "com.android.messaging",
      "com.thestoro.app",
    )
    assertEquals(4, PackagePolicy.SMS_APP_DENYLIST.size)
    assertEquals(ok, PackagePolicy.sanitize(sms + ok, debuggable = false))
    assertEquals(ok + "com.android.shell", PackagePolicy.sanitize(sms + ok, debuggable = true))
    for (p in sms) assertTrue(p, PackagePolicy.isDenied(p))
  }

  @Test fun dropsMalformedAndTooLong() {
    val bad = listOf("", " ", "nodots", "1com.x", "com..x", "com.x.", ".com.x", "com.x y", "com.x/y", "com.ä.b", null)
    val long = "com." + "a".repeat(197) // 201 chars
    assertEquals(201, long.length)
    val ok200 = "com." + "a".repeat(196)
    assertEquals(listOf(ok200), PackagePolicy.sanitize(bad + long + ok200, debuggable = false))
  }

  @Test fun trimsAndDedupes() {
    assertEquals(
      listOf("com.egyptianbanks.instapay"),
      PackagePolicy.sanitize(listOf(" com.egyptianbanks.instapay ", "com.egyptianbanks.instapay"), debuggable = false),
    )
  }

  @Test fun capsAtFifty() {
    val many = (1..80).map { "com.bank.app$it" }
    val out = PackagePolicy.sanitize(many, debuggable = false)
    assertEquals(50, out.size)
    assertEquals(many.take(50), out)
    val dbg = PackagePolicy.sanitize(many, debuggable = true)
    assertEquals(50, dbg.size)
    assertTrue(dbg.contains("com.android.shell"))
  }

  @Test fun shellOnlyWhenDebuggable() {
    assertFalse(PackagePolicy.sanitize(listOf("com.android.shell"), debuggable = false).contains("com.android.shell"))
    assertEquals(listOf("com.android.shell"), PackagePolicy.sanitize(emptyList(), debuggable = true))
    assertEquals(listOf("com.android.shell"), PackagePolicy.sanitize(listOf("com.android.shell"), debuggable = true))
  }

  @Test fun emptyIsValid() {
    assertEquals(emptyList<String>(), PackagePolicy.sanitize(emptyList(), debuggable = false))
    assertEquals(emptyList<String>(), PackagePolicy.sanitize(null, debuggable = false))
  }
}
