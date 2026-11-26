// /financials/categories — mobile manager for expense categories.
//
// System categories are read-only and badge-labeled "System". Tenant-custom
// categories (created under any group) can be renamed or archived. Archive
// is server-side; the server rejects if the category still has live expenses
// pointing at it.

import { useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { PencilSimpleIcon as PencilSimple } from "phosphor-react-native/src/icons/PencilSimple";
import { PlusIcon as Plus } from "phosphor-react-native/src/icons/Plus";
import { TrashIcon as Trash } from "phosphor-react-native/src/icons/Trash";

import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Sheet, useSheet } from "@/components/ui/Sheet";
import { SkeletonListRow } from "@/components/ui/skeleton";
import {
  useArchiveCategory,
  useCreateCategory,
  useFinanceCategories,
  useRenameCategory,
  type FinanceCategoryNode,
} from "@/hooks/useFinance";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, elevation, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

export default function CategoriesScreen() {
  const me = useSession((s) => s.me);
  const perms = new Set(me?.permissions ?? []);
  const canManage = me?.isOwner || perms.has("manage_expense_categories");

  const q = useFinanceCategories();
  const renameMut = useRenameCategory();
  const archiveMut = useArchiveCategory();

  const createSheet = useSheet();
  const renameSheet = useSheet();
  const [renameTarget, setRenameTarget] = useState<FinanceCategoryNode | null>(null);

  if (!canManage) {
    return (
      <Screen title={t("mobile.financials.categories.title")}>
        <Card>
          <Text style={styles.err}>{t("mobile.financials.expenses.noPermission")}</Text>
        </Card>
      </Screen>
    );
  }

  const onArchive = (cat: FinanceCategoryNode) => {
    Alert.alert(
      t("mobile.financials.categories.archive"),
      cat.nameAr || cat.nameEn,
      [
        { text: t("app.common.cancel"), style: "cancel" },
        {
          text: t("mobile.financials.categories.archive"),
          style: "destructive",
          onPress: async () => {
            try {
              await archiveMut.mutateAsync(cat.id);
            } catch {
              Alert.alert(t("mobile.financials.categories.archiveFailed"));
            }
          },
        },
      ],
    );
  };

  return (
    <View style={{ flex: 1 }}>
    <Screen
      title={t("mobile.financials.categories.title")}
      refreshing={q.isRefetching}
      onRefresh={() => q.refetch()}
    >
      {q.isPending && !q.data ? (
        <SkeletonListRow count={8} />
      ) : (
        (q.data ?? []).map((group) => (
          <Card key={group.id}>
            <View style={styles.groupHead}>
              <Text style={styles.groupTitle}>{group.nameAr || group.nameEn}</Text>
              {group.isSystem ? (
                <Badge label={t("mobile.financials.categories.systemBadge")} variant="neutral" />
              ) : null}
            </View>
            <View style={styles.children}>
              {group.children.length === 0 ? (
                <Text style={styles.empty}>—</Text>
              ) : (
                group.children.map((c) => (
                  <View key={c.id} style={styles.row}>
                    <Text style={styles.rowName} numberOfLines={1}>
                      {c.nameAr || c.nameEn}
                    </Text>
                    {c.archivedAt ? (
                      <Badge
                        label={t("mobile.financials.categories.archivedBadge")}
                        variant="outofstock"
                      />
                    ) : c.isSystem ? (
                      <Badge
                        label={t("mobile.financials.categories.systemBadge")}
                        variant="neutral"
                      />
                    ) : (
                      <View style={styles.rowActions}>
                        <Pressable
                          onPress={() => {
                            setRenameTarget(c);
                            renameSheet.open();
                          }}
                          style={styles.actionBtn}
                          accessibilityRole="button"
                          accessibilityLabel={t("mobile.financials.categories.renameTitle")}
                        >
                          <PencilSimple size={16} color={colors.accent} />
                        </Pressable>
                        <Pressable
                          onPress={() => onArchive(c)}
                          style={styles.actionBtn}
                          accessibilityRole="button"
                          accessibilityLabel={t("mobile.financials.categories.archive")}
                        >
                          <Trash size={16} color={colors.danger} />
                        </Pressable>
                      </View>
                    )}
                  </View>
                ))
              )}
            </View>
          </Card>
        ))
      )}

      <CreateCategorySheet
        visible={createSheet.visible}
        onClose={createSheet.close}
        categories={q.data ?? []}
      />

      <RenameCategorySheet
        visible={renameSheet.visible}
        onClose={() => {
          renameSheet.close();
          setRenameTarget(null);
        }}
        target={renameTarget}
        renameMut={renameMut}
      />
    </Screen>

    <Pressable
      onPress={createSheet.open}
      style={styles.fab}
      accessibilityRole="button"
      accessibilityLabel={t("mobile.financials.categories.newTitle")}
    >
      <Plus size={22} color={colors.card} weight="bold" />
    </Pressable>
    </View>
  );
}

