import { useEffect, useRef } from "react";
import { AppState, Platform } from "react-native";
import { useRouter } from "expo-router";
import { focusManager, useQueryClient } from "@tanstack/react-query";
import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import Constants from "expo-constants";
import { createMMKV } from "react-native-mmkv";
import { auth, notifications, type MeResponse } from "@matgary/api-client";

import { api } from "@/api/client";
import { NOTIFICATION_KEYS, canOpenRoute, toAppRoute } from "@/components/shell/NotificationBell";
import { t } from "@/i18n";
import { usePush } from "@/stores/push";
import { useSession } from "@/stores/session";

/**
 * Push registration + tap routing (doc 06 §8.5). Mounted once by <AppEffects/>.
 *
 * Registers AFTER login, never before — a token registered pre-auth belongs to
 * nobody. Re-registers on every login, when Expo rotates the device token, and
 * on demand from the settings card. The POST is sent once per (token, user):
 * MMKV "push" remembers what the server already has.
 *
 * Everything here degrades silently: the simulator, a denied permission and a
 * dev build with no EAS projectId each record a status in `usePush` for the
 * settings card to explain, and never throw into the tree.
 */

const store = createMMKV({ id: "push" });
const KEY_TOKEN = "token"; // last token the server acknowledged
const KEY_USER = "user"; // … and the user it was registered for

const ANDROID_CHANNEL = "default";

// Foreground presentation: banner + list + sound + badge. Set at module scope
// so it is in place before the first notification can arrive.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

function describe(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function platform(): "ios" | "android" {
  return Platform.OS === "android" ? "android" : "ios";
}

/**
 * Server schema is `z.string().trim().min(1).max(120).optional()`; an empty
 * Android DEVICE_NAME or a long iOS name must not turn into a permanent 400.
 */
function deviceName(): string | undefined {
  const name = (Device.deviceName ?? Device.modelName ?? "").trim().slice(0, 120);
  return name || undefined;
}

/**
 * True while `userId` is still the signed-in user. Checked after every await:
 * a sign-out (or the forced reset in stores/session.ts) mid-flight must not
 * repopulate the store the signedOut branch just cleared, nor POST with the
 * next account's bearer while remembering the old user id.
 */
function stillSignedInAs(userId: string): boolean {
  const s = useSession.getState();
  return s.status === "signedIn" && s.me?.user.id === userId;
}

/**
 * Spec §8.5: a push whose route this user may not open (a cashier's push about
 * /team) lands in the inbox instead of on the target screen's forbidden state.
 */
function permittedRoute(route: string, me: MeResponse | null): string {
  return canOpenRoute(route, me) ? route : "/notifications";
}

/**
 * Forget that the server has our token — called when the server tells us it
 * pruned it (a DeviceNotRegistered ticket on the test push). Leaves `status`
 * and `token` alone so the next register() re-mints and re-POSTs.
 */
export function forgetRegistration(): void {
  store.remove(KEY_TOKEN);
  store.remove(KEY_USER);
  usePush.getState().set({ registered: false });
}

/** POST the token unless the server already has it for this user. */
async function postToken(token: string, userId: string): Promise<void> {
  const push = usePush.getState();
  if (store.getString(KEY_TOKEN) === token && store.getString(KEY_USER) === userId) {
    push.set({ registered: true });
    return;
  }
  try {
    await notifications.registerPushToken(api, {
      token,
      platform: platform(),
      deviceName: deviceName(),
    });
    if (!stillSignedInAs(userId)) return;
    store.set(KEY_TOKEN, token);
    store.set(KEY_USER, userId);
    push.set({ registered: true, error: null });
  } catch (e) {
    if (!stillSignedInAs(userId)) return;
    // Token minted but the server did not take it — surface, and retry on the
    // next launch / foreground. Status stays "granted": permission is fine.
    push.set({ registered: false, error: describe(e) });
  }
}

/** Mint an Expo push token and hand it to the server. */
async function mintAndPost(userId: string): Promise<void> {
  const push = usePush.getState();
  const projectId: string | undefined =
    Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? undefined;
  if (!projectId) {
    push.set({
      status: "noProjectId",
      token: null,
      registered: false,
      error: t("mobile.push.noProjectIdDetail"),
    });
    return;
  }
  try {
    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (!stillSignedInAs(userId)) return;
    push.set({ status: "granted", token, error: null });
    await postToken(token, userId);
  } catch (e) {
    if (!stillSignedInAs(userId)) return;
    push.set({ status: "error", token: null, registered: false, error: describe(e) });
  }
}

/**
 * The whole registration flow. Idempotent; safe to call on every foreground.
 *
 * `prompt` decides whether a missing permission may open the OS dialog. Only
 * sign-in and the settings card's explicit retry prompt; the foreground retry
 * never does — on Android the first Deny leaves canAskAgain=true and the
 * dialog itself bounces AppState, so prompting there would re-ask on every
 * resume until the OS hard-denies (spec §8.5: degrade silently, retry on the
 * next launch).
 */
async function register(userId: string, opts: { prompt: boolean }): Promise<void> {
  const push = usePush.getState();
  if (!Device.isDevice) {
    push.set({ status: "unsupported", token: null, registered: false, error: null });
    return;
  }
  try {
    if (Platform.OS === "android") {
      // Before any notification arrives, or Android buckets everything into a
      // channel the user cannot tune (doc 06 §8.5).
      await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL, {
        name: t("mobile.push.channelDefault"),
        importance: Notifications.AndroidImportance.HIGH,
        sound: "default",
      });
    }
    let perm = await Notifications.getPermissionsAsync();
    if (!perm.granted && perm.canAskAgain && opts.prompt) {
      perm = await Notifications.requestPermissionsAsync();
    }
    if (!stillSignedInAs(userId)) return;
    if (!perm.granted) {
      push.set({ status: "denied", token: null, registered: false, error: null });
      return;
    }
  } catch (e) {
    if (!stillSignedInAs(userId)) return;
    push.set({ status: "error", token: null, registered: false, error: describe(e) });
    return;
  }
  await mintAndPost(userId);
}

