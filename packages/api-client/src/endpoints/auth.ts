import { ApiError } from "../errors";
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

// ---------------------------------------------------------------------------
// Second factor (doc 14 C7 / decision D3-b).
// ---------------------------------------------------------------------------

/**
 * `login` throws `ApiError { kind: "conflict", code: "TOTP_REQUIRED" }` for an
 * account with 2FA on; the 409 body carries a one-shot `challengeToken` worth
 * five minutes. This reads it, and is null for every other error — so the
 * caller can branch on "is this a 2FA prompt" with one call.
 */
export function challengeTokenOf(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== "TOTP_REQUIRED") return null;
  const body = error.body as { challengeToken?: unknown } | null;
  return typeof body?.challengeToken === "string" ? body.challengeToken : null;
}

/**
 * `verifyTwoFactor` throws `ApiError { code: "INVALID_CODE" }` with
 * `attemptsLeft` in the body; 0 means that was the last try and the challenge
 * is now dead (the next call would be CHALLENGE_EXPIRED). Null when the error
 * is anything else.
 */
export function attemptsLeftOf(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.code !== "INVALID_CODE") return null;
  const body = error.body as { attemptsLeft?: unknown } | null;
  return typeof body?.attemptsLeft === "number" ? body.attemptsLeft : null;
}

/**
 * Body of POST /api/v1/auth/2fa/verify
 * (apps/web/app/api/v1/auth/2fa/verify/route.ts bodySchema).
 */
export interface TwoFactorVerifyInput {
  /** From the 409 TOTP_REQUIRED login response — see `challengeTokenOf`. */
  challengeToken: string;
  /** The 6-digit authenticator code, or one of the recovery codes. */
  code: string;
  /** Same display-only metadata `login` sends; lands on the auth_devices row. */
  device?: {
    name?: string;
    platform?: "ios" | "android" | "web";
    appVersion?: string;
    installId?: string;
  };
}

/**
 * Finish a 2FA sign-in: the challenge plus the code become the same session
 * `login` would have returned, and the tokens are persisted the same way.
 *
 *   401 INVALID_CODE       wrong code — `attemptsLeftOf(error)`
 *   401 CHALLENGE_EXPIRED  start over at the password
 *   429 RATE_LIMITED       per IP
 */
export async function verifyTwoFactor(
  client: ApiClient,
  input: TwoFactorVerifyInput,
): Promise<LoginResponse> {
  const data = await client.request<LoginResponse>("/api/v1/auth/2fa/verify", {
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

// ---------------------------------------------------------------------------
// Onboarding — the wizard the owner lands on right after signup.
// ---------------------------------------------------------------------------

export type OnboardingPreset = "cornerstore" | "blank";

/**
 * Body of POST /api/v1/onboarding/complete
 * (apps/web/app/api/v1/onboarding/complete/route.ts). `shopPhone` is free-form
 * and normalised server-side; a typed-but-invalid one is 400 INVALID_PHONE.
 */
export interface CompleteOnboardingInput {
  preset: OnboardingPreset;
  shopName: string;
  shopPhone?: string;
  locale?: "ar" | "en";
}

/**
 * Error codes the route answers with (`ApiError.code`), same set as the web's
 * completeOnboardingAction. 400 for the three input codes, 409 for
 * PRIMARY_BRANCH_MISSING, 500 INTERNAL.
 */
export type OnboardingErrorCode =
  | "SHOP_NAME_REQUIRED"
  | "INVALID_PHONE"
  | "INVALID_INPUT"
  | "PRIMARY_BRANCH_MISSING"
  | "INTERNAL";

/**
 * Finish onboarding for the caller's tenant: writes the primary branch's shop
 * name / phone, flips `onboardingComplete`, and for `preset: "cornerstore"`
 * seeds the starter catalog (Watches / Perfumes / Sunglasses + attributes).
 * The seed is idempotent — a retry after a dropped response is safe.
 */
export async function completeOnboarding(
  client: ApiClient,
  input: CompleteOnboardingInput,
): Promise<{ ok: true }> {
  return client.request<{ ok: true }>("/api/v1/onboarding/complete", {
    method: "POST",
    body: input,
  });
}
