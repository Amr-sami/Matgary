import { useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { PrinterIcon as Printer } from "phosphor-react-native/src/icons/Printer";
import { ShareNetworkIcon as ShareNetwork } from "phosphor-react-native/src/icons/ShareNetwork";

import { Segmented } from "@/components/ui/Segmented";
import { t } from "@/i18n";
import type { ReceiptSale, ReceiptWidth } from "@/receipt/html";
import {
  ShareUnavailableError,
  getReceiptWidth,
  loadReceiptSettings,
  printReceipt,
  setReceiptWidth,
  shareReceipt,
} from "@/receipt/share";
import { PrintToPrinterAction } from "@/printing/PrintToPrinterAction";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";
import { RTL_TEXT } from "@/theme/rtl";

type Busy = "share" | "print" | null;

interface ReceiptActionsProps {
  /**
   * The receipt to render — build it with `toReceiptSale(cartSnapshot, result)`
   * from the cart BEFORE resetting it, so gross prices, per-line discounts and
   * brands survive (the server result alone carries only net line totals).
   */
  sale: ReceiptSale;
  /**
   * Slot for transports that ship later — the ESC/POS agent mounts
   * "Print to receipt printer" here without touching this file.
   */
  extraActions?: ReactNode;
  /** Hide the 58/80 mm picker where the width is decided elsewhere. */
  showPaperWidth?: boolean;
}

/**
 * Nothing tenant-specific could be loaded: ask before a receipt headed
 * "STORE" with no footer is handed to the customer. Resolves false on cancel.
 */
function confirmDefaultLayout(): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(
      t("mobile.receipt.settingsFallbackTitle"),
      t("mobile.receipt.settingsFallbackAsk"),
      [
        { text: t("app.common.cancel"), style: "cancel", onPress: () => resolve(false) },
        { text: t("mobile.receipt.settingsFallbackContinue"), onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}

/**
 * Share PDF · Print · [extra] — the row under a completed sale's receipt.
 *
 * The web's ShareReceiptButton offers copy-text / WhatsApp; on the phone the
 * OS share sheet already lists WhatsApp, so one "share" that hands over a
 * proper PDF replaces both. Print goes to AirPrint / the Android print
 * service (doc 06 §1.4 v1). Errors stay inline — a failed print must not
 * navigate the cashier away from a sale that DID succeed.
 *
 * Settings are resolved BEFORE anything renders: when only the generic
 * defaults are available the cashier is asked first, because the notice
 * after the share sheet closes would arrive after the customer has the PDF.
 */
export function ReceiptActions({ sale, extraActions, showPaperWidth = true }: ReceiptActionsProps) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [width, setWidth] = useState<ReceiptWidth>(() => getReceiptWidth());
  // `busy` is React state and lags a frame; two taps (or Share + Print in the
  // same frame) both read null. The ref is set synchronously, so only the
  // first one runs — a second shareAsync while the sheet is open rejects on
  // iOS and would print an error under a share that actually succeeded.
  const inflight = useRef(false);

  const run = async (kind: Exclude<Busy, null>) => {
    if (busy || inflight.current) return;
    inflight.current = true;
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      const loaded = await loadReceiptSettings(qc);
      if (loaded.fallback) {
        setNotice(t("mobile.receipt.settingsFallback"));
        if (!(await confirmDefaultLayout())) return;
      } else if (loaded.source === "saved") {
        setNotice(t("mobile.receipt.settingsSaved"));
      }
      if (kind === "share") await shareReceipt(sale, qc, width, loaded);
      else await printReceipt(sale, qc, width, loaded);
    } catch (e) {
      if (e instanceof ShareUnavailableError) setError(t("mobile.receipt.shareUnavailable"));
      else setError(t(kind === "share" ? "mobile.receipt.shareFailed" : "mobile.receipt.printFailed"));
    } finally {
      inflight.current = false;
      setBusy(null);
    }
  };

  const widths = useMemo(
    () => [
      { key: "58" as const, label: t("mobile.receipt.paper58") },
      { key: "80" as const, label: t("mobile.receipt.paper80") },
    ],
    [],
  );

  return (
    <View style={styles.wrap} accessibilityLabel={t("mobile.receipt.actionsLabel")}>
      <View style={styles.row}>
        <Action
          icon={<ShareNetwork size={20} color={colors.accent} weight="bold" />}
          label={t("mobile.receipt.sharePdf")}
          loading={busy === "share"}
          disabled={busy !== null}
          onPress={() => void run("share")}
        />
        <Action
          icon={<Printer size={20} color={colors.accent} weight="bold" />}
          label={t("mobile.receipt.print")}
          loading={busy === "print"}
          disabled={busy !== null}
          onPress={() => void run("print")}
        />
        {extraActions}
        {/* ESC/POS over BLE — renders nothing until a printer is saved in Settings → Receipt printer. */}
        <PrintToPrinterAction sale={sale} disabled={busy !== null} />
      </View>

      {showPaperWidth ? (
        <View style={styles.widthRow}>
          <Text style={styles.widthLabel}>{t("mobile.receipt.paperWidth")}</Text>
          <View style={styles.widthPicker}>
            <Segmented
              items={widths}
              value={String(width) as "58" | "80"}
              onChange={(v) => {
                const w: ReceiptWidth = v === "58" ? 58 : 80;
                setWidth(w);
                setReceiptWidth(w);
              }}
            />
          </View>
        </View>
      ) : null}

      {error ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
      {notice ? (
        <Text style={styles.notice} accessibilityLiveRegion="polite">
          {notice}
        </Text>
      ) : null}
    </View>
  );
}

function Action({
  icon,
  label,
  loading,
  disabled,
  onPress,
}: {
  icon: ReactNode;
  label: string;
  loading: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: loading }}
      style={({ pressed }) => [
        styles.action,
        pressed && !disabled && styles.actionPressed,
        disabled && !loading && styles.actionDisabled,
      ]}
    >
      {loading ? <ActivityIndicator color={colors.accent} /> : icon}
      <Text numberOfLines={1} style={styles.actionLabel}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing.sm, marginBottom: spacing.md },
  row: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  action: {
    flexGrow: 1,
    flexBasis: 0,
    minWidth: 120,
    minHeight: MIN_TOUCH,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  actionPressed: { backgroundColor: colors.accentLight },
  actionDisabled: { opacity: 0.5 },
  actionLabel: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.accent, flexShrink: 1 },
  widthRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  widthLabel: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, flexShrink: 1 },
  widthPicker: { width: 150 },
  error: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 13, color: colors.danger },
  notice: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary },
});
