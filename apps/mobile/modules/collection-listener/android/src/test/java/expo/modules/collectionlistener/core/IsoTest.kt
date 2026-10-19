package expo.modules.collectionlistener.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.Locale

/** Doc 15 spec 11 §7.1 IsoTest. */
class IsoTest {
  @Test fun epoch() {
    assertEquals("1970-01-01T00:00:00.000Z", Iso.format(0L))
    assertEquals("2026-09-27T09:03:11.402Z", Iso.format(1_790_499_791_402L))
  }

  @Test fun arabicDefaultLocaleStillAsciiDigits() {
    val prev = Locale.getDefault()
    try {
      Locale.setDefault(Locale.forLanguageTag("ar-EG"))
      val s = Iso.format(1_790_499_791_402L)
      assertEquals("2026-09-27T09:03:11.402Z", s)
      assertEquals(true, s.all { it.code < 128 })
    } finally {
      Locale.setDefault(prev)
    }
  }

  @Test fun formatOrNull() {
    assertNull(Iso.formatOrNull(null))
    assertNull(Iso.formatOrNull(0L))
    assertEquals("1970-01-01T00:00:00.001Z", Iso.formatOrNull(1L))
  }
}
