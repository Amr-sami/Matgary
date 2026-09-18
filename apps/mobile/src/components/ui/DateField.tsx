import { useEffect, useState } from "react";
import { Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import DateTimePicker, { DateTimePickerAndroid, type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { CalendarBlankIcon as CalendarBlank } from "phosphor-react-native/src/icons/CalendarBlank";

import { getLocale, t } from "@/i18n";
import { shortDate } from "@/lib/format";
import { RTL_TEXT, directionStyle } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";
import { Button } from "./Button";

/** Calendar day — the wire shape every screen already keeps in state. */
export type IsoDay = string; // "YYYY-MM-DD"

const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "YYYY-MM-DD" -> local midnight; null when malformed or impossible. */
export function isoDayToDate(day: IsoDay | null | undefined): Date | null {
  if (!day) return null;
  const m = ISO_DAY_RE.exec(day);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  if (d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  return d;
}

/** Local calendar fields -> "YYYY-MM-DD" (no toISOString: that would shift the day across UTC). */
export function dateToIsoDay(d: Date): IsoDay {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight today — the same shape isoDayToDate() returns, so range checks compare like with like. */
function startOfToday(): Date {
  const n = new Date();
  return new Date(n.getFullYear(), n.getMonth(), n.getDate(), 0, 0, 0, 0);
}

/** Pull `d` inside [lo, hi]; an inverted range resolves to `hi`. */
function clampDay(d: Date, lo?: Date, hi?: Date): Date {
  if (lo && d < lo) return lo;
  if (hi && d > hi) return hi;
  return d;
}

/**
 * iOS picker locale. `ar-EG` alone would render Arabic-Indic digits (CLDR's
 * default numbering system for ar-EG is `arab`) — the app shows Latin digits
 * everywhere (doc 03 §"Digits"), so the BCP-47 `u-nu-latn` extension pins the
 * calendar to Latin. NSLocale honours the extension: the native side hands the
 * string straight to `initWithLocaleIdentifier:`.
 */
function pickerLocale(): string {
  return getLocale() === "ar" ? "ar-EG-u-nu-latn" : "en-GB";
}

interface NativeDatePickerProps {
  visible: boolean;
  /** Day the picker opens on; today when null/invalid. */
  value: IsoDay | null;
  min?: IsoDay;
  max?: IsoDay;
  /** Sheet heading (iOS only — Android's dialog draws its own). */
  title?: string;
  onChange: (day: IsoDay) => void;
  onClose: () => void;
}

/**
 * The platform's own date picker, driven by `visible` like a Modal.
 *
 * iOS: a bottom sheet with the inline (calendar) UIDatePicker and a Done
 * button — the picker fires on every tap, so the pick is held locally and
 * committed on Done; the scrim dismisses without committing. RTL is re-applied
 * on the sheet because a Modal mounts its own native root.
 *
 * Android: the imperative dialog (`DateTimePickerAndroid.open`) — it renders
 * nothing itself, so the parent's `visible` is flipped back through `onClose`
 * as soon as the dialog settles. There is no locale prop on Android; the
 * dialog follows the system locale.
 */
export function NativeDatePicker({ visible, value, min, max, title, onChange, onClose }: NativeDatePickerProps) {
  const minimumDate = isoDayToDate(min) ?? undefined;
  const maximumDate = isoDayToDate(max) ?? undefined;
  // Clamped before it seeds anything: UIDatePicker silently *displays* the
  // nearest bound when `value` is out of range but never fires onChange for
  // it, so an unclamped seed would be what Done commits — a "to" day before
  // "from", or a day the screen's own hint calls invalid.
  const initial = clampDay(isoDayToDate(value) ?? startOfToday(), minimumDate, maximumDate);

  // iOS keeps the in-progress pick here; reset whenever the sheet opens
  // (the "adjust state on prop change during render" pattern — no effect).
  const [draft, setDraft] = useState<Date>(initial);
  const [wasVisible, setWasVisible] = useState(visible);
  if (visible !== wasVisible) {
    setWasVisible(visible);
    if (visible) setDraft(initial);
  }

  useEffect(() => {
    if (Platform.OS !== "android" || !visible) return;
    let settled = false;
    DateTimePickerAndroid.open({
      value: initial,
      mode: "date",
      minimumDate,
      maximumDate,
      onChange: (e: DateTimePickerEvent, d?: Date) => {
        settled = true;
        if (e.type === "set" && d) onChange(dateToIsoDay(d));
        onClose();
      },
      onError: () => {
        settled = true;
        onClose();
      },
    });
    // The dialog outlives a torn-down owner (parent Modal / screen unmount)
    // and would then fire onChange into unmounted state — close it with us.
    // Nothing to do once it settled on its own; the promise rejects only when
    // the Activity itself is already gone, which is the same outcome.
    return () => {
      if (!settled) DateTimePickerAndroid.dismiss("date").catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  if (Platform.OS !== "ios") return null;

  const rtl = getLocale() === "ar";
  // Compared as calendar days: the native picker may hand back a time-of-day,
  // and a "max" pick that is a few ms past local midnight is still in range.
  const draftInRange = dateToIsoDay(clampDay(draft, minimumDate, maximumDate)) === dateToIsoDay(draft);
  const commit = () => {
    if (!draftInRange) return;
    onChange(dateToIsoDay(draft));
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.overlay, directionStyle(rtl)]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t("app.common.close")}
        />
        <View style={styles.sheet}>
          {title ? <Text style={styles.sheetTitle}>{title}</Text> : null}
          <DateTimePicker
            value={draft}
            mode="date"
            display="inline"
            locale={pickerLocale()}
            minimumDate={minimumDate}
            maximumDate={maximumDate}
            accentColor={colors.accent}
            themeVariant="light"
            onChange={(_e: DateTimePickerEvent, d?: Date) => {
              if (d) setDraft(d);
            }}
            style={styles.picker}
          />
          <View style={styles.sheetActions}>
            <Button label={t("mobile.dateField.done")} onPress={commit} disabled={!draftInRange} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

interface DateFieldProps {
  label: string;
  /** "YYYY-MM-DD" or null when nothing is picked yet. */
  value: IsoDay | null;
  onChange: (day: IsoDay) => void;
  /** Earliest / latest selectable day, "YYYY-MM-DD". */
  min?: IsoDay;
  max?: IsoDay;
  placeholder?: string;
  disabled?: boolean;
}

/**
 * Field-shaped date input: label above a bordered box with the calendar glyph
 * at the start edge — the same box the web's native <input type="date"> draws
 * (doc 03 §6, Field's metrics). Tapping opens the platform picker; the value
 * renders as shortDate() so it matches every other date in the app, Latin
 * digits included.
 *
 * The box is a Pressable, not a TextInput, so nothing is ever typed: a hand
 * typed day was the one place the app could hold an unparseable date.
 */
export function DateField({ label, value, onChange, min, max, placeholder, disabled = false }: DateFieldProps) {
  const [open, setOpen] = useState(false);
  const day = isoDayToDate(value);
  const shown = day ? shortDate(day.toISOString()) : (placeholder ?? t("mobile.dateField.placeholder"));

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: shown }}
        accessibilityState={{ expanded: open, disabled }}
        disabled={disabled}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.box, open && styles.boxFocused, pressed && styles.boxPressed, disabled && styles.boxDisabled]}
      >
        <CalendarBlank size={18} color={colors.textSecondary} />
        <Text numberOfLines={1} style={[styles.value, !day && styles.placeholder]}>
          {shown}
        </Text>
      </Pressable>

      <NativeDatePicker
        visible={open}
        value={value}
        min={min}
        max={max}
        title={label}
        onChange={onChange}
        onClose={() => setOpen(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // Field's wrap/label/box, verbatim, so a DateField next to a Field reads as one row.
  wrap: { gap: 8 },
  label: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.textSecondary,
    ...RTL_TEXT,
  },
  box: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 52,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.bg,
  },
  boxFocused: { borderColor: colors.accent },
  boxPressed: { backgroundColor: colors.neutralTint },
  boxDisabled: { opacity: 0.5 },
  value: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 16,
    color: colors.text,
    includeFontPadding: false,
    paddingVertical: 12,
  },
  placeholder: { color: colors.textSecondary },

  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.scrim },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xxl,
    gap: spacing.md,
    ...elevation.modal,
  },
  sheetTitle: {
    fontFamily: fonts.bold,
    fontSize: 16,
    color: colors.text,
    ...RTL_TEXT,
  },
  // The inline UIDatePicker sizes itself; alignSelf keeps it from stretching past its intrinsic width.
  picker: { alignSelf: "center", width: "100%" },
  sheetActions: { flexDirection: "row", justifyContent: "flex-end" },
});
