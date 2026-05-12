// BullMQ queue + worker singletons for WhatsApp background work.
//
// One queue, multiple job kinds (outbound.text, outbound.document,
// inbound.process, quarantine.replay). One worker that switches on
// job.name. Phase 3 runs the worker in-process; the abstraction is
// designed so a future move to a dedicated worker container is a
// deploy-config change, not a refactor.
//
// Redis is REQUIRED for the queue to function. When REDIS_URL is unset
// the helpers below return null and callers fall back to inline
// execution. Existing cache/rate-limit clients use a different ioredis
// config (maxRetriesPerRequest=2) which BullMQ doesn't accept for its
// blocking BRPOPLPUSH connections — so we mint a separate connection
// here.

import "server-only";
import { Queue, Worker, type Job, type Processor, type RedisOptions } from "bullmq";
import IORedis, { type Redis as RedisClient } from "ioredis";
import { logger } from "@/lib/logger";

// Single named queue. Job *type* lives in job.name; payload in job.data.
export const QUEUE_NAME = "wa-jobs";

// Job kinds. Adding a new kind:
//   1) extend this union,
//   2) define a payload interface below,
//   3) handle it in lib/whatsapp/jobs.ts:routeJob.
export type WaJobName =
  | "outbound.text"
  | "outbound.document"
  | "inbound.process"
  | "quarantine.replay";

export interface OutboundTextJobData {
  tenantId: string;
  branchId: string;
  rowId: string; // wa_messages.id
  clientMessageId: string;
  phone: string; // already normalised
  message: string;
}

export interface OutboundDocumentJobData {
  tenantId: string;
  branchId: string;
  rowId: string;
  clientMessageId: string;
  phone: string;
  caption: string | null;
  // The invoice payload — kept as opaque JSON because pdfReceipt validates
  // shape at render time. Stored on the job rather than re-read from DB
  // so the worker is self-contained.
  invoice: unknown;
  fileName: string;
}

export interface InboundProcessJobData {
  eventId: string; // wa_webhook_events.id
}

export interface QuarantineReplayJobData {
  eventId: string;
}

export type WaJobData =
  | OutboundTextJobData
  | OutboundDocumentJobData
  | InboundProcessJobData
  | QuarantineReplayJobData;

// ─── Connection ───────────────────────────────────────────────────────────

const globalForQueue = globalThis as unknown as {
  __waQueueConn?: RedisClient | null;
  __waQueue?: Queue | null;
  __waWorker?: Worker | null;
};

function buildConnection(): RedisClient | null {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  // BullMQ contract: blocking commands need maxRetriesPerRequest=null.
  // Also disable enableReadyCheck so workers don't deadlock on Cluster
  // mode promotions (no-op for single-instance).
  const opts: RedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    // Lazy connect so importing this module is side-effect-free in routes
    // that never enqueue (e.g. settings GET).
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 200, 5000),
  };
  const client = new IORedis(url, opts);
  client.on("error", (err) => {
    logger.warn({
      event: "wa.queue.redis.error",
      reason: err.message,
    });
  });
  return client;
}

function getConnection(): RedisClient | null {
  if (globalForQueue.__waQueueConn === undefined) {
    globalForQueue.__waQueueConn = buildConnection();
  }
  return globalForQueue.__waQueueConn ?? null;
}

// ─── Queue (producer side) ────────────────────────────────────────────────

export function getQueue(): Queue | null {
  if (globalForQueue.__waQueue) return globalForQueue.__waQueue;
  const connection = getConnection();
  if (!connection) return null;
  const q = new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      // 5 attempts before BullMQ moves the job to the failed list.
      // Exponential backoff: 1s, 2s, 4s, 8s, 16s. The Graph 429 rate-
      // limit window is 60s so capping there is generous.
      attempts: 5,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: { age: 60 * 60 * 24, count: 1000 }, // 24h or 1k
      removeOnFail: { age: 60 * 60 * 24 * 7 }, // a week for forensics
    },
  });
  globalForQueue.__waQueue = q;
  return q;
}

