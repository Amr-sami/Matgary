import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, settings } from "@matgary/api-client";
import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from "phosphor-react-native/src/icons/ArrowCounterClockwise";
import { CameraIcon as Camera } from "phosphor-react-native/src/icons/Camera";
import { CaretDownIcon as CaretDown } from "phosphor-react-native/src/icons/CaretDown";
import { CaretUpIcon as CaretUp } from "phosphor-react-native/src/icons/CaretUp";
import { EyeIcon as Eye } from "phosphor-react-native/src/icons/Eye";
import { EyeSlashIcon as EyeSlash } from "phosphor-react-native/src/icons/EyeSlash";
import { PencilSimpleIcon as PencilSimple } from "phosphor-react-native/src/icons/PencilSimple";
import { PlusIcon as Plus } from "phosphor-react-native/src/icons/Plus";
import { ReceiptIcon as Receipt } from "phosphor-react-native/src/icons/Receipt";
import { TrashIcon as Trash } from "phosphor-react-native/src/icons/Trash";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { ChevronBack } from "@/components/ui/Chevron";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { Field } from "@/components/ui/Field";
import { Segmented } from "@/components/ui/Segmented";
import { money, shortDate } from "@/lib/format";
import { useLogoPicker } from "@/lib/useLogoPicker";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Receipt designer — the web's ReceiptCustomisationCard + ReceiptDesigner
 * (apps/web/components/settings/) as one native screen (doc 02 §2.13).
 *
 * Shape changes for a phone:
 *  - `@dnd-kit` drag-to-reorder becomes up/down arrows per section. No
 *    draggable list is installed and the spec allows the swap; seven rows
 *    don't need a drag handle anyway.
 *  - The custom-text editor is inline under its row instead of a popover.
 *  - The logo is read-only here (no image picker) — changing it is web-only.
 *  - The font trio (Cairo / Tajawal / Lemonada) is only loaded on the web,
 *    so the preview renders in the app font and says so.
 *
 * Owner-only — deliberately STRICTER than the web. The web page is reached
 * via the `view_settings` permission and does not `isOwner`-gate the receipt
 * section; PATCH /api/settings only runs requireTenantWithBranch (no
 * permission check), so until the server enforces one (spec §2.13, still
 * open) the mobile Settings index marks this tile ownerOnly and the screen
 * re-checks it here.
 */
type ShopSettings = settings.ShopSettings;
type ReceiptBlockKey = settings.ReceiptBlockKey;
type ReceiptFixedBlock = settings.ReceiptFixedBlock;
type ReceiptCustomBlock = settings.ReceiptCustomBlock;
type Draft = Pick<ShopSettings, (typeof settings.RECEIPT_SETTINGS_FIELDS)[number]>;

const pickDraft = (s: ShopSettings): Draft => ({
  receiptLogoSize: s.receiptLogoSize,
  receiptFooterText: s.receiptFooterText,
  receiptLanguage: s.receiptLanguage,
  receiptShowLoyalty: s.receiptShowLoyalty,
  receiptFontFamily: s.receiptFontFamily,
  receiptBlockOrder: [...s.receiptBlockOrder],
  receiptCustomBlocks: Object.fromEntries(
    Object.entries(s.receiptCustomBlocks).map(([id, b]) => [id, { ...b }]),
  ),
});

/** Same id shape as the web designer: matches the repo's /^[a-z0-9]{6,32}$/. */
const newCustomId = () => Math.random().toString(36).slice(2, 10);
const isCustom = (k: ReceiptBlockKey): k is `custom:${string}` => k.startsWith("custom:");
const customId = (k: ReceiptBlockKey) => k.slice("custom:".length);

const LOGO_PX = { small: 40, medium: 64, large: 96 } as const;

