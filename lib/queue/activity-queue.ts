// Activity-log queue. Decouples `logActivity` writes from the request
// hot path so an audit row insert never sits on the user-visible latency
// budget.
//
// Status: opt-in. Set `ACTIVITY_LOG_QUEUE=1` in the env to flip every
// `logActivity` call from synchronous insert to enqueue. Without the flag
// (or without REDIS_URL) the legacy synchronous path runs.
//
// Reliability contract: the queue uses removeOnComplete=200 / removeOnFail=
// 500 + 3 retries with backoff. A loss-of-Redis scenario before this code
// runs leaves the synchronous path active. If Redis goes down AFTER a job
// is queued, BullMQ buffers locally; jobs replay when Redis returns.

import "server-only";
import { Queue, Worker, type Processor, type RedisOptions } from "bullmq";
import IORedis, { type Redis as RedisClient } from "ioredis";
import { logger } from "@/lib/logger";

export const ACTIVITY_QUEUE_NAME = "activity-log";

export interface ActivityLogJobData {
  tenantId: string;
  actorUserId?: string | null;
  actorName?: string | null;
  action: string;
  category: string;
  entityType?: string | null;
  entityId?: string | null;
  entityLabel?: string | null;
  metadata?: Record<string, unknown> | null;
  branchId?: string | null;
  ip?: string | null;
}

let queueSingleton: Queue<ActivityLogJobData> | null = null;
let connectionSingleton: RedisClient | null = null;
let workerSingleton: Worker<ActivityLogJobData> | null = null;

function isQueueFlagEnabled(): boolean {
  return process.env.ACTIVITY_LOG_QUEUE === "1";
}

function isQueueable(): boolean {
  if (!isQueueFlagEnabled()) return false;
  if (!process.env.REDIS_URL) return false;
  return true;
}

/**
 * True iff the next call to `enqueueActivity` will go through the queue
 * (vs falling back to the legacy inline insert). Callers can use this to
 * short-circuit `if (isActivityQueueEnabled()) { enqueueActivity(...) }
 * else { await logActivityInline(...) }`.
 */
export function isActivityQueueEnabled(): boolean {
  return isQueueable();
}

function buildConnection(): RedisOptions {
  return {
    // BullMQ requires this to be null (it manages its own retry behaviour
    // for blocking BRPOPLPUSH connections).
    maxRetriesPerRequest: null,
  };
}

function getConnection(): RedisClient | null {
  if (!isQueueable()) return null;
  if (connectionSingleton) return connectionSingleton;
  connectionSingleton = new IORedis(process.env.REDIS_URL!, buildConnection());
  return connectionSingleton;
}

export function getActivityQueue(): Queue<ActivityLogJobData> | null {
  if (queueSingleton) return queueSingleton;
  const conn = getConnection();
  if (!conn) return null;
  queueSingleton = new Queue<ActivityLogJobData>(ACTIVITY_QUEUE_NAME, {
    connection: conn,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    },
  });
  return queueSingleton;
}

/**
 * Best-effort enqueue. Logs and swallows on failure — we never want a
 * queue glitch to crash the parent mutation.
 */
export async function enqueueActivity(
  data: ActivityLogJobData,
): Promise<void> {
  const q = getActivityQueue();
  if (!q) return;
  try {
    await q.add("write", data);
  } catch (err) {
    logger.warn({
      event: "activity.enqueue_failed",
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Start the activity-log worker. Called from instrumentation.ts on Node
 * runtime when the queue feature flag + REDIS_URL are both set.
 */
export function startActivityWorker(
  processor: Processor<ActivityLogJobData>,
): Worker<ActivityLogJobData> | null {
  if (workerSingleton) return workerSingleton;
  const conn = getConnection();
  if (!conn) return null;
  workerSingleton = new Worker<ActivityLogJobData>(
    ACTIVITY_QUEUE_NAME,
    processor,
    {
      connection: conn,
      // Activity writes are I/O bound and cheap; a single concurrency
      // setting keeps audit ordering close to user-action order without
      // serialising completely.
      concurrency: 4,
    },
  );
  workerSingleton.on("failed", (job, err) => {
    logger.warn({
      event: "activity.worker.job_failed",
      jobId: job?.id ?? null,
      attempts: job?.attemptsMade ?? 0,
      reason: err.message,
    });
  });
  return workerSingleton;
}

/** Tear-down for graceful shutdown. */
export async function closeActivityQueueInfra(): Promise<void> {
  if (workerSingleton) {
    try {
      await workerSingleton.close();
    } catch {
      /* ignored */
    }
    workerSingleton = null;
  }
  if (queueSingleton) {
    try {
      await queueSingleton.close();
    } catch {
      /* ignored */
    }
    queueSingleton = null;
  }
  if (connectionSingleton) {
    try {
      await connectionSingleton.quit();
    } catch {
      /* ignored */
    }
    connectionSingleton = null;
  }
}
