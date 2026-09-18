import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { BluetoothIcon as Bluetooth } from "phosphor-react-native/src/icons/Bluetooth";
import { BluetoothSlashIcon as BluetoothSlash } from "phosphor-react-native/src/icons/BluetoothSlash";
import { BluetoothXIcon as BluetoothX } from "phosphor-react-native/src/icons/BluetoothX";
import { CheckCircleIcon as CheckCircle } from "phosphor-react-native/src/icons/CheckCircle";
import { PrinterIcon as Printer } from "phosphor-react-native/src/icons/Printer";
import { StarIcon as Star } from "phosphor-react-native/src/icons/Star";
import { TrashIcon as Trash } from "phosphor-react-native/src/icons/Trash";

import { testTicket, type CodeTableNumbering, type PaperWidth } from "@matgary/domain";

import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ChevronBack } from "@/components/ui/Chevron";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { t } from "@/i18n";
import { type BleState, type FoundDevice, getBleState, onBleStateChange, scanForPrinters } from "@/printing/ble";
import { printTicket, printerErrorKey } from "@/printing/print";
import { TicketRasterizer, type RasterizerHandle } from "@/printing/rasterize";
import { type PrintMode, type SavedPrinter, removePrinter, savePrinter, setDefaultPrinter, updatePrinter, usePrinters } from "@/printing/registry";
import { PrinterError } from "@/printing/transport";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";

const SCAN_MS = 10_000;

/**
 * Settings → Receipt printer (doc 06 §1.4, BLE transport).
 *
 * Three cards top to bottom: the radio's state (the simulator lands on
 * "unsupported" and must say so instead of crashing), a scan that lists
 * named devices with their signal, and the saved printers with their paper
 * width, print mode, default flag and a test ticket.
 */
export default function PrintersSettingsScreen() {
  const router = useRouter();
  const printers = usePrinters();
  const [ble, setBle] = useState<BleState>("unknown");
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [found, setFound] = useState<FoundDevice[]>([]);
  const [error, setError] = useState<string | null>(null);
  /** A scan was refused by the OS permission — offer the way to Settings. */
  const [permissionDenied, setPermissionDenied] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const rasterizer = useRef<RasterizerHandle>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void getBleState().then((s) => alive.current && setBle(s));
    const off = onBleStateChange((s) => alive.current && setBle(s));
    return () => {
      alive.current = false;
      off();
    };
  }, []);

  const scan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    setError(null);
    setNotice(null);
    setFound([]);
    try {
      await scanForPrinters(SCAN_MS, (list) => alive.current && setFound(list));
      setScanned(true);
      setPermissionDenied(false);
    } catch (e) {
      setError(t(printerErrorKey(e)));
      if (e instanceof PrinterError && e.code === "unauthorized") setPermissionDenied(true);
    } finally {
      if (alive.current) setScanning(false);
    }
  }, [scanning]);

  const test = useCallback(async (p: SavedPrinter) => {
    if (testing) return;
    setTesting(p.id);
    setError(null);
    setNotice(null);
    try {
      const ticket = testTicket(p.name, p.width);
      await printTicket(p, ticket, p.mode === "raster" ? (tk, w) => rasterizer.current!.render(tk, w) : undefined);
      setNotice(t("mobile.printing.testSent"));
    } catch (e) {
      setError(t(printerErrorKey(e)));
    } finally {
      if (alive.current) setTesting(null);
    }
  }, [testing]);

  const confirmRemove = (p: SavedPrinter) =>
    Alert.alert(t("mobile.printing.remove"), t("mobile.printing.removeAsk"), [
      { text: t("app.common.cancel"), style: "cancel" },
      { text: t("mobile.printing.remove"), style: "destructive", onPress: () => removePrinter(p.id) },
    ]);

  const canScan = ble === "poweredOn" && !scanning;

  return (
    <Screen>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={12} style={styles.back}>
          <ChevronBack size={16} color={colors.textSecondary} />
          <Text style={styles.backLabel}>{t("app.settingsPage.title")}</Text>
        </Pressable>
        <Text style={styles.title}>{t("mobile.printing.title")}</Text>
        <Text style={styles.subtitle}>{t("mobile.printing.subtitle")}</Text>
      </View>

      <Card title={t("mobile.printing.bluetooth")}>
        <BleStateRow state={ble} />
        {ble === "unauthorized" || permissionDenied ? (
          <Button label={t("mobile.printing.openSettings")} variant="outline" onPress={() => void Linking.openSettings()} />
        ) : null}
        <Text style={styles.hint}>{t("mobile.printing.classicNote")}</Text>
      </Card>

      <Card title={t("mobile.printing.scanTitle")}>
        <Text style={styles.hint}>{t("mobile.printing.scanHint")}</Text>
        <Button
          label={scanning ? t("mobile.printing.scanning") : t("mobile.printing.scan")}
          onPress={() => void scan()}
          loading={scanning}
          disabled={!canScan}
        />
        {found.length > 0 ? (
          <View style={styles.list}>
            <Text style={styles.sectionLabel}>{t("mobile.printing.found")}</Text>
            {found.map((d) => (
              <FoundRow key={d.id} device={d} saved={printers.some((p) => p.id === d.id)} onSave={() => savePrinter({ id: d.id, name: d.name, kind: "ble" })} />
            ))}
          </View>
        ) : scanned && !scanning ? (
          <EmptyState compact title={t("mobile.printing.noneFound")} hint={t("mobile.printing.noneFoundHint")} />
        ) : null}
      </Card>

      <Card title={t("mobile.printing.savedTitle")}>
        {printers.length === 0 ? (
          <EmptyState compact title={t("mobile.printing.noSaved")} hint={t("mobile.printing.noSavedHint")} />
        ) : (
          <View style={styles.list}>
            {printers.map((p) => (
              <SavedRow
                key={p.id}
                printer={p}
                testing={testing === p.id}
                busy={testing !== null}
                onWidth={(width) => updatePrinter(p.id, { width })}
                onMode={(mode) => updatePrinter(p.id, { mode })}
                onCodeTable={(codeTable) => updatePrinter(p.id, { codeTable })}
                onDefault={() => setDefaultPrinter(p.id)}
                onTest={() => void test(p)}
                onRemove={() => confirmRemove(p)}
              />
            ))}
            <Text style={styles.hint}>{t("mobile.printing.modeHint")}</Text>
          </View>
        )}
      </Card>

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

      <TicketRasterizer ref={rasterizer} />
    </Screen>
  );
}