export default function ReceiptSettingsScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const me = useSession((s) => s.me);
  const branchId = me?.branch.id ?? null;
  const isOwner = me?.isOwner ?? false;

  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["shop-settings", branchId],
    queryFn: () => settings.getShopSettings(api),
    enabled: isOwner,
  });
  const server = q.data?.data ?? null;
  const logo = useLogoPicker(() => qc.invalidateQueries({ queryKey: ["shop-settings"] }));

  const dirty = useMemo(
    () =>
      !!server &&
      !!draft &&
      !settings.settingsFieldsEqual(server, draft, settings.RECEIPT_SETTINGS_FIELDS),
    [server, draft],
  );

  // Seed from the server; re-seed on refetch only while nothing is edited.
  useEffect(() => {
    if (server && (!draft || !dirty)) setDraft(pickDraft(server));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [server]);

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  const save = useMutation({
    mutationFn: async () => {
      if (!server || !draft) return;
      const patch = settings.diffSettings(server, draft, settings.RECEIPT_SETTINGS_FIELDS);
      await settings.updateShopSettings(api, patch);
    },
    onSuccess: async () => {
      setNotice({ tone: "ok", text: t("app.settingsPage.toast.saveSuccess") });
      setEditingId(null);
      await qc.invalidateQueries({ queryKey: ["shop-settings"] });
    },
    onError: (e) => {
      const text =
        e instanceof ApiError && e.kind === "forbidden"
          ? t("mobile.common.forbidden")
          : t("app.settingsPage.toast.saveFailed");
      setNotice({ tone: "err", text });
    },
  });

  const forbidden = q.error instanceof ApiError && q.error.kind === "forbidden";

  // ---- block order helpers (mirror ReceiptDesigner.tsx) -------------------
  // No client-side fallback to DEFAULT_RECEIPT_BLOCK_ORDER here, unlike the
  // web designer: the server already returns the default for a never-
  // customised (null) column, and the printed receipt walks the saved array
  // verbatim. An explicit [] therefore means "everything hidden" and must be
  // shown as the empty receipt — otherwise hiding the last block would make
  // all seven defaults reappear while the draft (and the save) is [].
  const order: ReceiptBlockKey[] = draft ? draft.receiptBlockOrder : [];
  const visible = new Set<string>(order);
  const hiddenFixed = settings.RECEIPT_FIXED_BLOCKS.filter((k) => !visible.has(k));
  const hiddenCustom = draft
    ? Object.entries(draft.receiptCustomBlocks).filter(([id]) => !visible.has(`custom:${id}`))
    : [];

  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length) return;
    const next = [...order];
    const [k] = next.splice(from, 1);
    next.splice(to, 0, k);
    update("receiptBlockOrder", next);
  };
  const hideBlock = (k: ReceiptBlockKey) =>
    update("receiptBlockOrder", order.filter((x) => x !== k));
  const showBlock = (k: ReceiptBlockKey) => {
    if (!order.includes(k)) update("receiptBlockOrder", [...order, k]);
  };
  const upsertCustom = (id: string, patch: Partial<ReceiptCustomBlock>) => {
    if (!draft) return;
    const cur = draft.receiptCustomBlocks[id] ?? { text: "", align: "center" as const };
    update("receiptCustomBlocks", { ...draft.receiptCustomBlocks, [id]: { ...cur, ...patch } });
  };
  const addCustom = () => {
    if (!draft) return;
    const id = newCustomId();
    setDraft({
      ...draft,
      receiptCustomBlocks: {
        ...draft.receiptCustomBlocks,
        [id]: { text: t("app.receiptDesigner.blockBody.newTextDefault"), align: "center" },
      },
      receiptBlockOrder: [...order, `custom:${id}`],
    });
    setEditingId(id);
  };
  const deleteCustom = (id: string) => {
    if (!draft) return;
    const { [id]: _gone, ...rest } = draft.receiptCustomBlocks;
    void _gone;
    setDraft({
      ...draft,
      receiptCustomBlocks: rest,
      receiptBlockOrder: order.filter((k) => k !== `custom:${id}`),
    });
    if (editingId === id) setEditingId(null);
  };
  const restoreOrder = () =>
    update("receiptBlockOrder", [...settings.DEFAULT_RECEIPT_BLOCK_ORDER]);

  const blockLabel = (k: ReceiptBlockKey) => {
    if (isCustom(k)) {
      const b = draft?.receiptCustomBlocks[customId(k)];
      if (!b) return t("app.receiptDesigner.blockBody.customDeletedMark");
      return b.text.trim() || t("app.receiptDesigner.blockBody.customEmpty");
    }
    return t(`app.receiptDesigner.blockLabels.${k}`);
  };

  return (
    <Screen onRefresh={() => void q.refetch()} refreshing={q.isRefetching}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.back}
        >
          <ChevronBack size={16} color={colors.textSecondary} />
          <Text style={styles.backLabel}>{t("app.settingsPage.title")}</Text>
        </Pressable>
        <View style={styles.titleRow}>
          <Receipt size={24} color={colors.accent} />
          <Text style={styles.title}>{t("app.settingsPage.receiptCard.heading")}</Text>
        </View>
        <Text style={styles.subtitle}>{t("app.settingsPage.receiptCard.subhead")}</Text>
      </View>

      {notice ? (
        <Pressable onPress={() => setNotice(null)}>
          <Text
            style={[styles.notice, notice.tone === "ok" ? styles.noticeOk : styles.noticeErr]}
          >
            {notice.text}
          </Text>
        </Pressable>
      ) : null}

      {!isOwner || forbidden ? (
        <Card>
          <Text style={styles.hint}>{t("mobile.common.ownerOnly")}</Text>
        </Card>
      ) : q.isError ? (
        <Card>
          <Text style={styles.hint}>{t("mobile.settings.loadFailed")}</Text>
          <Button
            label={t("mobile.settings.retry")}
            variant="outline"
            onPress={() => void q.refetch()}
            style={{ marginTop: spacing.md }}
          />
        </Card>
      ) : !server || !draft ? (
        <ActivityIndicator color={colors.accent} />
      ) : (
        <>
          {/* المعاينة المباشرة */}
          <Card title={t("mobile.settings.receiptPreview")}>
            <View testID="receipt-preview">
              <ReceiptPreview server={server} draft={draft} order={order} />
            </View>
            <Text style={[styles.hint, { marginTop: spacing.sm }]}>
              {t("mobile.settings.fontNote")}
            </Text>
          </Card>

          {/* لغة الفاتورة */}
          <Card title={t("app.settingsPage.receiptCard.language")}>
            <Segmented
              items={settings.RECEIPT_LANGUAGES.map((k) => ({
                key: k,
                label: t(`app.settingsPage.receiptLanguage.${k}`),
              }))}
              value={draft.receiptLanguage}
              onChange={(v) => update("receiptLanguage", v)}
            />
            <Text style={[styles.hint, { marginTop: spacing.sm }]}>
              {t(`app.settingsPage.receiptLanguage.${draft.receiptLanguage}Hint`)}
            </Text>
          </Card>

          {/* حجم الشعار */}
          <Card title={t("app.settingsPage.receiptCard.logoSize")}>
            <View style={styles.chips}>
              {settings.RECEIPT_LOGO_SIZES.map((k) => (
                <Chip
                  key={k}
                  label={t(`app.settingsPage.receiptLogoSize.${k}`)}
                  active={draft.receiptLogoSize === k}
                  onPress={() => update("receiptLogoSize", k)}
                />
              ))}
            </View>
            <Text style={[styles.hint, { marginTop: spacing.sm }]}>
              {t("app.settingsPage.receiptCard.logoHint")}
            </Text>
            {!server.receiptLogoUrl ? (
              <Text style={styles.hint}>
                {t("app.receiptDesigner.logoEmptyTitle")} {t("app.receiptDesigner.logoEmptySubtitle")}
              </Text>
            ) : null}
            <Text style={styles.hint}>{t("mobile.settings.logoHint")}</Text>
            <Pressable
                onPress={() => void logo.pick()}
                disabled={logo.status === "uploading"}
                accessibilityRole="button"
                accessibilityLabel={server.receiptLogoUrl ? t("mobile.settings.changeLogo") : t("mobile.settings.addLogo")}
                style={({ pressed }) => [styles.logoBtn, (pressed || logo.status === "uploading") && styles.logoBtnPressed]}
              >
                {logo.status === "uploading" ? (
                  <ActivityIndicator size="small" color={colors.accent} />
                ) : (
                  <Camera size={18} color={colors.accent} />
                )}
                <Text style={styles.logoBtnText}>
                  {logo.status === "uploading"
                    ? t("mobile.settings.logoUploading")
                    : server.receiptLogoUrl
                      ? t("mobile.settings.changeLogo")
                      : t("mobile.settings.addLogo")}
                </Text>
              </Pressable>
              {logo.message ? (
                <Text style={[styles.logoMsg, logo.status === "error" && styles.logoMsgError]}>{logo.message}</Text>
              ) : null}
          </Card>

          {/* الخط */}
          <Card title={t("app.receiptDesigner.fontLabel")}>
            <View style={styles.fontList}>
              {settings.RECEIPT_FONT_FAMILIES.map((f) => {
                const active = draft.receiptFontFamily === f;
                return (
                  <Pressable
                    key={f}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active }}
                    onPress={() => update("receiptFontFamily", f)}
                    style={[styles.fontRow, active && styles.fontRowActive]}
                  >
                    <View style={styles.fontBody}>
                      <Text style={styles.fontName}>{f.charAt(0).toUpperCase() + f.slice(1)}</Text>
                      <Text style={styles.hint}>{t(`app.receiptDesigner.fonts.${f}`)}</Text>
                    </View>
                    {active ? (
                      <Text style={styles.fontSelected}>{t("app.receiptDesigner.fontSelected")}</Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          </Card>

          {/* نص التذييل */}
          <Card>
            <Field
              label={t("app.settingsPage.receiptCard.footerLabel")}
              value={draft.receiptFooterText}
              onChangeText={(v) => update("receiptFooterText", v)}
              placeholder={t("app.settingsPage.receiptCard.footerPlaceholder")}
              maxLength={settings.RECEIPT_FOOTER_MAX}
              multiline
              numberOfLines={3}
            />
            <Text style={[styles.hint, { marginTop: spacing.xs }]}>
              {t("app.settingsPage.receiptCard.footerCount", {
                n: String(draft.receiptFooterText.length),
              })}
            </Text>
          </Card>

          {/* النقاط على الفاتورة */}
          <Card>
            <View style={styles.toggleRow}>
              <View style={styles.toggleBody}>
                <Text style={styles.sectionTitle}>
                  {t("app.settingsPage.receiptCard.showLoyalty")}
                </Text>
                <Text style={styles.hint}>{t("app.settingsPage.receiptCard.showLoyaltyHint")}</Text>
              </View>
              <Switch
                testID="receipt-toggle-loyalty"
                value={draft.receiptShowLoyalty}
                onValueChange={(v) => update("receiptShowLoyalty", v)}
                trackColor={{ true: colors.accent, false: colors.border }}
              />
            </View>
          </Card>

          {/* ترتيب الأقسام */}
          <Card title={t("mobile.settings.blocksTitle")}>
            <Text style={styles.hint}>{t("mobile.settings.blocksHint")}</Text>
            {order.length === 0 ? (
              <Text style={[styles.hint, { marginTop: spacing.md }]}>
                {t("app.receiptDesigner.emptyReceipt")}
              </Text>
            ) : (
              <View style={styles.blockList}>
                {order.map((k, i) => {
                  const custom = isCustom(k);
                  const id = custom ? customId(k) : null;
                  const editing = id !== null && editingId === id;
                  return (
                    <View key={k} style={styles.blockWrap}>
                      <View style={styles.blockRow}>
                        <View style={styles.arrows}>
                          <IconButton
                            label={t("mobile.settings.moveUp")}
                            disabled={i === 0}
                            onPress={() => move(i, i - 1)}
                          >
                            <CaretUp size={16} color={i === 0 ? colors.border : colors.text} />
                          </IconButton>
                          <IconButton
                            label={t("mobile.settings.moveDown")}
                            disabled={i === order.length - 1}
                            onPress={() => move(i, i + 1)}
                          >
                            <CaretDown
                              size={16}
                              color={i === order.length - 1 ? colors.border : colors.text}
                            />
                          </IconButton>
                        </View>
                        <View style={styles.blockBody}>
                          <Text numberOfLines={1} style={styles.blockLabel}>
                            {blockLabel(k)}
                          </Text>
                          {custom ? (
                            <Text style={styles.hint}>{t("mobile.settings.customText")}</Text>
                          ) : null}
                        </View>
                        {custom && id ? (
                          <IconButton
                            label={t("app.receiptDesigner.drag.editLabel")}
                            onPress={() => setEditingId(editing ? null : id)}
                          >
                            <PencilSimple
                              size={18}
                              color={editing ? colors.accent : colors.textSecondary}
                            />
                          </IconButton>
                        ) : null}
                        <IconButton
                          label={t("app.receiptDesigner.drag.hideLabel")}
                          onPress={() => hideBlock(k)}
                        >
                          <EyeSlash size={18} color={colors.textSecondary} />
                        </IconButton>
                      </View>

                      {editing && id ? (
                        <CustomBlockEditor
                          block={draft.receiptCustomBlocks[id] ?? { text: "", align: "center" }}
                          onChange={(patch) => upsertCustom(id, patch)}
                          onDone={() => setEditingId(null)}
                          onDelete={() => deleteCustom(id)}
                        />
                      ) : null}
                    </View>
                  );
                })}
              </View>
            )}

            <View style={styles.blockActions}>
              <Pressable
                accessibilityRole="button"
                onPress={addCustom}
                style={styles.textButton}
              >
                <Plus size={14} color={colors.accent} />
                <Text style={styles.textButtonLabel}>{t("mobile.settings.customText")}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={restoreOrder}
                style={styles.textButton}
              >
                <ArrowCounterClockwise size={14} color={colors.textSecondary} />
                <Text style={[styles.textButtonLabel, { color: colors.textSecondary }]}>
                  {t("app.receiptDesigner.restoreOrder")}
                </Text>
              </Pressable>
            </View>

            {hiddenFixed.length > 0 || hiddenCustom.length > 0 ? (
              <View style={styles.hiddenWrap}>
                <Text style={styles.sectionTitle}>{t("app.receiptDesigner.hiddenTitle")}</Text>
                <View style={styles.chips}>
                  {hiddenFixed.map((k) => (
                    <Chip key={k} label={blockLabel(k)} onPress={() => showBlock(k)} />
                  ))}
                </View>
                {hiddenCustom.map(([id, b]) => (
                  <View key={id} style={styles.blockRow}>
                    <View style={styles.blockBody}>
                      <Text numberOfLines={1} style={styles.blockLabel}>
                        {b.text.trim() || t("app.receiptDesigner.blockBody.customEmpty")}
                      </Text>
                      <Text style={styles.hint}>{t("mobile.settings.customText")}</Text>
                    </View>
                    <IconButton
                      label={t("common.show")}
                      onPress={() => showBlock(`custom:${id}`)}
                    >
                      <Eye size={18} color={colors.textSecondary} />
                    </IconButton>
                    <IconButton
                      label={t("app.receiptDesigner.permanentDelete")}
                      onPress={() => deleteCustom(id)}
                    >
                      <Trash size={18} color={colors.danger} />
                    </IconButton>
                  </View>
                ))}
              </View>
            ) : null}
          </Card>

          {/* شريط الحفظ */}
          <View style={styles.saveBar}>
            <Text style={[styles.dirtyText, dirty && styles.dirtyTextActive]}>
              {dirty ? t("app.settingsPage.dirty") : t("app.settingsPage.clean")}
            </Text>
            <View style={styles.saveButtons}>
              {dirty ? (
                <Button
                  label={t("mobile.settings.discard")}
                  variant="ghost"
                  disabled={save.isPending}
                  onPress={() => {
                    setDraft(pickDraft(server));
                    setEditingId(null);
                  }}
                />
              ) : null}
              <Button
                label={t("app.settingsPage.save")}
                disabled={!dirty || save.isPending}
                loading={save.isPending}
                onPress={() => save.mutate()}
              />
            </View>
          </View>
        </>
      )}
    </Screen>
  );
}

// ---------------------------------------------------------------------------

function IconButton({
  label,
  onPress,
  disabled,
  children,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, pressed && !disabled && styles.iconButtonPressed]}
    >
      {children}
    </Pressable>
  );
}

