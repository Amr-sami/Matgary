import { useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SkeletonSelectorRows } from "@/components/ui/skeleton";
import { useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PackageIcon as Package } from "phosphor-react-native/src/icons/Package";
import { TagIcon as Tag } from "phosphor-react-native/src/icons/Tag";
import { FunnelIcon as Funnel } from "phosphor-react-native/src/icons/Funnel";
import { inventoryCounts as api, taxonomy, catalog } from "@matgary/api-client";

import { api as client } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { HeaderAccessories } from "@/components/shell/HeaderAccessories";
import { BackLink } from "@/components/ui/BackLink";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { useSession } from "@/stores/session";
import { errorText } from "@/lib/errors";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing, MIN_TOUCH } from "@/theme/tokens";
import { t } from "@/i18n";

type ScopeKind = "all" | "category" | "brand";

/**
 * Scope picker for a new count.
 * UX rule the owner approved: tell the user what they're counting and how
 * many SKUs are included BEFORE the "Start" button is tappable.
 */
export default function NewInventoryCountScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const perms = useSession((s) => s.me?.permissions);
  const canManage = perms == null || perms.includes("manage_inventory_counts");

  const [kind, setKind] = useState<ScopeKind>("all");
  const [value, setValue] = useState<string | null>(null);
  const [filterQuery, setFilterQuery] = useState("");

  // Catalog lookups — reused existing endpoints (no new API).
  const categories = useQuery({
    queryKey: ["categories"],
    enabled: kind === "category",
    queryFn: () => taxonomy.listCategories(client),
  });
  const brands = useQuery({
    queryKey: ["brands"],
    enabled: kind === "brand",
    queryFn: () => taxonomy.listBrands(client),
  });
  const products = useQuery({
    queryKey: ["products"],
    queryFn: () => catalog.listProducts(client),
  });

  const scopeProductCount = useMemo(() => {
    if (kind === "all") return products.data?.length ?? 0;
    if (kind === "category" && value)
      return (products.data ?? []).filter((p) => p.category === value).length;
    if (kind === "brand" && value)
      return (products.data ?? []).filter((p) => p.brand === value).length;
    return 0;
  }, [kind, value, products.data]);

  const filteredChoices = useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    const src =
      kind === "category"
        ? (categories.data ?? []).map((c) => ({ id: c.id, label: c.label }))
        : kind === "brand"
          ? (brands.data ?? []).map((b) => ({ id: b.name, label: b.name }))
          : [];
    return q ? src.filter((x) => x.label.toLowerCase().includes(q)) : src;
  }, [kind, categories.data, brands.data, filterQuery]);

  const create = useMutation({
    mutationFn: () =>
      api.createCount(client, { scope: { kind, value } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["inventory-counts", "active"] });
      router.replace(`/inventory-count/${r.countId}`);
    },
  });

  const canStart = canManage && (kind === "all" || !!value) && scopeProductCount > 0;

  const header = (
    <View style={styles.header}>
      <HeaderAccessories />
      <BackLink
        label={t("mobile.inventoryCount.title")}
        onPress={() => router.navigate("/inventory-count")}
      />
    </View>
  );

  if (!canManage) {
    return (
      <Screen header={header}>
        <EmptyState title={t("mobile.common.forbidden")} />
      </Screen>
    );
  }

  return (
    <Screen header={header}>
      <View style={styles.titleBlock}>
        <Text style={styles.title}>{t("mobile.inventoryCount.newCount")}</Text>
        <Text style={styles.subtitle}>{t("mobile.inventoryCount.subtitle")}</Text>
      </View>

      <View style={styles.stack}>
        <Card title={t("mobile.inventoryCount.scope.title")}>
          <Segmented
            value={kind}
            onChange={(v) => {
              setKind(v as ScopeKind);
              setValue(null);
              setFilterQuery("");
            }}
            items={[
              { key: "all", label: t("mobile.inventoryCount.scope.all") },
              { key: "category", label: t("mobile.inventoryCount.scope.category") },
              { key: "brand", label: t("mobile.inventoryCount.scope.brand") },
            ]}
          />

          {kind === "category" || kind === "brand" ? (
            <>
              <Field
                label={t("mobile.inventoryCount.scope.filterLabel")}
                value={filterQuery}
                onChangeText={setFilterQuery}
                placeholder={t("mobile.inventoryCount.scope.filterPlaceholder")}
              />
              {kind === "category" && categories.isPending && !categories.data ? (
                <SkeletonSelectorRows count={4} avatarSize={0} />
              ) : kind === "brand" && brands.isPending && !brands.data ? (
                <SkeletonSelectorRows count={4} avatarSize={0} />
              ) : filteredChoices.length === 0 ? (
                <Text style={styles.hint}>{t("mobile.inventoryCount.scope.empty")}</Text>
              ) : (
                <View style={styles.choices}>
                  {filteredChoices.slice(0, 30).map((c) => {
                    const active = value === c.id;
                    return (
                      <Pressable
                        key={c.id}
                        onPress={() => setValue(c.id)}
                        style={({ pressed }) => [
                          styles.chip,
                          active && styles.chipActive,
                          pressed && styles.pressed,
                        ]}
                        accessibilityRole="button"
                      >
                        <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
                          {c.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </>
          ) : null}
        </Card>

        <Card title={t("mobile.inventoryCount.scope.summary")}>
          <View style={styles.summaryRow}>
            <Funnel size={18} color={colors.accent} />
            <Text style={styles.summaryText}>
              {kind === "all"
                ? t("mobile.inventoryCount.scope.all")
                : value
                  ? kind === "category"
                    ? t("mobile.inventoryCount.scope.categoryLabel", {
                        value:
                          (categories.data ?? []).find((c) => c.id === value)?.label ?? value,
                      })
                    : t("mobile.inventoryCount.scope.brandLabel", { value })
                  : t("mobile.inventoryCount.scope.pickOne")}
            </Text>
          </View>
          <View style={styles.summaryRow}>
            <Package size={18} color={colors.accent} />
            <Text style={styles.summaryText}>
              {t("mobile.inventoryCount.scope.productCount", { n: scopeProductCount })}
            </Text>
          </View>
          <Text style={styles.footnote}>{t("mobile.inventoryCount.scope.lowActivityHint")}</Text>
        </Card>

        {create.error ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>
              {errorText(create.error, t("mobile.inventoryCount.start.failed"))}
            </Text>
          </View>
        ) : null}

        <Button
          label={t("mobile.inventoryCount.start.cta")}
          onPress={() => create.mutate()}
          loading={create.isPending}
          disabled={!canStart || create.isPending}
          testID="inventory-count-start"
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: spacing.xs, alignItems: "flex-start" },
  titleBlock: { gap: spacing.xs, marginBottom: spacing.md },
  title: { fontFamily: fonts.bold, fontSize: 24, color: colors.text, ...RTL_TEXT },
  subtitle: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  stack: { gap: spacing.md },
  hint: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  footnote: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    ...RTL_TEXT,
    marginTop: spacing.sm,
  },
  summaryRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: 4 },
  summaryText: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT, flex: 1 },
  choices: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  chip: {
    minHeight: 36,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  chipActive: { borderColor: colors.accent, backgroundColor: colors.accentLight },
  chipText: { fontFamily: fonts.medium, fontSize: 13, color: colors.text, ...RTL_TEXT },
  chipTextActive: { color: colors.accent },
  pressed: { opacity: 0.85 },
  errorBanner: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.dangerLight,
  },
  errorText: { fontFamily: fonts.medium, fontSize: 13, color: colors.danger, ...RTL_TEXT },
});
