import * as SecureStore from "expo-secure-store";
import type { AuthTokens, TokenStore } from "@matgary/api-client";

/**
 * Tokens live in the iOS keychain / Android keystore, never in AsyncStorage.
 *
 * Stored as three separate entries rather than one JSON blob because
 * SecureStore warns (and on some Android versions truncates) above ~2048 bytes,
 * and an access token carrying a long permissions array can approach that on
 * its own. Splitting keeps each value comfortably small.
 */

const ACCESS_KEY = "mg.access";
const REFRESH_KEY = "mg.refresh";
const EXPIRES_KEY = "mg.expires";

export const secureTokenStore: TokenStore = {
  async get(): Promise<AuthTokens | null> {
    const [accessToken, refreshToken, expiresAt] = await Promise.all([
      SecureStore.getItemAsync(ACCESS_KEY),
      SecureStore.getItemAsync(REFRESH_KEY),
      SecureStore.getItemAsync(EXPIRES_KEY),
    ]);
    if (!accessToken || !refreshToken) return null;

    // A missing or corrupt expiry is treated as "expired", not "never expires".
    // The failure mode of guessing wrong in the other direction is a user stuck
    // with a dead token and no path to refresh.
    const parsed = Number(expiresAt);
    return {
      accessToken,
      refreshToken,
      expiresAt: Number.isFinite(parsed) ? parsed : 0,
    };
  },

  async set(tokens: AuthTokens): Promise<void> {
    await Promise.all([
      SecureStore.setItemAsync(ACCESS_KEY, tokens.accessToken),
      SecureStore.setItemAsync(REFRESH_KEY, tokens.refreshToken),
      SecureStore.setItemAsync(EXPIRES_KEY, String(tokens.expiresAt)),
    ]);
  },

  async clear(): Promise<void> {
    await Promise.all([
      SecureStore.deleteItemAsync(ACCESS_KEY),
      SecureStore.deleteItemAsync(REFRESH_KEY),
      SecureStore.deleteItemAsync(EXPIRES_KEY),
    ]);
  },
};
