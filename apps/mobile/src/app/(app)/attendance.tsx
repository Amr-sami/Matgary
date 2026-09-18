import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import * as Location from "expo-location";
import { ArrowsClockwiseIcon as ArrowsClockwise } from "phosphor-react-native/src/icons/ArrowsClockwise";
import { CheckCircleIcon as CheckCircle } from "phosphor-react-native/src/icons/CheckCircle";
import { CrosshairIcon as Crosshair } from "phosphor-react-native/src/icons/Crosshair";
import { MapPinIcon as MapPin } from "phosphor-react-native/src/icons/MapPin";
import { MapPinAreaIcon as MapPinArea } from "phosphor-react-native/src/icons/MapPinArea";
import { ShieldWarningIcon as ShieldWarning } from "phosphor-react-native/src/icons/ShieldWarning";
import { WarningCircleIcon as WarningCircle } from "phosphor-react-native/src/icons/WarningCircle";
import { ApiError, attendance } from "@matgary/api-client";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { t } from "@/i18n";
import { shortDate } from "@/lib/format";
import {
  accuracyExceedsRadius,
  evaluateGeofence,
  formatDistance,
  toAccuracyM,
} from "@/lib/geo";
import { useSession } from "@/stores/session";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";
import { RTL_TEXT } from "@/theme/rtl";

/**
 * Geofenced self check-in — doc 02 §3.2, promoted from the web's dashboard
 * widget (components/team/SelfCheckIn.tsx) to a full screen.
 *
 * What the phone adds over the browser:
 *  - the permission is a stated state (undetermined / denied / services off),
 *    each with the one action that fixes it, instead of one opaque prompt;
 *  - the fix carries `accuracy`, shown and sent as `accuracyM`, and Android's
 *    `mocked` flag blocks the button outright — the fraud vector the web
 *    cannot see;
 *  - when the session can read store locations (`manage_team`) the distance to
 *    the nearest fence is computed on-device with the SAME haversine the
 *    server runs, so "outside range" is known before the 403 — and the button
 *    is disabled because the server enforces it. Other staff still get the
 *    server's verdict; the screen says so rather than pretending to know.
 *
 * Foreground permission only (v1 per §3.2). No background geofencing.
 */

type AttendanceEvent = attendance.AttendanceEvent;
type StoreLocation = attendance.StoreLocation;

type LocationState =
  | { kind: "idle" }
  | { kind: "undetermined" }
  | { kind: "denied"; canAskAgain: boolean }
  | { kind: "servicesOff" }
  | { kind: "locating" }
  | { kind: "error"; reason: "timeout" | "unavailable" }
  | {
      kind: "fix";
      latitude: number;
      longitude: number;
      accuracy: number | null;
      mocked: boolean;
      at: number;
    };
type Fix = Extract<LocationState, { kind: "fix" }>;

/** expo-location has no timeout option; the simulator without a fix hangs forever. */
const FIX_TIMEOUT_MS = 15_000;
/** A fix older than this is re-acquired before it is sent. */
const FIX_STALE_MS = 60_000;
const HISTORY_DAYS = 7;

