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

/**
 * Revoke this device's session server-side, then drop it locally.
 *
 * Local state is cleared even when the call fails: a user who taps "sign out"
 * on a plane must end up signed out. The server row expires on its own.
 */
export async function logout(client: ApiClient): Promise<void> {
  const tokens = await client.currentTokens();
  try {
    if (tokens) {
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
