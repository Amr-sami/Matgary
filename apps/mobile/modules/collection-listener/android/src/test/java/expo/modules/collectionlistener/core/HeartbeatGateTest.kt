package expo.modules.collectionlistener.core

import expo.modules.collectionlistener.core.HeartbeatGate.Mode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Audit t1-m4 M4-3: a revoke must be noticed within one periodic run (spec 11 acceptance 8, ≤ 16 min). */
class HeartbeatGateTest {
  private val min = 60_000L

  private fun periodic(since: Long, attempt: Int = 0) = HeartbeatGate.wanted(Mode.PERIODIC, since, attempt, false, false)

  @Test fun modeParsesTheWorkerInput() {
    assertEquals(Mode.FORCED, HeartbeatGate.mode("heartbeat_forced"))
    assertEquals(Mode.DRAIN, HeartbeatGate.mode("drain"))
    assertEquals(Mode.PERIODIC, HeartbeatGate.mode("periodic"))
    assertEquals(Mode.PERIODIC, HeartbeatGate.mode(null)) // the worker's default
  }

  @Test fun periodicFirstAttemptHeartbeatsAfterTheOneMinuteFloor() {
    // The old rule skipped this run (6 min < 10 min), so the revoke waited for the next period.
    assertTrue(periodic(6 * min))
    assertTrue(periodic(60_000L))
    assertFalse(periodic(59_999L))
    assertTrue(periodic(Long.MAX_VALUE / 2)) // never sent
  }

  @Test fun periodicRetriesAndDrainRunsKeepTheTenMinuteGap() {
    assertFalse(periodic(6 * min, attempt = 1))
    assertTrue(periodic(10 * min, attempt = 3))
    assertFalse(HeartbeatGate.wanted(Mode.DRAIN, 9 * min, 0, false, false))
    assertTrue(HeartbeatGate.wanted(Mode.DRAIN, 10 * min, 0, false, false))
  }

  @Test fun forcedRulesAreUnchanged() {
    assertFalse(HeartbeatGate.wanted(Mode.FORCED, 30_000L, 0, false, false))
    assertTrue(HeartbeatGate.wanted(Mode.FORCED, 60_000L, 0, false, false))
    assertTrue(HeartbeatGate.wanted(Mode.FORCED, 1_000L, 0, connectedChanged = true, firstRedaction = false))
    assertTrue(HeartbeatGate.wanted(Mode.FORCED, 1_000L, 0, connectedChanged = false, firstRedaction = true))
  }

  /**
   * Periodic runs every 15 min; one extra heartbeat (forced or from a drain run) at any second of the
   * period; the revoke at any second after it. The revoke is noticed by the first heartbeat at or
   * after it. Worst case must stay ≤ one period + 60 s (≤ 16 min).
   */
  @Test fun revokeIsNoticedWithinOnePeriodWhateverTheExtraHeartbeat() {
    val period = HeartbeatGate.PERIOD_MS
    var worst = 0L
    for (extraSec in 1 until 900 step 7) {
      val extra = extraSec * 1_000L
      for (revokeSec in extraSec until extraSec + 900 step 11) {
        val revoke = revokeSec * 1_000L
        // Sent heartbeats: periodic at 0, the extra one, then periodic runs at k*period, gated.
        var last = extra
        var noticed = if (revoke <= extra) extra else -1L
        var k = 1
        while (noticed < 0) {
          val t = k * period
          if (periodic(t - last)) {
            last = t
            if (t >= revoke) noticed = t
          }
          k++
        }
        worst = maxOf(worst, noticed - revoke)
      }
    }
    assertTrue("worst latency ${worst / 1000} s", worst <= period + HeartbeatGate.MIN_GAP_MS)
  }

  /**
   * The 12/h budget (07 `ingest.heartbeat`): over one hour, periodic first attempts every 15 min plus a
   * drain run or periodic retry every minute (the worst case: a stream of posts or a flapping network).
   */
  @Test fun heartbeatsStayInsideTwelvePerHour() {
    var last = -HeartbeatGate.PERIOD_MS
    var sent = 0
    for (minute in 0 until 60) {
      val t = minute * min
      val isPeriodic = minute % 15 == 0
      val want = if (isPeriodic) periodic(t - last) else HeartbeatGate.wanted(Mode.DRAIN, t - last, 0, false, false)
      if (want) {
        sent++
        last = t
      }
    }
    assertTrue("sent $sent", sent <= 8)
  }
}
