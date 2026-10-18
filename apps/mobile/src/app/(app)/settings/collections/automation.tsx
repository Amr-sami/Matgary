import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, AppState, BackHandler, Linking, Platform, Pressable, Share, StyleSheet, Text, View } from "react-native";
import { Stack, useRouter } from "expo-router";
import * as Application from "expo-application";
import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import { useQueryClient } from "@tanstack/react-query";
import { collectionCredits } from "@matgary/api-client";

import { api } from "@/api/client";
import { IOS_SHORTCUT_NAME } from "@/collections/ios/steps";
import { collectionKeys, useCollectionAccounts } from "@/collections/queries";
import { ConsentScreen } from "@/components/collections/setup/ConsentScreen";
import { DeviceStep } from "@/components/collections/setup/DeviceStep";
import * as store from "@/components/collections/setup/device-store";
import { collectionsErrorText, errorCode } from "@/components/collections/setup/errors";
import { IosSteps } from "@/components/collections/setup/IosSteps";
import { useSetupNotice } from "@/components/collections/setup/notice";
import { StepFrame } from "@/components/collections/setup/StepFrame";
import { TokenCard } from "@/components/collections/setup/TokenCard";
import { useCollectionDevices, useCollectionsConfig, listStateOf } from "@/components/collections/setup/useDevices";
import { useCollectionsAccess } from "@/components/collections/setup/useCollectionsAccess";
import { VerifyStep, type VerifyState } from "@/components/collections/setup/VerifyStep";
import {
  VERIFY_POLL_MS,
  VERIFY_TIMEOUT_MS,
  arrived,
  clampLabel,
  healthTone,
  iosMajor,
  resolveAutomationPath,
  resumeAction,
  shortcutOpenUrl,
  shortcutRunTestUrl,
  simulateTestBody,
  stepsFor,
  tokenPrefix,
  unsupportedKey,
  type AutomationPath,
  type WizardStep,
} from "@/components/collections/setup/wizard";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { SettingsHeader } from "@/components/ui/SettingsHeader";
import { t } from "@/i18n";
import { goBack } from "@/lib/nav";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * M2: neither native module is imported (09 §4.6.1): the App Intent branch
 * arrives with 10's `modules/collections-ingest` (09 step 17, M3) and the
 * Android branch with 11's listener (09 step 19, M4). Until then the app
 * builds without their folders.
 */
const MODULES = { iosIntent: false, androidListener: false } as const;

const TONE_VARIANT = { danger: "outofstock", warning: "lowstock", neutral: "neutral", success: "success" } as const;
const HUB = "/settings/collections" as const;

/**
 * "Confirm transfers automatically" — the automation wizard (doc 15 spec 09
 * §4.6, M2 frame + spec 10's iOS shortcut branch; one PR, README §3 order 24).
 *
 * intro → consent → device → install → enable → verify → done, or
 * `unsupported` alone (§4.6.2). The device POST is sent only after
 * `collection-consent-agree`; declining or going back on consent sends
 * nothing. The ingest token lives ONLY in `tokenRef` (never MMKV, the query
 * cache, logs or params, 09 §4.6.4); it leaves the app once, through the
 * share sheet, into the shortcut's import question. `done` is reachable
 * only after the server recorded a newer `lastMessageAt` for this device.
 *
 * Resume (§4.6.6): the non-secret MMKV record + the devices list decide where
 * a relaunch lands — a lost token restarts at consent with
 * `replacesDeviceId` (07 revokes the old row as `replaced`, no DELETE).
 */