function CustomBlockEditor({
  block,
  onChange,
  onDone,
  onDelete,
}: {
  block: ReceiptCustomBlock;
  onChange: (patch: Partial<ReceiptCustomBlock>) => void;
  onDone: () => void;
  onDelete: () => void;
}) {
  return (
    <View style={styles.editor}>
      <Text style={styles.sectionTitle}>{t("app.receiptDesigner.editor.title")}</Text>
      <Field
        label={t("mobile.settings.customText")}
        value={block.text}
        onChangeText={(v) => onChange({ text: v })}
        placeholder={t("app.receiptDesigner.editor.placeholder")}
        maxLength={settings.CUSTOM_BLOCK_TEXT_MAX}
        multiline
        numberOfLines={2}
      />
      <Segmented
        items={settings.RECEIPT_BLOCK_ALIGNS.map((a) => ({
          key: a,
          label: t(`app.receiptDesigner.editor.align.${a}`),
        }))}
        value={block.align}
        onChange={(a) => onChange({ align: a })}
      />
      <View style={styles.editorActions}>
        <Pressable accessibilityRole="button" onPress={onDelete} style={styles.textButton}>
          <Trash size={14} color={colors.danger} />
          <Text style={[styles.textButtonLabel, { color: colors.danger }]}>
            {t("app.receiptDesigner.editor.deletePermanently")}
          </Text>
        </Pressable>
        <Button label={t("app.receiptDesigner.editor.done")} variant="outline" onPress={onDone} />
      </View>
    </View>
  );
}

