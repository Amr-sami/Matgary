import { useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, catalog, taxonomy } from "@matgary/api-client";
import type { Icon } from "phosphor-react-native";
import { CaretDownIcon as CaretDown } from "phosphor-react-native/src/icons/CaretDown";
import { CaretUpIcon as CaretUp } from "phosphor-react-native/src/icons/CaretUp";
import { CoffeeIcon as Coffee } from "phosphor-react-native/src/icons/Coffee";
import { CookieIcon as Cookie } from "phosphor-react-native/src/icons/Cookie";
import { DeviceMobileIcon as DeviceMobile } from "phosphor-react-native/src/icons/DeviceMobile";
import { EyeglassesIcon as Eyeglasses } from "phosphor-react-native/src/icons/Eyeglasses";
import { FlaskIcon as Flask } from "phosphor-react-native/src/icons/Flask";
import { HeadphonesIcon as Headphones } from "phosphor-react-native/src/icons/Headphones";
import { PackageIcon as Package } from "phosphor-react-native/src/icons/Package";
import { PencilSimpleIcon as PencilSimple } from "phosphor-react-native/src/icons/PencilSimple";
import { PillIcon as Pill } from "phosphor-react-native/src/icons/Pill";
import { PlusIcon as Plus } from "phosphor-react-native/src/icons/Plus";
import { ShoppingBagIcon as ShoppingBag } from "phosphor-react-native/src/icons/ShoppingBag";
import { TrashIcon as Trash } from "phosphor-react-native/src/icons/Trash";
import { TShirtIcon as TShirt } from "phosphor-react-native/src/icons/TShirt";
import { WatchIcon as Watch } from "phosphor-react-native/src/icons/Watch";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ChevronBack } from "@/components/ui/Chevron";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { useSession } from "@/stores/session";
import { RTL_TEXT, directionStyle } from "@/theme/rtl";
import { MIN_TOUCH, colors, elevation, fonts, radius, spacing } from "@/theme/tokens";
import { getLocale, t } from "@/i18n";

/**
 * Port of the web's CategoriesEditor (settings page, "الأقسام" section).
 *
 * Same server, same rules: create needs `manage_catalog`; delete is refused
 * with 409 while any product still points at the category, and the server's
 * own sentence is what the user reads. Two things are phone-shaped here:
 *
 *  - The web edits inline inside an accordion. A phone gets a bottom sheet for
 *    add/rename — one field, one button, the keyboard has room.
 *  - Order matters (the wizard lists categories by `position`), and the web
 *    has no reorder UI at all. Up/down arrows patch `position` on the two
 *    swapped rows; no drag library, per the spec.
 *
 * Attributes live one screen over (settings/attributes) — a category row
 * only says whether it has any.
 */
type Category = taxonomy.Category;

/** lucide names stored by the web → phosphor glyphs. Package is the fallback. */
const ICON_GLYPHS: Record<string, Icon> = {
  Watch,
  FlaskConical: Flask,
  Glasses: Eyeglasses,
  Headphones,
  Shirt: TShirt,
  ShoppingBag,
  Smartphone: DeviceMobile,
  Pill,
  Coffee,
  Cookie,
  Package,
};

function CategoryGlyph({ name, size = 20, color = colors.accent }: { name: string | null; size?: number; color?: string }) {
  const Glyph = (name && ICON_GLYPHS[name]) || Package;
  return <Glyph size={size} color={color} weight="duotone" />;
}

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.kind === "forbidden") return t("mobile.common.forbidden");
    if (e.kind === "offline") return t("mobile.common.offline");
    if (e.kind === "timeout") return t("mobile.common.timeout");
    // A unique-key clash surfaces as drizzle's raw "Failed query: insert…" — never show SQL.
    if (e.status === 409 && /failed query/i.test(e.message)) return t("mobile.catalog.duplicateKey");
    // 400/409 carry the server's own sentence (zod issue, duplicate key, "in use").
    if (e.status && e.status < 500 && e.message && !/^HTTP \d+$/.test(e.message)) return e.message;
  }
  return t("mobile.catalog.genericError");
}

