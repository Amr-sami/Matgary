// Next.js runs this once per server boot (App Router only).
//
// We use it to start the WhatsApp BullMQ worker so background jobs drain
// on every node that's also serving HTTP. The single-instance deploy
// model makes co-locating fine; when we move to dedicated worker
// containers the same lib/whatsapp/worker-bootstrap is imported there
// without the HTTP routes.
//
// Importantly, the Node-only worker code lives in a dynamically-imported
// module so the Edge-runtime analyser doesn't reject this file.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (!process.env.REDIS_URL) return;
  // Dynamic import keeps the Edge bundle clean.
  const { bootWorker } = await import("./lib/whatsapp/worker-bootstrap");
  await bootWorker();
}
