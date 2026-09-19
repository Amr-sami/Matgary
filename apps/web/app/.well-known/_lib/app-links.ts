/**
 * Pure builders for the two OS "association" files that make
 * https://thestoro.com/... open the native app instead of Safari/Chrome:
 *
 *   /.well-known/apple-app-site-association   (iOS Universal Links + password AutoFill)
 *   /.well-known/assetlinks.json              (Android App Links + Credential Manager)
 *
 * Both are generated at request time from environment variables so that a
 * placeholder Team ID or fingerprint can never be shipped by accident: when
 * the variable is missing or malformed the route answers 404 with a JSON hint
 * and the OS simply falls back to opening the URL in the browser — which is
 * the same behaviour as having no file at all.
 *
 * This module has no Next.js imports so it can be unit-tested with plain
 * `node --test` (see ./app-links.test.ts). The route handlers are thin.
 *
 * Operational steps live in mobile-dev-docs/10-universal-links.md.
 */

/** Must match `ios.bundleIdentifier` / `android.package` in apps/mobile/app.config.ts. */
export const APP_BUNDLE_ID = "com.thestoro.app";

/**
 * The web paths that should open the app. Everything else on the domain stays
 * in the browser. Apple's `components` syntax: a trailing `*` matches any
 * suffix, `?` any single char, `#` denotes a fragment. Kept to the two
 * pre-login flows the app actually handles from the outside — the reset link
 * that arrives by e-mail and the login page — for both locales, because the
 * web app prefixes every pre-login URL with /ar or /en (the middleware 307s a
 * bare /reset-password to a prefixed one, and Universal Links are resolved
 * BEFORE any HTTP request, so the bare form would never match the app).
 */
export const UNIVERSAL_LINK_PATHS: readonly string[] = [
  "/ar/reset-password*",
  "/en/reset-password*",
  "/ar/login*",
  "/en/login*",
];

/** Apple Developer Team ID: exactly 10 upper-case alphanumerics (e.g. "A1B2C3D4E5"). */
const TEAM_ID_RE = /^[A-Z0-9]{10}$/;

/** Android signing-cert SHA-256: 32 colon-separated upper-case hex bytes. */
const SHA256_FP_RE = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export type NotConfigured = { ok: false; hint: string };
export type Built<T> = { ok: true; body: T };

export type AppleAppSiteAssociation = {
  applinks: {
    details: Array<{
      appIDs: string[];
      components: Array<{ "/": string; comment?: string }>;
    }>;
  };
  webcredentials: { apps: string[] };
};

export type AssetLinks = Array<{
  relation: string[];
  target: {
    namespace: "android_app";
    package_name: string;
    sha256_cert_fingerprints: string[];
  };
}>;

/**
 * Normalise a Team ID from the environment. Returns null unless it is exactly
 * the 10-character form Apple issues — anything else (empty, "TODO",
 * "TEAMID.com.thestoro.app") is treated as "not configured".
 */
export function parseTeamId(raw: string | undefined | null): string | null {
  const v = (raw ?? "").trim().toUpperCase();
  return TEAM_ID_RE.test(v) ? v : null;
}

/**
 * Parse a comma- (or whitespace-) separated list of SHA-256 fingerprints as
 * printed by `keytool -list -v` / `eas credentials` (e.g.
 * "AA:BB:...:FF, 11:22:...:00"). Lower-case hex is accepted and upper-cased;
 * anything that is not a full 32-byte fingerprint is dropped. Order is kept,
 * duplicates removed.
 */
export function parseSha256Fingerprints(raw: string | undefined | null): string[] {
  const out: string[] = [];
  for (const part of (raw ?? "").split(/[\s,;]+/)) {
    const fp = part.trim().toUpperCase();
    if (fp && SHA256_FP_RE.test(fp) && !out.includes(fp)) out.push(fp);
  }
  return out;
}

export function buildAppleAppSiteAssociation(
  teamIdRaw: string | undefined | null,
  bundleId: string = APP_BUNDLE_ID,
): Built<AppleAppSiteAssociation> | NotConfigured {
  const teamId = parseTeamId(teamIdRaw);
  if (!teamId) {
    return {
      ok: false,
      hint:
        "Set APPLE_TEAM_ID to the 10-character Apple Developer Team ID " +
        "(Developer portal → Membership details) to publish " +
        "apple-app-site-association. Until then iOS opens these links in Safari.",
    };
  }
  const appId = `${teamId}.${bundleId}`;
  return {
    ok: true,
    body: {
      applinks: {
        details: [
          {
            appIDs: [appId],
            components: UNIVERSAL_LINK_PATHS.map((p) => ({ "/": p })),
          },
        ],
      },
      // Lets iOS password AutoFill associate saved thestoro.com credentials
      // with the app's login screen (and vice-versa).
      webcredentials: { apps: [appId] },
    },
  };
}

export function buildAssetLinks(
  fingerprintsRaw: string | undefined | null,
  packageName: string = APP_BUNDLE_ID,
): Built<AssetLinks> | NotConfigured {
  const fps = parseSha256Fingerprints(fingerprintsRaw);
  if (fps.length === 0) {
    return {
      ok: false,
      hint:
        "Set ANDROID_SHA256_CERT_FINGERPRINTS to the comma-separated SHA-256 " +
        "fingerprint(s) of the signing certificate(s) (Play App Signing key " +
        "and, for internal builds, the EAS upload keystore) to publish " +
        "assetlinks.json. Until then Android opens these links in the browser.",
    };
  }
  return {
    ok: true,
    body: [
      {
        relation: [
          // App Links: the app may handle https://thestoro.com/* intents.
          "delegate_permission/common.handle_all_urls",
          // Credential Manager / Smart Lock: share saved web passwords with the app.
          "delegate_permission/common.get_login_creds",
        ],
        target: {
          namespace: "android_app",
          package_name: packageName,
          sha256_cert_fingerprints: fps,
        },
      },
    ],
  };
}
