import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, catalog, taxonomy } from "@matgary/api-client";
import { PencilSimpleIcon as PencilSimple } from "phosphor-react-native/src/icons/PencilSimple";
import { PlusIcon as Plus } from "phosphor-react-native/src/icons/Plus";
import { TagIcon as Tag } from "phosphor-react-native/src/icons/Tag";
import { TrashIcon as Trash } from "phosphor-react-native/src/icons/Trash";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ChevronBack } from "@/components/ui/Chevron";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Sheet } from "@/components/ui/Sheet";
import { countLabel } from "@/lib/format";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Port of the web's BrandsEditor ("البراندات" section of settings).
 *
 * The web is a category <select> over a flat name list with add/delete.
 * Here the select is a chip row (with "all", which the web lacks — on a
 * phone you want to see the whole brand book in one scroll), each row shows
 * its category and how many products carry the name, and rename / move-to-
 * category happen in the same sheet that adds. `PATCH /api/brands/[id]`
 * already supports both fields; the web just never exposed them.
 *
 * Brands are stored on products by NAME (`products.brand`), not by id, so
 * deleting a brand row is never blocked by the server — the confirm says how
 * many products still carry the name so the owner knows what they are doing.
 */
type Brand = taxonomy.Brand;
type Category = taxonomy.Category;

const ALL = "__all";

function errText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.kind === "forbidden") return t("mobile.common.forbidden");
    if (e.kind === "offline") return t("mobile.common.offline");
    if (e.kind === "timeout") return t("mobile.common.timeout");
    // A unique-key clash surfaces as drizzle's raw "Failed query: insert…" — never show SQL.
    if (e.status === 409 && /failed query/i.test(e.message)) return t("mobile.catalog.duplicateKey");
    if (e.status && e.status < 500 && e.message && !/^HTTP \d+$/.test(e.message)) return e.message;
  }
  return t("mobile.catalog.genericError");
}

