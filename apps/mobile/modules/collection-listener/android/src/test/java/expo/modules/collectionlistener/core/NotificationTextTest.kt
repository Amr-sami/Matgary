package expo.modules.collectionlistener.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Doc 15 spec 11 §7.1 NotificationTextTest. */
class NotificationTextTest {
  private val now = 1_790_000_000_000L
  private val h = 3_600_000L
  private val min = 60_000L

  @Test fun groupSummarySkipped() {
    assertEquals(NotificationText.Skip.GROUP_SUMMARY, NotificationText.skipReason(0x200, now, now, 48))
    assertEquals(0x200, NotificationText.FLAG_GROUP_SUMMARY) // android.app.Notification.FLAG_GROUP_SUMMARY
  }

  @Test fun ongoingSkipped() {
    assertEquals(NotificationText.Skip.ONGOING, NotificationText.skipReason(0x2, now, now, 48))
    assertEquals(2, NotificationText.FLAG_ONGOING_EVENT) // android.app.Notification.FLAG_ONGOING_EVENT
    assertNull(NotificationText.skipReason(0x10 /* AUTO_CANCEL */, now, now, 48))
  }

  @Test fun ageGate48h() {
    assertNull(NotificationText.skipReason(0, now - (47 * h + 59 * min), now, 48))
    assertEquals(NotificationText.Skip.TOO_OLD, NotificationText.skipReason(0, now - (48 * h + 1 * min), now, 48))
    // A non-positive config value falls back to 48.
    assertNull(NotificationText.skipReason(0, now - 47 * h, now, 0))
  }

  @Test fun bigTextBeatsTextLinesBeatsText() {
    val all = NotificationText.Extras(title = "T", bigText = "big", textLines = listOf("l1", "l2"), text = "plain")
    assertEquals("big", NotificationText.extract(all)!!.text)
    assertEquals("l1\nl2", NotificationText.extract(all.copy(bigText = null))!!.text)
    assertEquals("plain", NotificationText.extract(all.copy(bigText = null, textLines = null))!!.text)
    assertEquals("plain", NotificationText.extract(all.copy(bigText = "  ", textLines = listOf(" ", null)))!!.text)
  }

  @Test fun nullOrBlankTextSkipped() {
    assertNull(NotificationText.extract(NotificationText.Extras(title = "T")))
    assertNull(NotificationText.extract(NotificationText.Extras(title = "T", text = "   \n")))
  }

  @Test fun blankTitleAndSubtitleBecomeNull() {
    val t = NotificationText.extract(NotificationText.Extras(title = " ", subText = "", text = "x"))!!
    assertNull(t.title)
    assertNull(t.subtitle)
  }

  @Test fun truncates500_500_2000() {
    val t = NotificationText.extract(
      NotificationText.Extras(title = "a".repeat(600), subText = "b".repeat(501), text = "ت".repeat(2500)),
    )!!
    assertEquals(500, t.title!!.length)
    assertEquals(500, t.subtitle!!.length)
    assertEquals(2000, t.text.length)
  }
}
