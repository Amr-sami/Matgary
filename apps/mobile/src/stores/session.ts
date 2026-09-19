import { create } from "zustand";
import * as Device from "expo-device";
import { createMMKV } from "react-native-mmkv";
import { ApiError, auth, me as meApi, type MeResponse } from "@matgary/api-client";

import { api, deviceMeta, onSessionLost, setActiveBranchId } from "@/api/client";
import { getLocale, t } from "@/i18n";
import { getInstallId } from "@/auth/installId";
import { sessionEndedText } from "@/lib/errors";
import { markBoot } from "@/observability/perf";
import { useCart } from "@/stores/cart";

type Status = "loading" | "signedOut" | "signedIn";

/**
 * What the two-factor screen renders under the code field. Structured, not
 * a string, because the screen decides differently per case: a wrong code
 * stays on the screen with the count, everything terminal (expiry, the last
 * attempt burnt) clears `challenge` and lands on the login screen instead.
 */
export type TwoFactorError =
  | { code: "INVALID_CODE"; attemptsLeft: number | null }
  | { code: "OTHER"; message: string };

interface SessionState {
  status: Status;
  me: MeResponse | null;
  /**
   * `me` is the copy cached on the last successful /me, not this launch's
   * answer: the device was offline (or the server unreachable) at bootstrap
   * and the session was restored so the cashier can keep selling from the
   * snapshots (doc 06 §6.6). Cleared by the next successful /me, which
   * <SnapshotRefresher/> asks for as soon as connectivity returns.
   */
  offline: boolean;
  /**
   * What the login form shows under the fields. Set by signIn (the reason
   * the attempt failed) and by every dead-session path (why the device was
   * signed out — revoked from another device, "sign out everywhere", an
   * expired refresh), so the drop to login is never silent. One slot, cleared
   * by the next sign-in attempt.
   */
  signInError: string | null;
  signingIn: boolean;
  /**
   * A sign-in that passed the password and is waiting on the authenticator
   * code: the one-shot challenge token the 409 TOTP_REQUIRED carried
   * (doc 14 C7). In memory only — it is worth five minutes and one use, so
   * there is nothing to persist; a relaunch starts over at the password.
   * `status` stays "signedOut" meanwhile: the root layout's guards keep the
   * public stack up, and the login screen pushes /two-factor when this is set.
   */
  challenge: string | null;
  twoFactorError: TwoFactorError | null;

  bootstrap: () => Promise<void>;
  signIn: (identifier: string, password: string) => Promise<void>;
  /**
   * Second step of signIn: trade `challenge` plus the code for a session and
   * finish exactly as signIn does (seeded from /me). Terminal failures —
   * CHALLENGE_EXPIRED, the fifth wrong code — clear `challenge` and put the
   * reason in `signInError`, so the login screen shows it after the pop.
   */
  verifyTwoFactor: (code: string) => Promise<void>;
  /** "Back to sign in": drop the challenge; the server lets it expire. */
  cancelTwoFactor: () => void;
  signOut: () => Promise<void>;
  switchBranch: (branchId: string) => Promise<void>;
  /**
   * Re-read /me without changing branch. Settings mutations (create, rename,
   * deactivate) and the switcher sheet call this so `me.branches` — which
   * only /me carries — does not go stale until the next launch.
   */
  refreshMe: () => Promise<void>;
  /**
   * Tokens were just minted by something other than signIn — signup, or the
   * trial store — and are already in the store. Seed the session from /me.
   */
  adoptSession: () => Promise<void>;
  /** Open the trial store as an ephemeral owner. */
  startDemo: () => Promise<void>;
}

/**
 * The confirmed branch, remembered across launches.
 *
 * Native has no `mg.branch` cookie, so without this every cold start sends
 * /me with no header and the server resolves the PRIMARY branch — a staff
 * member working at another location was silently moved back after every
 * restart. The id is not a secret (the server re-validates it against the
 * allow-list on every request and falls back to primary when it no longer
 * applies), so MMKV, not SecureStore. Cleared with the session.
 */
const branchStore = createMMKV({ id: "session" });
const KEY_BRANCH = "activeBranchId";
/**
 * The last good /me, so a cold launch with no network can still open the
 * app (doc 06 §6.6: a cashier must never be unable to sell; the only
 * allowed blocker is "never synced"). It lives here — not in the snapshot
 * table — because that table is keyed by the tenant id /me carries, so it is
 * unreadable until /me has been answered. Same lifetime as the tokens: only
 * read when tokens exist, and removed with the branch on every sign-out and
 * dead-session path. Permissions/plan flags in it are re-validated by the
 * server on every request, so it grants nothing the tokens do not.
 */
