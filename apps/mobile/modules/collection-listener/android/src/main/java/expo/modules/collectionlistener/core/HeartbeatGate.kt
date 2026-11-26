package expo.modules.collectionlistener.core

/**
 * When a worker run sends a heartbeat (doc 15 spec 11 §4.5.6 step 4). Pure Kotlin for the JVM tests.
 *
 * Acceptance 8 wants a server-side revoke noticed "within one periodic run (≤ 16 min)". A revoke is
 * noticed by the next request that gets a 401: a drain (only when something is queued) or a heartbeat.
 * The old rule sent a periodic heartbeat only when the last one was ≥ 10 min old, so any heartbeat
 * between two periodic runs (a forced one after a reconnect, an A6 change, a drain-run heartbeat) made
 * the next periodic run skip, and the revoke waited for the run after it: up to about 25 min (audit
 * t1-m4 M4-3).
 *
 * Now the FIRST attempt of every periodic run heartbeats unless one went out in the last 60 s (the same
 * floor as a forced heartbeat). A run inside that 60-s window is covered by the heartbeat that just
 * went out, or the revoke happened after it and the next periodic run (≤ 15 min later) sends one, so
 * the worst case is one period plus 60 s. Retries of a periodic run (WorkManager backoff after a
 * network / 5xx / 429 outcome) and drain runs keep the 10-minute gap.
 *
 * Budget (07's `ingest.heartbeat` bucket, 12/h per device): periodic first attempts are ≥ 15 min apart
 * (≤ 4/h), and every other non-forced heartbeat needs 10 min since the last one, so at most one fits
 * between two periodic ones (≤ 4/h). Forced heartbeats stay rare (configure, reconnect, a change of
 * `listenerConnected`, the first A6 redaction). A heartbeat 429 is skipped, never retried.
 */
object HeartbeatGate {
  enum class Mode { FORCED, PERIODIC, DRAIN }

  /** Floor between two heartbeats for a forced one and for a periodic run's first attempt. */
  const val MIN_GAP_MS = 60_000L

  /** Gap for drain runs and periodic retries. */
  const val RETRY_GAP_MS = 10 * 60_000L

  /** The longest a revoke can wait for a heartbeat while periodic runs keep their 15-minute period. */
  const val PERIOD_MS = 15 * 60_000L

  fun mode(raw: String?): Mode = when (raw) {
    "heartbeat_forced" -> Mode.FORCED
    "drain" -> Mode.DRAIN
    else -> Mode.PERIODIC
  }

  /**
   * @param sinceLastMs ms since the last 200 heartbeat (`now − last_heartbeat_at`; huge when never sent).
   * @param runAttempt WorkManager's `runAttemptCount` (0 = first attempt; reset for each period).
   * @param connectedChanged `listenerConnected` differs from the last value the server heard.
   * @param firstRedaction the first A6 redaction since the server last heard 0.
   */
  fun wanted(
    mode: Mode,
    sinceLastMs: Long,
    runAttempt: Int,
    connectedChanged: Boolean,
    firstRedaction: Boolean,
  ): Boolean = when (mode) {
    Mode.FORCED -> sinceLastMs >= MIN_GAP_MS || connectedChanged || firstRedaction
    Mode.PERIODIC -> sinceLastMs >= (if (runAttempt == 0) MIN_GAP_MS else RETRY_GAP_MS)
    Mode.DRAIN -> sinceLastMs >= RETRY_GAP_MS
  }
}
