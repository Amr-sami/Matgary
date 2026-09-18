import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CalendarBlank, Check } from "phosphor-react-native";

import { api } from "@/api/client";
import { getLocale, t } from "@/i18n";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { HeaderAccessories } from "@/components/shell/HeaderAccessories";
import { formatActivityDetails } from "@/lib/activity-details";
import { shortDate } from "@/lib/format";
import { useSession } from "@/stores/session";
import { RTL, RTL_TEXT, directionStyle } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Port of app__activity.png — the tenant-wide audit trail.
 *
 * Same route as the web (GET /api/activity), same permission gate
 * (view_activity_log), same four filters. The web paginates with a
 * `before=<createdAt of last row>` keyset cursor and treats a full page as
 * "there is more", so this screen is a FlatList over useInfiniteQuery with the
 * exact same rule. The web's date inputs are native <input type="date">; the
 * app has no picker dependency, so they are Field-shaped text inputs with the
 * browser's calendar glyph, accepting dd/mm/yyyy (the placeholder — localised,
 * unlike the browser's, which the design PNG shows in English) or YYYY-MM-DD. The web's User / Category <select>s are a
 * Field-styled Pressable opening a Modal option list, so the filter card keeps
 * the design's compact 2x2 grid.
 */

type ActivityCategory =
  | "auth"
  | "team"
  | "settings"
  | "leave"
  | "task"
  | "product"
  | "sale"
  | "expense"
  | "supplier"
  | "purchase"
  | "attendance";

/** Same order as apps/web/lib/activity-labels.ts → ACTIVITY_CATEGORIES. */
const ACTIVITY_CATEGORIES: ActivityCategory[] = [
  "auth",
  "team",
  "settings",
  "leave",
  "task",
  "product",
  "sale",
  "expense",
  "supplier",
  "purchase",
  "attendance",
];

