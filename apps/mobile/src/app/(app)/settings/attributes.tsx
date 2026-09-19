import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View, Platform } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, taxonomy } from "@matgary/api-client";
import { CaretDownIcon as CaretDown } from "phosphor-react-native/src/icons/CaretDown";
import { CaretUpIcon as CaretUp } from "phosphor-react-native/src/icons/CaretUp";
import { PencilSimpleIcon as PencilSimple } from "phosphor-react-native/src/icons/PencilSimple";
import { PlusIcon as Plus } from "phosphor-react-native/src/icons/Plus";
import { SlidersHorizontalIcon as SlidersHorizontal } from "phosphor-react-native/src/icons/SlidersHorizontal";
import { TrashIcon as Trash } from "phosphor-react-native/src/icons/Trash";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { SettingsHeader } from "@/components/ui/SettingsHeader";
import { Sheet } from "@/components/ui/Sheet";
import { countLabel } from "@/lib/format";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Port of the web's AttributesEditor — the accordion body inside each category
 * row of CategoriesEditor. On the web an attribute and its values are edited
 * in place under the category; here the category is a chip row at the top and
 * each attribute is a card that expands to its values, so the two levels
 * (attribute → value) live on one screen without a second route.
 *
 * Server: `GET /api/categories/[id]/attributes` answers attributes WITH their
 * values in one shot; adds/patches/deletes go to `/api/attributes/[id]`,
 * `/api/attributes/[id]/values` and `/api/attribute-values/[id]`. Adding the
 * first attribute flips the category's `hasAttributes` server-side, so the
 * categories query is invalidated too.
 *
 * `required` exists on the row (the wizard enforces it) but the web never
 * exposed a toggle; the sheet here does.
 */
type Attribute = taxonomy.CategoryAttribute;
type Value = taxonomy.AttributeValue;

type SheetState =
  | { kind: "add-attr" }
  | { kind: "edit-attr"; attr: Attribute }
  | { kind: "edit-value"; value: Value }
  | null;

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

const byPosition = <T extends { position: number; label: string }>(rows: T[]) =>
  [...rows].sort((a, b) => a.position - b.position || a.label.localeCompare(b.label));

