// "Print to receipt printer" — the ESC/POS action under a completed sale.
// Renders nothing until a printer is saved (settings/printers.tsx), so the
// receipt row stays Share · Print for shops that print via AirPrint / PDF.

import { useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { ReceiptIcon as Receipt } from "phosphor-react-native/src/icons/Receipt";

import { hasArabic, saleToTicket } from "@matgary/domain";

import { t } from "@/i18n";
import { receiptQrPayload, type ReceiptSale } from "@/receipt/html";
import { loadReceiptSettings } from "@/receipt/share";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";
import { RTL_TEXT } from "@/theme/rtl";

import { printTicket, printerErrorKey } from "./print";
import { TicketRasterizer, type RasterizerHandle } from "./rasterize";
import { useDefaultPrinter } from "./registry";

interface Props {
  sale: ReceiptSale;
  /** The parent row is busy with Share / Print — do not start a third job. */
  disabled?: boolean;
}

export function PrintToPrinterAction({ sale, disabled }: Props) {
  const qc = useQueryClient();
  const printer = useDefaultPrinter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inflight = useRef(false);
  const rasterizer = useRef<RasterizerHandle>(null);

  if (!printer) return null;

  const run = async () => {
    if (inflight.current || disabled) return;
    inflight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { settings } = await loadReceiptSettings(qc);
      const ticket = saleToTicket(
        sale,
        {
          shopName: settings.shopName,
          shopPhone: settings.shopPhone,
          footerText: settings.receiptFooterText,
          showLoyalty: settings.receiptShowLoyalty,
          qrPayload: receiptQrPayload(sale, settings),
        },
        settings.receiptLanguage,
      );
      const arabic = ticket.lines.some((l) => (l.kind === "text" ? hasArabic(l.text) : l.kind === "row" ? hasArabic(l.start) : false));
      await printTicket(printer, ticket, printer.mode === "raster" ? (tk, w) => rasterizer.current!.render(tk, w) : undefined);
      setNotice(arabic && printer.mode === "text" ? t("mobile.printing.textModeArabicNote") : t("mobile.printing.printed"));
    } catch (e) {
      setError(t(printerErrorKey(e)));
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  };

  const label = t("mobile.printing.printToPrinter");
  const off = !!disabled || busy;
  return (
    <>
      <Pressable
        onPress={() => void run()}
        disabled={off}
        accessibilityRole="button"
        accessibilityLabel={`${label} — ${printer.name}`}
        accessibilityState={{ disabled: off, busy }}
        style={({ pressed }) => [styles.action, pressed && !off && styles.pressed, off && !busy && styles.disabled]}
      >
        {busy ? <ActivityIndicator color={colors.accent} /> : <Receipt size={20} color={colors.accent} weight="bold" />}
        <View style={styles.labels}>
          <Text numberOfLines={1} style={styles.label}>
            {label}
          </Text>
          <Text numberOfLines={1} style={styles.sub}>
            {printer.name} · {t(printer.width === 58 ? "mobile.receipt.paper58" : "mobile.receipt.paper80")}
          </Text>
        </View>
      </Pressable>
      {error || notice ? (
        <Text style={[styles.msg, error ? styles.error : styles.notice]} accessibilityLiveRegion="polite">
          {error ?? notice}
        </Text>
      ) : null}
      {printer.mode === "raster" ? <TicketRasterizer ref={rasterizer} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
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
  pressed: { backgroundColor: colors.accentLight },
  disabled: { opacity: 0.5 },
  labels: { flexShrink: 1, alignItems: "flex-start" },
  label: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.accent },
  sub: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 11, color: colors.textSecondary },
  // sits inside the wrapping action row — take the whole line
  msg: { ...RTL_TEXT, flexBasis: "100%", fontFamily: fonts.regular, fontSize: 12 },
  error: { color: colors.danger },
  notice: { color: colors.textSecondary },
});
