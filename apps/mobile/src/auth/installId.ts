import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

const INSTALL_ID_KEY = "mg.installId";

/**
 * A stable id for this installation.
 *
 * The login route uses it to retire the previous session row for the same
 * install, so a reinstall does not leave behind a device the user can see in
 * their session list but can never revoke.
 *
 * Deliberately NOT a hardware id: those are either unavailable (iOS), unstable
 * (Android across factory resets), or privacy-sensitive. A random value we
 * generate once is enough, because its only job is to correlate one app
 * instance with its own past sessions.
 */
export async function getInstallId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(INSTALL_ID_KEY);
  if (existing) return existing;

  const fresh = Crypto.randomUUID();
  await SecureStore.setItemAsync(INSTALL_ID_KEY, fresh);
  return fresh;
}