export function PushRegistrar() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const status = useSession((s) => s.status);
  const userId = useSession((s) => s.me?.user.id ?? null);
  const attempt = usePush((s) => s.attempt);

  // A tap that arrived before the session was ready (cold start from a push)
  // waits here until we are signed in and the router can take it.
  const pendingRoute = useRef<string | null>(null);
  const handledResponse = useRef<string | null>(null);

  // Let auth.logout() unregister this device with the bearer still valid.
  useEffect(() => {
    auth.setPushTokenProvider(() => usePush.getState().token);
    return () => auth.setPushTokenProvider(null);
  }, []);

  // TanStack's refetchOnWindowFocus is inert on native until the focus manager
  // hears AppState; wiring it here is what makes the bell's 60s poll also
  // refresh the moment the app comes back to the foreground.
  useEffect(() => {
    focusManager.setEventListener((handleFocus) => {
      const sub = AppState.addEventListener("change", (state) => {
        handleFocus(state === "active");
      });
      return () => sub.remove();
    });
  }, []);

  // Register on sign-in (and on every retry); forget on sign-out.
  useEffect(() => {
    if (status === "signedIn" && userId) {
      void register(userId, { prompt: true });
      return;
    }
    if (status === "signedOut") {
      // auth.logout already sent the DELETE; drop the local memory so the next
      // account on this phone gets its own POST.
      store.remove(KEY_TOKEN);
      store.remove(KEY_USER);
      usePush.getState().reset();
      // The bell's badge and the inbox rows are per-user; a shared shop-floor
      // phone must not show the last cashier's unread count to the next one
      // for the bell's 30s staleTime, nor their rows until the refetch lands.
      queryClient.removeQueries({ queryKey: NOTIFICATION_KEYS.root });
    }
  }, [status, userId, attempt, queryClient]);

  // Expo rotates device tokens; re-mint the Expo token and re-POST.
  useEffect(() => {
    if (status !== "signedIn" || !userId || !Device.isDevice) return;
    const sub = Notifications.addPushTokenListener(() => {
      void mintAndPost(userId);
    });
    return () => sub.remove();
  }, [status, userId]);

  // Coming back to the foreground: a user who just flipped the OS switch, or
  // whose POST failed offline, gets another go without relaunching. Never
  // prompts — see register(); a still-denied permission is left alone.
  useEffect(() => {
    if (status !== "signedIn" || !userId) return;
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      const p = usePush.getState();
      const retryable =
        p.status === "denied" ||
        p.status === "error" ||
        (p.status === "granted" && !p.registered);
      if (retryable) void register(userId, { prompt: false });
    });
    return () => sub.remove();
  }, [status, userId]);

  // A notification arriving while the app is open: the inbox and the bell are
  // stale the instant it lands, so refresh both.
  useEffect(() => {
    const sub = Notifications.addNotificationReceivedListener(() => {
      void queryClient.invalidateQueries({ queryKey: NOTIFICATION_KEYS.root });
    });
    return () => sub.remove();
  }, [queryClient]);

  // Tap handling — warm (listener) and cold (last response), deduped by id.
  useEffect(() => {
    const handle = (resp: Notifications.NotificationResponse) => {
      const id = resp.notification.request.identifier;
      if (handledResponse.current === id) return;
      handledResponse.current = id;
      const data = resp.notification.request.content.data as
        | Partial<notifications.PushPayloadData>
        | null
        | undefined;
      // Existence is checked here; permission is checked in flush(), once the
      // session (and therefore `me`) is known.
      pendingRoute.current = toAppRoute(data?.route) ?? "/notifications";
      flush();
    };
    const flush = () => {
      const route = pendingRoute.current;
      if (!route) return;
      const session = useSession.getState();
      if (session.status !== "signedIn") return; // wait for sign-in
      pendingRoute.current = null;
      void queryClient.invalidateQueries({ queryKey: NOTIFICATION_KEYS.root });
      router.push(permittedRoute(route, session.me) as never);
    };
    const sub = Notifications.addNotificationResponseReceivedListener(handle);
    Notifications.getLastNotificationResponseAsync()
      .then((resp) => {
        if (resp) handle(resp);
      })
      .catch(() => {
        /* no last response, or not supported here */
      });
    return () => sub.remove();
    // router/queryClient are stable; re-subscribing on them would re-handle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Release a stashed cold-start route once the session is in.
  useEffect(() => {
    if (status !== "signedIn" || !pendingRoute.current) return;
    const route = pendingRoute.current;
    pendingRoute.current = null;
    router.push(permittedRoute(route, useSession.getState().me) as never);
  }, [status, router]);

  return null;
}
