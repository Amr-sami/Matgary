package expo.modules.collectionlistener.core

/**
 * HTTP answer → action (doc 15 spec 11 §4.5.6 table; it implements 07 §4.5 "Device refusal
 * semantics"). Pure: the worker passes the status (null = `IOException` / timeout), 07's `error`
 * code from the body, and the batch size.
 *
 * | Server answer                                   | Ingest action            | Heartbeat action |
 * |-------------------------------------------------|--------------------------|------------------|
 * | 200 `{results:[{fp,status}]}`                   | [IngestAction.APPLY]     | OK               |
 * | 401 `INGEST_TOKEN_INVALID` / `INGEST_DEVICE_REVOKED` | CLEAR (token, queue, seen, works) | CLEAR |
 * | 403 `INGEST_DISABLED` / `TENANT_SUSPENDED`      | PAUSE (keep the queue)   | PAUSE            |
 * | 413 `INGEST_PAYLOAD_TOO_LARGE`                  | SPLIT (> 1 row) / DROP (1 row) | SKIP       |
 * | 400                                             | DROP (never retried)     | SKIP             |
 * | 429 `RATE_LIMITED`                              | RETRY (WorkManager backoff) | SKIP (not retried) |
 * | 5xx, IOException, timeout                       | RETRY                    | RETRY            |
 *
 * Not in 11's table, decided here (deviation, the cautious side): a 404 (an older server without the
 * route, or a deploy in progress) is RETRY, never a data-loss DROP; any other 4xx is DROP.
 */
object ResponsePolicy {
  enum class IngestAction { APPLY, CLEAR, PAUSE, SPLIT, DROP, RETRY }
  enum class HeartbeatAction { OK, CLEAR, PAUSE, SKIP, RETRY }

  /** A sent row missing from `results` is retried at most this many times, then deleted. */
  const val MAX_ATTEMPTS = 5

  /** `errorCode` (07's `error`) does not change the action today: every 401 clears, every 403 pauses. */
  @Suppress("UNUSED_PARAMETER")
  fun forIngest(status: Int?, errorCode: String?, batchSize: Int): IngestAction {
    if (status == null) return IngestAction.RETRY
    return when {
      status in 200..299 -> IngestAction.APPLY
      status == 401 -> IngestAction.CLEAR
      status == 403 -> IngestAction.PAUSE
      status == 413 -> if (batchSize > 1) IngestAction.SPLIT else IngestAction.DROP
      status == 400 -> IngestAction.DROP
      status == 429 -> IngestAction.RETRY
      status == 404 || status == 408 -> IngestAction.RETRY
      status >= 500 -> IngestAction.RETRY
      else -> IngestAction.DROP
    }
  }

  @Suppress("UNUSED_PARAMETER")
  fun forHeartbeat(status: Int?, errorCode: String?): HeartbeatAction {
    if (status == null) return HeartbeatAction.RETRY
    return when {
      status in 200..299 -> HeartbeatAction.OK
      status == 401 -> HeartbeatAction.CLEAR
      status == 403 -> HeartbeatAction.PAUSE
      status == 429 -> HeartbeatAction.SKIP
      status >= 500 || status == 404 || status == 408 -> HeartbeatAction.RETRY
      else -> HeartbeatAction.SKIP
    }
  }

  /** What a 200 means for each sent row. */
  data class Outcome(val delete: List<String>, val bump: List<String>, val dropAfterAttempts: List<String>)

  /**
   * 200 partial results: every sent fp that appears in `results` is final (`accepted`, `duplicate`,
   * `dropped` alike) → delete. A sent fp missing from `results` gets `attempts++`; at [MAX_ATTEMPTS]
   * it is deleted instead (`State.droppedAttempts++`).
   */
  fun applyResults(sent: List<Pair<String, Int>>, resultFps: Set<String>): Outcome {
    val delete = ArrayList<String>()
    val bump = ArrayList<String>()
    val drop = ArrayList<String>()
    for ((fp, attempts) in sent) {
      when {
        fp in resultFps -> delete.add(fp)
        attempts + 1 >= MAX_ATTEMPTS -> drop.add(fp)
        else -> bump.add(fp)
      }
    }
    return Outcome(delete, bump, drop)
  }
}
