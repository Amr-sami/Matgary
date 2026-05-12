// Structured logger. Single-line JSON when LOG_FORMAT=json (production)
// or NODE_ENV=production; otherwise a compact human line for dev. Field
// names are stable so downstream log aggregators don't break when we
// change the wording of a message.
//
// Goals:
//   - Never log tokens, encrypted blobs, or PII (phone numbers are
//     considered PII for inbound webhooks — last 4 digits only).
//   - Always include an `event` name (snake-or-dot-cased namespace) so
//     dashboards can group/filter without parsing the message.
//   - Cheap to call from anywhere without DI plumbing.
//
// Intentionally NOT a wrapper around pino/winston — adding a dep just to
// stringify JSON is overkill for the current footprint. Drop-in compatible
// shape so swapping later is one PR.

import "server-only";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function minLevel(): LogLevel {
  const env = (process.env.LOG_LEVEL || "").toLowerCase();
  if (env === "debug" || env === "info" || env === "warn" || env === "error") {
    return env;
  }
  return process.env.NODE_ENV === "production" ? "info" : "debug";
}

function shouldEmit(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel()];
}

function asJson(): boolean {
  if (process.env.LOG_FORMAT === "json") return true;
  if (process.env.LOG_FORMAT === "pretty") return false;
  return process.env.NODE_ENV === "production";
}

// Strip values that would be expensive or sensitive to serialise. The
// fields we *want* sanitised either match by name or are already objects
// we don't want bleeding into log output (Buffers, Errors-with-stacks,
// big jsonb blobs from raw_metadata).
const SENSITIVE_KEYS = new Set([
  "accessToken",
  "access_token",
  "token",
  "appSecret",
  "app_secret",
  "client_secret",
  "secret",
  "Authorization",
  "authorization",
  "password",
  "passwordHash",
  "rawMetadata",
  "raw_metadata",
]);

function sanitiseValue(v: unknown, depth = 0): unknown {
  if (depth > 4) return "[depth]";
  if (v == null) return v;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return v;
  }
  if (v instanceof Error) {
    return { name: v.name, message: v.message };
  }
  if (Array.isArray(v)) {
    return v.slice(0, 20).map((x) => sanitiseValue(x, depth + 1));
  }
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(k)) {
        out[k] = typeof val === "string" && val.length > 0 ? "[redacted]" : null;
        continue;
      }
      out[k] = sanitiseValue(val, depth + 1);
    }
    return out;
  }
  return String(v);
}

export interface LogFields {
  event: string;
  [key: string]: unknown;
}

function emit(level: LogLevel, fields: LogFields): void {
  if (!shouldEmit(level)) return;
  const ts = new Date().toISOString();
  const payload: Record<string, unknown> = {
    ts,
    level,
    ...(sanitiseValue(fields) as Record<string, unknown>),
  };
  // Stream selection: warn/error → stderr, info/debug → stdout. Matches
  // how systemd/container log shippers segregate streams.
  const stream =
    level === "warn" || level === "error" ? process.stderr : process.stdout;
  if (asJson()) {
    stream.write(`${JSON.stringify(payload)}\n`);
  } else {
    // Compact dev format: 10:23:01.123 INFO  wa.oauth.start tenantId=… …
    const t = ts.slice(11, 23);
    const rest = Object.entries(payload)
      .filter(([k]) => k !== "ts" && k !== "level" && k !== "event")
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(" ");
    stream.write(
      `${t} ${level.toUpperCase().padEnd(5)} ${payload.event}${rest ? " " + rest : ""}\n`,
    );
  }
}

export const logger = {
  debug(fields: LogFields): void {
    emit("debug", fields);
  },
  info(fields: LogFields): void {
    emit("info", fields);
  },
  warn(fields: LogFields): void {
    emit("warn", fields);
  },
  error(fields: LogFields): void {
    emit("error", fields);
  },
};

/** Returns a logger pre-bound to a set of context fields. Convenient for
 *  per-request loggers that want to stamp every line with the same
 *  tenantId/connectionId/correlationId. */
export function withContext(ctx: Record<string, unknown>) {
  return {
    debug: (f: LogFields) => emit("debug", { ...ctx, ...f }),
    info: (f: LogFields) => emit("info", { ...ctx, ...f }),
    warn: (f: LogFields) => emit("warn", { ...ctx, ...f }),
    error: (f: LogFields) => emit("error", { ...ctx, ...f }),
  };
}
