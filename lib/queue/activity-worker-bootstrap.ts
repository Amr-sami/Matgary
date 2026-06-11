// Node-only boot for the activity-log worker. Dynamically imported from
// instrumentation.ts so the Edge runtime analyser doesn't see bullmq.
//
// Worker simply calls insertActivityRow with the queued payload. The
// row builder + impersonation-tagging logic lives in lib/repo/activity.ts;
// the queue is the transport.

import "server-only";
import type { Job } from "bullmq";
import {
  startActivityWorker,
  closeActivityQueueInfra,
  type ActivityLogJobData,
} from "./activity-queue";
import { insertActivityRow } from "@/lib/repo/activity";
import { logger } from "@/lib/logger";

const SHUTDOWN_HANDLER_NAME = "activityWorkerShutdown";

export async function bootActivityWorker(): Promise<void> {
  const worker = startActivityWorker(async (job: Job<ActivityLogJobData>) => {
    const data = job.data;
    await insertActivityRow({
      tenantId: data.tenantId,
      actorUserId: data.actorUserId ?? null,
      actorName: data.actorName ?? null,
      action: data.action,
      // The LogActivityInput interface narrows `category` to a union; the
      // queue payload is a wider string. Cast at the boundary — the writer
      // upstream already enforced the union before enqueuing.
      category: data.category as never,
      entityType: data.entityType ?? null,
      entityId: data.entityId ?? null,
      entityLabel: data.entityLabel ?? null,
      metadata: data.metadata ?? null,
      branchId: data.branchId ?? null,
      ip: data.ip ?? null,
    });
  });
  if (!worker) return;

  logger.info({ event: "activity.worker.spawned" });

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info({ event: "activity.worker.shutdown.begin", signal });
    await closeActivityQueueInfra();
    logger.info({ event: "activity.worker.shutdown.done" });
  };

  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    const already = process
      .listeners(sig)
      .some((l) => (l as { name?: string }).name === SHUTDOWN_HANDLER_NAME);
    if (already) continue;
    process.once(sig, async function activityWorkerShutdown() {
      await shutdown(sig);
    });
  }
}
