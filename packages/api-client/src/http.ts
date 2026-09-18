/**
 * The transport every screen goes through.
 *
 * Pure TypeScript on purpose — no React, no React Native, no expo-*. Anything
 * device-specific (where tokens are stored, which branch is active) is injected,
 * so this same file runs in a Node test with an in-memory store.
 */
import { ApiError, type BlockedCode, blockedCodeOf, classify } from "./errors";

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. Derived from the login response's `expiresIn`, not sent by the server. */
  expiresAt: number;
}

/** Injected by the app. On device this is expo-secure-store. */
export interface TokenStore {
  get(): Promise<AuthTokens | null>;
  set(tokens: AuthTokens): Promise<void>;
  clear(): Promise<void>;
}

export interface ApiClientOptions {
  /** e.g. "http://192.168.1.14:3001" — no trailing slash. */
  baseUrl: string;
  tokens: TokenStore;
  /** Active branch, or null to let the server pick the default. */
  getBranchId?: () => string | null;
  /** Called once when the session is unrecoverable. The app signs out here. */
  onSessionLost?: (error: ApiError) => void;
  /**
   * Called, in addition to the throw, whenever a response is one of the four
   * walls (see `BlockedCode`). The app routes here — to the paused screen,
   * billing, or change-password — instead of every screen re-deriving it from
   * the error it caught. The error still propagates to the caller.
   */
  onBlocked?: (code: BlockedCode, error: ApiError) => void;
  timeoutMs?: number;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  /** Set false for the two mint routes, which must not carry a stale bearer. */
  auth?: boolean;
  signal?: AbortSignal;
  /** Skip the X-Branch-Id header. Only auth routes want this. */
  noBranch?: boolean;
  /** Extra request headers, e.g. Idempotency-Key on the POS write. */
  headers?: Record<string, string>;
}

/** Refresh this long before the token actually expires. */
const REFRESH_SKEW_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;

export class ApiClient {
  private readonly baseUrl: string;
  private readonly store: TokenStore;
  private readonly getBranchId: () => string | null;
  private readonly onSessionLost?: (error: ApiError) => void;
  private readonly onBlocked?: (code: BlockedCode, error: ApiError) => void;
  private readonly timeoutMs: number;

  /**
   * The single most important field in this file.
   *
   * The server rotates refresh tokens and treats a second use of an already
   * rotated one as theft — it revokes EVERY session the user has. Two requests
   * 401-ing at the same moment would do exactly that to an innocent user. So
   * all callers share one in-flight refresh and await its result.
   */
  private refreshInFlight: Promise<AuthTokens> | null = null;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.store = opts.tokens;
    this.getBranchId = opts.getBranchId ?? (() => null);
    this.onSessionLost = opts.onSessionLost;
    this.onBlocked = opts.onBlocked;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const useAuth = opts.auth !== false;

    if (useAuth) {
      // Proactive: refreshing on a schedule beats refreshing on a 401, because
      // a 401 costs a wasted round trip and, on a write, risks a duplicate.
      const current = await this.store.get();
      if (current && current.expiresAt - Date.now() < REFRESH_SKEW_MS) {
        await this.refresh(current);
      }
    }

    let response = await this.send(path, opts, useAuth);

    // Reactive: the token was revoked mid-flight, or the clock was wrong.
    if (response.status === 401 && useAuth) {
      const code = await peekErrorCode(response);
      // A dead session cannot be refreshed — refreshing would present the
      // refresh token and, if this was a reuse kill, deepen the damage.
      if (code && code !== "TOKEN_EXPIRED" && isDeadSession(code)) {
        await this.killSession(code, 401);
      }
      const current = await this.store.get();
      if (!current) await this.killSession(code, 401);
      await this.refresh(current!);
      response = await this.send(path, opts, useAuth);
    }

