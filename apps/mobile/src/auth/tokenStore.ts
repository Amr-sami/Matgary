import * as SecureStore from "expo-secure-store";
import type { AuthTokens, TokenStore } from "@matgary/api-client";

/**
 * Tokens live in the iOS keychain / Android keystore, never in AsyncStorage.
 *
 * Stored as three separate entries rather than one JSON blob because
 * SecureStore warns (and on some Android versions truncates) above ~2048 bytes,
 * and an access token carrying a long permissions array can approach that.
 *
 * **Reads are served from memory.** The keychain is a native, cross-process
 * call, and the client touches the store twice per request — once to check the
 * expiry and once to set the Authorization header — so a naive implementation
 * costs SIX keychain round trips per API call. The cache makes a warm read
 * free; writes still go through to the keychain immediately, so a crash never
 * loses a rotated refresh token.
 *
 * The cache is process-local, which is the correct lifetime: it is populated on
 * first read at launch and invalidated by the only two things that change
 * tokens, set() and clear().
 */

const ACCESS_KEY = "mg.access";
const REFRESH_KEY = "mg.refresh";
const EXPIRES_KEY = "mg.expires";

/** undefined = not read yet; null = read, and there is no session. */
let cache: AuthTokens | null | undefined;

export const secureTokenStore: TokenStore = {
  async get(): Promise<AuthTokens | null> {
    if (cache !== undefined) return cache;

    const [accessToken, refreshToken, expiresAt] = await Promise.all([
      SecureStore.getItemAsync(ACCESS_KEY),
      SecureStore.getItemAsync(REFRESH_KEY),
      SecureStore.getItemAsync(EXPIRES_KEY),
    ]);

    if (!accessToken || !refreshToken) {
      cache = null;
      return null;
    }

    // A missing or corrupt expiry is treated as "expired", not "never expires".
    // Guessing the other way strands the user with a dead token and no refresh.
    const parsed = Number(expiresAt);
    cache = {
      accessToken,
      refreshToken,
      expiresAt: Number.isFinite(parsed) ? parsed : 0,
    };
    return cache;
  },

  async set(tokens: AuthTokens): Promise<void> {
    // Cache first so a concurrent read cannot observe the old token, then
    // persist. Both happen before the caller continues.
    cache = tokens;
    await Promise.all([
      SecureStore.setItemAsync(ACCESS_KEY, tokens.accessToken),
      SecureStore.setItemAsync(REFRESH_KEY, tokens.refreshToken),
      SecureStore.setItemAsync(EXPIRES_KEY, String(tokens.expiresAt)),
    ]);
  },

  async clear(): Promise<void> {
    cache = null;
    await Promise.all([
      SecureStore.deleteItemAsync(ACCESS_KEY),
      SecureStore.deleteItemAsync(REFRESH_KEY),
      SecureStore.deleteItemAsync(EXPIRES_KEY),
    ]);
  },
};
