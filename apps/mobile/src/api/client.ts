import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Application from "expo-application";
import { ApiClient, type ApiError } from "@matgary/api-client";

import { secureTokenStore } from "@/auth/tokenStore";
import { useBlocked } from "@/stores/blocked";

/**
 * Resolving the dev API host is the single most common "why won't it connect"
 * in RN, because each target reaches the developer's Mac differently:
 *
 *   iOS simulator    shares the host network stack   → 127.0.0.1 works
 *   Android emulator runs behind its own NAT          → 10.0.2.2 is the host
 *   physical device  is a separate machine on Wi-Fi   → needs the LAN IP
 *
 * EXPO_PUBLIC_API_URL overrides everything, and is required for a real device.
 * Otherwise we derive the host from the Metro server the app was loaded from,
 * which is correct by construction — it is literally the machine serving us.
 */
function resolveBaseUrl(): string {
  const explicit = process.env.EXPO_PUBLIC_API_URL;
  if (explicit) return explicit.replace(/\/+$/, "");

  // Port only — the host stays derived from Metro so it cannot go stale.
  // 3001 is Matgary's dev port, but another project (verolegal) also uses it;
  // when the two collide, set this rather than pinning the whole URL.
  const port = Number(process.env.EXPO_PUBLIC_API_PORT) || 3001;

  // e.g. "192.168.1.14:8081" — the host running Metro.
  const hostUri =
    Constants.expoConfig?.hostUri ??
    (Constants.expoGoConfig as { debuggerHost?: string } | undefined)
      ?.debuggerHost;
  const host = hostUri?.split(":")[0];

  if (host && host !== "localhost" && host !== "127.0.0.1") {
    return `http://${host}:${port}`;
  }
  return Platform.OS === "android"
    ? `http://10.0.2.2:${port}`
    : `http://127.0.0.1:${port}`;
}

export const API_BASE_URL = resolveBaseUrl();

/**
 * Set by the session store. Read lazily on every request so a branch switch
 * takes effect on the next call without rebuilding the client.
 */
let activeBranchId: string | null = null;

export function setActiveBranchId(id: string | null) {
  activeBranchId = id;
}

/**
 * Registered by the session store rather than imported, because the store
 * imports this module — wiring it the other way is a require cycle that Metro
 * resolves to `undefined` at runtime, not an error at build time.
 */
let sessionLostHandler: ((error: ApiError) => void) | null = null;

export function onSessionLost(handler: (error: ApiError) => void) {
  sessionLostHandler = handler;
}

export const api = new ApiClient({
  baseUrl: API_BASE_URL,
  tokens: secureTokenStore,
  getBranchId: () => activeBranchId,
  onSessionLost: (error) => sessionLostHandler?.(error),
  // The four walls (suspended / unpaid / must-change-password / no permission)
  // land in a store, and <SuspensionRouter/> does the navigating. Imported
  // directly — unlike the session store, blocked.ts imports nothing from here,
  // so there is no cycle to break.
  onBlocked: (code, error) => useBlocked.getState().raise(code, error.message),
});

/** Display-only metadata, shown in the user's session list. */
export const deviceMeta = {
  platform: Platform.OS === "ios" || Platform.OS === "android"
    ? (Platform.OS as "ios" | "android")
    : ("web" as const),
  appVersion: Application.nativeApplicationVersion ?? "0.1.0",
};
