package expo.modules.collectionlistener.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Doc 15 spec 11 §7.1 FilterTest. The two fixtures below are copies of 06's constants
 * (packages/domain/src/collections/filter.ts); `__tests__/manifest-parity.test.ts` fails when they drift.
 */
class FilterTest {
  // BEGIN OTP_PATTERNS fixture (= 06 OTP_PATTERNS, kept in sync by manifest-parity.test.ts)
  private val otpPatterns = listOf(
    "(^|[^a-z])otp([^a-z]|$)",
    "one[ -]?time (pass|code|pin)",
    "verification code",
    "passcode",
    "do not share",
    "don'?t share",
    "[كق]ود (ال)?(تحقق|تفعيل|سري)",
    "رمز (ال)?(تحقق|تفعيل|سري|المرور)",
    "كلم[ةه] (ال)?(مرور|سر)",
    "الرقم السري",
    "لا تشارك",
    "لا تفصح",
    "لمر[ةه] واحد[ةه]",
  )
  // END OTP_PATTERNS fixture

  // BEGIN CANDIDATE_KEYWORDS fixture
  private val keywordsAr = listOf("استلام", "إستلام", "استقبال", "إستقبال", "إضافة", "اضافة", "إيداع", "ايداع", "تحويل لحظي", "تم تحويل")
  private val keywordsEn = listOf("received", "credited", "IPN", "cash-in")
  // END CANDIDATE_KEYWORDS fixture

  private val f = CandidateFilter.of(keywordsAr, keywordsEn, otpPatterns)

  @Test fun keywordHitOnRawArabic() {
    assertTrue(f.keywordHit("تم استلام مبلغ 150.00 جنيه"))
    assertTrue(f.isCandidate(null, null, "تم استلام مبلغ 150.00 جنيه"))
  }

  @Test fun englishIsCaseInsensitive() {
    assertTrue(f.isCandidate("Test", null, "IPN transfer received"))
    assertTrue(f.isCandidate(null, null, "ipn transfer"))
    assertTrue(f.isCandidate("CREDITED", null, "x"))
  }

  @Test fun noHitIsNotACandidate() {
    assertFalse(f.isCandidate("Test", null, "Hello"))
    assertFalse(f.isCandidate(null, null, null))
  }

  @Test fun zynkOtpIsAnOtp() {
    assertTrue(f.otpHit("Your OTP is 482910. Do not share this code."))
    assertFalse(f.isCandidate("Test", null, "IPN received. Your OTP is 482910. Do not share this code."))
    assertTrue(f.otpHit("رمز التحقق الخاص بك 1234"))
    assertTrue(f.otpHit("كود التفعيل 5555"))
    assertFalse(f.otpHit("IPN transfer received"))
    assertFalse(f.otpHit("hotpot HOTPOT")) // "otp" inside a word is not an OTP: (^|[^a-z])otp([^a-z]|$)
  }

  @Test fun everyServerPatternCompilesUnderJavaRegex() {
    assertEquals(0, f.badPatterns)
    for (p in otpPatterns) java.util.regex.Pattern.compile(p, java.util.regex.Pattern.CASE_INSENSITIVE)
  }

  @Test fun invalidPatternIsSkippedAndCounted() {
    val g = CandidateFilter(listOf("IPN"), listOf("(unclosed", "[z-a]", "otp"))
    assertEquals(2, g.badPatterns)
    assertTrue(g.otpHit("your otp 1"))
    assertTrue(g.isCandidate(null, null, "IPN in"))
  }

  @Test fun fpNormCollapsesAsciiWhitespaceOnly() {
    assertEquals("Test message 1", FpNorm.apply("Test  message\n1"))
    assertEquals("a b c d e f", FpNorm.apply(" a\tb\nc\rd\u000Ce\u000Bf "))
    assertEquals("a b", FpNorm.apply("a b"))
    assertEquals(" x", FpNorm.apply(" x")) // U+00A0 is not trimmed either
    assertEquals("", FpNorm.apply(null))
    assertEquals("", FpNorm.apply("   "))
  }
}