/**
 * The printed-receipt mock. Labels follow `receiptLanguage`, NOT the app
 * locale — they are what the customer will see on paper, exactly as the
 * web's ReceiptCustomisationCard / ReceiptDesigner render them. Amounts go
 * through money() so the sample matches the app's real receipts.
 */
function ReceiptPreview({
  server,
  draft,
  order,
}: {
  server: ShopSettings;
  draft: Draft;
  order: ReceiptBlockKey[];
}) {
  const lang = draft.receiptLanguage;
  const T = (en: string, ar: string) =>
    lang === "en" ? en : lang === "ar" ? ar : `${en} · ${ar}`;
  const shopName = (server.shopName || "STORE").toUpperCase();
  const showLoyaltyRows = draft.receiptShowLoyalty && server.loyaltyEnabled;
  const dateString = shortDate(new Date().toISOString());

  const renderBlock = (key: ReceiptBlockKey) => {
    if (isCustom(key)) {
      const c = draft.receiptCustomBlocks[customId(key)];
      if (!c) {
        return <Text style={p.muted}>{t("app.receiptDesigner.blockBody.customDeletedMark")}</Text>;
      }
      const align =
        c.align === "center" ? "center" : c.align === "left" ? "flex-start" : "flex-end";
      return (
        <View style={{ alignItems: align }}>
          <Text style={c.text ? p.body : p.muted}>
            {c.text || t("app.receiptDesigner.blockBody.customEmpty")}
          </Text>
        </View>
      );
    }
    switch (key as ReceiptFixedBlock) {
      case "logo": {
        if (draft.receiptLogoSize === "hidden") {
          return <Text style={p.muted}>{t("app.receiptDesigner.blockBody.logoHidden")}</Text>;
        }
        const px = LOGO_PX[draft.receiptLogoSize];
        return (
          <View style={p.center}>
            {server.receiptLogoUrl ? (
              <Image
                source={{ uri: server.receiptLogoUrl }}
                resizeMode="contain"
                style={{ width: px, height: px }}
              />
            ) : (
              <View style={[p.logoPlaceholder, { width: px, height: px }]} />
            )}
          </View>
        );
      }
      case "shopInfo":
        return (
          <>
            <Text style={[p.center, p.bold]}>{shopName}</Text>
            {server.shopPhone ? (
              <Text style={[p.center, p.ltr]}>TEL: {server.shopPhone}</Text>
            ) : null}
          </>
        );
      case "purchaseDate":
        return (
          <View style={p.row}>
            <Text style={p.body}>{shopName}</Text>
            <Text style={[p.body, p.ltr]}>{dateString}</Text>
          </View>
        );
      case "items":
        return (
          <>
            <Text style={[p.center, p.black]}>{T("*** RECEIPT ***", "*** فاتورة ***")}</Text>
            <View style={p.row}>
              <Text style={p.body}>SAMPLE ITEM</Text>
              <Text style={[p.body, p.ltr]}>{money(100)}</Text>
            </View>
          </>
        );
      case "totals":
        return (
          <>
            <View style={p.row}>
              <Text style={p.body}>{T("SUBTOTAL", "المجموع")}</Text>
              <Text style={[p.body, p.ltr]}>{money(100)}</Text>
            </View>
            {showLoyaltyRows ? (
              <View style={p.row}>
                <Text style={p.body}>{T("CREDIT APPLIED", "رصيد مستخدم")}</Text>
                <Text style={[p.body, p.ltr]}>- {money(10)}</Text>
              </View>
            ) : null}
            <View style={p.hr} />
            <View style={p.row}>
              <Text style={[p.body, p.black]}>{T("TOTAL AMOUNT", "الإجمالي")}</Text>
              <Text style={[p.body, p.black, p.ltr]}>{money(showLoyaltyRows ? 90 : 100)}</Text>
            </View>
          </>
        );
      case "loyalty":
        return showLoyaltyRows ? (
          <View style={p.row}>
            <Text style={p.body}>{T("POINTS EARNED", "نقاط مكتسبة")}</Text>
            <Text style={[p.body, p.ltr]}>+9</Text>
          </View>
        ) : (
          <Text style={p.muted}>{t("app.receiptDesigner.blockBody.loyaltyDisabled")}</Text>
        );
      case "footer":
        return (
          <>
            <Text style={[p.center, p.bold]}>
              {T("THANK YOU FOR SHOPPING!", "شكراً لتسوقكم معنا")}
            </Text>
            {draft.receiptFooterText ? (
              <Text style={[p.center, p.small]}>{draft.receiptFooterText}</Text>
            ) : null}
          </>
        );
      default:
        return null;
    }
  };

  return (
    <View style={p.paperWrap}>
      <View style={p.paper}>
        {order.length === 0 ? (
          <Text style={p.muted}>{t("app.receiptDesigner.emptyReceipt")}</Text>
        ) : (
          order.map((k, i) => (
            <View key={k}>
              {i > 0 ? <View style={p.hr} /> : null}
              {renderBlock(k)}
            </View>
          ))
        )}
      </View>
    </View>
  );
}

