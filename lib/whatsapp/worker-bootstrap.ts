// Node-only worker boot. Imported dynamically from instrumentation.ts so
// the Next.js Edge-runtime analyser doesn't choke on the `process.once`
// calls below. Importing this file in the Edge runtime would fail at
// runtime — the dynamic-import-only contract enforces that.

import "server-only";
import { startWorker, closeQueueInfra } from "./queue";
import { routeJob } from "./jobs";
import { logger } from "@/lib/logger";

const SHUTDOWN_HANDLER_NAME = "waWorkerShutdown";

export async function bootWorker(): Promise<void> {
  const worker = startWorker(routeJob);
  if (!worker) return;

  logger.info({ event: "wa.worker.spawned" });

  const shutdown = async (signal: NodeJS.Signals) => {
    logger.info({ event: "wa.worker.shutdown.begin", signal });
    await closeQueueInfra();
    logger.info({ event: "wa.worker.shutdown.done" });
  };

  // Idempotent registration so hot-reload doesn't pile up listeners.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    const already = process
      .listeners(sig)
      .some((l) => (l as { name?: string }).name === SHUTDOWN_HANDLER_NAME);
    if (already) continue;

    const handler = Object.assign(
      async function waWorkerShutdown() {
        await shutdown(sig);
      },
      { name: SHUTDOWN_HANDLER_NAME },
    );
    process.once(sig, handler);
  }
}