export default function AutomationWizardScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useSession((s) => s.me);
  const access = useCollectionsAccess();
  const enabled = access.canManage && access.ingest;

  const configQ = useCollectionsConfig(enabled);
  const devicesQ = useCollectionDevices(enabled);
  const accountsQ = useCollectionAccounts(enabled);
  const accounts = useMemo(() => (accountsQ.accounts ?? []).filter((a) => !a.archivedAt), [accountsQ.accounts]);

  const ingest = configQ.data?.ingest ?? null;
  const major = Platform.OS === "ios" ? iosMajor(Platform.Version) : 0;
  const ready = configQ.isSuccess && accountsQ.accounts != null;
  const path: AutomationPath | null = useMemo(() => {
    if (!enabled) return { kind: "unsupported", reason: "ingest_off" };
    if (!ready) return null;
    return resolveAutomationPath({
      os: Platform.OS,
      osVersion: Platform.Version,
      ingest: access.ingest && configQ.data?.features?.collectionsIngest !== false,
      activeAccounts: accounts.length,
      config: ingest ?? {},
      modules: MODULES,
    });
  }, [enabled, ready, access.ingest, configQ.data, accounts.length, ingest]);

  const steps = path ? stepsFor(path) : [];
  const [step, setStep] = useState<WizardStep | null>(null);
  const [summary, setSummary] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // The token: memory only (09 §4.6.4 rule 1). Cleared on done and unmount.
  const tokenRef = useRef<string | null>(null);
  const ingestUrlRef = useRef<string | null>(null);
  const [prefix, setPrefix] = useState<string | null>(null);
  const [replacesId, setReplacesId] = useState<string | null>(null);
  const consentVersionRef = useRef<string | null>(null);
  useEffect(() => () => {
    tokenRef.current = null;
  }, []);

  // ── resume (§4.6.6), decided once per mount ────────────────────────────────
  const decided = useRef(false);
  useEffect(() => {
    if (decided.current || !path) return;
    if (path.kind === "unsupported") {
      decided.current = true;
      setStep("unsupported");
      return;
    }
    const list = listStateOf(devicesQ);
    if (!list.ok && (devicesQ.isPending || devicesQ.isFetching)) return; // wait for a fresh list
    const rec = store.read();
    let a = resumeAction(rec, list);
    if (a.kind === "keep" && rec) {
      // The list is unknown (offline / 5xx / 403): decide on the record alone, never clear.
      a = !rec.tokenDelivered && rec.deviceId
        ? { kind: "token_lost", replacesDeviceId: rec.deviceId }
        : rec.completedAt
          ? { kind: "summary" }
          : { kind: "resume_enable" };
    }
    decided.current = true;
    switch (a.kind) {
      case "clear":
        store.clear();
        setStep("intro");
        break;
      case "token_lost":
        store.write({ deviceId: null, replacesDeviceId: a.replacesDeviceId, tokenDelivered: false, completedAt: null });
        setReplacesId(a.replacesDeviceId);
        setNotice(t("mobile.collections.setup.token.lost"));
        setStep("consent");
        break;
      case "resume_enable":
        setStep("enable");
        break;
      case "summary":
        setSummary(true);
        setStep("done");
        break;
      default:
        setStep("intro");
    }
  }, [path, devicesQ]);

  const leave = useCallback(() => goBack(HUB), []);

  const decline = useCallback(() => {
    // No request is sent on decline (09 §6.10).
    useSetupNotice.getState().put({ tone: "ok", text: t("mobile.collections.setup.consentDeclined") });
    leave();
  }, [leave]);

  const prev = useCallback(() => {
    if (!step || step === "intro" || step === "unsupported" || step === "done") return leave();
    if (step === "consent") return decline();
    const i = steps.indexOf(step);
    // Back from install/enable/verify never re-creates a device: device → consent is the only re-entry.
    const target = steps[Math.max(0, i - 1)];
    if (target === "device" || target === "consent") return leave();
    // Resumed at enable after a relaunch: the token is gone, so install has nothing to share.
    if (target === "install" && !tokenRef.current) return leave();
    setStep(target);
  }, [step, steps, leave, decline]);

  // Android hardware back moves one step back; on consent it is a decline.
  useEffect(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      prev();
      return true;
    });
    return () => sub.remove();
  }, [prev]);

  // ── device ─────────────────────────────────────────────────────────────────
  const defaultLabel = useMemo(
    () =>
      clampLabel(
        t("mobile.collections.setup.device.default", {
          name: me?.user?.name ?? "",
          model: Device.modelName ?? (Platform.OS === "ios" ? "iPhone" : "Android"),
        }).replace(/^\s*—\s*/, ""),
      ),
    [me?.user?.name],
  );
  const [label, setLabel] = useState<string | null>(null);
  const [allAccounts, setAllAccounts] = useState(true);
  const [picked, setPicked] = useState<string[]>([]);
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [limitReached, setLimitReached] = useState(false);
  const [creating, setCreating] = useState(false);
  const idemRef = useRef<string | null>(null);
  useEffect(() => {
    if (step === "device") idemRef.current = Crypto.randomUUID(); // one key per device step (09 §4.6.4)
  }, [step]);

  const create = async () => {
    if (!path || path.kind === "unsupported" || path.kind === "android_listener") return;
    const version = consentVersionRef.current;
    if (!version) return setStep("consent");
    setCreating(true);
    setDeviceError(null);
    setLimitReached(false);
    try {
      const scoped = allAccounts ? [] : picked;
      const res = await collectionCredits.createDevice(
        api,
        {
          label: clampLabel(label ?? defaultLabel) || defaultLabel,
          platform: path.platform,
          channels: path.channels,
          accountIds: scoped,
          branchId: access.isOwner ? null : (me?.branch?.id ?? null),
          consentVersion: version,
          consentAccepted: true,
          ...(replacesId ? { replacesDeviceId: replacesId } : {}),
          appVersion: Application.nativeApplicationVersion ?? null,
          osVersion: String(Platform.Version),
        },
        idemRef.current ?? Crypto.randomUUID(),
      );
      if (!res.token) {
        // An idempotent replay after first use (07 §4.11): the lost-token row.
        store.write({ deviceId: null, replacesDeviceId: res.device.id, tokenDelivered: false, completedAt: null });
        setReplacesId(res.device.id);
        setNotice(t("mobile.collections.setup.token.lost"));
        setStep("consent");
        return;
      }
      tokenRef.current = res.token;
      ingestUrlRef.current = res.ingestUrl;
      setPrefix(tokenPrefix(res.token));
      const labels = scoped.map((id) => accounts.find((a) => a.id === id)?.label).filter((x): x is string => !!x);
      store.write({
        deviceId: res.device.id,
        platform: res.device.platform,
        variant: path.variant,
        tokenDelivered: false,
        baselineSeenAt: res.device.lastSeenAt,
        baselineMessageAt: res.device.lastMessageAt,
        createdAt: res.device.createdAt,
        completedAt: null,
        replacesDeviceId: null,
        accountLabels: labels,
      });
      if (replacesId) setNotice(t("mobile.collections.setup.device.replaced"));
      else setNotice(null);
      setReplacesId(null);
      setShared(false);
      setOpened(false);
      await qc.invalidateQueries({ queryKey: collectionKeys.devices() });
      setStep("install");
    } catch (e) {
      const code = errorCode(e);
      if (code === "INGEST_DISABLED" || code === "COLLECTIONS_DISABLED") {
        setStep("unsupported");
        return;
      }
      if (code === "DEVICE_LIMIT_REACHED") setLimitReached(true);
      if (__DEV__ && code === "INVALID_REQUEST") console.warn("[collections] device POST rejected", e);
      setDeviceError(collectionsErrorText(e, t("mobile.common.serverError")));
    } finally {
      setCreating(false);
    }
  };

  // ── install (ios_shortcut) ─────────────────────────────────────────────────
  const [shared, setShared] = useState(false);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (shared && opened) store.write({ tokenDelivered: true });
  }, [shared, opened]);

  const shareToken = async () => {
    const token = tokenRef.current;
    if (!token) return;
    try {
      const r = await Share.share({ message: token });
      if (r.action === Share.sharedAction) setShared(true);
    } catch {
      // The sheet failed to open; the button stays.
    }
  };

  const openLink = async () => {
    if (!path || (path.kind !== "ios_shortcut" && path.kind !== "ios_app_intent")) return;
    try {
      await Linking.openURL(path.url);
      setOpened(true);
    } catch {
      setNotice(t("mobile.collections.setup.unsupported.linkMissing"));
    }
  };

  const shortcutName = t("mobile.collections.ios.shortcutName") || IOS_SHORTCUT_NAME;
  const openShortcut = () => {
    void Linking.openURL(shortcutOpenUrl(shortcutName)).catch(() => undefined);
  };

  // ── verify (§4.6.7) ───────────────────────────────────────────────────────
  const [verify, setVerify] = useState<VerifyState>("idle");
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const baselineRef = useRef<string | null>(null);
  const startedRef = useRef(0);

  const thisDevice = (list: collectionCredits.DevicesResponse | undefined) => {
    const id = store.read()?.deviceId;
    return id ? list?.devices.find((d) => d.id === id) ?? null : null;
  };

  const captureBaseline = async (): Promise<boolean> => {
    try {
      const list = await collectionCredits.listDevices(api);
      const d = thisDevice(list);
      if (!d || d.revokedAt) {
        // Revoked meanwhile: the record is stale; start again.
        store.clear();
        setSummary(false);
        setStep("intro");
        return false;
      }
      baselineRef.current = d.lastMessageAt;
      store.write({ baselineMessageAt: d.lastMessageAt, baselineSeenAt: d.lastSeenAt });
      return true;
    } catch (e) {
      setVerifyError(collectionsErrorText(e, t("mobile.common.serverError")));
      return false;
    }
  };

  const sendTest = async () => {
    setVerifyError(null);
    if (!(await captureBaseline())) return;
    startedRef.current = Date.now();
    setVerify("waiting");
    try {
      await Linking.openURL(shortcutRunTestUrl(shortcutName));
    } catch {
      // Shortcuts missing (simulator): keep waiting; the dev simulate button or a manual run still posts.
    }
  };

  const simulate = async () => {
    const token = tokenRef.current;
    if (!token || !path || path.kind === "unsupported") return;
    setVerifyError(null);
    if (!(await captureBaseline())) return;
    startedRef.current = Date.now();
    setVerify("waiting");
    try {
      const bytes = Crypto.getRandomBytes(16);
      const fp = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      const channel = path.kind === "android_listener" ? "android_notification" : "ios_sms";
      const url = ingestUrlRef.current ?? ingest?.ingestUrl ?? "/api/v1/collections/ingest";
      await collectionCredits.sendIngestTest(api, url, token, simulateTestBody(channel, fp, new Date()));
    } catch (e) {
      setVerifyError(collectionsErrorText(e, t("mobile.common.serverError")));
    }
  };

  const poll = useCallback(async () => {
    try {
      const list = await collectionCredits.listDevices(api);
      const d = thisDevice(list);
      if (d && arrived(baselineRef.current, d.lastMessageAt)) {
        setVerify("ok");
        store.write({ completedAt: new Date().toISOString(), tokenDelivered: true });
        tokenRef.current = null; // delivered and proven (rule 3)
        void qc.invalidateQueries({ queryKey: collectionKeys.devices() });
        return true;
      }
    } catch {
      // Offline blip: keep polling until the timeout.
    }
    if (Date.now() - startedRef.current >= VERIFY_TIMEOUT_MS) setVerify("timeout");
    return false;
  }, [qc]);

  useEffect(() => {
    if (verify !== "waiting") return;
    const id = setInterval(() => void poll(), VERIFY_POLL_MS);
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") void poll();
    });
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, [verify, poll]);

  // ok → done (never before ok).
  useEffect(() => {
    if (verify !== "ok" || step !== "verify") return;
    const id = setTimeout(() => setStep("done"), 1200);
    return () => clearTimeout(id);
  }, [verify, step]);

  // ── render ────────────────────────────────────────────────────────────────
  const header = (
    <SettingsHeader
      parentLabel={t("app.collectionsSettings.title")}
      title={t("mobile.collections.setup.title")}
      onBack={prev}
      fallback={HUB}
    />
  );
  const swipeBack = !step || step === "intro" || step === "done" || step === "unsupported";
  const screenOptions = <Stack.Screen options={{ gestureEnabled: swipeBack }} />;

  if (!access.canManage) {
    return (
      <Screen header={header}>
        {screenOptions}
        <Card>
          <Text style={styles.body}>{t("app.collectionsSettings.noPermission")}</Text>
        </Card>
      </Screen>
    );
  }

  if (!path || !step) {
    const failed = configQ.isError || accountsQ.query.isError;
    return (
      <Screen header={header}>
        {screenOptions}
        {failed ? (
          <Card>
            <Text style={styles.body}>{t("mobile.settings.loadFailed")}</Text>
            <Button
              label={t("mobile.settings.retry")}
              variant="outline"
              onPress={() => {
                void configQ.refetch();
                void accountsQ.query.refetch();
                void devicesQ.refetch();
              }}
            />
          </Card>
        ) : (
          <ActivityIndicator color={colors.accent} />
        )}
      </Screen>
    );
  }

  const n = Math.max(1, steps.indexOf(step) + 1);
  const total = steps.length;
  const isIos = path.kind === "ios_shortcut" || path.kind === "ios_app_intent";
  const mode = path.kind === "ios_app_intent" ? "intent" : "http";
  const variant = isIos ? path.variant : "legacy";
  const noticeEl = notice ? (
    <Pressable onPress={() => setNotice(null)} testID="collection-automation-notice">
      <Text style={styles.notice}>{notice}</Text>
    </Pressable>
  ) : null;

  let content: ReactNode = null;

  if (step === "unsupported") {
    const reason = path.kind === "unsupported" ? path.reason : "ingest_off";
    content = (
      <StepFrame step="unsupported" n={1} total={1}>
        <Text style={styles.body} testID={`collection-automation-unsupported-${reason}`}>
          {t(unsupportedKey(reason))}
        </Text>
        {reason === "no_accounts" ? (
          <Button
            label={t("app.collectionsSettings.accounts.addInstapay")}
            onPress={() => router.push("/settings/collections/account/new?rail=instapay" as never)}
          />
        ) : null}
        <Button label={t("mobile.collections.setup.back")} variant="outline" onPress={leave} />
      </StepFrame>
    );
  } else if (step === "intro") {
    const pathLine =
      path.kind === "android_listener"
        ? t("mobile.collections.setup.intro.pathAndroid")
        : variant === "ios27"
          ? t("mobile.collections.setup.intro.pathIos27", { version: String(major) })
          : t("mobile.collections.setup.intro.pathLegacy", { version: String(major) });
    const minutes = path.kind === "unsupported" ? 0 : path.minutes;
    content = (
      <StepFrame
        step="intro"
        n={n}
        total={total}
        primary={{ label: t("mobile.collections.setup.next"), onPress: () => setStep("consent") }}
        onFinishLater={leave}
      >
        <Text style={styles.body}>{t("mobile.collections.setup.intro.body")}</Text>
        <Text style={styles.body}>{t("mobile.collections.setup.intro.whichPhone")}</Text>
        <Text style={styles.body}>{t("mobile.collections.setup.intro.manualStays")}</Text>
        <Text style={styles.strong}>{pathLine}</Text>
        <Text style={styles.hint}>{t("mobile.collections.setup.intro.duration", { min: String(minutes) })}</Text>
      </StepFrame>
    );
  } else if (step === "consent") {
    content = (
      <StepFrame step="consent" n={n} total={total}>
        <ConsentScreen
          variant={path.kind === "android_listener" ? "android" : "ios"}
          onAgree={(version) => {
            consentVersionRef.current = version;
            setStep("device");
          }}
          onDecline={decline}
        />
      </StepFrame>
    );
  } else if (step === "device") {
    content = (
      <StepFrame
        step="device"
        n={n}
        total={total}
        primary={{ label: t("mobile.collections.setup.device.create"), onPress: () => void create(), loading: creating, disabled: creating || (!allAccounts && picked.length === 0) }}
        onFinishLater={leave}
      >
        <DeviceStep
          label={label ?? defaultLabel}
          onLabel={setLabel}
          accounts={accounts}
          allAccounts={allAccounts}
          onAllAccounts={setAllAccounts}
          selected={picked}
          onToggle={(id, on) => setPicked((p) => (on ? [...new Set([...p, id])] : p.filter((x) => x !== id)))}
          error={deviceError}
        />
        {limitReached ? (
          <Button
            label={t("mobile.collections.setup.devicesEntry.title")}
            variant="outline"
            onPress={() => router.push("/settings/collections/devices" as never)}
          />
        ) : null}
      </StepFrame>
    );
  } else if (step === "install") {
    const delivered = shared && opened;
    content = (
      <StepFrame
        step="install"
        n={n}
        total={total}
        primary={{ label: t("mobile.collections.setup.install.done"), onPress: () => setStep("enable"), disabled: !delivered }}
        onFinishLater={leave}
      >
        {prefix && mode === "http" ? <TokenCard prefix={prefix} onShare={() => void shareToken()} shared={shared} /> : null}
        <View testID="collection-automation-open-link" collapsable={false}>
          <Button
            label={t("mobile.collections.setup.install.openLink")}
            variant={opened ? "outline" : "primary"}
            onPress={() => void openLink()}
            disabled={mode === "http" && !shared}
          />
        </View>
        <IosSteps phase="install" mode={mode} variant={variant} iosMajor={major} />
      </StepFrame>
    );
  } else if (step === "enable") {
    content = (
      <StepFrame
        step="enable"
        n={n}
        total={total}
        primary={{ label: t("mobile.collections.setup.enable.done"), onPress: () => setStep("verify") }}
        onFinishLater={leave}
      >
        <View testID="collection-automation-open-shortcut" collapsable={false}>
          <Button label={t("mobile.collections.setup.install.openShortcut")} variant="outline" onPress={openShortcut} />
        </View>
        <IosSteps phase="enable" mode={mode} variant={variant} iosMajor={major} />
      </StepFrame>
    );
  } else if (step === "verify") {
    content = (
      <StepFrame step="verify" n={n} total={total} onFinishLater={leave}>
        <VerifyStep
          state={verify}
          onSend={() => void sendTest()}
          onSimulate={tokenRef.current ? () => void simulate() : undefined}
          mode={mode}
          variant={variant}
          iosMajor={major}
          error={verifyError}
        />
      </StepFrame>
    );
  } else if (step === "done") {
    const d = summary ? thisDevice(devicesQ.data) : null;
    const health = d?.health ?? null;
    const tone = health ? healthTone(health) : null;
    content = (
      <StepFrame
        step="done"
        n={n}
        total={total}
        primary={{ label: t("mobile.collections.setup.done.finish"), onPress: leave, testID: "collection-automation-finish" }}
      >
        <Text accessibilityRole="header" style={styles.title}>
          {t("mobile.collections.setup.done.title")}
        </Text>
        <Text style={styles.body}>{t("mobile.collections.setup.done.body")}</Text>
        <Text style={styles.hint}>{t("mobile.collections.setup.verify.realTransfer")}</Text>
        {summary ? (
          <View style={styles.summary} testID="collection-automation-summary">
            {d ? (
              <View style={styles.row}>
                <Text style={styles.strong}>{d.label}</Text>
                {tone && health ? (
                  <Badge label={t(`mobile.collections.setup.devices.health.${health}`)} variant={TONE_VARIANT[tone]} />
                ) : null}
              </View>
            ) : null}
            <VerifyStep
              state={verify}
              onSend={() => void sendTest()}
              mode={mode}
              variant={variant}
              iosMajor={major}
              error={verifyError}
            />
            <View testID="collection-automation-setup-again" collapsable={false}>
              <Button
                label={t("mobile.collections.setup.devices.setupAgain")}
                variant="outline"
                onPress={() => {
                  const rec = store.read();
                  setReplacesId(rec?.deviceId ?? null);
                  setSummary(false);
                  setVerify("idle");
                  setStep("consent");
                }}
              />
            </View>
          </View>
        ) : null}
      </StepFrame>
    );
  }

  return (
    <Screen header={header}>
      {screenOptions}
      {noticeEl}
      {content}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 20, color: colors.text },
  body: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 15, lineHeight: 24, color: colors.text },
  strong: { ...RTL_TEXT, flexShrink: 1, fontFamily: fonts.semibold, fontSize: 15, lineHeight: 24, color: colors.text },
  hint: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, lineHeight: 20, color: colors.textSecondary },
  notice: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 14,
    lineHeight: 22,
    color: colors.warningStrong,
    backgroundColor: colors.warningLight,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  summary: { gap: spacing.md, marginTop: spacing.md },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
});