// Receipt paper mock. Ink and ground come from the same tokens as the rest of
// the app (colors.text on colors.bg) so the paper is themable/auditable in one
// place; the paper still reads as thermal print because the block styles
// below are what carry the look, not a private palette.
const PAPER_INK = colors.text;
const PAPER_BG = colors.bg;
const p = StyleSheet.create({
  paperWrap: {
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.neutralTint,
    padding: spacing.md,
    alignItems: "center",
  },
  paper: {
    width: "100%",
    maxWidth: 320,
    backgroundColor: PAPER_BG,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: 2,
  },
  body: { fontFamily: fonts.regular, fontSize: 12, color: PAPER_INK, lineHeight: 18 },
  small: { fontFamily: fonts.regular, fontSize: 11, color: PAPER_INK, lineHeight: 16 },
  bold: { fontFamily: fonts.bold, fontSize: 13, color: PAPER_INK, lineHeight: 20 },
  black: { fontFamily: fonts.bold, letterSpacing: 1 },
  center: { textAlign: "center", alignItems: "center", alignSelf: "stretch" },
  ltr: { writingDirection: "ltr", fontVariant: ["tabular-nums"] },
  muted: { fontFamily: fonts.regular, fontSize: 10, color: colors.textSecondary, textAlign: "center" },
  row: { flexDirection: "row", justifyContent: "space-between", gap: spacing.sm },
  hr: { height: 1, backgroundColor: PAPER_INK, marginVertical: 4, opacity: 0.8 },
  logoPlaceholder: { backgroundColor: colors.neutralTint, borderRadius: radius.md, marginBottom: 4 },
});