function BleStateRow({ state }: { state: BleState }) {
  const map: Record<BleState, { key: string; color: string; Icon: typeof Bluetooth }> = {
    poweredOn: { key: "mobile.printing.statePoweredOn", color: colors.successStrong, Icon: Bluetooth },
    poweredOff: { key: "mobile.printing.statePoweredOff", color: colors.warningStrong, Icon: BluetoothSlash },
    unauthorized: { key: "mobile.printing.stateUnauthorized", color: colors.danger, Icon: BluetoothX },
    unsupported: { key: "mobile.printing.stateUnsupported", color: colors.danger, Icon: BluetoothX },
    unknown: { key: "mobile.printing.stateUnknown", color: colors.textSecondary, Icon: Bluetooth },
  };
  const { key, color, Icon } = map[state];
  return (
    <View style={styles.stateRow} accessibilityLiveRegion="polite" testID={`ble-state-${state}`}>
      {state === "unknown" ? <ActivityIndicator color={colors.textSecondary} /> : <Icon size={22} color={color} weight="bold" />}
      <Text style={[styles.stateText, { color }]}>{t(key)}</Text>
    </View>
  );
}

function FoundRow({ device, saved, onSave }: { device: FoundDevice; saved: boolean; onSave: () => void }) {
  return (
    <View style={styles.foundRow}>
      <Printer size={20} color={device.likelyPrinter ? colors.accent : colors.textSecondary} />
      <View style={styles.foundBody}>
        <Text style={styles.foundName} numberOfLines={1}>
          {device.name}
        </Text>
        <Text style={styles.foundMeta} numberOfLines={1}>
          {t("mobile.printing.signal")}: {t("mobile.printing.signalFmt", { rssi: device.rssi ?? "—" })} · {device.id}
        </Text>
      </View>
      {device.likelyPrinter ? <Badge label={t("mobile.printing.likelyPrinter")} variant="accent" /> : null}
      {saved ? <CheckCircle size={22} color={colors.successStrong} weight="fill" /> : <Button label={t("mobile.printing.save")} variant="outline" onPress={onSave} />}
    </View>
  );
}