export default function CategoriesSettingsScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useSession((s) => s.me);
  const canManage = !!me && (me.isOwner || me.permissions.includes("manage_catalog"));

  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [sheet, setSheet] = useState<{ mode: "add" } | { mode: "edit"; category: Category } | null>(null);

  const q = useQuery({
    queryKey: ["categories"],
    queryFn: () => taxonomy.listCategories(api),
  });
  // Products are the only place the per-category count lives — /api/categories
  // does not aggregate. Best effort: the list renders without it and the badge
  // fills in when it lands.
  const products = useQuery({
    queryKey: ["products"],
    queryFn: () => catalog.listProducts(api),
    staleTime: 60_000,
  });

  const categories = useMemo(
    () => [...(q.data ?? [])].sort((a, b) => a.position - b.position || a.label.localeCompare(b.label)),
    [q.data],
  );
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of products.data ?? []) m.set(p.category, (m.get(p.category) ?? 0) + 1);
    return m;
  }, [products.data]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["categories"] });
    void qc.invalidateQueries({ queryKey: ["brands"] });
  };
  const fail = (e: unknown) => setNotice({ tone: "err", text: errText(e) });

  const create = useMutation({
    mutationFn: (input: { label: string; icon: string }) =>
      taxonomy.createCategory(api, {
        key: taxonomy.slugKey(input.label, "category"),
        label: input.label,
        icon: input.icon,
        position: categories.length,
      }),
    onSuccess: () => {
      setSheet(null);
      setNotice({ tone: "ok", text: t("app.catalog.categoriesAdmin.toasts.categoryAdded") });
      invalidate();
    },
    onError: fail,
  });

  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & taxonomy.UpdateCategoryInput) =>
      taxonomy.updateCategory(api, id, body),
    onSuccess: () => {
      setSheet(null);
      setNotice({ tone: "ok", text: t("mobile.catalog.saved") });
      invalidate();
    },
    onError: fail,
  });

  const remove = useMutation({
    mutationFn: (id: string) => taxonomy.deleteCategory(api, id),
    onSuccess: () => {
      setNotice({ tone: "ok", text: t("app.catalog.categoriesAdmin.toasts.categoryDeleted") });
      invalidate();
    },
    onError: fail,
  });

  // Swap `position` with the neighbour. Both rows are patched so the order is
  // stable even when positions were never set (all zero on a fresh tenant).
  const move = useMutation({
    mutationFn: async ({ index, dir }: { index: number; dir: -1 | 1 }) => {
      const a = categories[index];
      const b = categories[index + dir];
      if (!a || !b) return;
      await Promise.all([
        taxonomy.updateCategory(api, a.id, { position: index + dir }),
        taxonomy.updateCategory(api, b.id, { position: index }),
      ]);
      // Rows never patched still carry their old position; make the rest match
      // their visual index so the two swapped values can't collide with them.
      const fixes = categories
        .map((c, i) => ({ c, i }))
        .filter(({ c, i }) => c.id !== a.id && c.id !== b.id && c.position !== i)
        .map(({ c, i }) => taxonomy.updateCategory(api, c.id, { position: i }));
      if (fixes.length) await Promise.all(fixes);
    },
    // The reorder is 2+N un-transactional PATCHes; a drop mid-way leaves the server
    // holding a partial order. Refetch on failure too so the list shows server truth.
    onSettled: invalidate,
    onError: fail,
  });

  const confirmDelete = (c: Category) => {
    const n = counts.get(c.id) ?? 0;
    if (n > 0 && products.data) {
      // The server would refuse with 409 anyway; say so before the round-trip,
      // in the same words the web uses.
      Alert.alert(t("mobile.catalog.deleteCategoryTitle"), t("mobile.catalog.categoryInUse", { n }));
      return;
    }
    Alert.alert(
      t("mobile.catalog.deleteCategoryTitle"),
      `${c.label}\n${t("app.catalog.categoriesAdmin.confirmDeleteCategory")}`,
      [
        { text: t("app.common.cancel"), style: "cancel" },
        { text: t("app.common.delete"), style: "destructive", onPress: () => remove.mutate(c.id) },
      ],
    );
  };

  const busy = create.isPending || update.isPending || remove.isPending || move.isPending;

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={12} style={styles.back}>
          <ChevronBack size={16} color={colors.textSecondary} />
          <Text style={styles.backLabel}>{t("app.settingsPage.title")}</Text>
        </Pressable>
        <View style={styles.titleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>{t("app.catalog.categoriesAdmin.title")}</Text>
            <Text style={styles.subtitle}>{t("mobile.catalog.categoriesIntro")}</Text>
          </View>
          {canManage ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("app.catalog.categoriesAdmin.addCategory")}
              testID="categories-add"
              onPress={() => setSheet({ mode: "add" })}
              style={({ pressed }) => [styles.addBtn, pressed && { backgroundColor: colors.accentPressed }]}
            >
              <Plus size={20} color={colors.onAccent} weight="bold" />
            </Pressable>
          ) : null}
        </View>
      </View>

      {notice ? (
        <Pressable onPress={() => setNotice(null)} style={[styles.notice, notice.tone === "ok" ? styles.noticeOk : styles.noticeErr]}>
          <Text style={[styles.noticeText, notice.tone === "ok" ? { color: colors.successStrong } : { color: colors.danger }]}>
            {notice.text}
          </Text>
        </Pressable>
      ) : null}

      {!canManage && me ? (
        <Text style={styles.readOnly} testID="categories-readonly">
          {t("mobile.catalog.readOnly")}
        </Text>
      ) : null}

      {q.isLoading ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.xl }} />
      ) : q.isError ? (
        <Card>
          <Text style={styles.hint}>{errText(q.error)}</Text>
          <Button label={t("app.common.retry")} variant="outline" onPress={() => void q.refetch()} />
        </Card>
      ) : categories.length === 0 ? (
        <EmptyState
          title={t("app.catalog.categoriesAdmin.empty")}
          hint={canManage ? t("app.catalog.categoriesAdmin.addCategory") : undefined}
        />
      ) : (
        <View style={{ gap: spacing.sm }}>
          <Text style={styles.countLine}>{t("mobile.catalog.categoryCount", { n: categories.length })}</Text>
          {categories.map((c, i) => {
            const n = counts.get(c.id);
            return (
              <Card key={c.id}>
                <View style={styles.row}>
                  <View style={styles.glyph}>
                    <CategoryGlyph name={c.icon} />
                  </View>
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text style={styles.rowTitle} numberOfLines={1}>{c.label}</Text>
                    <View style={styles.metaRow}>
                      <Text style={styles.key} numberOfLines={1}>{c.key}</Text>
                      {n !== undefined ? <Badge label={t("mobile.catalog.productsCount", { n })} variant="neutral" /> : null}
                      {c.hasAttributes ? <Badge label={t("mobile.catalog.hasAttributes")} variant="accent" /> : null}
                    </View>
                  </View>
                </View>
                {canManage ? (
                  <View style={styles.actions}>
                    <IconBtn
                      label={t("mobile.catalog.moveUp")}
                      disabled={i === 0 || busy}
                      onPress={() => move.mutate({ index: i, dir: -1 })}
                    >
                      <CaretUp size={18} color={i === 0 ? colors.border : colors.textSecondary} weight="bold" />
                    </IconBtn>
                    <IconBtn
                      label={t("mobile.catalog.moveDown")}
                      disabled={i === categories.length - 1 || busy}
                      onPress={() => move.mutate({ index: i, dir: 1 })}
                    >
                      <CaretDown size={18} color={i === categories.length - 1 ? colors.border : colors.textSecondary} weight="bold" />
                    </IconBtn>
                    <IconBtn label={t("mobile.catalog.editCategory")} disabled={busy} onPress={() => setSheet({ mode: "edit", category: c })}>
                      <PencilSimple size={18} color={colors.accent} />
                    </IconBtn>
                    <IconBtn label={t("mobile.catalog.deleteCategoryTitle")} disabled={busy} onPress={() => confirmDelete(c)}>
                      <Trash size={18} color={colors.danger} />
                    </IconBtn>
                  </View>
                ) : null}
              </Card>
            );
          })}
        </View>
      )}

      <CategorySheet
        state={sheet}
        pending={create.isPending || update.isPending}
        onClose={() => setSheet(null)}
        onSubmit={(label, icon) => {
          if (!sheet) return;
          if (sheet.mode === "add") create.mutate({ label, icon });
          else update.mutate({ id: sheet.category.id, label, icon });
        }}
      />
    </Screen>
  );
}

