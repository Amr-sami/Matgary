// Per-request context, propagated via Node's AsyncLocalStorage. Middleware
// stamps a request id on every incoming request and stuffs it (+ caller
// identity once auth resolves) into this store; any log line emitted
// downstream is auto-decorated with the same id, so a single request can
// be re-assembled from logs without threading the id through every call.
//
// Pattern is intentionally tiny — there's no DI container, no hooks, just
// `getRequestContext()` from server code anywhere on the call stack.

import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestContext {
  /** Per-request opaque id. Echoed back as `x-request-id` so a client
   *  ticket can be cross-referenced with server logs. */
  requestId: string;
  /** Populated after `requireTenant()` resolves — null on pre-auth routes. */
  tenantId?: string | null;
  /** Populated after auth resolves. */
  userId?: string | null;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function getRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

export function runWithRequestContext<T>(
  ctx: RequestContext,
  fn: () => T | Promise<T>,
): Promise<T> | T {
  return storage.run(ctx, fn);
}

/**
 * "Enter once, stay active" mode. Node's AsyncLocalStorage propagates the
 * store FORWARD from the call site through all subsequent awaits in the
 * same async resource chain, so we can open the scope inside a route
 * helper and have every later await see it without wrapping the entire
 * handler. Idempotent — re-entering on the same request is fine.
 */
export function enterRequestContext(ctx: RequestContext): void {
  storage.enterWith(ctx);
}

/** Mutate the in-flight request context (e.g. after auth resolves). Safe
 *  to call from any descendant of an entered scope. */
export function setRequestContext(patch: Partial<RequestContext>): void {
  const cur = storage.getStore();
  if (cur) Object.assign(cur, patch);
}
