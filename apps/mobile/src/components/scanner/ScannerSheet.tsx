import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Linking,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Every symbology the shop might scan (doc 06 §2.8). itf14 is left out on
 * purpose: it is a carton code and a false positive at a till.
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
  "qr",
];

/** The same code fired again inside this window is the decoder re-reading the same label. */
const REPEAT_WINDOW_MS = 1500;

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
}: ScannerSheetProps) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [manual, setManual] = useState("");
  const last = useRef<{ code: string; at: number } | null>(null);
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
    setManual("");
    let cancelled = false;
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
      if (last.current && last.current.code === code && now - last.current.at < REPEAT_WINDOW_MS) {
        return;
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
      onScan(code);
      if (mode === "single") {
        finished.current = true;
        onClose();
      }
    },
    [mode, onClose, onScan],
  );

  const onBarcode = useCallback(
    (r: BarcodeScanningResult) => accept(r.data, "camera"),
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

          {message ? (
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
