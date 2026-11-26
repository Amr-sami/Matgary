package expo.modules.collectionlistener.core

import expo.modules.collectionlistener.core.ResponsePolicy.HeartbeatAction
import expo.modules.collectionlistener.core.ResponsePolicy.IngestAction
import org.junit.Assert.assertEquals
import org.junit.Test

/** Doc 15 spec 11 §7.1 ResponsePolicyTest: every row of the §4.5.6 table. */
class ResponsePolicyTest {
  @Test fun ok200() {
    assertEquals(IngestAction.APPLY, ResponsePolicy.forIngest(200, null, 3))
    assertEquals(HeartbeatAction.OK, ResponsePolicy.forHeartbeat(200, null))
  }

  @Test fun partialResults() {
    val out = ResponsePolicy.applyResults(listOf("a" to 0, "b" to 0, "c" to 3, "d" to 4), setOf("a", "x"))
    assertEquals(listOf("a"), out.delete)
    assertEquals(listOf("b", "c"), out.bump) // missing → attempts++
    assertEquals(listOf("d"), out.dropAfterAttempts) // 5th attempt → deleted
    assertEquals(5, ResponsePolicy.MAX_ATTEMPTS)
  }

  @Test fun clearOn401BothCodes() {
    for (c in listOf("INGEST_TOKEN_INVALID", "INGEST_DEVICE_REVOKED")) {
      assertEquals(IngestAction.CLEAR, ResponsePolicy.forIngest(401, c, 1))
      assertEquals(HeartbeatAction.CLEAR, ResponsePolicy.forHeartbeat(401, c))
    }
  }

  @Test fun pauseOn403BothCodes() {
    for (c in listOf("INGEST_DISABLED", "TENANT_SUSPENDED")) {
      assertEquals(IngestAction.PAUSE, ResponsePolicy.forIngest(403, c, 2))
      assertEquals(HeartbeatAction.PAUSE, ResponsePolicy.forHeartbeat(403, c))
    }
  }

  @Test fun tooLarge413() {
    assertEquals(IngestAction.SPLIT, ResponsePolicy.forIngest(413, "INGEST_PAYLOAD_TOO_LARGE", 7))
    assertEquals(IngestAction.DROP, ResponsePolicy.forIngest(413, "INGEST_PAYLOAD_TOO_LARGE", 1))
  }

  @Test fun badRequest400() {
    assertEquals(IngestAction.DROP, ResponsePolicy.forIngest(400, "INVALID_REQUEST", 5))
  }

  @Test fun retryOn429And5xxAndIo() {
    assertEquals(IngestAction.RETRY, ResponsePolicy.forIngest(429, "RATE_LIMITED", 1))
    assertEquals(IngestAction.RETRY, ResponsePolicy.forIngest(500, null, 1))
    assertEquals(IngestAction.RETRY, ResponsePolicy.forIngest(503, null, 1))
    assertEquals(IngestAction.RETRY, ResponsePolicy.forIngest(null, null, 1)) // IOException / timeout
    assertEquals(HeartbeatAction.RETRY, ResponsePolicy.forHeartbeat(500, null))
    assertEquals(HeartbeatAction.RETRY, ResponsePolicy.forHeartbeat(null, null))
  }

  @Test fun heartbeat429IsSkippedNotRetried() {
    assertEquals(HeartbeatAction.SKIP, ResponsePolicy.forHeartbeat(429, "RATE_LIMITED"))
  }

  @Test fun deviationsOutsideTheTable() {
    assertEquals(IngestAction.RETRY, ResponsePolicy.forIngest(404, null, 1)) // never a data-loss drop
    assertEquals(IngestAction.DROP, ResponsePolicy.forIngest(422, null, 1))
    assertEquals(HeartbeatAction.SKIP, ResponsePolicy.forHeartbeat(400, "INVALID_REQUEST"))
  }
}
