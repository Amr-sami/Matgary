import { create } from "zustand";
import * as Device from "expo-device";
import { createMMKV } from "react-native-mmkv";
import { ApiError, auth, me as meApi, type MeResponse } from "@matgary/api-client";

import { api, deviceMeta, onSessionLost, setActiveBranchId } from "@/api/client";
import { t } from "@/i18n";
import { getInstallId } from "@/auth/installId";
import { useCart } from "@/stores/cart";

type Status = "loading" | "signedOut" | "signedIn";

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
  /** Populated only by signIn, for the login form. Cleared on the next attempt. */
  signInError: string | null;
  signingIn: boolean;

  bootstrap: () => Promise<void>;
  signIn: (identifier: string, password: string) => Promise<void>;
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
    default:
      return t("mobile.auth.signInFailed");
  }
}

export const useSession = create<SessionState>((set, get) => ({
  status: "loading",
  me: null,
  offline: false,
  signInError: null,
  signingIn: false,

  /**
   * Called once at launch. A stored refresh token is worth 90 days, so the
   * common path is: tokens exist → /me succeeds → straight to the app.
   *
   * /me is what proves the session, not the presence of tokens: the access
   * token may be expired (the client refreshes transparently) or the session
   * may have been revoked from another device, and only the server knows.
   */
  async bootstrap() {
    const tokens = await api.currentTokens();
    if (!tokens) {
      set({ status: "signedOut", me: null });
      return;
    }
    try {
      // Ask for the branch this device was last on; the server validates it
      // and echoes back the one it actually resolved.
      setActiveBranchId(recallBranch());
      const me = await meApi.getMe(api);
      adoptMe(me);
      set({ status: "signedIn", me, offline: false });
    } catch (error) {
      // A dead session (revoked, reused, refresh rejected) already cleared
      // storage inside the client — signing out is correct and final.
      const fatal = error instanceof ApiError && error.fatalToSession;
      if (fatal) {
        applyBranch(null);
        set({ status: "signedOut", me: null, offline: false, signInError: null });
        return;
      }
      // Offline-at-launch is NOT a signed-out state: the tokens are still
      // good and stay in the keychain. With a cached /me the session is
      // restored as-is and the app renders from the snapshots; the first
      // successful /me (SnapshotRefresher asks on reconnect) replaces it.
      const cached = recallMe();
      if (cached) {
        setActiveBranchId(cached.branch.id);
        set({ status: "signedIn", me: cached, offline: true, signInError: null });
        return;
      }
      // Never synced on this device: nothing to render yet, so the login
      // screen it is, with the reason.
      set({ status: "signedOut", me: null, offline: false, signInError: messageFor(error) });
    }
  },

  async signIn(identifier, password) {
    set({ signingIn: true, signInError: null });
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
      set({ signingIn: false, signInError: messageFor(error) });
    }
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
    set({ status: "signedOut", me: null, offline: false, signInError: null });
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
onSessionLost(() => {
  applyBranch(null);
  useSession.setState({ status: "signedOut", me: null, offline: false });
});