export default function BrandsSettingsScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useSession((s) => s.me);
  const canManage = !!me && (me.isOwner || me.permissions.includes("manage_catalog"));

  const [filter, setFilter] = useState<string>(ALL);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [sheet, setSheet] = useState<{ mode: "add" } | { mode: "edit"; brand: Brand } | null>(null);

  const categoriesQ = useQuery({
    queryKey: ["categories"],
    queryFn: () => taxonomy.listCategories(api),
  });
  // One unfiltered fetch; the chip row filters locally so switching is instant
  // and the "all" view needs no second request.
  const brandsQ = useQuery({
    queryKey: ["brands"],
    queryFn: () => taxonomy.listBrands(api),
  });
  const products = useQuery({
    queryKey: ["products"],
    queryFn: () => catalog.listProducts(api),
    staleTime: 60_000,
  });

  const categories = useMemo(
    () => [...(categoriesQ.data ?? [])].sort((a, b) => a.position - b.position || a.label.localeCompare(b.label)),
    [categoriesQ.data],
  );
  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const brands = useMemo(() => {
    const all = [...(brandsQ.data ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    return filter === ALL ? all : all.filter((b) => b.categoryId === filter);
  }, [brandsQ.data, filter]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of products.data ?? []) {
      if (!p.brand) continue;
      const k = p.brand.trim().toLowerCase();
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [products.data]);
  const countFor = (b: Brand) => (products.data ? (counts.get(b.name.trim().toLowerCase()) ?? 0) : undefined);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ["brands"] });
  const fail = (e: unknown) => setNotice({ tone: "err", text: errText(e) });

  const create = useMutation({
    mutationFn: (input: taxonomy.CreateBrandInput) => taxonomy.createBrand(api, input),
    onSuccess: () => {
      setSheet(null);
      setNotice({ tone: "ok", text: t("mobile.catalog.brandAdded") });
      invalidate();
    },
    onError: fail,
  });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & taxonomy.UpdateBrandInput) => taxonomy.updateBrand(api, id, body),
    onSuccess: () => {
      setSheet(null);
      setNotice({ tone: "ok", text: t("mobile.catalog.saved") });
      invalidate();
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (id: string) => taxonomy.deleteBrand(api, id),
    onSuccess: () => {
      setNotice({ tone: "ok", text: t("app.catalog.categoriesAdmin.toasts.categoryDeleted") });
      invalidate();
    },
    onError: fail,
  });

  const confirmDelete = (b: Brand) => {
    const n = countFor(b) ?? 0;
    const lines = [b.name, t("app.catalog.brandsAdmin.confirmDelete")];
    if (n > 0) lines.push(t("mobile.catalog.brandInUse", { n }));
    Alert.alert(t("mobile.catalog.deleteBrandTitle"), lines.join("\n"), [
      { text: t("app.common.cancel"), style: "cancel" },
      { text: t("app.common.delete"), style: "destructive", onPress: () => remove.mutate(b.id) },
    ]);
  };

  const busy = create.isPending || update.isPending || remove.isPending;
  const loading = categoriesQ.isLoading || brandsQ.isLoading;
  const error = categoriesQ.error ?? brandsQ.error;
  const refetch = () => {
    void categoriesQ.refetch();
    void brandsQ.refetch();
  };

  return (
    <Screen onRefresh={refetch} refreshing={brandsQ.isRefetching}>
      <View style={styles.header}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={12} style={styles.back}>
          <ChevronBack size={16} color={colors.textSecondary} />
          <Text style={styles.backLabel}>{t("app.settingsPage.title")}</Text>
        </Pressable>
        <View style={styles.titleRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>{t("app.catalog.brandsAdmin.title")}</Text>
            <Text style={styles.subtitle}>{t("mobile.catalog.brandsIntro")}</Text>
          </View>
          {canManage && categories.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("app.catalog.brandsAdmin.add")}
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
          <Text style={[styles.noticeText, { color: notice.tone === "ok" ? colors.successStrong : colors.danger }]}>{notice.text}</Text>
        </Pressable>
      ) : null}

      {!canManage && me ? <Text style={styles.readOnly}>{t("mobile.catalog.readOnly")}</Text> : null}

      {loading ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.xl }} />
      ) : error ? (
        <Card>
          <Text style={styles.hint}>{errText(error)}</Text>
          <Button label={t("app.common.retry")} variant="outline" onPress={refetch} />
        </Card>
      ) : categories.length === 0 ? (
        <EmptyState title={t("app.catalog.brandsAdmin.noCategoriesHint")} />
      ) : (
        <View style={{ gap: spacing.md }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            <Chip label={t("mobile.catalog.allCategories")} active={filter === ALL} onPress={() => setFilter(ALL)} />
            {categories.map((c) => (
              <Chip key={c.id} label={c.label} active={filter === c.id} onPress={() => setFilter(c.id)} />
            ))}
          </ScrollView>

          {brands.length === 0 ? (
            <EmptyState
              title={t("app.catalog.brandsAdmin.empty")}
              hint={canManage ? t("app.catalog.brandsAdmin.newPlaceholder") : undefined}
            />
          ) : (
            <View style={{ gap: spacing.sm }}>
              <Text style={styles.countLine}>
                {filter === ALL
                  ? countLabel("mobile.catalog.brandCount", brands.length)
                  : t("mobile.catalog.brandsForCategory", { category: categoryById.get(filter)?.label ?? "" }) +
                    ` · ${countLabel("mobile.catalog.brandCount", brands.length)}`}
              </Text>
              {brands.map((b) => {
                const n = countFor(b);
                const cat = categoryById.get(b.categoryId);
                return (
                  <Card key={b.id}>
                    <View style={styles.row}>
                      <View style={styles.glyph}>
                        <Tag size={20} color={colors.accent} weight="duotone" />
                      </View>
                      <View style={{ flex: 1, gap: 4 }}>
                        <Text style={styles.rowTitle} numberOfLines={1}>{b.name}</Text>
                        <View style={styles.metaRow}>
                          <Text style={styles.meta} numberOfLines={1}>{cat?.label ?? t("mobile.catalog.noCategory")}</Text>
                          {n !== undefined ? <Badge label={countLabel("mobile.catalog.productsCount", n)} variant="neutral" /> : null}
                        </View>
                      </View>
                      {canManage ? (
                        <View style={styles.actions}>
                          <IconBtn label={t("mobile.catalog.editBrand")} disabled={busy} onPress={() => setSheet({ mode: "edit", brand: b })}>
                            <PencilSimple size={18} color={colors.accent} />
                          </IconBtn>
                          <IconBtn label={t("mobile.catalog.deleteBrandTitle")} disabled={busy} onPress={() => confirmDelete(b)}>
                            <Trash size={18} color={colors.danger} />
                          </IconBtn>
                        </View>
                      ) : null}
                    </View>
                  </Card>
                );
              })}
            </View>
          )}
        </View>
      )}

      <BrandSheet
        visible={sheet !== null}
        seedKey={sheet ? (sheet.mode === "edit" ? sheet.brand.id : "add") : null}
        categories={categories}
        initial={
          sheet?.mode === "edit"
            ? { name: sheet.brand.name, categoryId: sheet.brand.categoryId }
            : { name: "", categoryId: filter === ALL ? categories[0]?.id ?? null : filter }
        }
        title={sheet?.mode === "edit" ? t("mobile.catalog.editBrand") : t("app.catalog.brandsAdmin.add")}
        pending={create.isPending || update.isPending}
        onClose={() => setSheet(null)}
        onSubmit={(name, categoryId) => {
          if (!sheet) return;
          if (sheet.mode === "add") {
            create.mutate({ name, categoryId });
            return;
          }
          const prev = sheet.brand;
          const renamed = name.trim() !== prev.name.trim();
          const n = renamed ? countFor(prev) ?? 0 : 0;
          if (n === 0) {
            update.mutate({ id: prev.id, name, categoryId });
            return;
          }
          // `products.brand` is the NAME, and PATCH /api/brands/[id] only touches the
          // brands row — no cascade. Renaming a brand that products carry orphans them
          // exactly like a delete does, so warn with the same count before committing.
          Alert.alert(
            t("mobile.catalog.renameBrandTitle"),
            t("mobile.catalog.renameBrandWarn", { n, old: prev.name }),
            [
              { text: t("app.common.cancel"), style: "cancel" },
              {
                text: t("app.common.confirm"),
                style: "destructive",
                onPress: () => update.mutate({ id: prev.id, name, categoryId }),
              },
            ],
          );
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

function BrandSheet({
  visible,
  seedKey,
  categories,
  initial,
  title,
  pending,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  /** Changes per open (brand id or "add") — re-seeds the fields. */
  seedKey: string | null;
  categories: Category[];
  initial: { name: string; categoryId: string | null };
  title: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (name: string, categoryId: string | null) => void;
}) {
  const [name, setName] = useState(initial.name);
  const [categoryId, setCategoryId] = useState<string | null>(initial.categoryId);
  const { name: seedName, categoryId: seedCategoryId } = initial;
  useEffect(() => {
    if (seedKey !== null) {
      setName(seedName);
      setCategoryId(seedCategoryId);
    }
    // Only re-seed when a sheet OPENS (seedKey flips), not on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);
  const valid = name.trim().length > 0 && name.trim().length <= 80 && !!categoryId;
  const submit = () => onSubmit(name.trim(), categoryId);
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={title}
      testID="brand-form"
      primaryAction={{
        label: t("app.common.save"),
        onPress: submit,
        disabled: !valid,
        loading: pending,
        testID: "brand-form-submit",
      }}
      secondaryAction={{ label: t("app.common.cancel"), onPress: onClose }}
    >
      <Field
        label={t("mobile.catalog.brandNameLabel")}
        value={name}
        onChangeText={setName}
        placeholder={t("app.catalog.brandsAdmin.newPlaceholder")}
        autoFocus
        maxLength={80}
        returnKeyType="done"
        onSubmitEditing={() => valid && !pending && submit()}
      />
      <View>
        <Text style={styles.label}>{t("app.common.category")}</Text>
        <View style={styles.chipWrap}>
          {categories.map((c) => (
            <Chip key={c.id} label={c.label} active={categoryId === c.id} onPress={() => setCategoryId(c.id)} />
          ))}
        </View>
      </View>
    </Sheet>
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
  chipRow: { flexDirection: "row", gap: spacing.sm, paddingVertical: 2 },
  chipWrap: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
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
  meta: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  actions: { flexDirection: "row", alignItems: "center", gap: 0 },
  iconBtn: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: "center", justifyContent: "center", borderRadius: radius.md },
  label: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary, marginBottom: spacing.sm, ...RTL_TEXT },
});