const KEY_ME = "lastMe";

function recallBranch(): string | null {
  return branchStore.getString(KEY_BRANCH) ?? null;
}

function recallMe(): MeResponse | null {
  const raw = branchStore.getString(KEY_ME);
  if (!raw) return null;
  try {
    const me = JSON.parse(raw) as MeResponse;
    return me && typeof me === "object" && me.tenant?.id && me.branch?.id ? me : null;
  } catch {
    return null;
  }
}

/** Adopt the branch the SERVER echoed: header for the next request + disk. */
function applyBranch(id: string | null) {
  setActiveBranchId(id);
  if (id) branchStore.set(KEY_BRANCH, id);
  else {
    branchStore.remove(KEY_BRANCH);
    branchStore.remove(KEY_ME);
  }
}

/** A /me the server just answered: branch header + disk, and the offline copy for the next cold start. */
function adoptMe(me: MeResponse) {
  applyBranch(me.branch.id);
  try {
    branchStore.set(KEY_ME, JSON.stringify(me));
  } catch {
    /* the cache is a convenience; the live session is unaffected */
  }
}

/** Error copy, from the shared dictionary so the language switch applies. */
export function messageFor(error: unknown): string {
  if (!(error instanceof ApiError)) return t("mobile.auth.unexpected");
  switch (error.kind) {
    case "credentials":
      return t("mobile.auth.badCredentials");
    case "offline":
      return t("mobile.common.offline");
    case "timeout":
      return t("mobile.common.timeout");
    case "rateLimited":
      return t("mobile.signup.tooMany");
    case "billing":
      // Three walls share the kind; only one of them is about billing.
      if (error.code === "TENANT_SUSPENDED") return t("mobile.common.tenantSuspended");
      if (error.code === "PASSWORD_CHANGE_REQUIRED") {
        return t("mobile.common.passwordChangeRequired");
      }
      return t("mobile.common.subscriptionInactive");
    case "conflict":
      return error.code === "TOTP_REQUIRED"
        ? t("mobile.auth.totpRequired")
        : t("mobile.auth.requestFailed");
    case "server":
      return t("mobile.common.serverError");
    case "session":
      return sessionEndedText(error);
    default:
      return t("mobile.auth.signInFailed");
  }
}

/**
 * The background half of bootstrap: this launch's /me, applied only while the
 * session still holds the copy it set out to confirm. If anything replaced
 * `me` meanwhile (signIn, switchBranch, refreshMe, a sign-out) the answer is
 * for a session that no longer exists on this device and is dropped.
 *
 *   ok      → adopt (branch header + disk + `offline: false`), as refreshMe does.
 *   fatal   → the session is dead server-side: sign out, exactly as the
 *             awaited path always did. The client already cleared the tokens.
 *   other   → offline / timeout / 5xx: the cache stays, flagged `offline`
 *             so SnapshotRefresher re-reads /me the moment connectivity is
 *             back (doc 06 §6.6) — the same state an offline cold start
 *             produced before.
 */
async function revalidateMe(cached: MeResponse): Promise<void> {
  const stillOurs = () => {
    const s = useSession.getState();
    return s.status === "signedIn" && s.me === cached;
  };
  try {
    const me = await meApi.getMe(api);
    if (!stillOurs()) return;
    adoptMe(me);
    useSession.setState({ me, offline: false });
    // The server resolved a DIFFERENT branch than the cached one (deactivated
    // or dropped from the allow-list since the last launch). Anything the
    // cashier put in the cart during the revalidation window was priced and
    // stock-checked against the cached branch; under the new header it would
    // drain A's stock while booking the revenue to B (recordSale has no
    // cross-branch guard) — the same reason switchBranch resets it.
    if (me.branch.id !== cached.branch.id) useCart.getState().reset();
  } catch (error) {
    if (!stillOurs()) return;
    const fatal = error instanceof ApiError && error.fatalToSession;
    if (fatal) {
      applyBranch(null);
      useSession.setState({
        status: "signedOut",
        me: null,
        offline: false,
        signInError: sessionEndedText(error),
      });
      return;
    }
    useSession.setState({ offline: true });
  }
}

