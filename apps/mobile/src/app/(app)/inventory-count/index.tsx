import { Pressable, StyleSheet, Text, View } from "react-native";
import { SkeletonListRow } from "@/components/ui/skeleton";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { PlusIcon as Plus } from "phosphor-react-native/src/icons/Plus";
import { PackageIcon as Package } from "phosphor-react-native/src/icons/Package";
import { CheckCircleIcon as CheckCircle } from "phosphor-react-native/src/icons/CheckCircle";
import { inventoryCounts as api } from "@matgary/api-client";

import { api as client } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { ChevronForward } from "@/components/ui/Chevron";
import { EmptyState } from "@/components/ui/EmptyState";
import { useSession } from "@/stores/session";
import { shortDate } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing, MIN_TOUCH } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Inventory Count home.
 *
 * Two sections (owner's approved layout):
 *   1) Active — any count in draft / in_progress / review.
 *   2) Completed — the last 50, newest first.
 * And a primary "+ New count" row at the top.
 *
 * Row style mirrors the Team hub + More page (white card, hairline border,
 * plain icon, no filled icon bubbles). No navigation changes elsewhere.
 */
export default function InventoryCountHomeScreen() {
  const router = useRouter();
  const perms = useSession((s) => s.me?.permissions);
  const canManage = perms == null || perms.includes("manage_inventory_counts");
  const canView = perms == null || perms.includes("view_inventory_counts");

  const active = useQuery({
    queryKey: ["inventory-counts", "active"],
    enabled: canView,
    queryFn: () => api.listCounts(client, { status: "active" }),
  });
  const completed = useQuery({
    queryKey: ["inventory-counts", "completed"],
    enabled: canView,
    queryFn: () => api.listCounts(client, { status: "completed" }),
  });

  if (!canView) {
    return (
      <Screen title={t("mobile.inventoryCount.title")}>
        <EmptyState title={t("mobile.common.forbidden")} />
      </Screen>
    );
  }

  return (
    <Screen
      title={t("mobile.inventoryCount.title")}
      subtitle={t("mobile.inventoryCount.subtitle")}
      onRefresh={() => {
        void active.refetch();
        void completed.refetch();
      }}
      refreshing={active.isRefetching || completed.isRefetching}
    >
      <View style={styles.stack}>
        {canManage ? (
          <Pressable
            style={({ pressed }) => [styles.newRow, pressed && styles.pressed]}
            onPress={() => router.push("/inventory-count/new")}
            accessibilityRole="button"
            testID="inventory-count-new"
          >
            <Plus size={22} color={colors.accent} />
            <View style={styles.rowBody}>
              <Text style={[styles.rowName, styles.accentLabel]}>
                {t("mobile.inventoryCount.newCount")}
              </Text>
            </View>
            <ChevronForward />
          </Pressable>
        ) : null}

        <SectionHeader label={t("mobile.inventoryCount.sections.active")} />
        {active.isPending && !active.data ? (
          <SkeletonListRow count={2} avatarSize={0} trailingWidth={48} height={64} />
        ) : (active.data ?? []).length === 0 ? (
          <EmptyState title={t("mobile.inventoryCount.empty.active")} />
        ) : (
          active.data!.map((item) => (
            <CountRow
              key={item.count.id}
              status={item.count.status}
              title={scopeLabel(item.count.scopeKind, item.count.scopeValue)}
              createdAt={item.count.createdAt}
              counted={item.summary.linesCounted}
              scope={item.summary.scopeProductCount}
              differences={item.summary.linesShortage + item.summary.linesOverage}
              onPress={() => router.push(`/inventory-count/${item.count.id}`)}
            />
          ))
        )}

        <SectionHeader label={t("mobile.inventoryCount.sections.completed")} />
        {completed.isPending && !completed.data ? (
          <SkeletonListRow count={3} avatarSize={0} trailingWidth={48} height={64} />
        ) : (completed.data ?? []).length === 0 ? (
          <EmptyState title={t("mobile.inventoryCount.empty.completed")} />
        ) : (
          completed.data!.map((item) => (
            <CountRow
              key={item.count.id}
              status={item.count.status}
              title={scopeLabel(item.count.scopeKind, item.count.scopeValue)}
              createdAt={item.count.confirmedAt ?? item.count.createdAt}
              counted={item.summary.linesCounted}
              scope={item.summary.scopeProductCount}
              differences={item.summary.linesShortage + item.summary.linesOverage}
              onPress={() => router.push(`/inventory-count/${item.count.id}`)}
            />
          ))
        )}
      </View>
    </Screen>
  );
}

function SectionHeader({ label }: { label: string }) {
  return <Text style={styles.sectionHeader}>{label}</Text>;
}

function CountRow({
  status,
  title,
  createdAt,
  counted,
  scope,
  differences,
  onPress,
}: {
  status: string;
  title: string;
  createdAt: string | null;
  counted: number;
  scope: number;
  differences: number;
  onPress: () => void;
}) {
  const Icon = status === "completed" ? CheckCircle : Package;
  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      testID="inventory-count-row"
    >
      <Icon size={22} color={colors.accent} />
      <View style={styles.rowBody}>
        <Text numberOfLines={1} style={styles.rowName}>
          {title}
        </Text>
        <Text numberOfLines={1} style={styles.rowMeta}>
          {createdAt ? shortDate(createdAt) : ""}
          {" · "}
          {t("mobile.inventoryCount.row.countedOf", { n: counted, total: scope })}
          {differences > 0 ? ` · ${t("mobile.inventoryCount.row.differences", { n: differences })}` : ""}
        </Text>
      </View>
      <ChevronForward />
    </Pressable>
  );
}

function scopeLabel(kind: string, value: string | null): string {
  if (kind === "all") return t("mobile.inventoryCount.scope.all");
  if (kind === "category") return t("mobile.inventoryCount.scope.categoryLabel", { value: value ?? "—" });
  if (kind === "brand") return t("mobile.inventoryCount.scope.brandLabel", { value: value ?? "—" });
  return kind;
}

const styles = StyleSheet.create({
  stack: { gap: spacing.sm },
  sectionHeader: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: spacing.md,
    ...RTL_TEXT,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: MIN_TOUCH,
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  newRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: MIN_TOUCH,
    backgroundColor: colors.card,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.accent,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  pressed: { opacity: 0.85 },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowName: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  rowMeta: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  accentLabel: { color: colors.accent },
});
