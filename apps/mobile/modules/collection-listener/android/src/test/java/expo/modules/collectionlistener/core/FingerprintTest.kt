package expo.modules.collectionlistener.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Doc 15 spec 11 §7.1 FingerprintTest: 06 §4.12's two vectors, byte-identical. */
class FingerprintTest {
  private val pkg = "com.egyptianbanks.instapay"

  @Test fun vector1() {
    assertEquals("com.egyptianbanks.instapay|InstaPay|Test message 1", Fingerprint.preimage(pkg, "InstaPay", "Test  message\n1"))
    assertEquals(
      "d2a12863b43d6398fa279b01ea4e7a2f89e2fe778afb0fa21bb5497cc159cf5d",
      Fingerprint.of(pkg, "InstaPay", "Test  message\n1"),
    )
  }

  @Test fun vector2NullNull() {
    assertEquals("com.egyptianbanks.instapay||", Fingerprint.preimage(pkg, null, null))
    assertEquals("4bacbdd023de576c342a52d362ff064f14787400adc05dbdf987bf3c0ffb3024", Fingerprint.of(pkg, null, null))
  }

  @Test fun shapeFits03B26() {
    val fp = Fingerprint.of(pkg, "عنوان", "تم استلام مبلغ")
    assertEquals(64, fp.length)
    assertTrue(Regex("^[0-9a-f]{64}$").matches(fp))
    assertTrue(Regex("^[A-Za-z0-9_-]{16,64}$").matches(fp))
  }
}