const styles = StyleSheet.create({
  logoBtn: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: spacing.xs,
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    backgroundColor: colors.accentLight,
    marginTop: spacing.sm,
  },
  logoBtnPressed: { opacity: 0.7 },
  logoBtnText: { fontFamily: fonts.medium, fontSize: 13, color: colors.accent },
  logoMsg: { fontFamily: fonts.regular, fontSize: 13, color: colors.success, marginTop: spacing.xs, ...RTL_TEXT },
  logoMsgError: { color: colors.danger },
  header: { gap: spacing.xs },
  back: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 32 },
  backLabel: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary },
  titleRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  title: { fontFamily: fonts.bold, fontSize: 26, color: colors.text, ...RTL_TEXT },
  subtitle: { fontFamily: fonts.regular, fontSize: 15, color: colors.textSecondary, ...RTL_TEXT },

  notice: {
    fontFamily: fonts.medium,
    fontSize: 13,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    overflow: "hidden",
    ...RTL_TEXT,
  },
  noticeOk: { backgroundColor: colors.successLight, color: colors.successStrong },
  noticeErr: { backgroundColor: colors.dangerLight, color: colors.danger },

  sectionTitle: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  hint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    lineHeight: 20,
    ...RTL_TEXT,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.xs },

  fontList: { gap: spacing.sm },
  fontRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.bg,
  },
  fontRowActive: { borderColor: colors.accent, backgroundColor: colors.accentLight },
  fontBody: { flex: 1, minWidth: 0 },
  fontName: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text },
  fontSelected: { fontFamily: fonts.medium, fontSize: 12, color: colors.accent },

  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  toggleBody: { flex: 1, minWidth: 0, gap: 2 },

  blockList: { gap: spacing.sm, marginTop: spacing.md },
  blockWrap: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.bg,
    overflow: "hidden",
  },
  blockRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  // Side by side, each a full MIN_TOUCH square with no hitSlop, so the two
  // targets never overlap (stacked 28pt buttons + 6pt slop used to).
  arrows: { flexDirection: "row" },
  blockBody: { flex: 1, minWidth: 0 },
  blockLabel: { fontFamily: fonts.medium, fontSize: 14, color: colors.text, ...RTL_TEXT },
  iconButton: {
    minWidth: MIN_TOUCH,
    minHeight: MIN_TOUCH,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
  },
  iconButtonPressed: { backgroundColor: colors.accentLight },

  blockActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  textButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.sm,
  },
  textButtonLabel: { fontFamily: fonts.medium, fontSize: 13, color: colors.accent },

  hiddenWrap: {
    marginTop: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.xs,
  },

  editor: {
    gap: spacing.md,
    padding: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.neutralTint,
  },
  editorActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: spacing.sm,
  },

  saveBar: {
    gap: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  dirtyText: { fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  dirtyTextActive: { color: colors.warningStrong, fontFamily: fonts.medium },
  saveButtons: { flexDirection: "row", justifyContent: "flex-end", gap: spacing.sm, minHeight: MIN_TOUCH },
});