export function isQueueEnabled(): boolean {
  return !!process.env.REDIS_URL;
}

// Type-safe add helpers. Each kind picks its payload type so callers
// can't drift the shape — e.g. handing inbound data to an outbound job
// would be a compile error.

export async function enqueueOutboundText(
  data: OutboundTextJobData,
): Promise<Job<OutboundTextJobData> | null> {
  const q = getQueue();
  if (!q) return null;
  // jobId = clientMessageId so the same client UUID enqueued twice is
  // BullMQ-deduped before it even reaches a worker.
  return q.add("outbound.text" satisfies WaJobName, data, {
    jobId: `out:${data.clientMessageId}`,
  });
}

export async function enqueueOutboundDocument(
  data: OutboundDocumentJobData,
): Promise<Job<OutboundDocumentJobData> | null> {
  const q = getQueue();
  if (!q) return null;
  return q.add("outbound.document" satisfies WaJobName, data, {
    jobId: `outdoc:${data.clientMessageId}`,
  });
}

export async function enqueueInboundProcess(
  data: InboundProcessJobData,
): Promise<Job<InboundProcessJobData> | null> {
  const q = getQueue();
  if (!q) return null;
  return q.add("inbound.process" satisfies WaJobName, data, {
    jobId: `in:${data.eventId}`,
  });
}

export async function enqueueQuarantineReplay(
  data: QuarantineReplayJobData,
): Promise<Job<QuarantineReplayJobData> | null> {
  const q = getQueue();
  if (!q) return null;
  return q.add("quarantine.replay" satisfies WaJobName, data, {
    jobId: `replay:${data.eventId}`,
  });
}

// ─── Worker (consumer side) ───────────────────────────────────────────────

export function startWorker(processor: Processor<WaJobData>): Worker | null {
  if (globalForQueue.__waWorker) return globalForQueue.__waWorker;
  const connection = getConnection();
  if (!connection) {
    logger.info({ event: "wa.worker.skip_start", reason: "REDIS_URL not set" });
    return null;
  }
  const w = new Worker<WaJobData>(QUEUE_NAME, processor, {
    connection,
    // Concurrency: 10 jobs in flight is plenty for a POS workload.
    // Bump for tenants pushing high volume; the upstream Graph rate
    // limits will become the bottleneck long before this does.
    concurrency: 10,
    // Lock duration matches our slowest expected job (PDF gen + media
    // upload + send: rarely above 10s, but Graph 502s can stall longer).
    lockDuration: 60_000,
  });

  w.on("ready", () => {
    logger.info({ event: "wa.worker.ready", queue: QUEUE_NAME });
  });
  w.on("error", (err) => {
    logger.warn({
      event: "wa.worker.error",
      reason: err.message,
    });
  });
  w.on("failed", (job, err) => {
    logger.warn({
      event: "wa.worker.job_failed",
      jobName: job?.name ?? null,
      jobId: job?.id ?? null,
      attemptsMade: job?.attemptsMade ?? null,
      reason: err.message,
    });
  });
  w.on("completed", (job) => {
    logger.debug({
      event: "wa.worker.job_completed",
      jobName: job.name,
      jobId: job.id ?? null,
    });
  });

  globalForQueue.__waWorker = w;
  return w;
}

/** Graceful shutdown. Closes the worker first so in-flight jobs finish,
 *  then the queue (producer side). Idempotent. */
export async function closeQueueInfra(): Promise<void> {
  const w = globalForQueue.__waWorker;
  const q = globalForQueue.__waQueue;
  const c = globalForQueue.__waQueueConn;
  globalForQueue.__waWorker = null;
  globalForQueue.__waQueue = null;
  globalForQueue.__waQueueConn = null;
  try {
    if (w) await w.close();
  } catch (err) {
    logger.warn({
      event: "wa.worker.close_failed",
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    if (q) await q.close();
  } catch {
    // ignore
  }
  try {
    if (c) await c.quit();
  } catch {
    // ignore
  }
}