function IconBtn({ label, disabled, onPress, children }: { label: string; disabled?: boolean; onPress: () => void; children: React.ReactNode }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.iconBtn, pressed && { backgroundColor: colors.neutralTint }]}
    >
      {children}
    </Pressable>
  );
}

/** Add / rename sheet. The key is derived on submit; only the label is typed. */
function CategorySheet({
  state,
  pending,
  onClose,
  onSubmit,
}: {
  state: { mode: "add" } | { mode: "edit"; category: Category } | null;
  pending: boolean;
  onClose: () => void;
  onSubmit: (label: string, icon: string) => void;
}) {
  const editing = state?.mode === "edit" ? state.category : null;
  // Keyed remount on open so the fields seed from the row being edited.
  return (
    <Modal visible={state !== null} transparent animationType="slide" onRequestClose={onClose}>
      {state ? (
        <SheetBody
          key={editing?.id ?? "add"}
          initialLabel={editing?.label ?? ""}
          initialIcon={editing?.icon ?? "Package"}
          title={editing ? t("mobile.catalog.editCategory") : t("app.catalog.categoriesAdmin.addCategory")}
          pending={pending}
          onClose={onClose}
          onSubmit={onSubmit}
        />
      ) : null}
    </Modal>
  );
}

function SheetBody({
  initialLabel,
  initialIcon,
  title,
  pending,
  onClose,
  onSubmit,
}: {
  initialLabel: string;
  initialIcon: string;
  title: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (label: string, icon: string) => void;
}) {
  const [label, setLabel] = useState(initialLabel);
  const [icon, setIcon] = useState(initialIcon);
  const valid = label.trim().length > 0 && label.trim().length <= 80;
  return (
    <View style={[styles.overlay, directionStyle(getLocale() === "ar")]}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel={t("app.common.close")} />
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={styles.sheet}>
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetBody}>
            <Text style={styles.sheetTitle}>{title}</Text>
            <Field
              label={t("app.catalog.categoriesAdmin.labelLabel")}
              value={label}
              onChangeText={setLabel}
              placeholder={t("app.catalog.categoriesAdmin.labelPlaceholder")}
              autoFocus
              maxLength={80}
              returnKeyType="done"
              onSubmitEditing={() => valid && !pending && onSubmit(label.trim(), icon)}
            />
            <View>
              <Text style={styles.label}>{t("app.catalog.categoriesAdmin.iconLabel")}</Text>
              <View style={styles.iconGrid}>
                {taxonomy.CATEGORY_ICONS.map((name) => {
                  const active = icon === name;
                  return (
                    <Pressable
                      key={name}
                      accessibilityRole="button"
                      accessibilityLabel={name}
                      accessibilityState={{ selected: active }}
                      onPress={() => setIcon(name)}
                      style={[styles.iconCell, active && styles.iconCellActive]}
                    >
                      <CategoryGlyph name={name} size={22} color={active ? colors.accent : colors.textSecondary} />
                    </Pressable>
                  );
                })}
              </View>
            </View>
            <View style={styles.sheetActions}>
              <Button label={t("app.common.cancel")} variant="ghost" onPress={onClose} style={{ flex: 1 }} />
              <Button
                label={t("app.catalog.categoriesAdmin.save")}
                onPress={() => onSubmit(label.trim(), icon)}
                disabled={!valid}
                loading={pending}
                style={{ flex: 1 }}
              />
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { gap: spacing.sm, marginBottom: spacing.lg },
  back: { flexDirection: "row", alignItems: "center", gap: 4, alignSelf: "flex-start", minHeight: MIN_TOUCH },
  backLabel: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary },
  titleRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md },
  title: { fontFamily: fonts.bold, fontSize: 24, color: colors.text, ...RTL_TEXT },
  subtitle: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, marginTop: 4, ...RTL_TEXT },
  addBtn: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  notice: { borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, marginBottom: spacing.md },
  noticeOk: { backgroundColor: colors.successLight },
  noticeErr: { backgroundColor: colors.dangerLight },
  noticeText: { fontFamily: fonts.medium, fontSize: 14, ...RTL_TEXT },
  readOnly: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, marginBottom: spacing.md, ...RTL_TEXT },
  hint: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, marginBottom: spacing.md, ...RTL_TEXT },
  countLine: { fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  glyph: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    backgroundColor: colors.accentLight,
    alignItems: "center",
    justifyContent: "center",
  },
  rowTitle: { fontFamily: fonts.semibold, fontSize: 16, color: colors.text, ...RTL_TEXT },
  metaRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" },
  key: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, writingDirection: "ltr" },
  // Own row under the content so the label column keeps the full card width —
  // four 44pt targets beside a 40pt glyph left the chips ~60pt to draw in.
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 0,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  iconBtn: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: "center", justifyContent: "center", borderRadius: radius.md },
  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.scrim },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    maxHeight: "90%",
    ...elevation.modal,
  },
  sheetBody: { padding: spacing.xl, gap: spacing.lg },
  sheetTitle: { fontFamily: fonts.bold, fontSize: 18, color: colors.text, ...RTL_TEXT },
  label: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary, marginBottom: spacing.sm, ...RTL_TEXT },
  iconGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  iconCell: {
    width: 48,
    height: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  iconCellActive: { borderColor: colors.accent, backgroundColor: colors.accentLight },
  sheetActions: { flexDirection: "row", gap: spacing.md },
});