export default function AttributesSettingsScreen() {
  const qc = useQueryClient();
  const me = useSession((s) => s.me);
  const canManage = !!me && (me.isOwner || me.permissions.includes("manage_catalog"));

  const [selected, setSelected] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [newValue, setNewValue] = useState<Record<string, string>>({});

  const categoriesQ = useQuery({
    queryKey: ["categories"],
    queryFn: () => taxonomy.listCategories(api),
  });
  const categories = useMemo(() => byPosition(categoriesQ.data ?? []), [categoriesQ.data]);
  // Default to the first category that already has attributes — that is the
  // one the owner most likely came to edit.
  const categoryId = selected ?? categories.find((c) => c.hasAttributes)?.id ?? categories[0]?.id ?? null;

  const attrsQ = useQuery({
    queryKey: ["attributes", categoryId],
    queryFn: () => taxonomy.listAttributes(api, categoryId as string),
    enabled: !!categoryId,
  });
  const attrs = useMemo(() => byPosition(attrsQ.data ?? []), [attrsQ.data]);

  const invalidate = () => {
    // Prefix match, not ['attributes', categoryId]: this closes over the render-time
    // category, and the user can tap another chip before a mutation settles.
    void qc.invalidateQueries({ queryKey: ["attributes"] });
    void qc.invalidateQueries({ queryKey: ["categories"] });
  };
  const fail = (e: unknown) => setNotice({ tone: "err", text: errText(e) });
  const ok = (text: string) => {
    setSheet(null);
    setNotice({ tone: "ok", text });
    invalidate();
  };

  // ---- attributes -------------------------------------------------------
  const createAttr = useMutation({
    mutationFn: (input: { label: string; required: boolean }) =>
      taxonomy.createAttribute(api, categoryId as string, {
        key: taxonomy.slugKey(input.label, "attr"),
        label: input.label,
        required: input.required,
        position: attrs.length,
      }),
    onSuccess: () => ok(t("mobile.catalog.attributeAdded")),
    onError: fail,
  });
  const updateAttr = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & taxonomy.UpdateAttributeInput) =>
      taxonomy.updateAttribute(api, id, body),
    onSuccess: () => ok(t("mobile.catalog.saved")),
    onError: fail,
  });
  const removeAttr = useMutation({
    mutationFn: (id: string) => taxonomy.deleteAttribute(api, id),
    onSuccess: () => ok(t("app.catalog.categoriesAdmin.toasts.categoryDeleted")),
    onError: fail,
  });
  const moveAttr = useMutation({
    mutationFn: async ({ index, dir }: { index: number; dir: -1 | 1 }) => {
      const a = attrs[index];
      const b = attrs[index + dir];
      if (!a || !b) return;
      await Promise.all([
        taxonomy.updateAttribute(api, a.id, { position: index + dir }),
        taxonomy.updateAttribute(api, b.id, { position: index }),
        ...attrs
          .map((r, i) => ({ r, i }))
          .filter(({ r, i }) => r.id !== a.id && r.id !== b.id && r.position !== i)
          .map(({ r, i }) => taxonomy.updateAttribute(api, r.id, { position: i })),
      ]);
    },
    // The reorder is 2+N un-transactional PATCHes; a drop mid-way leaves the server
    // holding a partial order. Refetch on failure too so the list shows server truth.
    onSettled: invalidate,
    onError: fail,
  });

  // ---- values -----------------------------------------------------------
  const createValue = useMutation({
    mutationFn: ({ attr, label }: { attr: Attribute; label: string }) =>
      taxonomy.createAttributeValue(api, attr.id, {
        key: taxonomy.slugKey(label, "value"),
        label,
        position: attr.values.length,
      }),
    onSuccess: (_r, vars) => {
      setNewValue((s) => ({ ...s, [vars.attr.id]: "" }));
      ok(t("mobile.catalog.valueAdded"));
    },
    onError: fail,
  });
  const updateValue = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & taxonomy.UpdateAttributeValueInput) =>
      taxonomy.updateAttributeValue(api, id, body),
    onSuccess: () => ok(t("mobile.catalog.saved")),
    onError: fail,
  });
  const removeValue = useMutation({
    mutationFn: (id: string) => taxonomy.deleteAttributeValue(api, id),
    onSuccess: () => ok(t("app.catalog.categoriesAdmin.toasts.categoryDeleted")),
    onError: fail,
  });
  const moveValue = useMutation({
    mutationFn: async ({ values, index, dir }: { values: Value[]; index: number; dir: -1 | 1 }) => {
      const a = values[index];
      const b = values[index + dir];
      if (!a || !b) return;
      await Promise.all([
        taxonomy.updateAttributeValue(api, a.id, { position: index + dir }),
        taxonomy.updateAttributeValue(api, b.id, { position: index }),
        ...values
          .map((r, i) => ({ r, i }))
          .filter(({ r, i }) => r.id !== a.id && r.id !== b.id && r.position !== i)
          .map(({ r, i }) => taxonomy.updateAttributeValue(api, r.id, { position: i })),
      ]);
    },
    // The reorder is 2+N un-transactional PATCHes; a drop mid-way leaves the server
    // holding a partial order. Refetch on failure too so the list shows server truth.
    onSettled: invalidate,
    onError: fail,
  });

  const confirmDeleteAttr = (a: Attribute) =>
    Alert.alert(
      t("mobile.catalog.deleteAttributeTitle"),
      [a.label, t("app.catalog.categoriesAdmin.attributes.confirmDeleteAttribute"), a.values.length ? t("mobile.catalog.deleteAttributeHint") : null]
        .filter(Boolean)
        .join("\n"),
      [
        { text: t("app.common.cancel"), style: "cancel" },
        { text: t("app.common.delete"), style: "destructive", onPress: () => removeAttr.mutate(a.id) },
      ],
    );
  const confirmDeleteValue = (v: Value) =>
    Alert.alert(t("mobile.catalog.deleteValueTitle"), `${v.label}\n${t("app.catalog.categoriesAdmin.attributes.confirmDeleteValue")}`, [
      { text: t("app.common.cancel"), style: "cancel" },
      { text: t("app.common.delete"), style: "destructive", onPress: () => removeValue.mutate(v.id) },
    ]);

  const busy =
    createAttr.isPending || updateAttr.isPending || removeAttr.isPending || moveAttr.isPending ||
    createValue.isPending || updateValue.isPending || removeValue.isPending || moveValue.isPending;

  const refetch = () => {
    void categoriesQ.refetch();
    void attrsQ.refetch();
  };

  return (
    <Screen onRefresh={refetch} refreshing={attrsQ.isRefetching}>
      <SettingsHeader
        parentLabel={t("app.settingsPage.title")}
        title={t("app.catalog.categoriesAdmin.attributes.heading")}
        subtitle={t("mobile.catalog.attributesIntro")}
        fallback="/settings"
        accessories={
          canManage && categoryId ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t("app.catalog.categoriesAdmin.attributes.addAttribute")}
              onPress={() => setSheet({ kind: "add-attr" })}
              style={({ pressed }) => [styles.addBtn, pressed && { backgroundColor: colors.accentPressed }]}
            >
              <Plus size={20} color={colors.onAccent} weight="bold" />
            </Pressable>
          ) : null
        }
      />

      {notice ? (
        <Pressable onPress={() => setNotice(null)} style={[styles.notice, notice.tone === "ok" ? styles.noticeOk : styles.noticeErr]}>
          <Text style={[styles.noticeText, { color: notice.tone === "ok" ? colors.successStrong : colors.danger }]}>{notice.text}</Text>
        </Pressable>
      ) : null}

      {!canManage && me ? <Text style={styles.readOnly}>{t("mobile.catalog.readOnly")}</Text> : null}

      {categoriesQ.isLoading ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.xl }} />
      ) : categoriesQ.isError ? (
        <Card>
          <Text style={styles.hint}>{errText(categoriesQ.error)}</Text>
          <Button label={t("app.common.retry")} variant="outline" onPress={refetch} />
        </Card>
      ) : categories.length === 0 ? (
        <EmptyState title={t("app.catalog.brandsAdmin.noCategoriesHint")} />
      ) : (
        <View style={{ gap: spacing.md }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
            {categories.map((c) => (
              <Chip
                key={c.id}
                label={c.label}
                active={categoryId === c.id}
                onPress={() => {
                  if (busy) return;
                  setSelected(c.id);
                  setExpanded(null);
                }}
              />
            ))}
          </ScrollView>

          {!categoryId ? (
            <EmptyState title={t("mobile.catalog.pickCategoryFirst")} />
          ) : attrsQ.isLoading ? (
            <ActivityIndicator color={colors.accent} style={{ marginTop: spacing.lg }} />
          ) : attrsQ.isError ? (
            <Card>
              <Text style={styles.hint}>{errText(attrsQ.error)}</Text>
              <Button label={t("app.common.retry")} variant="outline" onPress={() => void attrsQ.refetch()} />
            </Card>
          ) : attrs.length === 0 ? (
            <EmptyState
              title={t("app.catalog.categoriesAdmin.attributes.empty")}
              hint={canManage ? t("app.catalog.categoriesAdmin.attributes.addAttribute") : undefined}
            />
          ) : (
            <View style={{ gap: spacing.sm }}>
              <Text style={styles.countLine}>{countLabel("mobile.catalog.attributeCount", attrs.length)}</Text>
              {attrs.map((a, i) => {
                const open = expanded === a.id;
                const values = byPosition(a.values);
                const draft = newValue[a.id] ?? "";
                const draftValid = draft.trim().length > 0 && draft.trim().length <= 80;
                return (
                  <Card key={a.id}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ expanded: open }}
                      onPress={() => setExpanded(open ? null : a.id)}
                      style={styles.row}
                    >
                      <View style={styles.glyph}>
                        <SlidersHorizontal size={20} color={colors.accent} weight="duotone" />
                      </View>
                      <View style={{ flex: 1, gap: 4 }}>
                        <Text style={styles.rowTitle} numberOfLines={1}>{a.label}</Text>
                        <View style={styles.metaRow}>
                          <Text style={styles.key} numberOfLines={1}>{a.key}</Text>
                          <Badge label={countLabel("mobile.catalog.valuesCount", a.values.length)} variant="neutral" />
                          {a.required ? <Badge label={t("app.common.required")} variant="accent" /> : null}
                        </View>
                      </View>
                      {open ? (
                        <CaretUp size={18} color={colors.textSecondary} weight="bold" />
                      ) : (
                        <CaretDown size={18} color={colors.textSecondary} weight="bold" />
                      )}
                    </Pressable>

                    {open ? (
                      <View style={styles.body}>
                        {canManage ? (
                          <View style={styles.attrActions}>
                            <IconBtn label={t("mobile.catalog.moveUp")} disabled={i === 0 || busy} onPress={() => moveAttr.mutate({ index: i, dir: -1 })}>
                              <CaretUp size={18} color={i === 0 ? colors.border : colors.textSecondary} weight="bold" />
                            </IconBtn>
                            <IconBtn label={t("mobile.catalog.moveDown")} disabled={i === attrs.length - 1 || busy} onPress={() => moveAttr.mutate({ index: i, dir: 1 })}>
                              <CaretDown size={18} color={i === attrs.length - 1 ? colors.border : colors.textSecondary} weight="bold" />
                            </IconBtn>
                            <View style={{ flex: 1 }} />
                            <Button label={t("mobile.catalog.editAttribute")} variant="ghost" onPress={() => setSheet({ kind: "edit-attr", attr: a })} disabled={busy} />
                            <IconBtn label={t("mobile.catalog.deleteAttributeTitle")} disabled={busy} onPress={() => confirmDeleteAttr(a)}>
                              <Trash size={18} color={colors.danger} />
                            </IconBtn>
                          </View>
                        ) : null}

                        {values.length === 0 ? (
                          <Text style={styles.hint}>{t("mobile.catalog.noValues")}</Text>
                        ) : (
                          <View style={styles.valueList}>
                            {values.map((v, vi) => (
                              <View key={v.id} style={styles.valueRow}>
                                <View style={{ flex: 1, gap: 2 }}>
                                  <Text style={styles.valueLabel} numberOfLines={1}>{v.label}</Text>
                                  <Text style={styles.key} numberOfLines={1}>{v.key}</Text>
                                </View>
                                {canManage ? (
                                  <View style={styles.actions}>
                                    <IconBtn label={t("mobile.catalog.moveUp")} disabled={vi === 0 || busy} onPress={() => moveValue.mutate({ values, index: vi, dir: -1 })}>
                                      <CaretUp size={16} color={vi === 0 ? colors.border : colors.textSecondary} weight="bold" />
                                    </IconBtn>
                                    <IconBtn label={t("mobile.catalog.moveDown")} disabled={vi === values.length - 1 || busy} onPress={() => moveValue.mutate({ values, index: vi, dir: 1 })}>
                                      <CaretDown size={16} color={vi === values.length - 1 ? colors.border : colors.textSecondary} weight="bold" />
                                    </IconBtn>
                                    <IconBtn label={t("mobile.catalog.editValue")} disabled={busy} onPress={() => setSheet({ kind: "edit-value", value: v })}>
                                      <PencilSimple size={16} color={colors.accent} />
                                    </IconBtn>
                                    <IconBtn label={t("mobile.catalog.deleteValueTitle")} disabled={busy} onPress={() => confirmDeleteValue(v)}>
                                      <Trash size={16} color={colors.danger} />
                                    </IconBtn>
                                  </View>
                                ) : null}
                              </View>
                            ))}
                          </View>
                        )}

                        {canManage ? (
                          <View style={styles.addValueRow}>
                            <View style={{ flex: 1 }}>
                              <Field
                                label={t("mobile.catalog.valueLabel")}
                                value={draft}
                                onChangeText={(s) => setNewValue((st) => ({ ...st, [a.id]: s }))}
                                placeholder={t("app.catalog.categoriesAdmin.attributes.valuePlaceholder")}
                                maxLength={80}
                                returnKeyType="done"
                                onSubmitEditing={() => draftValid && !busy && createValue.mutate({ attr: a, label: draft.trim() })}
                              />
                            </View>
                            <Button
                              label={t("app.catalog.categoriesAdmin.attributes.addValue")}
                              onPress={() => createValue.mutate({ attr: a, label: draft.trim() })}
                              disabled={!draftValid || busy}
                              loading={createValue.isPending && createValue.variables?.attr.id === a.id}
                              style={styles.addValueBtn}
                            />
                          </View>
                        ) : null}
                      </View>
                    ) : null}
                  </Card>
                );
              })}
            </View>
          )}
        </View>
      )}

      {/* One sheet, three configurations; `seedKey` flips per open so the
          field re-seeds from the row being edited. */}
      <NameSheet
        visible={sheet !== null}
        seedKey={
          sheet?.kind === "add-attr"
            ? "add-attr"
            : sheet?.kind === "edit-attr"
              ? sheet.attr.id
              : sheet?.kind === "edit-value"
                ? sheet.value.id
                : null
        }
        title={
          sheet?.kind === "add-attr"
            ? t("app.catalog.categoriesAdmin.attributes.addAttribute")
            : sheet?.kind === "edit-value"
              ? t("mobile.catalog.editValue")
              : t("mobile.catalog.editAttribute")
        }
        fieldLabel={sheet?.kind === "edit-value" ? t("mobile.catalog.valueLabel") : t("mobile.catalog.attributeLabel")}
        placeholder={
          sheet?.kind === "edit-value"
            ? t("app.catalog.categoriesAdmin.attributes.valuePlaceholder")
            : t("app.catalog.categoriesAdmin.attributes.namePlaceholder")
        }
        initial={sheet?.kind === "edit-attr" ? sheet.attr.label : sheet?.kind === "edit-value" ? sheet.value.label : ""}
        required={sheet?.kind === "add-attr" ? false : sheet?.kind === "edit-attr" ? sheet.attr.required : undefined}
        pending={createAttr.isPending || updateAttr.isPending || updateValue.isPending}
        onClose={() => setSheet(null)}
        onSubmit={(label, required) => {
          if (sheet?.kind === "add-attr") createAttr.mutate({ label, required: required ?? false });
          else if (sheet?.kind === "edit-attr") updateAttr.mutate({ id: sheet.attr.id, label, required });
          else if (sheet?.kind === "edit-value") updateValue.mutate({ id: sheet.value.id, label });
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

/**
 * One sheet for all three forms: attribute add/edit (label + required toggle)
 * and value edit (label only — `required` is omitted so the toggle hides).
 */
function NameSheet({
  visible,
  seedKey,
  title,
  fieldLabel,
  placeholder,
  initial,
  required,
  pending,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  /** Changes per open — re-seeds the field and the toggle. */
  seedKey: string | null;
  title: string;
  fieldLabel: string;
  placeholder: string;
  initial: string;
  required?: boolean;
  pending: boolean;
  onClose: () => void;
  onSubmit: (label: string, required?: boolean) => void;
}) {
  const [label, setLabel] = useState(initial);
  const [req, setReq] = useState(required ?? false);
  useEffect(() => {
    if (seedKey !== null) {
      setLabel(initial);
      setReq(required ?? false);
    }
    // Only re-seed when a sheet OPENS (seedKey flips), not on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);
  const showRequired = required !== undefined;
  const valid = label.trim().length > 0 && label.trim().length <= 80;
  const submit = () => onSubmit(label.trim(), showRequired ? req : undefined);
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={title}
      testID="attribute-form"
      primaryAction={{
        label: t("app.common.save"),
        onPress: submit,
        disabled: !valid,
        loading: pending,
        testID: "attribute-form-submit",
      }}
      secondaryAction={{ label: t("app.common.cancel"), onPress: onClose }}
    >
      <Field
        label={fieldLabel}
        value={label}
        onChangeText={setLabel}
        placeholder={placeholder}
        autoFocus
        maxLength={80}
        returnKeyType="done"
        onSubmitEditing={() => valid && !pending && submit()}
      />
      {showRequired ? (
        <View style={styles.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.switchLabel}>{t("mobile.catalog.requiredLabel")}</Text>
            <Text style={styles.hint}>{t("mobile.catalog.requiredHint")}</Text>
          </View>
          <Switch
            value={req}
            onValueChange={setReq}
            thumbColor={Platform.OS === "android" ? colors.card : undefined}
            trackColor={{ true: colors.accent, false: Platform.OS === "android" ? colors.switchTrackOff : colors.border }}
            accessibilityLabel={t("mobile.catalog.requiredLabel")}
          />
        </View>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
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
  hint: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  countLine: { fontFamily: fonts.medium, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  chipRow: { flexDirection: "row", gap: spacing.sm, paddingVertical: 2 },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md, minHeight: MIN_TOUCH },
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
  key: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, writingDirection: "ltr", flexShrink: 1 },
  body: { marginTop: spacing.md, paddingTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.border, gap: spacing.md },
  attrActions: { flexDirection: "row", alignItems: "center", gap: 0 },
  actions: { flexDirection: "row", alignItems: "center", gap: 0 },
  iconBtn: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: "center", justifyContent: "center", borderRadius: radius.md },
  valueList: { gap: 2 },
  valueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: MIN_TOUCH,
    paddingStart: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.neutralTint,
  },
  valueLabel: { fontFamily: fonts.medium, fontSize: 15, color: colors.text, ...RTL_TEXT },
  addValueRow: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm },
  addValueBtn: { minWidth: 88 },
  switchRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  switchLabel: { fontFamily: fonts.medium, fontSize: 15, color: colors.text, ...RTL_TEXT },
});
