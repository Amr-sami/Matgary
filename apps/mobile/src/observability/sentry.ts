// STUB — owned by the observability agent. Called at module top of the root layout.
export function initSentry(): void {}
/** Wrap the root component (Sentry.wrap) — identity until wired. */
export function wrapRoot<T>(component: T): T {
  return component;
}