export const useSession = create<SessionState>((set, get) => ({
  status: "loading",
  me: null,
  offline: false,
  signInError: null,
  signingIn: false,
  challenge: null,
  twoFactorError: null,

  /**
   * Called once at launch. A stored refresh token is worth 90 days, so the
   * common path is: tokens exist → the last good /me is adopted at once →
   * straight to the app, while this launch's /me revalidates in the
   * background (perf.md §5: the splash used to wait on that round trip, the
   * one boot phase a shop's connection can stretch to seconds).
   *
   * /me is still what proves the session, not the presence of tokens: the
   * access token may be expired (the client refreshes transparently) or the
   * session may have been revoked from another device, and only the server
   * knows. Adopting the cache first grants nothing the tokens do not — every
   * permission and plan flag in it is re-checked by the server on the first
   * request — and a fatal answer signs the device out exactly as before.
   */
  async bootstrap() {
    // A keychain that refuses to answer (missing entitlement on a mis-signed
    // build, a locked device at cold start) must not strand the app on the
    // splash: treat it as no session and let the user sign in.
    const tokens = await api.currentTokens().catch(() => null);
    if (!tokens) {
      set({ status: "signedOut", me: null });
      markBoot("bootstrap-done");
      return;
    }
    // Ask for the branch this device was last on; the server validates it
    // and echoes back the one it actually resolved.
    setActiveBranchId(recallBranch());

    const cached = recallMe();
    if (cached) {
      // Synchronous adoption: `status` leaves "loading" now, so the splash
      // lifts on fonts alone. `offline` stays false — the copy is being
      // confirmed right here, and SnapshotRefresher (which re-reads /me while
      // `offline` is set) must not fire a second, duplicate request.
      setActiveBranchId(cached.branch.id);
      set({ status: "signedIn", me: cached, offline: false, signInError: null });
      markBoot("bootstrap-done");
      void revalidateMe(cached);
      return;
    }

    // Never synced on this device: nothing to render from, so /me is awaited
    // as before — the login screen (with the reason) is the only alternative.
    try {
      const me = await meApi.getMe(api);
      adoptMe(me);
      set({ status: "signedIn", me, offline: false });
    } catch (error) {
      // A dead session (revoked, reused, refresh rejected) already cleared
      // storage inside the client — signing out is correct and final. The
      // reason goes where the login screen shows it, so the user learns why
      // the app asks for the password again.
      const fatal = error instanceof ApiError && error.fatalToSession;
      if (fatal) {
        applyBranch(null);
        set({ status: "signedOut", me: null, offline: false, signInError: sessionEndedText(error) });
      } else {
        set({ status: "signedOut", me: null, offline: false, signInError: messageFor(error) });
      }
    } finally {
      markBoot("bootstrap-done");
    }
  },

  async signIn(identifier, password) {
    set({ signingIn: true, signInError: null, challenge: null, twoFactorError: null });
    try {
      await auth.login(api, {
        identifier: identifier.trim(),
        password,
        deviceName: Device.deviceName ?? Device.modelName ?? undefined,
        platform: deviceMeta.platform,
        appVersion: deviceMeta.appVersion,
        installId: await getInstallId(),
      });

      // Login returns the RAW permissions column, which is empty for an owner.
      // /me returns the effective, owner-expanded set — that is the one the UI
      // may build navigation from, so the session is always seeded from /me.
      const me = await meApi.getMe(api);
      adoptMe(me);
      set({ status: "signedIn", me, offline: false, signingIn: false });
    } catch (error) {
      // The password was right and the account has 2FA on: not an error to
      // show, a step to take. The login screen routes to /two-factor on this.
      const challenge = auth.challengeTokenOf(error);
      if (challenge) {
        set({ signingIn: false, challenge, twoFactorError: null });
        return;
      }
      set({ signingIn: false, signInError: messageFor(error) });
    }
  },

  async verifyTwoFactor(code) {
    const challengeToken = get().challenge;
    if (!challengeToken || get().signingIn) return;
    set({ signingIn: true, twoFactorError: null });

    // Terminal: the challenge is gone server-side, so it goes here too. The
    // reason lands where the login screen already shows sign-in failures.
    const startOver = (message: string) =>
      set({ signingIn: false, challenge: null, twoFactorError: null, signInError: message });

    try {
      await auth.verifyTwoFactor(api, {
        challengeToken,
        code: code.trim(),
        device: {
          name: Device.deviceName ?? Device.modelName ?? undefined,
          platform: deviceMeta.platform,
          appVersion: deviceMeta.appVersion,
          installId: await getInstallId(),
        },
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === "CHALLENGE_EXPIRED") {
        startOver(t("mobile.twoFactor.expired"));
        return;
      }
      if (error instanceof ApiError && error.code === "INVALID_CODE") {
        const attemptsLeft = auth.attemptsLeftOf(error);
        // 0 means that was the last one: the server has already killed the
        // challenge, and a retry would only answer CHALLENGE_EXPIRED.
        if (attemptsLeft === 0) {
          startOver(t("mobile.twoFactor.tooManyAttempts"));
          return;
        }
        set({ signingIn: false, twoFactorError: { code: "INVALID_CODE", attemptsLeft } });
        return;
      }
      set({ signingIn: false, twoFactorError: { code: "OTHER", message: messageFor(error) } });
      return;
    }

    // The challenge is spent and the tokens are stored: from here on this is
    // signIn's tail. A /me that fails now (the connection dropped between the
    // two requests) is reported on the login screen, and the next attempt
    // mints a fresh challenge — the spent one must not be retried.
    try {
      const me = await meApi.getMe(api);
      adoptMe(me);
      set({
        status: "signedIn",
        me,
        offline: false,
        signingIn: false,
        challenge: null,
        twoFactorError: null,
        signInError: null,
      });
    } catch (error) {
      startOver(messageFor(error));
    }
  },

  cancelTwoFactor() {
    set({ challenge: null, twoFactorError: null, signInError: null });
  },

  async adoptSession() {
    // Never from the mint response: it carries the RAW permissions column,
    // which is empty for an owner. /me returns the effective set.
    const me = await meApi.getMe(api);
    adoptMe(me);
    set({ status: "signedIn", me, offline: false, signInError: null, signingIn: false });
  },

  async startDemo() {
    set({ signingIn: true, signInError: null });
    try {
      await auth.startDemo(api, {
        // The route seeds the ephemeral owner's language from this; without
        // it the trial store answers in Arabic to an English-mode app.
        locale: getLocale(),
        platform: deviceMeta.platform,
        appVersion: deviceMeta.appVersion,
        installId: await getInstallId(),
      });
      await get().adoptSession();
    } catch (error) {
      set({ signingIn: false, signInError: messageFor(error) });
    }
  },

  async signOut() {
    await auth.logout(api);
    applyBranch(null);
    set({ status: "signedOut", me: null, offline: false, signInError: null, challenge: null });
  },

  /**
   * Switching branch is a header change, not a request — so it is confirmed by
   * re-reading /me, which echoes back the branch the SERVER resolved. If the
   * id was not in the allow-list the server silently keeps the old one, and
   * this is what surfaces that instead of showing a branch we never got.
   *
   * The candidate id rides on THIS request only. The global header stays on
   * the current branch until the server has confirmed, so a query that
   * refetches meanwhile (focus, pull-to-refresh, another mutation's
   * invalidation) cannot fetch branch B's rows and cache them under branch
   * A's query key. `noBranch` suppresses the global header; the explicit one
   * takes its place.
   */
  async switchBranch(branchId) {
    const me = await api.request<MeResponse>("/api/v1/me", {
      noBranch: true,
      headers: { "X-Branch-Id": branchId },
    });
    // Not on the allow-list (or deactivated since /me was read): the server
    // resolved a different branch. Adopting THAT would silently move the user
    // somewhere they did not pick, so the session stays where it was.
    if (me.branch.id !== branchId) throw new Error("BRANCH_NOT_SWITCHED");
    adoptMe(me);
    set({ me, offline: false });
    // The POS cart was priced and stock-checked against the OLD branch. Under
    // the new header its product ids would drain A's stock while the revenue
    // books to B (recordSale has no cross-branch guard), so it goes with the
    // switch — here, so every caller (chip, Settings → Branches) is covered.
    useCart.getState().reset();
  },

  async refreshMe() {
    const me = await meApi.getMe(api);
    adoptMe(me);
    set({ me, offline: false });
  },
}));

// The client cannot import the store (that would be a cycle), so the store
// registers itself here.
//
// Fires from inside the client the moment a refresh is refused (or a 401 the
// client may not refresh past), with the ApiError that carries the server's
// code — so the login screen can say WHY, not just drop the user there: a
// "sign out everywhere" (SESSION_REVOKED), a reuse kill
// (TOKEN_REUSE_DETECTED), or the generic sentence for everything else. The
// tokens are already gone; this only mirrors that into the UI.
onSessionLost((error) => {
  applyBranch(null);
  useSession.setState({
    status: "signedOut",
    me: null,
    offline: false,
    signInError: sessionEndedText(error),
    challenge: null,
    twoFactorError: null,
  });
});
