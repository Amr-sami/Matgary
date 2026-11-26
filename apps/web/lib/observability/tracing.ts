// Thin wrappers around the OpenTelemetry tracer API. Use them at hot-path
// repo boundaries to get a clean span tree without leaking otel imports
// across the codebase.
//
// When OTEL_SERVICE_NAME is unset (the default), the tracer is a no-op —
// the wrappers add ~0 overhead and emit no spans. When it's set, we get
// a tagged span per call with the matching exception captured if the
// wrapped function throws.
//
// Use sparingly: only on functions where Phase 5A measured them as a hot
// path. Wrapping every repo call would inflate the trace and obscure the
// signal. Phase 5B identifies the three real hot paths:
//   1. recordCartSale (POS write — bottleneck #1)
//   2. loadDashboardStats / listProducts / listSalesPage (dashboard fan-out
//      — bottleneck #2)
//   3. resolveActiveBranch (per-request branch lookup — bottleneck #3)

import "server-only";
import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";

const TRACER_NAME = "matgary";

/**
 * Wrap an async function in a span. The span auto-finishes when the
 * promise settles. Throws are recorded on the span and re-thrown so the
 * caller flow is identical to a non-traced call.
 *
 *   await withSpan("repo.sale.record", { tenantId }, async () => {
 *     return recordCartSale(...);
 *   });
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean | null | undefined>,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, async (span) => {
    try {
      for (const [k, v] of Object.entries(attributes)) {
        if (v !== null && v !== undefined) {
          // The API accepts string | number | boolean | array of those.
          span.setAttribute(k, v as string | number | boolean);
        }
      }
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      if (err instanceof Error) {
        span.recordException(err);
      }
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Synchronous variant — for cheap, non-async hot paths if any appear. */
export function withSpanSync<T>(
  name: string,
  attributes: Record<string, string | number | boolean | null | undefined>,
  fn: (span: Span) => T,
): T {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, (span) => {
    try {
      for (const [k, v] of Object.entries(attributes)) {
        if (v !== null && v !== undefined) {
          span.setAttribute(k, v as string | number | boolean);
        }
      }
      const result = fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      if (err instanceof Error) span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}