function CreateCategorySheet({
  visible,
  onClose,
  categories,
}: {
  visible: boolean;
  onClose: () => void;
  categories: FinanceCategoryNode[];
}) {
  const [parentId, setParentId] = useState<string | null>(null);
  const [nameEn, setNameEn] = useState("");
  const [nameAr, setNameAr] = useState("");
  const [slug, setSlug] = useState("");

  const createMut = useCreateCategory();

  const canSave =
    !!parentId &&
    nameEn.trim().length > 0 &&
    nameAr.trim().length > 0 &&
    /^[a-z0-9-]{3,32}$/.test(slug) &&
    !createMut.isPending;

  const groups = useMemo(
    () => categories.filter((g) => !g.archivedAt),
    [categories],
  );

  const onSave = async () => {
    if (!canSave) return;
    try {
      await createMut.mutateAsync({
        parentId: parentId!,
        slug,
        nameEn: nameEn.trim(),
        nameAr: nameAr.trim(),
      });
      setNameEn("");
      setNameAr("");
      setSlug("");
      setParentId(null);
      onClose();
    } catch {
      Alert.alert(t("mobile.financials.expenses.saveFailed"));
    }
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={t("mobile.financials.categories.newTitle")}
      testID="category-create"
      primaryAction={{
        label: t("mobile.financials.expenses.save"),
        onPress: onSave,
        loading: createMut.isPending,
        disabled: !canSave,
      }}
      secondaryAction={{ label: t("app.common.cancel"), onPress: onClose }}
    >
      <Text style={styles.label}>{t("mobile.financials.categories.pickGroup")}</Text>
      <View style={styles.chipRow}>
        {groups.map((g) => (
          <Pressable
            key={g.id}
            onPress={() => setParentId(g.id)}
            style={[styles.chip, parentId === g.id && styles.chipActive]}
          >
            <Text style={[styles.chipText, parentId === g.id && styles.chipTextActive]}>
              {g.nameAr || g.nameEn}
            </Text>
          </Pressable>
        ))}
      </View>

      <Field
        label={t("mobile.financials.categories.fieldNameAr")}
        value={nameAr}
        onChangeText={setNameAr}
        maxLength={60}
      />
      <Field
        label={t("mobile.financials.categories.fieldNameEn")}
        value={nameEn}
        onChangeText={setNameEn}
        maxLength={60}
      />
      <Field
        label={t("mobile.financials.categories.fieldSlug")}
        value={slug}
        onChangeText={(v) =>
          setSlug(v.replace(/[^a-z0-9-]/g, "").toLowerCase().slice(0, 32))
        }
        maxLength={32}
        ltr
      />
    </Sheet>
  );
}

function RenameCategorySheet({
  visible,
  onClose,
  target,
  renameMut,
}: {
  visible: boolean;
  onClose: () => void;
  target: FinanceCategoryNode | null;
  renameMut: ReturnType<typeof useRenameCategory>;
}) {
  const [nameEn, setNameEn] = useState(target?.nameEn ?? "");
  const [nameAr, setNameAr] = useState(target?.nameAr ?? "");

  // Re-seed when the target changes (another row tapped Rename).
  if (target && (nameEn !== target.nameEn || nameAr !== target.nameAr) && !visible) {
    // no-op guard
  }

  const canSave =
    !!target &&
    (nameEn.trim() !== (target?.nameEn ?? "") || nameAr.trim() !== (target?.nameAr ?? "")) &&
    nameEn.trim().length > 0 &&
    nameAr.trim().length > 0 &&
    !renameMut.isPending;

  const onSave = async () => {
    if (!target || !canSave) return;
    try {
      await renameMut.mutateAsync({
        id: target.id,
        nameEn: nameEn.trim(),
        nameAr: nameAr.trim(),
      });
      onClose();
    } catch {
      Alert.alert(t("mobile.financials.expenses.saveFailed"));
    }
  };

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={t("mobile.financials.categories.renameTitle")}
      testID="category-rename"
      primaryAction={{
        label: t("mobile.financials.expenses.save"),
        onPress: onSave,
        loading: renameMut.isPending,
        disabled: !canSave,
      }}
      secondaryAction={{ label: t("app.common.cancel"), onPress: onClose }}
    >
      <Field
        label={t("mobile.financials.categories.fieldNameAr")}
        value={nameAr}
        onChangeText={setNameAr}
        maxLength={60}
      />
      <Field
        label={t("mobile.financials.categories.fieldNameEn")}
        value={nameEn}
        onChangeText={setNameEn}
        maxLength={60}
      />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  err: { ...RTL_TEXT, fontSize: 14, color: colors.danger },
  groupHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
  },
  groupTitle: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
  },
  children: { gap: spacing.xs },
  empty: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textSecondary,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.xs,
  },
  rowName: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.text,
    flex: 1,
  },
  rowActions: { flexDirection: "row", gap: spacing.xs },
  actionBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.bg,
  },
  fab: {
    position: "absolute",
    end: spacing.lg,
    bottom: spacing.xl + 40,
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    ...elevation.modal,
  },
  label: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginBottom: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 12,
    color: colors.textSecondary,
  },
  chipTextActive: { color: colors.card },
});
