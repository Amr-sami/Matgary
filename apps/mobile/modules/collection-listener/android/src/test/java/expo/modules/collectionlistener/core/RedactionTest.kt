package expo.modules.collectionlistener.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** A6 (doc 15 audit t1-m4): Android 15+ hands untrusted listeners a redacted copy of sensitive posts. */
class RedactionTest {
  private val ph = Redaction.placeholders(null)

  private fun extras(text: String?, big: String? = null) =
    NotificationText.Extras(title = "Vodafone Cash", bigText = big, text = text)

  @Test fun placeholderTextOnApi35IsRedacted() {
    assertTrue(Redaction.isRedacted(35, extras("Sensitive notification content hidden"), ph))
    assertTrue(Redaction.isRedacted(36, extras("تم إخفاء المحتوى الحساس في الإشعار"), ph))
    // Surrounding whitespace does not hide it; a placeholder that survived in bigText counts too.
    assertTrue(Redaction.isRedacted(35, extras("  Sensitive notification content hidden\n"), ph))
    assertTrue(Redaction.isRedacted(35, extras(null, big = "Sensitive notification content hidden"), ph))
  }

  @Test fun beforeApi35NothingIsRedacted() {
    assertFalse(Redaction.isRedacted(34, extras("Sensitive notification content hidden"), ph))
  }

  @Test fun realCreditTextIsNotRedacted() {
    assertFalse(Redaction.isRedacted(35, extras("تم استلام مبلغ 2700.00 جنيه من رقم 01127777705"), ph))
    assertFalse(Redaction.isRedacted(35, extras(null), ph))
    assertFalse(Redaction.isRedacted(35, extras(""), ph))
    // A credit text that merely CONTAINS the phrase is a real text, not the placeholder.
    assertFalse(Redaction.isRedacted(35, extras("IPN 5 received. Sensitive notification content hidden"), ph))
  }

  @Test fun theFrameworkStringOfTheSystemLocaleIsAdded() {
    val fr = "Contenu sensible de la notification masqué"
    val set = Redaction.placeholders("  $fr ")
    assertTrue(Redaction.isRedacted(35, extras(fr), set))
    assertFalse(Redaction.isRedacted(35, extras(fr), ph))
    assertEquals(ph, Redaction.placeholders("   "))
  }

  @Test fun bumpCountsPerPackageAndCapsKeys() {
    var m: Map<String, Long> = emptyMap()
    m = Redaction.bump(m, "com.egyptianbanks.instapay")
    m = Redaction.bump(m, "com.egyptianbanks.instapay")
    m = Redaction.bump(m, "com.android.shell")
    assertEquals(mapOf("com.egyptianbanks.instapay" to 2L, "com.android.shell" to 1L), m)
    var full: Map<String, Long> = (1..Redaction.MAX_PACKAGES).associate { "com.p$it.app" to 1L }
    full = Redaction.bump(full, "com.new.app")
    assertEquals(Redaction.MAX_PACKAGES, full.size)
    assertFalse("com.new.app" in full)
    full = Redaction.bump(full, "com.p1.app")
    assertEquals(2L, full["com.p1.app"])
  }
}
