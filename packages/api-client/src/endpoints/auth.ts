import type { ApiClient } from "../http";
import type { DeviceSummary, LoginResponse } from "../types";

export interface LoginInput {
  /** Email, or a synthetic staff identifier like "cashier@amr-store". */
  identifier: string;
  password: string;
  deviceName?: string;
  platform?: "ios" | "android" | "web";
  appVersion?: string;
  /** Stable per install, so a reinstall replaces its old session row. */
  installId?: string;
}

/**
 * Sign in and persist the tokens.
 *
 * `auth: false` matters: a stale bearer on this request would be rejected by
 * resolveSession before the body is ever read, because an invalid bearer does
 * not fall back to the cookie.
 */
export async function login(
  client: ApiClient,
  input: LoginInput,
): Promise<LoginResponse> {
  const data = await client.request<LoginResponse>("/api/v1/auth/login", {
    method: "POST",
    body: input,
    auth: false,
    noBranch: true,
  });
  await client.adoptTokens(data.accessToken, data.refreshToken, data.expiresIn);
  return data;
}

export interface LogoutOptions {
  /**
   * This device's Expo push token. When present it is unregistered
   * (DELETE /api/v1/devices/push-token) BEFORE the session is revoked — the
   * server needs the still-valid bearer to know whose token to drop. Omitted,
   * the token registered through `setPushTokenProvider` is used instead.
   */
  pushToken?: string | null;
}

let pushTokenProvider: (() => string | null | undefined) | null = null;

/**
 * Let the push layer hand its current token to `logout` without every caller
 * of `logout` having to know about push. The app's session store calls
 * `logout(client)` with no options; the registrar installs this provider once
 * at mount so sign-out still unregisters the device.
 */
export function setPushTokenProvider(
  provider: (() => string | null | undefined) | null,
): void {
  pushTokenProvider = provider;
}

/** Hard cap on the best-effort push unregister so sign-out never hangs on it. */
const PUSH_UNREGISTER_TIMEOUT_MS = 4_000;

/**
 * Revoke this device's session server-side, then drop it locally.
 *
 * Local state is cleared even when the call fails: a user who taps "sign out"
 * on a plane must end up signed out. The server row expires on its own.
 */
export async function logout(
  client: ApiClient,
  opts: LogoutOptions = {},
): Promise<void> {
  const tokens = await client.currentTokens();
  try {
    if (tokens) {
      const pushToken = opts.pushToken ?? pushTokenProvider?.() ?? null;
      if (pushToken) {
        // Best-effort and time-boxed: a failed unregister must not keep the
        // user signed in, and the server prunes dead tokens from receipts.
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), PUSH_UNREGISTER_TIMEOUT_MS);
        try {
          await client.request("/api/v1/devices/push-token", {
            method: "DELETE",
            body: { token: pushToken },
            noBranch: true,
            signal: ctl.signal,
          });
        } catch {
          // ignore — see above
        } finally {
          clearTimeout(timer);
        }
      }
      await client.request("/api/v1/auth/logout", {
        method: "POST",
        body: { refreshToken: tokens.refreshToken },
        auth: false,
        noBranch: true,
      });
    }
  } finally {
    await client.clearTokens();
  }
}

export async function listDevices(client: ApiClient): Promise<DeviceSummary[]> {
  const data = await client.request<{ devices: DeviceSummary[] }>(
    "/api/v1/auth/devices",
    { noBranch: true },
  );
  return data.devices;
}

/**
 * Revoke one device. The id goes in the query string, not a body — DELETE
 * handlers here read `new URL(req.url).searchParams`, and a JSON body would be
 * silently ignored, making the call look like it succeeded.
 */
export async function revokeDevice(
  client: ApiClient,
  deviceId: string,
): Promise<void> {
  await client.request("/api/v1/auth/devices", {
    method: "DELETE",
    query: { id: deviceId },
    noBranch: true,
  });
}

export interface SignupInput {
  email: string;
  password: string;
  storeName: string;
  /** Becomes the @-suffix of every staff login. [a-z0-9-], 2..40. */
  storeHandle: string;
  locale?: "ar" | "en";
  deviceName?: string;
  platform?: "ios" | "android" | "web";
  appVersion?: string;
  installId?: string;
}

/**
 * Create an owner account and its store, and sign in. Same account creation
 * the web's signupAction runs (lib/auth/create-account.ts); only the transport
 * differs. Field-level validation errors come back as 422 with `field` set,
 * EMAIL_TAKEN / HANDLE_TAKEN as 409.
 */
export async function signup(client: ApiClient, input: SignupInput): Promise<LoginResponse> {
  const data = await client.request<LoginResponse>("/api/v1/auth/signup", {
    method: "POST",
    body: input,
    auth: false,
    noBranch: true,
  });
  await client.adoptTokens(data.accessToken, data.refreshToken, data.expiresIn);
  return data;
}

/**
 * Body of POST /api/v1/auth/demo (apps/web/app/api/v1/auth/demo/route.ts
 * bodySchema): device meta plus `locale`, which seeds the ephemeral owner's
 * language so the trial store's copy matches the app's.
 */
export type DemoInput = Omit<SignupInput, "email" | "password" | "storeName" | "storeHandle">;

/**
 * Open the trial store: an ephemeral owner on a fresh clone of the demo
 * template, signed in. Rate-limited to 10/hour per IP server-side.
 */
export async function startDemo(
  client: ApiClient,
  meta: DemoInput = {},
): Promise<LoginResponse & { demo: true }> {
  const data = await client.request<LoginResponse & { demo: true }>("/api/v1/auth/demo", {
    method: "POST",
    body: meta,
    auth: false,
    noBranch: true,
  });
  await client.adoptTokens(data.accessToken, data.refreshToken, data.expiresIn);
  return data;
}