function SavedRow({
  printer,
  testing,
  busy,
  onWidth,
  onMode,
  onCodeTable,
  onDefault,
  onTest,
  onRemove,
}: {
  printer: SavedPrinter;
  testing: boolean;
  busy: boolean;
  onWidth: (w: PaperWidth) => void;
  onMode: (m: PrintMode) => void;
  onCodeTable: (n: CodeTableNumbering) => void;
  onDefault: () => void;
  onTest: () => void;
  onRemove: () => void;
}) {
  return (
    <View style={styles.savedRow}>
      <View style={styles.savedHead}>
        <Printer size={22} color={colors.accent} weight="bold" />
        <Text style={styles.savedName} numberOfLines={1}>
          {printer.name}
        </Text>
        {printer.isDefault ? <Badge label={t("mobile.printing.default")} variant="success" /> : null}
      </View>
      <Text style={styles.foundMeta} numberOfLines={1}>
        {printer.id}
      </Text>

      <Text style={styles.fieldLabel}>{t("mobile.printing.paperWidth")}</Text>
      <View style={styles.chips}>
        <Chip label={t("mobile.receipt.paper58")} active={printer.width === 58} onPress={() => onWidth(58)} />
        <Chip label={t("mobile.receipt.paper80")} active={printer.width === 80} onPress={() => onWidth(80)} />
      </View>

      <Text style={styles.fieldLabel}>{t("mobile.printing.mode")}</Text>
      <View style={styles.chips}>
        <Chip label={t("mobile.printing.modeRaster")} active={printer.mode === "raster"} onPress={() => onMode("raster")} />
        <Chip label={t("mobile.printing.modeText")} active={printer.mode === "text"} onPress={() => onMode("text")} />
      </View>

      {printer.mode === "text" ? (
        <>
          <Text style={styles.fieldLabel}>{t("mobile.printing.codeTable")}</Text>
          <View style={styles.chips}>
            <Chip label={t("mobile.printing.codeTableEpson")} active={(printer.codeTable ?? "epson") === "epson"} onPress={() => onCodeTable("epson")} />
            <Chip label={t("mobile.printing.codeTableXprinter")} active={printer.codeTable === "xprinter"} onPress={() => onCodeTable("xprinter")} />
          </View>
          <Text style={styles.hint}>{t("mobile.printing.codeTableHint")}</Text>
        </>
      ) : null}

      <View style={styles.actions}>
        {!printer.isDefault ? (
          <Pressable accessibilityRole="button" onPress={onDefault} style={({ pressed }) => [styles.actionBtn, pressed && styles.actionPressed]}>
            <Star size={18} color={colors.accent} />
            <Text style={styles.actionText}>{t("mobile.printing.setDefault")}</Text>
          </Pressable>
        ) : null}
        <Pressable
          accessibilityRole="button"
          onPress={onTest}
          disabled={busy}
          accessibilityState={{ disabled: busy, busy: testing }}
          style={({ pressed }) => [styles.actionBtn, pressed && !busy && styles.actionPressed, busy && !testing && styles.disabled]}
        >
          {testing ? <ActivityIndicator color={colors.accent} /> : <Printer size={18} color={colors.accent} />}
          <Text style={styles.actionText}>{t("mobile.printing.testPrint")}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={onRemove} style={({ pressed }) => [styles.actionBtn, pressed && styles.actionPressed]}>
          <Trash size={18} color={colors.danger} />
          <Text style={[styles.actionText, { color: colors.danger }]}>{t("mobile.printing.remove")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { gap: 4, alignItems: "flex-start" },
  back: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 32 },
  backLabel: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary },
  title: { fontFamily: fonts.bold, fontSize: 26, color: colors.text, ...RTL_TEXT },
  subtitle: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 22, color: colors.textSecondary, ...RTL_TEXT },
  hint: { fontFamily: fonts.regular, fontSize: 13, lineHeight: 20, color: colors.textSecondary, ...RTL_TEXT, marginBottom: spacing.sm },
  stateRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: MIN_TOUCH, marginBottom: spacing.xs },
  stateText: { fontFamily: fonts.medium, fontSize: 15, lineHeight: 22, flexShrink: 1, ...RTL_TEXT },
  list: { gap: spacing.sm, marginTop: spacing.md },
  sectionLabel: { fontFamily: fonts.semibold, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  foundRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: MIN_TOUCH,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  foundBody: { flex: 1, gap: 2 },
  foundName: { fontFamily: fonts.medium, fontSize: 15, color: colors.text, ...RTL_TEXT },
  foundMeta: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary },
  savedRow: {
    gap: spacing.xs,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  savedHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  savedName: { flex: 1, fontFamily: fonts.semibold, fontSize: 16, color: colors.text, ...RTL_TEXT },
  fieldLabel: { fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary, marginTop: spacing.sm, ...RTL_TEXT },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.sm },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  actionPressed: { backgroundColor: colors.accentLight },
  actionText: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 13, color: colors.accent },
  disabled: { opacity: 0.5 },
  error: { fontFamily: fonts.regular, fontSize: 13, color: colors.danger, marginTop: spacing.sm, ...RTL_TEXT },
  notice: { fontFamily: fonts.regular, fontSize: 12, color: colors.successStrong, marginTop: spacing.sm, ...RTL_TEXT },
});