    return this.parse<T>(response);
  }

  /** Persist tokens minted by a login. Called by the auth endpoints module. */
  async adoptTokens(accessToken: string, refreshToken: string, expiresIn: number) {
    await this.store.set({
      accessToken,
      refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
    });
  }

  async currentTokens(): Promise<AuthTokens | null> {
    return this.store.get();
  }

  async clearTokens(): Promise<void> {
    await this.store.clear();
  }

  // ---------------------------------------------------------------- internals

  /**
   * Side channel for the walls. Never lets a handler bug mask the real error:
   * the caller still gets the ApiError whether or not the app's hook throws.
   */
  private notifyBlocked(error: ApiError): void {
    if (!this.onBlocked) return;
    const blocked = blockedCodeOf(error.status, error.code);
    if (!blocked) return;
    try {
      this.onBlocked(blocked, error);
    } catch {
      // The app's handler is not our problem to surface here.
    }
  }

  private async refresh(current: AuthTokens): Promise<AuthTokens> {
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      // The refresh route reads the OLD access token to compare token_version
      // ("sign out everywhere"). Sending it is what makes that check work.
      const response = await this.send(
        "/api/v1/auth/refresh",
        {
          method: "POST",
          body: { refreshToken: current.refreshToken },
          noBranch: true,
        },
        false,
        { Authorization: `Bearer ${current.accessToken}` },
      );

      if (!response.ok) {
        const code = await peekErrorCode(response);
        await this.killSession(code, response.status);
      }

      const data = (await response.json()) as {
        accessToken: string;
        refreshToken: string;
        expiresIn: number;
      };
      const next: AuthTokens = {
        accessToken: data.accessToken,
        refreshToken: data.refreshToken,
        expiresAt: Date.now() + data.expiresIn * 1000,
      };
      await this.store.set(next);
      return next;
    })();

    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  /** Always throws. Clears storage and notifies the app exactly once. */
  private async killSession(code: string | null, status: number): Promise<never> {
    await this.store.clear();
    const error = new ApiError({
      kind: "session",
      code,
      status,
      message: "Session ended",
    });
    this.onSessionLost?.(error);
    throw error;
  }

  private async send(
    path: string,
    opts: RequestOptions,
    useAuth: boolean,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const url = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      ...opts.headers,
      ...extraHeaders,
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";

    if (useAuth) {
      const tokens = await this.store.get();
      if (tokens) headers.Authorization = `Bearer ${tokens.accessToken}`;
    }

    if (!opts.noBranch) {
      const branchId = this.getBranchId();
      // Replaces the HttpOnly mg.branch cookie the web uses. The server
      // validates it against the same allow-list, so it grants no new access.
      if (branchId) headers["X-Branch-Id"] = branchId;
    }

    // Two abort sources: our timeout and the caller's (screen unmounted).
    const timer = new AbortController();
    const timeoutId = setTimeout(() => timer.abort(), this.timeoutMs);
    const onCallerAbort = () => timer.abort();
    opts.signal?.addEventListener("abort", onCallerAbort);

    try {
      return await fetch(url.toString(), {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: timer.signal,
      });
    } catch (cause) {
      // fetch rejects for DNS failure, connection refused, and abort alike.
      // Distinguishing them is what lets the outbox decide to queue vs fail.
      if (opts.signal?.aborted) {
        throw new ApiError({ kind: "unknown", message: "Request cancelled" });
      }
      if (timer.signal.aborted) {
        throw new ApiError({ kind: "timeout", message: "Request timed out" });
      }
      // Name the host that failed. A stale EXPO_PUBLIC_API_URL pointing at a
      // LAN IP the Mac no longer holds looks exactly like "the server is down",
      // and without the URL in the message it costs a measurement pass to tell
      // the two apart. Host only — never the path or query, which can carry
      // identifiers.
      throw new ApiError({
        kind: "offline",
        message: `Cannot reach ${url.host}${
          cause instanceof Error ? ` (${cause.message})` : ""
        }`,
      });
    } finally {
      clearTimeout(timeoutId);
      opts.signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  private async parse<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as T;

    const text = await response.text();
    let payload: unknown = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        // An nginx/Cloudflare error page, not our API.
        if (!response.ok) {
          throw new ApiError({
            kind: classify(response.status, null),
            status: response.status,
            message: `Non-JSON response (${response.status})`,
          });
        }
      }
    }

    if (!response.ok) {
      const code = readErrorCode(payload);
      const retryAfter = Number(response.headers.get("retry-after"));
      const error = new ApiError({
        kind: classify(response.status, code),
        code,
        status: response.status,
        message: readErrorMessage(payload) ?? code ?? `HTTP ${response.status}`,
        retryAfterSec: Number.isFinite(retryAfter) ? retryAfter : null,
      });
      this.notifyBlocked(error);
      throw error;
    }

    return payload as T;
  }
}

// -------------------------------------------------------------------- helpers

function isDeadSession(code: string): boolean {
  return (
    code === "INVALID_REFRESH_TOKEN" ||
    code === "TOKEN_REUSE_DETECTED" ||
    code === "SESSION_REVOKED" ||
    code === "NO_TENANT" ||
    code === "USER_NOT_FOUND"
  );
}

/** Reads the code without consuming the body the caller may still need. */
async function peekErrorCode(response: Response): Promise<string | null> {
  try {
    const clone = response.clone();
    return readErrorCode(await clone.json());
  } catch {
    return null;
  }
}

function readErrorCode(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "error" in payload) {
    const value = (payload as { error: unknown }).error;
    if (typeof value === "string") return value;
  }
  return null;
}

function readErrorMessage(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "detail" in payload) {
    const value = (payload as { detail: unknown }).detail;
    if (typeof value === "string") return value;
  }
  return null;
}
