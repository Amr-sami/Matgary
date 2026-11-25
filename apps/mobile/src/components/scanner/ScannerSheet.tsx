import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAudioPlayer, setAudioModeAsync } from "expo-audio";
import {
  CameraView,
  useCameraPermissions,
  type BarcodeScanningResult,
  type BarcodeType,
} from "expo-camera";
import * as Haptics from "expo-haptics";
import { StatusBar } from "expo-status-bar";
import { XIcon as X } from "phosphor-react-native/src/icons/X";

import { Button } from "@/components/ui/Button";
import { useSheetPresence } from "@/components/ui/Sheet";
import { isRTL, t } from "@/i18n";
import { clearMark, mark, measure } from "@/observability/perf";
import { RTL_TEXT, directionStyle } from "@/theme/rtl";
import { MIN_TOUCH, colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Every symbology the shop might scan (doc 06 §2.8). itf14 is left out on
 * purpose: it is a carton code and a false positive at a till.
 *
 * QR is DELIBERATELY EXCLUDED. Many products print a QR code next to or
 * behind their 1D barcode (brand marketing link, warranty registration,
 * loyalty signup). When both are visible the camera decodes whichever
 * stabilises first — and the QR typically carries a URL, which then opens
 * the browser instead of looking up the product by SKU/barcode. The shop
 * only cares about the 1D product code (EAN / UPC / Code128 / Code39 serial
 * numbers). If a tenant ever needs a QR-only workflow we add a separate
 * scanner mode with its own code-type list; the retail-scan path stays
 * 1D-only.
 *
 * Doc URL: https://docs.expo.dev/versions/v57.0.0/sdk/camera/ — CameraView +
 * barcodeScannerSettings + onBarcodeScanned, useCameraPermissions.
 */
const BARCODE_TYPES: BarcodeType[] = [
  "ean13",
  "ean8",
  "upc_a",
  "upc_e",
  "code128",
  "code39",
];

/** The same code fired again inside this window is the decoder re-reading the same label. */
const REPEAT_WINDOW_MS = 1500;
// A real cashier can't aim at a second real barcode in less than ~400 ms.
// Any decode faster than this is almost always a mis-read in the same decode
// burst (shaky hand, two barcodes glimpsed at once). Reject it even if the
// code string is different — the SAME-code gate above already covers a slow
// re-aim at the same product.
const BURST_WINDOW_MS = 400;
// Stability threshold: require the SAME code to be decoded this many times
// in a row before we actually accept it. Real barcodes decode consistently
// across many camera frames (hold still → 10+ identical decodes in a second);
// ghost / stray decodes flicker between different codes and never stabilise.
// Two is the sweet spot — ~33 ms extra latency at 30fps, but phantom reads
// (Mac serial / nearby packaging) are filtered out entirely.
const STABILITY_REQUIRED = 2;
// How long a pending (unconfirmed) decode is "fresh". If no matching second
// frame arrives inside this window, we discard the pending state and treat
// the next decode as a fresh start.
const STABILITY_WINDOW_MS = 300;

export type ScanTone = "info" | "success" | "error";

export interface ScannerSheetProps {
  visible: boolean;
  onClose: () => void;
  /**
   * Fired once per accepted scan with the raw decoder output — the server
   * normalises it (findProductByBarcode). In "continuous" mode the sheet stays
   * open for the next item; in "single" mode it closes itself after this.
   */
  onScan: (code: string) => void;
  mode?: "continuous" | "single";
  /** Toast strip at the bottom — the last-scanned product's name, or the error. */
  message?: string | null;
  tone?: ScanTone;
  /**
   * "Not found → add this product?" overlay. When set, a centered card is
   * drawn over the camera view with the scanned code + an action row. The
   * card belongs to the scanner (not the opening screen) so the camera stays
   * running underneath: the owner can dismiss the card and try another scan
   * without leaving the sheet.
   */
  notFound?: {
    code: string;
    onAdd: () => void;
    onDismiss: () => void;
  } | null;
}

/**
 * The camera scanner (doc 06 §2.8), as a Modal — its own native root, so
 * direction is applied here again the way _layout.tsx does for the stack.
 *
 * Decoding is hardware: AVCaptureMetadataOutput on iOS, ML Kit on Android,
 * via expo-camera's CameraView. There is no JS decoder to prime and no beep
 * asset yet (assets/sounds/scan-beep.wav is still to be ported), so the
 * "heard it" feedback is the success haptic.
 *
 * The manual-entry row at the bottom is not a nicety — it is what a cashier
 * with a cracked lens or a refused permission uses, and on a simulator (no
 * camera at all) it is the only path that works.
 *
 * Presence follows `useSheetPresence` (see ui/Sheet.tsx): the sheet closes
 * when the screen that opened it loses focus, and hides — camera off — while
 * the app lock is armed. Maestro ids: `scanner-sheet` (root), `scanner-close`
 * (header X), `scanner-manual` (typed code), `scanner-manual-submit`,
 * `scanner-done` (Done / Cancel).
 */
export function ScannerSheet({
  visible,
  onClose,
  onScan,
  mode = "continuous",
  message,
  tone = "info",
  notFound = null,
}: ScannerSheetProps) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  // Preloaded "Tink" beep — played on every accepted scan. useAudioPlayer
  // keeps one player instance across renders; seekTo(0)+play() in accept()
  // lets rapid consecutive scans each fire the full sound.
  const beep = useAudioPlayer(require("@/assets/sounds/scan-beep.wav"));
  useEffect(() => {
    // Routes the player through iOS's "Playback" category so the beep is
    // audible even when the Ring/Silent switch is set to silent — a cashier
    // at a till does not want to miss confirmation because the phone is on
    // silent in the drawer. Fire-and-forget; a failure (older iOS) just means
    // the beep follows the Silent switch like any other sound.
    setAudioModeAsync({ playsInSilentMode: true }).catch(() => {});
  }, []);
  // On iOS physical devices, CameraView.isAvailableAsync() calls into a
  // native method the current expo-camera iOS module does not register, so the
  // Promise rejects and the probe falsely reports "no camera" on hardware that
  // very much has one. Default `true` on iOS (every iPhone/iPad has a camera);
  // the probe can still PROMOTE a null to false on web/Android/sim where the
  // native path actually answers.
  const [available, setAvailable] = useState<boolean | null>(Platform.OS === "ios" ? true : null);
  const [manual, setManual] = useState("");
  const last = useRef<{ code: string; at: number } | null>(null);
  // Rolling stability buffer for camera decodes. The decoder fires per frame
  // (~30fps); a real barcode produces the same `code` on every frame while
  // the camera holds it in view, so requiring STABILITY_REQUIRED matching
  // frames before accepting rejects one-off ghost reads that briefly decode
  // nearby packaging / monitor edges / Mac serial labels into a value that
  // happens to collide with an existing SKU.
  const pending = useRef<{ code: string; firstAt: number; hits: number } | null>(null);
  const finished = useRef(false);
  // Effective visibility: the owner's `visible` minus route blur (closes it)
  // and app lock (hides it). Everything below that used to read `visible` for
  // "is the sheet on screen" reads `shown`, so the camera is not kept hot
  // behind the lock cover.
  const shown = useSheetPresence(visible, onClose);

  useEffect(() => {
    if (!visible) return;
    finished.current = false;
    last.current = null;
    pending.current = null;
    setManual("");
    let cancelled = false;
    // iOS: the native CameraView.isAvailableAsync is not registered in the
    // current expo-camera module; the Promise rejects, we fall into .catch,
    // and `available` snaps to false — so the sheet showed "camera not
    // available" on every iPhone that very much had a camera. Every iOS
    // device has at least one camera, so skip the probe on iOS entirely and
    // let the initial state (`true` on iOS) stand. Android + web still probe
    // because those platforms genuinely answer the method.
    if (Platform.OS === "ios") return () => { cancelled = true; };
    CameraView.isAvailableAsync()
      .then((ok) => {
        if (!cancelled) setAvailable(ok);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible]);

  const accept = useCallback(
    (raw: string, source: "camera" | "manual") => {
      const code = raw.trim();
      if (!code || finished.current) return;
      const now = Date.now();
      // Two gates: same-code within 1.5 s (owner re-aims at same product) AND
      // any-code within 0.4 s (prevents "scan unknown item → got Casio +1" —
      // the camera decoded two different symbols in the same burst). The
      // ANY-code gate only fires for camera decodes; a human typing in the
      // manual field is never faster than 400 ms.
      if (last.current) {
        if (last.current.code === code && now - last.current.at < REPEAT_WINDOW_MS) return;
        if (source === "camera" && now - last.current.at < BURST_WINDOW_MS) return;
      }
      last.current = { code, at: now };
      if (source === "camera") {
        // §10.3 "camera open → first decode": measured once per opening, from
        // the frame the CameraView mounted (consumed so later codes in a
        // "continuous" session are not re-measured against the same start).
        // A typed code is not a decode: it neither closes this interval (the
        // camera decoded nothing) nor consumes the start the first real
        // decode of this opening is still waiting to be measured against.
        measure("pos.scan-decode", "pos.camera-open", { consume: true });
        // Start of "scan → line added": sales.tsx closes it after `cart.add`.
        mark("pos.scan-decoded");
      }
      // Fire-and-forget: a device without a Taptic engine rejects, and that
      // must never block the scan.
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      // Short "Tink" beep — fired for every scan (camera or manual) so the
      // cashier hears confirmation even if the phone is in silent mode (the
      // audio category sets playsInSilentModeIOS=true in the mount effect).
      try {
        beep.seekTo(0);
        beep.play();
      } catch {
        // The audio engine is optional for the scanner's correctness — never
        // throw out of accept() if it's not ready.
      }
      onScan(code);
      if (mode === "single") {
        finished.current = true;
        onClose();
      }
    },
    [mode, onClose, onScan],
  );

  const onBarcode = useCallback(
    (r: BarcodeScanningResult) => {
      const code = r.data?.trim();
      if (!code) return;
      const now = Date.now();
      const p = pending.current;
      // Same code as pending AND inside the stability window → it's stable.
      if (p && p.code === code && now - p.firstAt < STABILITY_WINDOW_MS) {
        const hits = p.hits + 1;
        if (hits >= STABILITY_REQUIRED) {
          pending.current = null;
          accept(code, "camera");
          return;
        }
        pending.current = { code, firstAt: p.firstAt, hits };
        return;
      }
      // Different code OR window expired → start a new pending. The old
      // ghost is forgotten; the next frame has to agree with THIS code.
      pending.current = { code, firstAt: now, hits: 1 };
    },
    [accept],
  );

  const submitManual = () => {
    const code = manual.trim();
    if (!code) return;
    setManual("");
    accept(code, "manual");
  };

  // The bottom "Done" is the way OUT, in every mode and every field state:
  // an empty field closes the sheet exactly like the header X; a typed code is
  // submitted first (the cashier typed it to use it — dropping it on Done
  // would be the same as never having typed), then the sheet closes. `accept`
  // already closed it in "single" mode (finished is set), so close once.
  const onDone = () => {
    const code = manual.trim();
    if (code) {
      setManual("");
      accept(code, "manual");
    }
    if (finished.current) return;
    finished.current = true;
    onClose();
  };

  const granted = permission?.granted === true;
  const cameraOn = shown && granted && available === true;
  // One filled button per state. While the camera works, "Done" is the way
  // out and manual entry is the outline fallback; the moment the cashier
  // starts typing — or the device has no camera at all, where typing is the
  // only path — the submit becomes the filled action and Done steps back.
  const manualOnly = granted && available === false;
  const manualPrimary = manual.trim().length > 0 || manualOnly;

  // The camera is mounted in this commit: the decode budget starts here.
  // Closing the sheet before any decode drops the mark, so the next opening
  // never inherits a stale start.
  useEffect(() => {
    if (cameraOn) mark("pos.camera-open");
    else clearMark("pos.camera-open");
  }, [cameraOn]);

  return (
    <Modal
      visible={shown}
      animationType="slide"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={[styles.root, directionStyle(isRTL())]} testID="scanner-sheet">
        {/* The sheet is near-black; the root layout's dark bar would leave the
            clock and battery unreadable on it. Last-mounted StatusBar wins, and
            the Modal drops its children on close, so the root's style returns. */}
        <StatusBar style="light" />
        {/* Header */}
        <View style={[styles.header, { paddingTop: insets.top + spacing.sm }]}>
          <Text style={styles.title}>{t("app.ui.scanner.title")}</Text>
          <Pressable
            onPress={onClose}
            hitSlop={8}
            style={styles.closeBtn}
            accessibilityRole="button"
            accessibilityLabel={t("app.common.close")}
            testID="scanner-close"
          >
            <X size={22} color={colors.bg} weight="bold" />
          </Pressable>
        </View>

        {/* Viewfinder */}
        <View style={styles.stage}>
          {cameraOn ? (
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              active={shown}
              barcodeScannerSettings={{ barcodeTypes: BARCODE_TYPES }}
              onBarcodeScanned={onBarcode}
            />
          ) : null}

          {cameraOn ? (
            <Frame />
          ) : (
            <View style={styles.state}>
              {permission === null || (granted && available === null) ? (
                <>
                  <ActivityIndicator color={colors.bg} />
                  <Text style={styles.stateText}>{t("app.ui.scanner.loading")}</Text>
                </>
              ) : !granted ? (
                permission.canAskAgain ? (
                  <>
                    <Text style={styles.stateText}>{t("app.ui.scanner.subtitle")}</Text>
                    <Button
                      label={t("app.ui.scanner.scanButton")}
                      onPress={() => void requestPermission()}
                    />
                  </>
                ) : (
                  <>
                    <Text style={styles.stateText}>{t("mobile.scanner.permissionDenied")}</Text>
                    <Button
                      label={t("app.shell.secondary.settings")}
                      onPress={() => void Linking.openSettings()}
                    />
                  </>
                )
              ) : (
                <Text style={styles.stateText}>{t("mobile.scanner.notSupported")}</Text>
              )}
            </View>
          )}

          {message && !notFound ? (
            <View
              style={[
                styles.toast,
                tone === "success" && styles.toastSuccess,
                tone === "error" && styles.toastError,
              ]}
              accessibilityLiveRegion="polite"
            >
              <Text
                numberOfLines={2}
                style={[
                  styles.toastText,
                  tone === "success" && styles.toastTextSuccess,
                  tone === "error" && styles.toastTextError,
                ]}
              >
                {message}
              </Text>
            </View>
          ) : null}

          {/* Not-found popup — a centered card on top of the camera. The
              scanner sheet stays open underneath, so after dismiss the owner
              is right back on the viewfinder with no mode switch. */}
          {notFound ? (
            <View style={styles.notFoundOverlay} pointerEvents="box-none">
              <View style={styles.notFoundCard} accessibilityLiveRegion="polite">
                <Text style={styles.notFoundTitle}>
                  {t("app.sales.form.productSearch.notFoundTitle")}
                </Text>
                <Text style={styles.notFoundBody}>
                  {t("app.sales.form.productSearch.notFoundBody", { code: notFound.code })}
                </Text>
                <View style={styles.notFoundActions}>
                  <Button
                    label={t("app.common.cancel")}
                    variant="outline"
                    onPress={notFound.onDismiss}
                    style={styles.notFoundBtn}
                  />
                  <Button
                    label={t("app.sales.form.productSearch.notFoundAddCta")}
                    onPress={notFound.onAdd}
                    style={styles.notFoundBtn}
                    testID="scanner-not-found-add"
                  />
                </View>
              </View>
            </View>
          ) : null}
        </View>

        {/* Manual entry + done */}
        <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.lg }]}>
          {/* With no camera the state text above already says "type the code
              below", so "Or …" has nothing to be an alternative to. */}
          <Text style={styles.manualLabel}>
            {t(manualOnly ? "mobile.scanner.manualLabelOnly" : "app.ui.scanner.manualLabel")}
          </Text>
          <View style={styles.manualRow}>
            <TextInput
              value={manual}
              onChangeText={setManual}
              onSubmitEditing={submitManual}
              submitBehavior="submit"
              placeholder={t("app.ui.scanner.manualPlaceholder")}
              placeholderTextColor={colors.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              testID="scanner-manual"
              // TextInput alignment is physical (no start/end swap), so the
              // locale picks the edge; inline because the locale can change
              // while the module-scope StyleSheet cannot.
              style={[styles.manualInput, { textAlign: isRTL() ? "right" : "left" }]}
            />
            {/* Button takes no testID; the app's convention is a wrapping
                View, which Maestro taps at its centre. */}
            <View testID="scanner-manual-submit">
              <Button
                label={t("app.ui.scanner.manualSubmit")}
                variant={manualPrimary ? "primary" : "outline"}
                disabled={!manual.trim()}
                onPress={submitManual}
              />
            </View>
          </View>
          {/* "Cancel" (single mode) discards a typed code; "Done" uses it. */}
          <View testID="scanner-done">
            <Button
              label={mode === "single" ? t("app.ui.scanner.cancel") : t("app.receiptDesigner.editor.done")}
              variant={manualPrimary ? "outline" : "primary"}
              onPress={mode === "single" ? onClose : onDone}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

/**
 * The dimmed frame with a clear scan window — four dim panels around a hole,
 * because RN cannot punch a transparent rect out of one overlay.
 */
function Frame() {
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <View style={styles.dim} />
      <View style={styles.windowRow}>
        <View style={styles.dim} />
        <View style={styles.window} />
        <View style={styles.dim} />
      </View>
      <View style={[styles.dim, styles.dimBottom]}>
        <Text style={styles.hint}>{t("app.ui.scanner.subtitle")}</Text>
      </View>
    </View>
  );
}

const WINDOW = 240;
/** The token near-black at ~55% — the viewfinder dim, and the sheet ground. */
const DIM = `${colors.text}8C`;

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.text },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
  },
  title: { fontFamily: fonts.bold, fontSize: 18, color: colors.bg, ...RTL_TEXT },
  closeBtn: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    alignItems: "center",
    justifyContent: "center",
  },
  stage: { flex: 1, overflow: "hidden", backgroundColor: colors.text },
  state: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.lg,
    paddingHorizontal: spacing.xxl,
  },
  stateText: {
    fontFamily: fonts.regular,
    fontSize: 15,
    lineHeight: 22,
    color: colors.bg,
    textAlign: "center",
  },
  dim: { flex: 1, backgroundColor: DIM },
  dimBottom: { alignItems: "center", paddingTop: spacing.lg },
  windowRow: { flexDirection: "row", height: WINDOW },
  window: {
    width: WINDOW,
    height: WINDOW,
    borderWidth: 2,
    borderColor: colors.bg,
    borderRadius: radius.lg,
  },
  hint: {
    fontFamily: fonts.medium,
    fontSize: 14,
    lineHeight: 20,
    color: colors.bg,
    textAlign: "center",
    paddingHorizontal: spacing.xxl,
  },
  toast: {
    position: "absolute",
    left: spacing.lg,
    right: spacing.lg,
    bottom: spacing.lg,
    minHeight: MIN_TOUCH,
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
  },
  toastSuccess: { backgroundColor: colors.successLight },
  toastError: { backgroundColor: colors.dangerLight },
  toastText: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.text,
    textAlign: "center",
  },
  toastTextSuccess: { color: colors.successStrong },
  toastTextError: { color: colors.danger },
  // Not-found popup — a centred card over the camera. `box-none` on the
  // overlay lets taps outside the card fall through to… nothing yet; the
  // dismiss button on the card is the deliberate exit. (Tap-outside-to-close
  // on a decision prompt would feel accidental.)
  notFoundOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.scrim,
  },
  notFoundCard: {
    width: "100%",
    maxWidth: 360,
    backgroundColor: colors.card,
    borderRadius: radius.xl,
    padding: spacing.xl,
    gap: spacing.md,
    ...elevation.modal,
  },
  notFoundTitle: {
    ...RTL_TEXT,
    fontFamily: fonts.bold,
    fontSize: 17,
    color: colors.text,
  },
  notFoundBody: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textSecondary,
    lineHeight: 20,
  },
  notFoundActions: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  notFoundBtn: { flex: 1 },
  footer: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    gap: spacing.md,
  },
  manualLabel: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  manualRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  manualInput: {
    flex: 1,
    minHeight: MIN_TOUCH,
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text,
    includeFontPadding: false,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
  },
});
