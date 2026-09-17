import { create } from "zustand";
import * as Device from "expo-device";
import { ApiError, auth, me as meApi, type MeResponse } from "@matgary/api-client";

import { api, deviceMeta, onSessionLost, setActiveBranchId } from "@/api/client";
import { getInstallId } from "@/auth/installId";

type Status = "loading" | "signedOut" | "signedIn";

interface SessionState {
  status: Status;
  me: MeResponse | null;
  /** Populated only by signIn, for the login form. Cleared on the next attempt. */
  signInError: string | null;
  signingIn: boolean;

  bootstrap: () => Promise<void>;
  signIn: (identifier: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  switchBranch: (branchId: string) => Promise<void>;
  /**
   * Tokens were just minted by something other than signIn — signup, or the
   * trial store — and are already in the store. Seed the session from /me.
   */
  adoptSession: () => Promise<void>;
  /** Open the trial store as an ephemeral owner. */
  startDemo: () => Promise<void>;
}

/**
 * Arabic, because every user-facing string in this product is Arabic. These
 * live here rather than in a dictionary for now; they move to @matgary/i18n
 * when the shared dictionaries are wired up (doc 06 §11 step 2).
 */
function messageFor(error: unknown): string {
  if (!(error instanceof ApiError)) return "حدث خطأ غير متوقع";
  switch (error.kind) {
    case "credentials":
      return "بيانات الدخول غير صحيحة";
    case "offline":
      return "تعذّر الاتصال بالخادم";
    case "timeout":
      return "انتهت مهلة الاتصال";
    case "rateLimited":
      return "محاولات كثيرة. حاول بعد قليل";
    case "billing":
      return "الاشتراك غير مفعّل";
    case "conflict":
      return error.code === "TOTP_REQUIRED"
        ? "هذا الحساب يتطلب رمز تحقق"
        : "تعذّر إتمام الطلب";
    case "server":
      return "الخادم لا يستجيب";
    default:
      return "تعذّر تسجيل الدخول";
  }
}

export const useSession = create<SessionState>((set, get) => ({
  status: "loading",
  me: null,
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
      const me = await meApi.getMe(api);
      setActiveBranchId(me.branch.id);
      set({ status: "signedIn", me });
    } catch (error) {
      // Both paths land on the login screen today, but for different reasons,
      // and the user is told which.
      //
      // A dead session (revoked, reused, refresh rejected) already cleared
      // storage inside the client — signing out is correct and final.
      //
      // Offline-at-launch is NOT a signed-out state: the tokens are still good
      // and are deliberately left in the keychain, so the next launch with a
      // network recovers silently. The app simply cannot render yet, because
      // nothing is cached. Phase 3 caches /me and this branch becomes
      // "continue offline" instead.
      const fatal = error instanceof ApiError && error.fatalToSession;
      set({
        status: "signedOut",
        me: null,
        signInError: fatal ? null : messageFor(error),
      });
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
      setActiveBranchId(me.branch.id);
      set({ status: "signedIn", me, signingIn: false });
    } catch (error) {
      set({ signingIn: false, signInError: messageFor(error) });
    }
  },

  async adoptSession() {
    // Never from the mint response: it carries the RAW permissions column,
    // which is empty for an owner. /me returns the effective set.
    const me = await meApi.getMe(api);
    setActiveBranchId(me.branch.id);
    set({ status: "signedIn", me, signInError: null, signingIn: false });
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
    setActiveBranchId(null);
    set({ status: "signedOut", me: null, signInError: null });
  },

  /**
   * Switching branch is a header change, not a request — so it is confirmed by
   * re-reading /me, which echoes back the branch the SERVER resolved. If the
   * id was not in the allow-list the server silently keeps the old one, and
   * this is what surfaces that instead of showing a branch we never got.
   */
  async switchBranch(branchId) {
    const previous = get().me?.branch.id ?? null;
    setActiveBranchId(branchId);
    try {
      const me = await meApi.getMe(api);
      setActiveBranchId(me.branch.id);
      set({ me });
    } catch (error) {
      setActiveBranchId(previous);
      throw error;
    }
  },
}));

// The client cannot import the store (that would be a cycle), so the store
// registers itself here.
onSessionLost(() => {
  useSession.setState({ status: "signedOut", me: null });
});