const pad2 = (n: number) => String(n).padStart(2, "0");
/** ISO -> "HH:MM" in device-local time. No Intl on Hermes. */
function hhmm(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
/** Local "YYYY-MM-DD" bucket key. */
function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

interface Shift {
  day: string;
  inAt: string | null;
  outAt: string | null;
}

/** Pair check_in → next check_out per local day. Events arrive oldest-first. */
function pairShifts(events: AttendanceEvent[]): Shift[] {
  const shifts: Shift[] = [];
  let open: Shift | null = null;
  for (const e of events) {
    const day = dayKey(e.occurredAt);
    if (e.type === "check_in") {
      if (open) shifts.push(open);
      open = { day, inAt: e.occurredAt, outAt: null };
    } else if (open && open.day === day) {
      open.outAt = e.occurredAt;
      shifts.push(open);
      open = null;
    } else {
      shifts.push({ day, inAt: null, outAt: e.occurredAt });
    }
  }
  if (open) shifts.push(open);
  return shifts.reverse();
}

function durationLabel(inAt: string, outAt: string): string {
  const ms = new Date(outAt).getTime() - new Date(inAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.round(ms / 60_000);
  return t("mobile.attendance.history.duration", {
    h: Math.floor(mins / 60),
    m: mins % 60,
  });
}

export default function AttendanceScreen() {
  const me = useSession((s) => s.me);
  const qc = useQueryClient();
  const canReadTeam =
    !!me && (me.isOwner || me.permissions.includes("manage_team"));
  const canManual =
    !!me && (me.isOwner || me.permissions.includes("attendance_self_manual"));

  const [loc, setLoc] = useState<LocationState>({ kind: "idle" });
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(
    null,
  );
  // Ticks once a second while a fix is shown so "updated Ns ago" stays honest.
  const [now, setNow] = useState(() => Date.now());
  // iOS Precise Location off (or Android coarse-only): the fix is ~1-5 km wide.
  const [reducedAccuracy, setReducedAccuracy] = useState(false);
  // The in-flight fix, shared by the refresh icon and the submit path so two
  // concurrent acquisitions can never race on setLoc.
  const inflight = useRef<Promise<Fix | null> | null>(null);

  // ---- data -----------------------------------------------------------------
  const statusQ = useQuery({
    queryKey: ["attendance", "self-status"],
    queryFn: () => attendance.selfStatus(api),
  });

  const locationsQ = useQuery({
    queryKey: ["attendance", "locations"],
    queryFn: () => attendance.listLocations(api),
    enabled: canReadTeam,
    staleTime: 5 * 60_000,
  });

  // Anchored to local day bounds so the key is stable within a day: a status
  // refetch (pull, focus, a successful check-in) must not mint a new history
  // query and swap the list for a spinner.
  const historyRange = useMemo(() => {
    const to = new Date();
    to.setHours(23, 59, 59, 999);
    const from = new Date(to);
    from.setDate(from.getDate() - (HISTORY_DAYS - 1));
    from.setHours(0, 0, 0, 0);
    return { from: from.toISOString(), to: to.toISOString() };
  }, [statusQ.dataUpdatedAt]); // re-anchor "today" across midnight when status refreshes

  const historyQ = useQuery({
    queryKey: ["attendance", "events", me?.user.id, historyRange.from, historyRange.to],
    queryFn: () =>
      attendance.listEvents(api, {
        employeeId: me!.user.id,
        from: historyRange.from,
        to: historyRange.to,
      }),
    enabled: canReadTeam && !!me?.user.id,
    placeholderData: keepPreviousData,
  });

  // ---- location -------------------------------------------------------------
  /** Resolves to the fix now shown, or null when the card shows why there is none. */
  const acquireFix = useCallback((): Promise<Fix | null> => {
    if (inflight.current) return inflight.current;
    const run = async (): Promise<Fix | null> => {
      setLoc({ kind: "locating" });
      try {
        const enabled = await Location.hasServicesEnabledAsync().catch(() => true);
        if (!enabled) {
          setLoc({ kind: "servicesOff" });
          return null;
        }
        const pos = await withTimeout(
          Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
            mayShowUserSettingsDialog: true,
          }),
          FIX_TIMEOUT_MS,
        );
        const fix: Fix = {
          kind: "fix",
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy ?? null,
          mocked: pos.mocked === true,
          at: Date.now(),
        };
        setLoc(fix);
        return fix;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setLoc({
          kind: "error",
          reason: /timeout|timed out/i.test(msg) ? "timeout" : "unavailable",
        });
        return null;
      } finally {
        inflight.current = null;
      }
    };
    inflight.current = run();
    return inflight.current;
  }, []);

  const checkPermission = useCallback(
    async (request: boolean) => {
      const res = request
        ? await Location.requestForegroundPermissionsAsync()
        : await Location.getForegroundPermissionsAsync();
      if (res.status === Location.PermissionStatus.GRANTED) {
        setReducedAccuracy(
          res.ios?.accuracy === "reduced" || res.android?.accuracy === "coarse",
        );
        await acquireFix();
      } else if (res.status === Location.PermissionStatus.DENIED) {
        setLoc({ kind: "denied", canAskAgain: res.canAskAgain });
      } else {
        setLoc({ kind: "undetermined" });
      }
    },
    [acquireFix],
  );

  useEffect(() => {
    void checkPermission(false);
  }, [checkPermission]);

  // Coming back from Settings must re-read the permission without a pull.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (
        s === "active" &&
        (loc.kind === "denied" || loc.kind === "servicesOff" || reducedAccuracy)
      ) {
        void checkPermission(false);
      }
    });
    return () => sub.remove();
  }, [checkPermission, loc.kind, reducedAccuracy]);

  useEffect(() => {
    if (loc.kind !== "fix") return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [loc.kind]);

  // ---- geofence -------------------------------------------------------------
  const fence = useMemo(() => {
    if (loc.kind !== "fix" || !locationsQ.data) return null;
    return evaluateGeofence<StoreLocation>(loc, locationsQ.data);
  }, [loc, locationsQ.data]);
  const noLocations = canReadTeam && locationsQ.isSuccess && locationsQ.data.length === 0;
  const knownOutside = fence !== null && !fence.inside;
  const lowAccuracy =
    fence !== null && loc.kind === "fix" && accuracyExceedsRadius(loc.accuracy, fence.nearest.geofenceRadiusM);
  const mocked = loc.kind === "fix" && loc.mocked;

  // ---- submit ---------------------------------------------------------------
  const last = statusQ.data ?? null;
  const nextType: "check_in" | "check_out" =
    last?.type === "check_in" ? "check_out" : "check_in";

  const submit = useMutation({
    mutationFn: async (source: "geofence" | "manual") => {
      if (source === "manual") {
        return attendance.selfCheck(api, { type: nextType, source });
      }
      let fix: Fix | null = loc.kind === "fix" ? loc : null;
      if (!fix || Date.now() - fix.at > FIX_STALE_MS) {
        // Re-acquire through the same guarded path as the refresh icon, so the
        // coordinates we send are the ones we show — never a second racing fix.
        fix = await acquireFix();
        if (!fix) throw new Error("noFix");
      }
      if (fix.mocked) throw new Error("mocked");
      return attendance.selfCheck(api, {
        type: nextType,
        source,
        latitude: fix.latitude,
        longitude: fix.longitude,
        accuracyM: toAccuracyM(fix.accuracy),
      });
    },
    onSuccess: (event) => {
      setNotice({
        tone: "ok",
        text: t(
          event.type === "check_in"
            ? "app.team.selfCheckIn.toast.checkedIn"
            : "app.team.selfCheckIn.toast.checkedOut",
        ),
      });
      void qc.invalidateQueries({ queryKey: ["attendance"] });
    },
    onError: (err, source) => {
      let text = t("app.team.selfCheckIn.toast.saveFailed");
      if (err instanceof ApiError) {
        if (err.kind === "offline" || err.kind === "timeout") {
          // Nothing reached the server: retry once online, don't move.
          text = t("mobile.common.offline");
        } else if (err.status === 403) {
          // The manual path 403s only on a revoked attendance_self_manual.
          text = t(
            source === "manual"
              ? "mobile.attendance.errors.manualForbidden"
              : "mobile.attendance.errors.outside",
          );
        } else if (err.status === 409) {
          // Two 409s share the status: the check_out state machine (any
          // source) and the geofence path's "no store locations". check_in
          // never trips the former, and a manager already knows the latter.
          const stateMachine =
            nextType === "check_out" && (source === "manual" || !noLocations);
          text = t(
            stateMachine
              ? "mobile.attendance.errors.noOpenCheckIn"
              : "mobile.attendance.errors.noLocations",
          );
          // Our cached status disagreed with the server's — re-sync it.
          if (stateMachine)
            void qc.invalidateQueries({ queryKey: ["attendance", "self-status"] });
        } else if (err.status === 400) {
          text = err.message || text;
        }
      } else if (err instanceof Error && err.message === "mocked") {
        text = t("mobile.attendance.location.mocked");
      } else {
        // "noFix": acquireFix already put the reason (timeout, services off,
        // unavailable) in the location card, with its retry button.
        text = t("app.team.selfCheckIn.toast.geoFailed");
      }
      setNotice({ tone: "err", text });
      // The server said no on location — the fix we hold is not to be trusted.
      if (source === "geofence" && err instanceof ApiError && err.status === 403)
        void acquireFix();
    },
  });

  // !isSuccess (pending OR error): without the server's last event we would be
  // guessing the direction, and a guessed check_in flags the real one for review.
  const geofenceDisabled =
    !statusQ.isSuccess ||
    submit.isPending ||
    loc.kind !== "fix" ||
    mocked ||
    knownOutside ||
    noLocations;

  // One line under the button saying WHY it is disabled (or who verifies).
  const buttonHint = statusQ.isError
    ? t("mobile.attendance.loadFailed")
    : mocked
      ? t("mobile.attendance.location.mocked")
      : noLocations
        ? t("mobile.attendance.geofence.noLocations")
        : knownOutside
          ? t("mobile.attendance.geofence.outsideHint")
          : loc.kind !== "fix"
            ? t("app.team.selfCheckIn.needsLocation")
            : canReadTeam
              ? null
              : t("mobile.attendance.geofence.serverChecks");

  const refresh = () => {
    setNotice(null);
    void qc.invalidateQueries({ queryKey: ["attendance"] });
    void checkPermission(false);
  };

  const shifts = useMemo(() => pairShifts(historyQ.data ?? []), [historyQ.data]);

  return (
    <Screen
      title={t("mobile.attendance.screenTitle")}
      subtitle={t("mobile.attendance.subtitle")}
      onRefresh={refresh}
    >
      {notice ? (
        <View style={[styles.notice, notice.tone === "ok" ? styles.noticeOk : styles.noticeErr]}>
          {notice.tone === "ok" ? (
            <CheckCircle size={18} color={colors.successStrong} weight="fill" />
          ) : (
            <WarningCircle size={18} color={colors.danger} weight="fill" />
          )}
          <Text
            style={[styles.noticeText, notice.tone === "ok" ? styles.okText : styles.errText]}
            testID="attendance-notice"
          >
            {notice.text}
          </Text>
        </View>
      ) : null}

      {/* ---- today's status ---- */}
      <Card style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.cardTitle}>{t("mobile.attendance.today")}</Text>
          {last ? (
            <Badge
              label={t(
                // Past-tense STATE, not the event verb — "Check out" read as a button.
                last.type === "check_in"
                  ? "app.team.selfCheckIn.toast.checkedIn"
                  : "app.team.selfCheckIn.toast.checkedOut",
              )}
              variant={last.type === "check_in" ? "success" : "neutral"}
            />
          ) : null}
        </View>
        {statusQ.isPending ? (
          <ActivityIndicator color={colors.accent} style={styles.spinner} />
        ) : statusQ.isError ? (
          <>
            <Text style={styles.errText}>{t("mobile.attendance.loadFailed")}</Text>
            <Button
              label={t("mobile.attendance.location.retry")}
              variant="outline"
              onPress={() => void statusQ.refetch()}
              style={styles.inlineBtn}
            />
          </>
        ) : last ? (
          <>
            <Text style={styles.statusHeadline} testID="attendance-status">
              {last.type === "check_in"
                ? t("app.team.selfCheckIn.checkedIn")
                : t("mobile.attendance.checkedOutAt", { time: hhmm(last.occurredAt) })}
            </Text>
            {last.type === "check_in" ? (
              <Text style={styles.muted}>
                {t("app.team.selfCheckIn.sinceLabel", { time: hhmm(last.occurredAt) })}
              </Text>
            ) : null}
            <Text style={styles.mutedSmall}>
              {t(`app.activityLabels.attendanceSources.${last.source}`)}
            </Text>
          </>
        ) : (
          <Text style={styles.statusHeadline} testID="attendance-status">{t("app.team.selfCheckIn.notYetToday")}</Text>
        )}
      </Card>

      {/* ---- the button ---- */}
      <View testID="attendance-check">
        <Button
          label={t(
            nextType === "check_in"
              ? "app.team.selfCheckIn.checkIn"
              : "app.team.selfCheckIn.checkOut",
          )}
          onPress={() => {
            setNotice(null);
            submit.mutate("geofence");
          }}
          loading={submit.isPending && submit.variables === "geofence"}
          disabled={geofenceDisabled}
          style={styles.bigBtn}
        />
      </View>
      {buttonHint ? <Text style={styles.underBtn}>{buttonHint}</Text> : null}

      {canManual ? (
        <>
          <Button
            label={t("app.team.selfCheckIn.manualButton")}
            variant="outline"
            onPress={() => {
              setNotice(null);
              submit.mutate("manual");
            }}
            loading={submit.isPending && submit.variables === "manual"}
            disabled={!statusQ.isSuccess || submit.isPending}
          />
          <Text style={styles.underBtn}>{t("mobile.attendance.manualHint")}</Text>
        </>
      ) : null}

      {/* ---- location card ---- */}
      <Card style={styles.card}>
        <View style={styles.rowBetween}>
          <View style={styles.rowGap}>
            <MapPin size={18} color={colors.accent} weight="fill" />
            <Text style={styles.cardTitle}>{t("mobile.attendance.location.title")}</Text>
          </View>
          {loc.kind === "fix" || loc.kind === "error" ? (
            <Pressable
              onPress={() => void acquireFix()}
              disabled={submit.isPending}
              hitSlop={8}
              style={styles.iconBtn}
              accessibilityLabel={t("mobile.attendance.location.refresh")}
            >
              <ArrowsClockwise size={18} color={colors.accent} />
            </Pressable>
          ) : null}
        </View>

        {loc.kind === "idle" || loc.kind === "locating" ? (
          <View style={styles.rowGap}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.muted}>{t("mobile.attendance.location.checking")}</Text>
          </View>
        ) : null}

        {loc.kind === "undetermined" || (loc.kind === "denied" && loc.canAskAgain) ? (
          <>
            <Text style={styles.body}>{t("mobile.attendance.location.permissionNeeded")}</Text>
            <Button
              label={t("mobile.attendance.location.allow")}
              onPress={() => void checkPermission(true)}
              style={styles.inlineBtn}
            />
          </>
        ) : null}

        {loc.kind === "denied" && !loc.canAskAgain ? (
          <>
            <View style={styles.rowGap}>
              <ShieldWarning size={18} color={colors.warningStrong} weight="fill" />
              <Text style={[styles.body, styles.flex]}>{t("mobile.attendance.location.denied")}</Text>
            </View>
            <Button
              label={t("mobile.attendance.location.openSettings")}
              variant="outline"
              onPress={() => void Linking.openSettings()}
              style={styles.inlineBtn}
            />
          </>
        ) : null}

        {loc.kind === "servicesOff" ? (
          <>
            <Text style={styles.body}>{t("mobile.attendance.location.servicesOff")}</Text>
            <View style={styles.btnRow}>
              {Platform.OS === "android" ? (
                <Button
                  label={t("mobile.attendance.location.openSettings")}
                  variant="outline"
                  onPress={() => void Linking.openSettings()}
                  style={styles.flex}
                />
              ) : null}
              <Button
                label={t("mobile.attendance.location.retry")}
                onPress={() => void acquireFix()}
                style={styles.flex}
              />
            </View>
          </>
        ) : null}

        {loc.kind === "error" ? (
          <>
            <Text style={styles.body}>
              {t(
                loc.reason === "timeout"
                  ? "mobile.attendance.location.timeout"
                  : "mobile.attendance.location.unavailable",
              )}
            </Text>
            <Button
              label={t("mobile.attendance.location.retry")}
              variant="outline"
              onPress={() => void acquireFix()}
              style={styles.inlineBtn}
            />
          </>
        ) : null}

        {loc.kind === "fix" ? (
          <>
            {fence ? (
              <View
                style={[
                  styles.fenceBox,
                  fence.inside ? styles.fenceInside : styles.fenceOutside,
                ]}
              >
                <MapPinArea
                  size={20}
                  color={fence.inside ? colors.successStrong : colors.danger}
                  weight="fill"
                />
                <View style={styles.flex}>
                  <Text
                    style={[styles.fenceText, fence.inside ? styles.okText : styles.errText]}
                    testID="attendance-fence"
                  >
                    {fence.inside
                      ? t("mobile.attendance.geofence.inside", {
                          distance: formatDistance(fence.distanceM, t),
                          radius: formatDistance(fence.nearest.geofenceRadiusM, t),
                        })
                      : t("mobile.attendance.geofence.outside", {
                          distance: formatDistance(fence.distanceM, t),
                          name: fence.nearest.name,
                          radius: formatDistance(fence.nearest.geofenceRadiusM, t),
                        })}
                  </Text>
                  {fence.inside ? (
                    <Text style={styles.mutedSmall}>
                      {t("mobile.attendance.geofence.nearest", { name: fence.nearest.name })}
                    </Text>
                  ) : null}
                </View>
              </View>
            ) : noLocations ? (
              <Text style={styles.body}>{t("mobile.attendance.geofence.noLocations")}</Text>
            ) : canReadTeam && locationsQ.isPending ? (
              <ActivityIndicator color={colors.accent} />
            ) : (
              <Text style={styles.muted}>{t("mobile.attendance.geofence.serverChecks")}</Text>
            )}

            {lowAccuracy && fence ? (
              <View style={styles.warnBox}>
                <WarningCircle size={16} color={colors.warningStrong} weight="fill" />
                <Text style={[styles.warnText, styles.flex]}>
                  {t("mobile.attendance.geofence.lowAccuracy", {
                    accuracy: formatDistance(loc.accuracy ?? 0, t),
                    radius: formatDistance(fence.nearest.geofenceRadiusM, t),
                  })}
                </Text>
              </View>
            ) : null}

            {reducedAccuracy ? (
              <>
                <View style={styles.warnBox}>
                  <WarningCircle size={16} color={colors.warningStrong} weight="fill" />
                  <Text style={[styles.warnText, styles.flex]}>
                    {t("mobile.attendance.location.reducedAccuracy")}
                  </Text>
                </View>
                <Button
                  label={t("mobile.attendance.location.openSettings")}
                  variant="outline"
                  onPress={() => void Linking.openSettings()}
                  style={styles.inlineBtn}
                />
              </>
            ) : null}

            {mocked ? (
              <View style={styles.warnBox}>
                <ShieldWarning size={16} color={colors.danger} weight="fill" />
                <Text style={[styles.errText, styles.flex]}>
                  {t("mobile.attendance.location.mocked")}
                </Text>
              </View>
            ) : null}

            <View style={styles.metaRow}>
              <View style={styles.rowGap}>
                <Crosshair size={14} color={colors.textSecondary} />
                <Text style={styles.mutedSmall}>
                  {loc.accuracy != null
                    ? t("mobile.attendance.location.accuracy", {
                        m: formatDistance(loc.accuracy, t),
                      })
                    : "—"}
                </Text>
              </View>
              <Text style={styles.mutedSmall}>
                {t("mobile.attendance.location.updatedAgo", {
                  s: Math.max(0, Math.round((now - loc.at) / 1000)),
                })}
              </Text>
            </View>
            <Text style={styles.coords}>
              {loc.latitude.toFixed(5)}, {loc.longitude.toFixed(5)}
            </Text>
          </>
        ) : null}
      </Card>

      {/* ---- last 7 days ---- */}
      <Card style={styles.card}>
        <Text style={styles.cardTitle}>{t("mobile.attendance.history.title")}</Text>
        {!canReadTeam ? (
          <Text style={styles.muted}>{t("mobile.attendance.history.managersOnly")}</Text>
        ) : historyQ.isPending ? (
          <ActivityIndicator color={colors.accent} style={styles.spinner} />
        ) : historyQ.isError ? (
          <>
            <Text style={styles.errText}>{t("mobile.attendance.loadFailed")}</Text>
            <Button
              label={t("mobile.attendance.location.retry")}
              variant="outline"
              onPress={() => void historyQ.refetch()}
              style={styles.inlineBtn}
            />
          </>
        ) : shifts.length === 0 ? (
          <EmptyState title={t("mobile.attendance.history.empty")} />
        ) : (
          shifts.map((s, i) => (
            <View
              key={`${s.day}-${s.inAt ?? ""}-${s.outAt ?? ""}-${i}`}
              style={[styles.shiftRow, i > 0 && styles.shiftBorder]}
            >
              <Text style={styles.shiftDay}>{shortDate(s.inAt ?? s.outAt)}</Text>
              <View style={styles.shiftTimes}>
                <Text style={styles.shiftTime}>
                  {t("app.team.selfCheckIn.checkIn")} {s.inAt ? hhmm(s.inAt) : "—"}
                </Text>
                <Text style={styles.shiftTime}>
                  {t("app.team.selfCheckIn.checkOut")}{" "}
                  {s.outAt ? hhmm(s.outAt) : t("mobile.attendance.history.stillIn")}
                </Text>
              </View>
              <Text style={styles.shiftDuration}>
                {s.inAt && s.outAt ? durationLabel(s.inAt, s.outAt) : ""}
              </Text>
            </View>
          ))
        )}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { marginTop: spacing.md, gap: spacing.sm },
  cardTitle: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 15, color: colors.text },
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
  },
  rowGap: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  flex: { flex: 1 },
  spinner: { alignSelf: "flex-start", marginVertical: spacing.sm },
  statusHeadline: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 20, color: colors.text },
  body: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 14, color: colors.text, lineHeight: 22 },
  muted: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary },
  mutedSmall: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary },
  okText: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.successStrong },
  errText: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.danger },
  warnText: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, color: colors.warningStrong, lineHeight: 20 },
  bigBtn: { marginTop: spacing.lg, minHeight: MIN_TOUCH + 12 },
  underBtn: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
    lineHeight: 18,
  },
  inlineBtn: { alignSelf: "flex-start", marginTop: spacing.xs },
  btnRow: { flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs },
  // The 18pt glyph is centred in a 44pt target, so without the pull-back it
  // sat (44 - 18) / 2 = 13pt inside the card's content edge while the status
  // pill above was flush. The negative marginEnd lands the glyph on that edge
  // and keeps the full 44pt target — it grows into the Card's own padding
  // (spacing.xl), never past the card.
  iconBtn: {
    minWidth: MIN_TOUCH,
    minHeight: MIN_TOUCH,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.full,
    marginEnd: -((MIN_TOUCH - 18) / 2),
  },
  fenceBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  fenceInside: { backgroundColor: colors.successLight, borderColor: colors.success },
  fenceOutside: { backgroundColor: colors.dangerLight, borderColor: colors.danger },
  fenceText: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 14, lineHeight: 21 },
  warnBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.warningLight,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.xs,
  },
  coords: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 11, color: colors.textSecondary },
  notice: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    marginTop: spacing.md,
  },
  noticeOk: { backgroundColor: colors.successLight },
  noticeErr: { backgroundColor: colors.dangerLight },
  noticeText: { flex: 1, lineHeight: 21 },
  shiftRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  shiftBorder: { borderTopWidth: 1, borderTopColor: colors.border },
  shiftDay: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 13, color: colors.text, minWidth: 78 },
  shiftTimes: { flex: 1, gap: 2 },
  shiftTime: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, color: colors.text },
  shiftDuration: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary },
});