interface LogRow {
  id: string;
  action: string;
  category: string;
  actorUserId: string | null;
  actorName: string | null;
  entityType: string | null;
  entityId: string | null;
  entityLabel: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface Actor {
  userId: string;
  name: string;
}

interface ActivityPage {
  rows: LogRow[];
  actors: Actor[];
}

interface Filters {
  from: string;
  to: string;
  actor: string;
  category: string;
}

const PAGE_SIZE = 50;
const EMPTY_FILTERS: Filters = { from: "", to: "", actor: "", category: "" };
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DMY_DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;

/** `t()` echoes the path when a key is missing; turn that into `undefined`. */
function tOpt(path: string): string | undefined {
  const v = t(path);
  return v === path ? undefined : v;
}

/** Normalise the two accepted spellings to YYYY-MM-DD; null when it is neither. */
function toIsoDay(v: string): string | null {
  const s = v.trim();
  if (ISO_DATE_RE.test(s)) return s;
  const m = DMY_DATE_RE.exec(s);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function parseDayStart(v: string): Date | null {
  const iso = toIsoDay(v);
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00`);
  return Number.isFinite(d.valueOf()) ? d : null;
}

/** Non-empty text that does not parse — the user typed something, and Apply would silently ignore it. */
function isBadDate(v: string): boolean {
  return v.trim() !== "" && parseDayStart(v) === null;
}

function buildQuery(f: Filters, before?: string): string {
  const p = new URLSearchParams();
  const from = parseDayStart(f.from);
  if (from) p.set("from", from.toISOString());
  const to = parseDayStart(f.to);
  if (to) {
    to.setHours(23, 59, 59, 999);
    p.set("to", to.toISOString());
  }
  if (f.actor) p.set("actor", f.actor);
  if (f.category) p.set("category", f.category);
  if (before) p.set("before", before);
  p.set("limit", String(PAGE_SIZE));
  return p.toString();
}

/**
 * Arabic does not count "{n} unit" for every n: 1 is the bare noun, 2 the dual
 * (ساعتين), 3–10 the plural noun (ساعات), 11+ the singular again. The
 * dictionary carries the One/Two/Few forms next to the default; this picks one.
 */
function relativeUnit(unit: "minutes" | "hours" | "days", n: number): string {
  const form = n === 1 ? "One" : n === 2 ? "Two" : n >= 3 && n <= 10 ? "Few" : "";
  return t(`app.activity.relative.${unit}${form}`, { n });
}

/** Mirror of the web's formatRelative — falls back to a short date at 30 days. */
function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - then);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return t("app.activity.relative.now");
  const min = Math.floor(sec / 60);
  if (min < 60) return relativeUnit("minutes", min);
  const hr = Math.floor(min / 60);
  if (hr < 24) return relativeUnit("hours", hr);
  const days = Math.floor(hr / 24);
  if (days < 30) return relativeUnit("days", days);
  return shortDate(iso);
}

export default function ActivityScreen() {
  const insets = useSafeAreaInsets();
  const me = useSession((s) => s.me);
  const allowed = Boolean(me?.permissions?.includes("view_activity_log"));

  // Draft = what the inputs show; applied = what the query runs with.
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Filters>(EMPTY_FILTERS);

  const q = useInfiniteQuery({
    queryKey: ["activity", applied],
    enabled: allowed,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api.request<ActivityPage>(`/api/activity?${buildQuery(applied, pageParam)}`),
    getNextPageParam: (last) =>
      last.rows.length === PAGE_SIZE ? last.rows[last.rows.length - 1]?.createdAt : undefined,
  });

  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.rows) ?? [], [q.data]);
  const actors = q.data?.pages[0]?.actors ?? [];

  const fromBad = isBadDate(draft.from);
  const toBad = isBadDate(draft.to);

  /**
   * The web's Apply always re-runs load(). With TanStack an unchanged draft
   * produces the same query key and no fetch, so refetch explicitly then.
   */
  const apply = () => {
    if (fromBad || toBad) return;
    if (JSON.stringify(draft) === JSON.stringify(applied)) void q.refetch();
    else setApplied(draft);
  };
  const clear = () => {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
  };
  /** Selects commit immediately — a pick that waits for "Apply" reads as broken. */
  const pick = (patch: Partial<Filters>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    setApplied(next);
  };

  const actorOptions: SelectOption[] = [
    { value: "", label: t("app.activity.filters.allUsers") },
    ...actors.map((a) => ({ value: a.userId, label: a.name })),
  ];
  const categoryOptions: SelectOption[] = [
    { value: "", label: t("app.activity.filters.allCategories") },
    ...ACTIVITY_CATEGORIES.map((c) => ({ value: c, label: t(`app.activityLabels.categories.${c}`) })),
  ];

  // Same frame as components/layout/Screen: the accessories row, then the
  // title block shrink-wrapped to the reading edge (alignItems flex-start).
  // A textAlign right/left would be swapped by Fabric under an RTL layout
  // direction — that is what left the Arabic title hugging the left edge.
  const header = (
    <View style={styles.headerWrap}>
      <View style={styles.titleBlock}>
        <HeaderAccessories />
        <Text style={styles.title}>{t("app.activity.heading")}</Text>
        <Text style={styles.subtitle}>{t("app.activity.subhead")}</Text>
      </View>

      {!allowed ? (
        <Card>
          <Text style={styles.notAllowed}>{t("app.activity.notAllowed")}</Text>
        </Card>
      ) : (
        <Card>
          <View style={styles.dateRow}>
            <View style={styles.dateCol}>
              <DateField
                label={t("app.activity.filters.fromLabel")}
                value={draft.from}
                onChangeText={(v) => setDraft((d) => ({ ...d, from: v }))}
                error={fromBad ? t("mobile.activity.invalidDate") : undefined}
              />
            </View>
            <View style={styles.dateCol}>
              <DateField
                label={t("app.activity.filters.toLabel")}
                value={draft.to}
                onChangeText={(v) => setDraft((d) => ({ ...d, to: v }))}
                error={toBad ? t("mobile.activity.invalidDate") : undefined}
              />
            </View>
          </View>

          {/* Second row of the design's 2x2 grid: two selects, like the web's <select>s. */}
          <View style={styles.selectRow}>
            <View style={styles.dateCol}>
              <Select
                label={t("app.activity.filters.userLabel")}
                value={draft.actor}
                options={actorOptions}
                onChange={(v) => pick({ actor: v })}
              />
            </View>
            <View style={styles.dateCol}>
              <Select
                label={t("app.activity.filters.categoryLabel")}
                value={draft.category}
                options={categoryOptions}
                onChange={(v) => pick({ category: v })}
              />
            </View>
          </View>

          {/* Packed at the row's end edge with the primary outermost, as the design draws it. */}
          <View style={styles.actions}>
            <Button label={t("app.activity.filters.clear")} onPress={clear} variant="outline" />
            <Button
              label={t("app.activity.filters.apply")}
              onPress={apply}
              disabled={fromBad || toBad}
              loading={q.isFetching && !q.isFetchingNextPage}
            />
          </View>
        </Card>
      )}

      {q.isError ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{t("app.activity.errors.loadFailed")}</Text>
        </View>
      ) : null}
    </View>
  );

  const footer = q.isFetchingNextPage ? (
    <View style={styles.footer}>
      <ActivityIndicator color={colors.accent} />
    </View>
  ) : null;

  const empty = !allowed ? null : q.isPending ? (
    <View style={styles.footer}>
      <ActivityIndicator color={colors.accent} />
    </View>
  ) : (
    <View style={styles.listCard}>
      <EmptyState title={t("app.activity.empty")} />
    </View>
  );

  return (
    <View style={styles.root}>
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        renderItem={({ item, index }) => (
          <ActivityRow row={item} first={index === 0} last={index === rows.length - 1} />
        )}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        ListEmptyComponent={empty}
        onEndReached={() => {
          if (q.hasNextPage && !q.isFetchingNextPage) q.fetchNextPage();
        }}
        onEndReachedThreshold={0.4}
        refreshControl={<RefreshControl refreshing={q.isRefetching && !q.isFetchingNextPage} onRefresh={() => q.refetch()} />}
        contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.lg }]}
        keyboardShouldPersistTaps="handled"
      />
    </View>
  );
}

/**
 * Field-shaped date input with the calendar glyph the web's native
 * <input type="date"> draws at the start edge (see the design PNG). The kit's
 * Field has no adornment slot, so the box is rebuilt here to Field's metrics.
 * textAlign is left unset, as in Field: RN resolves it from the layout
 * direction, whereas an explicit right/left gets swapped under RTL.
 */
function DateField({
  label,
  value,
  onChangeText,
  error,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  error?: string;
}) {
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.selectWrap}>
      <Text style={styles.filterLabel}>{label}</Text>
      <View style={[styles.dateBox, focused && styles.dateBoxFocused]}>
        <CalendarBlank size={18} color={colors.textSecondary} />
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={t("mobile.activity.datePlaceholder")}
          placeholderTextColor={colors.textSecondary}
          keyboardType="numbers-and-punctuation"
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={label}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={styles.dateInput}
        />
      </View>
      {error ? <Text style={styles.fieldError}>{error}</Text> : null}
    </View>
  );
}

interface SelectOption {
  value: string;
  label: string;
}

/**
 * Stand-in for the web's <select>: a Field-styled box showing the current
 * label (no caret — the design draws none, and it cost the width that clipped
 * "كل المستخدمين"), opening a bottom-sheet list of the options. The kit
 * has no Select primitive; this keeps the filter card at the design's height
 * instead of two scrolling chip rows. RTL is re-applied inside the Modal on
 * purpose — it mounts its own native root, so the root layout's direction does
 * not reach it.
 */
function Select({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value) ?? options[0];
  const close = () => setOpen(false);

  return (
    <View style={styles.selectWrap}>
      <Text style={styles.filterLabel}>{label}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityValue={{ text: current?.label }}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(true)}
        style={styles.selectBox}
      >
        <Text numberOfLines={1} style={styles.selectValue}>
          {current?.label ?? ""}
        </Text>
      </Pressable>

      <Modal visible={open} transparent animationType="slide" onRequestClose={close}>
        <View style={[styles.overlay, directionStyle(getLocale() === "ar")]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel={t("app.common.close")} />
          <View style={styles.sheet}>
            <Text style={styles.sheetTitle}>{label}</Text>
            <ScrollView contentContainerStyle={styles.sheetBody}>
              {options.map((o) => {
                const active = o.value === value;
                return (
                  <Pressable
                    key={o.value || "__all"}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    onPress={() => {
                      onChange(o.value);
                      close();
                    }}
                    style={[styles.option, active && styles.optionActive]}
                  >
                    <Text style={[styles.optionText, active && styles.optionTextActive]} numberOfLines={1}>
                      {o.label}
                    </Text>
                    {active ? <Check size={16} color={colors.accent} weight="bold" /> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function ActivityRow({ row, first, last }: { row: LogRow; first: boolean; last: boolean }) {
  const actionLabel = tOpt(`app.activityLabels.actions.${row.action}`) ?? row.action;
  const categoryLabel = tOpt(`app.activityLabels.categories.${row.category}`) ?? row.category;
  // Per-action port of the web formatter: sale lines flattened, enums translated,
  // changed-field lists — `t` passed at render time so a live locale switch re-labels.
  const details = formatActivityDetails(row.action, row.metadata, t);

  return (
    <View style={[styles.row, first && styles.rowFirst, last && styles.rowLast]}>
      <View style={styles.rowTop}>
        <View style={styles.pill}>
          <Text style={styles.pillText}>{categoryLabel}</Text>
        </View>
        <Text style={styles.action}>{actionLabel}</Text>
        {row.entityLabel ? (
          <Text style={styles.entity} numberOfLines={1}>
            {`— ${row.entityLabel}`}
          </Text>
        ) : null}
      </View>
      <View style={styles.rowMeta}>
        <Text style={styles.meta}>{row.actorName ?? "—"}</Text>
        <Text style={styles.meta}>•</Text>
        <Text style={styles.meta}>{formatRelative(row.createdAt)}</Text>
      </View>
      {details.length > 0 ? (
        <View style={styles.details}>
          {details.map((d, i) => (
            <View key={`${i}-${d.label}`} style={styles.detail}>
              <Text style={styles.detailLabel}>{`${d.label}:`}</Text>
              <Text style={styles.detailValue} numberOfLines={2}>
                {d.value}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, ...RTL },
  content: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.xxl * 2,
  },
  headerWrap: { gap: spacing.lg, marginBottom: spacing.lg },
  titleBlock: { gap: 4, alignItems: "flex-start" },
  title: { fontFamily: fonts.bold, fontSize: 26, color: colors.text, ...RTL_TEXT },
  subtitle: { fontFamily: fonts.regular, fontSize: 15, color: colors.textSecondary, ...RTL_TEXT },
  notAllowed: {
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.textSecondary,
    textAlign: "center",
    paddingVertical: spacing.lg,
  },

  dateRow: { flexDirection: "row", gap: spacing.md },
  selectRow: { flexDirection: "row", gap: spacing.md, marginTop: spacing.lg },
  dateCol: { flex: 1 },
  fieldError: { fontFamily: fonts.regular, fontSize: 12, color: colors.danger, marginTop: spacing.xs, ...RTL_TEXT },
  filterLabel: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.textSecondary,
    ...RTL_TEXT,
  },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm, marginTop: spacing.lg },

  // DateField — Field's box and input metrics, plus the calendar glyph.
  dateBox: {
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
  dateBoxFocused: { borderColor: colors.accent },
  dateInput: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 16,
    color: colors.text,
    includeFontPadding: false,
    paddingVertical: 12,
  },

  // Select — box matches Field's border/height so the 2x2 grid reads as one.
  selectWrap: { gap: spacing.sm },
  selectBox: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: 52,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
  },
  selectValue: { flexShrink: 1, fontFamily: fonts.regular, fontSize: 15, color: colors.text },
  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.45)" },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    maxHeight: "70%",
    paddingBottom: spacing.xxl,
    ...elevation.modal,
  },
  sheetTitle: {
    fontFamily: fonts.bold,
    fontSize: 16,
    color: colors.text,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.sm,
    ...RTL_TEXT,
  },
  sheetBody: { paddingHorizontal: spacing.md, gap: 2 },
  option: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.sm,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
  },
  optionActive: { backgroundColor: colors.accentLight },
  optionText: { flexShrink: 1, fontFamily: fonts.regular, fontSize: 15, color: colors.text, ...RTL_TEXT },
  optionTextActive: { fontFamily: fonts.semibold, color: colors.accent },

  errorBox: {
    backgroundColor: colors.dangerLight,
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  errorText: { fontFamily: fonts.medium, fontSize: 14, color: colors.danger, ...RTL_TEXT },

  listCard: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.xl,
  },
  row: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderLeftWidth: 1,
    borderRightWidth: 1,
    borderTopWidth: 1,
    padding: spacing.lg,
    gap: 4,
  },
  rowFirst: { borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl },
  rowLast: {
    borderBottomWidth: 1,
    borderBottomLeftRadius: radius.xl,
    borderBottomRightRadius: radius.xl,
  },
  rowTop: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
  pill: {
    backgroundColor: colors.neutralTint,
    borderRadius: radius.full,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  pillText: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary },
  action: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  entity: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, flexShrink: 1 },
  rowMeta: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
  meta: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary },
  details: { marginTop: spacing.xs, gap: 2 },
  detail: { flexDirection: "row", alignItems: "baseline", gap: spacing.sm },
  detailLabel: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary },
  detailValue: { fontFamily: fonts.medium, fontSize: 12, color: colors.text, flexShrink: 1 },
  footer: { paddingVertical: spacing.xl, alignItems: "center" },
});
