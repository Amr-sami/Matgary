import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Image } from "expo-image";
import { ArrowCounterClockwiseIcon as ArrowCounterClockwise } from "phosphor-react-native/src/icons/ArrowCounterClockwise";
import { ArrowDownIcon as ArrowDown } from "phosphor-react-native/src/icons/ArrowDown";
import { ArrowUpIcon as ArrowUp } from "phosphor-react-native/src/icons/ArrowUp";
import { CameraIcon as Camera } from "phosphor-react-native/src/icons/Camera";
import { CoinsIcon as Coins } from "phosphor-react-native/src/icons/Coins";
import { MinusIcon as Minus } from "phosphor-react-native/src/icons/Minus";
import { PackageIcon as Package } from "phosphor-react-native/src/icons/Package";
import { PencilSimpleIcon as PencilSimple } from "phosphor-react-native/src/icons/PencilSimple";
import { PlusIcon as Plus } from "phosphor-react-native/src/icons/Plus";
import { ShoppingCartIcon as ShoppingCart } from "phosphor-react-native/src/icons/ShoppingCart";
import { SparkleIcon as Sparkle } from "phosphor-react-native/src/icons/Sparkle";
import { TagIcon as Tag } from "phosphor-react-native/src/icons/Tag";
import { WalletIcon as Wallet } from "phosphor-react-native/src/icons/Wallet";
import { ApiError, catalog, type Product, type Supplier } from "@matgary/api-client";

import { API_BASE_URL, api } from "@/api/client";
import { pickLibraryPhoto, uploadErrorText } from "@/lib/productPhoto";
import { Screen } from "@/components/layout/Screen";
import { BackLink } from "@/components/ui/BackLink";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Field } from "@/components/ui/Field";
import { Sheet } from "@/components/ui/Sheet";
import { StatCard } from "@/components/ui/StatCard";
import { money, shortDate } from "@/lib/format";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/** History rows shown before the first "show more"; each tap adds another page. */
const HISTORY_PAGE = 30;

/**
 * Product detail (/inventory/<id>) — doc 02 §1.1 row 3, the "detail sheet"
 * third of the Inventory split: inline ± adjust and the movement history.
 *
 * NO capture exists for this screen — the web has no product detail page, it
 * edits products in a modal off the inventory table. So this is composed, not
 * ported: the inventory row's own vocabulary (name, category badge, stock
 * badge, price) promoted into a header card, the four figures the inventory
 * KPI block already uses for the whole shelf shown here for one product, the
 * web's ± row actions as a stepper, its edit modal cut down to the three
 * numbers a phone edits (price, cost, low-stock threshold), and its
 * ProductHistoryModal as an inline list. Every label is lifted from the shared
 * dictionary (app.inventory.*), so nothing here invents Arabic.
 *
 * Reads the SAME ["products"] query the list screen fills, so opening a
 * product costs no request and the two can never disagree; every write here
 * patches that cache in place and then invalidates it.
 *
 * Writes go through the web's own handlers:
 *   POST  /api/products/[id]/adjust   { delta }   — writes a history row
 *   PATCH /api/products/[id]          { price, costPrice, lowStockThreshold }
 * This screen gates both behind `manage_inventory`. That is STRICTER than the
 * web: InventoryClient renders ± and the edit modal with no permission check,
 * and neither route checks a permission (adjust → requireTenantWithBranch,
 * PATCH → requireTenant), so a view_inventory-only staffer can write on the
 * web. The permission's own description covers "adjust stock", so the gate is
 * the intended reading; the routes should grow the same check (web owner).
 * `me` unknown (mid-refresh) → do not block; the server is still the authority.
 *
 * This route lives in the (app) Tabs navigator, so `router.push` to another
 * product re-params this mounted screen instead of remounting it: every piece
 * of per-product local state is reset on `id`, and both mutations carry the id
 * they were fired for as variables, so a late response patches the product
 * the request was for, not whichever one is on screen when it lands.
 */
export default function ProductDetailScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const params = useLocalSearchParams<{ id: string | string[] }>();
  const id = (Array.isArray(params.id) ? params.id[0] : params.id) ?? "";

  const permissions = useSession((s) => s.me?.permissions);
  const canManage = permissions == null || permissions.includes("manage_inventory");

  const productsQ = useQuery({
    queryKey: ["products"],
    queryFn: () => catalog.listProducts(api),
  });
  const categoriesQ = useQuery({
    queryKey: ["categories"],
    queryFn: () => catalog.listCategories(api),
  });
  const suppliersQ = useQuery({
    queryKey: ["suppliers"],
    queryFn: async () => {
      try {
        return await catalog.listSuppliers(api);
      } catch (error) {
        // view_suppliers is a separate permission from view_inventory.
        if (error instanceof ApiError && error.kind === "forbidden") {
          return [] as Supplier[];
        }
        throw error;
      }
    },
  });
  const historyQ = useQuery({
    queryKey: ["productHistory", id],
    queryFn: () => catalog.listProductHistory(api, id),
    enabled: id.length > 0,
  });

  const product = useMemo(
    () => (productsQ.data ?? []).find((p) => p.id === id) ?? null,
    [productsQ.data, id],
  );

  const categoryLabel =
    categoriesQ.data?.find((c) => c.id === product?.category)?.label ?? "";
  const supplierName =
    suppliersQ.data?.find((s) => s.id === product?.supplierId)?.name ?? null;

  /** Only string/number attribute values are printable; anything else is skipped. */
  const attributes = useMemo(() => {
    const entries: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(product?.attributes ?? {})) {
      if (typeof value === "string" && value.trim()) entries.push([key, value]);
      else if (typeof value === "number") entries.push([key, String(value)]);
    }
    return entries;
  }, [product]);

  /**
   * Write the server's answer straight into the list cache so the header does
   * not flash stale. Takes the product id explicitly: mutation callbacks pass
   * the id they were fired for, which may not be the one on screen any more.
   */
  const patchCache = (productId: string, patch: Partial<Product>) => {
    qc.setQueryData<Product[]>(["products"], (rows) =>
      rows ? rows.map((p) => (p.id === productId ? { ...p, ...patch } : p)) : rows,
    );
  };
  /** The id currently on screen, readable from a callback that may outlive its render. */
  const idRef = useRef(id);
  idRef.current = id;

  // ---- Inline ± adjust -----------------------------------------------------
  const [deltaText, setDeltaText] = useState("0");
  const [adjustError, setAdjustError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // The success line is transient, like the web's toast.
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  const delta = parseDelta(deltaText);
  const current = product?.quantity ?? 0;
  const projected = Math.max(0, current + delta);
  const step = (by: number) => {
    setAdjustError(null);
    setDeltaText(String(delta + by));
  };

  const adjust = useMutation({
    mutationFn: (v: { id: string; delta: number }) => catalog.adjustProductQuantity(api, v.id, v.delta),
    onSuccess: ({ newQuantity }, v) => {
      patchCache(v.id, { quantity: newQuantity });
      void qc.invalidateQueries({ queryKey: ["products"] });
      void qc.invalidateQueries({ queryKey: ["productHistory", v.id] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      // A response that lands after the user moved to another product must not
      // clear that product's typed delta or show this one's toast over it.
      if (v.id !== idRef.current) return;
      const name = qc.getQueryData<Product[]>(["products"])?.find((p) => p.id === v.id)?.name ?? "";
      setDeltaText("0");
      setAdjustError(null);
      setNotice(t("app.inventory.toast.qtyAdjusted", { name, n: newQuantity }));
    },
    onError: (e, v) => {
      if (v.id !== idRef.current) return;
      // Validation / permission / not-found: nothing was written, keep the delta
      // so the user can correct it. Anything else (timeout, 5xx, unknown) may
      // have committed server-side — the route has no Idempotency-Key and
      // writes before answering — so a plain retry would double-apply. Pull
      // the true quantity and history, drop the delta, and say so.
      if (
        e instanceof ApiError &&
        (e.kind === "validation" || e.kind === "forbidden" || e.kind === "notFound" || e.kind === "offline")
      ) {
        setAdjustError(writeError(e, t("app.inventory.toast.qtyAdjustFailed")));
        return;
      }
      void qc.invalidateQueries({ queryKey: ["products"] });
      void qc.invalidateQueries({ queryKey: ["productHistory", v.id] });
      setDeltaText("0");
      setAdjustError(
        `${writeError(e, t("app.inventory.toast.qtyAdjustFailed"))} — ${t("mobile.inventoryDetail.checkQtyBeforeRetry")}`,
      );
    },
  });
  // A delta of 0 still writes a history row server-side; a decrease past zero
  // is clamped there, so refuse it here instead of recording a lie.
  const canAdjust =
    canManage && product !== null && delta !== 0 && current + delta >= 0 && !adjust.isPending;

  // ---- Price / cost / threshold edit ---------------------------------------
  const [editOpen, setEditOpen] = useState(false);
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [threshold, setThreshold] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  const openEdit = () => {
    if (!product) return;
    setPrice(String(product.price));
    setCost(String(product.costPrice));
    setThreshold(String(product.lowStockThreshold));
    setEditError(null);
    setEditOpen(true);
  };

  const priceN = parseMoney(price);
  const costN = parseMoney(cost);
  const thresholdN = parseCount(threshold);
  const editValid = priceN !== null && costN !== null && thresholdN !== null;
  const editChanged =
    product !== null &&
    (priceN !== product.price || costN !== product.costPrice || thresholdN !== product.lowStockThreshold);

  const update = useMutation({
    mutationFn: (v: { id: string; body: catalog.UpdateProductInput }) =>
      catalog.updateProduct(api, v.id, v.body).then(() => v),
    onSuccess: (v) => {
      patchCache(v.id, v.body as Partial<Product>);
      void qc.invalidateQueries({ queryKey: ["products"] });
      void qc.invalidateQueries({ queryKey: ["productHistory", v.id] });
      if (v.id !== idRef.current) return;
      setEditOpen(false);
      setNotice(t("app.inventory.toast.productUpdated"));
    },
    onError: (e, v) => {
      if (v.id !== idRef.current) return;
      setEditError(writeError(e, t("mobile.product.saveFailed")));
    },
  });
  const canSaveEdit = canManage && editValid && editChanged && !update.isPending;

  // ---- photo: pick → upload → PATCH imageUrl ------------------------------
  // Same picker as add-product.tsx (src/lib/productPhoto: Android permission,
  // MIME inference, > 3 MB refused before the network). Upload and PATCH run
  // in ONE mutation: `update`'s error only renders inside the edit modal,
  // which is closed here, so a failed PATCH after a good upload would have
  // been silent and the file orphaned.
  const [photoError, setPhotoError] = useState<string | null>(null);
  const photoUpload = useMutation({
    mutationFn: async (v: { id: string; file: { uri: string; name: string; type: string } }) => {
      const { url } = await catalog.uploadProductImage(api, v.file);
      await catalog.updateProduct(api, v.id, { imageUrl: url });
      return { id: v.id, url };
    },
    onSuccess: ({ id: pid, url }) => {
      patchCache(pid, { imageUrl: url });
      void qc.invalidateQueries({ queryKey: ["products"] });
      void qc.invalidateQueries({ queryKey: ["productHistory", pid] });
      if (pid !== idRef.current) return;
      setNotice(t("app.inventory.toast.productUpdated"));
    },
    onError: (e, v) => {
      if (v.id !== idRef.current) return;
      setPhotoError(uploadErrorText(e));
    },
  });
  const changePhoto = async () => {
    if (!product) return;
    setPhotoError(null);
    const res = await pickLibraryPhoto();
    if (res.kind === "cancelled") return;
    if (res.kind === "tooBig") return setPhotoError(t("mobile.product.photoInvalid"));
    if (res.kind === "denied") return setPhotoError(t("mobile.product.libraryDenied"));
    if (res.kind === "pickFailed") return setPhotoError(t("mobile.product.photoPickFailed"));
    const { uri, name, type } = res.photo;
    photoUpload.mutate({ id: product.id, file: { uri, name, type } });
  };
  const photoBusy = photoUpload.isPending;
  const imageUri = catalog.resolveUploadUrl(API_BASE_URL, product?.imageUrl);
  const saveEdit = () => {
    if (!product) return;
    // Only the fields that changed: the activity log records `changed` keys,
    // and the web's edit form does the same.
    const body: catalog.UpdateProductInput = {};
    if (priceN !== null && priceN !== product.price) body.price = priceN;
    if (costN !== null && costN !== product.costPrice) body.costPrice = costN;
    if (thresholdN !== null && thresholdN !== product.lowStockThreshold) {
      body.lowStockThreshold = thresholdN;
    }
    update.mutate({ id: product.id, body });
  };

  // ---- Movement history ----------------------------------------------------
  // GET /history has no limit and every sale / return / adjust adds a row, so a
  // fast-moving SKU has hundreds. Render the newest page and grow on demand
  // rather than hand the ScrollView every row at once.
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE);
  const historyRows = historyQ.data ?? [];
  const visibleHistory = historyRows.slice(0, historyLimit);

  // Tabs navigator: `/inventory/<other>` re-params this mounted screen. Nothing
  // typed for the previous product may survive into the next one.
  useEffect(() => {
    setDeltaText("0");
    setAdjustError(null);
    setNotice(null);
    setEditOpen(false);
    setEditError(null);
    setHistoryLimit(HISTORY_PAGE);
  }, [id]);

  const out = (product?.quantity ?? 0) === 0;
  const low =
    product !== null &&
    product.quantity > 0 &&
    product.quantity <= product.lowStockThreshold;
  const margin = product ? product.price - product.costPrice : 0;
  const marginPct =
    product && product.price > 0 ? Math.round((margin / product.price) * 100) : 0;

  return (
    <Screen
      onRefresh={() => {
        void productsQ.refetch();
        void historyQ.refetch();
      }}
      refreshing={productsQ.isRefetching}
      // "‹ Parent" in the FIXED header band — the same shape sale/customer
      // detail and settings use, and it no longer scrolls away with the page.
      // The product name is the content heading in the hero Card below.
      header={
        <BackLink
          label={t("app.inventory.title")}
          fallback="/inventory"
        />
      }
    >

      {productsQ.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : productsQ.isError && !productsQ.data ? (
        // Cold start / offline / 5xx with nothing cached: "could not load" is a
        // network state, not "this product does not exist".
        <Card>
          <View style={styles.historyState}>
            <Text style={styles.err}>{writeError(productsQ.error, t("mobile.inventoryDetail.loadFailed"))}</Text>
            <Button label={t("app.common.retry")} variant="outline" onPress={() => void productsQ.refetch()} />
          </View>
        </Card>
      ) : !product ? (
        <Card>
          <Text style={styles.notFound}>{t("mobile.product.notFound")}</Text>
          <Pressable
            accessibilityRole="button"
            hitSlop={8}
            style={styles.backLink}
            onPress={() => router.navigate("/inventory")}
          >
            <Text style={styles.backLinkText}>{t("mobile.inventory.backToList")}</Text>
          </Pressable>
        </Card>
      ) : (
        <>
          <Card>
            <View style={styles.heroRow}>
              {imageUri ? (
                <Image
                  source={{ uri: imageUri }}
                  style={styles.heroImage}
                  contentFit="cover"
                  transition={150}
                  accessibilityLabel={t("mobile.product.a11yPhotoPreview")}
                />
              ) : (
                <View style={styles.avatar}>
                  <Package size={28} color={colors.accent} />
                </View>
              )}
              {canManage ? (
                <Pressable
                  onPress={() => void changePhoto()}
                  disabled={photoBusy}
                  accessibilityRole="button"
                  accessibilityLabel={imageUri ? t("mobile.product.changePhoto") : t("mobile.product.addPhoto")}
                  style={({ pressed }) => [styles.photoBtn, (pressed || photoBusy) && styles.photoBtnPressed]}
                >
                  {photoBusy ? (
                    <ActivityIndicator size="small" color={colors.accent} />
                  ) : (
                    <Camera size={18} color={colors.accent} />
                  )}
                  <Text style={styles.photoBtnText}>
                    {photoBusy
                      ? t("mobile.product.photoUploading")
                      : imageUri
                        ? t("mobile.product.changePhoto")
                        : t("mobile.product.addPhoto")}
                  </Text>
                </Pressable>
              ) : null}
            </View>
            {photoError ? <Text style={styles.photoError}>{photoError}</Text> : null}
            <Text style={styles.name}>{product.name}</Text>
            {product.brand ? (
              <Text numberOfLines={1} style={styles.brand}>
                {product.brand}
              </Text>
            ) : null}
            <View style={styles.badgeRow}>
              {categoryLabel ? <Badge label={categoryLabel} variant="accent" /> : null}
              <Badge
                label={out ? t("app.dashboard.lowStock.outOfStock") : t("mobile.common.pieces", { n: product.quantity })}
                variant={out ? "outofstock" : low ? "lowstock" : "success"}
              />
            </View>
          </Card>

          {notice ? (
            <View style={styles.notice}>
              <Text style={styles.noticeText}>{notice}</Text>
            </View>
          ) : null}

          <View style={styles.gridRow}>
            <StatCard title={t("app.inventory.addProduct.step3.fields.price")} value={money(product.price)} icon={Tag} color="accent" />
            <StatCard
              title={t("app.activityLabels.fieldNames.costPrice")}
              value={money(product.costPrice)}
              icon={Coins}
              color="accent"
            />
          </View>
          <View style={styles.gridRow}>
            <StatCard
              title={t("app.common.quantity")}
              value={String(product.quantity)}
              icon={Package}
              color={out || low ? "danger" : "accent"}
            />
            <StatCard
              title={t("app.inventory.summary.stockValue")}
              value={money(product.costPrice * product.quantity)}
              icon={Wallet}
              color="accent"
            />
          </View>

          {/* ---- Inline ± adjust ---- */}
          <Card title={t("mobile.inventoryDetail.adjustTitle")}>
            {canManage ? (
              <View style={styles.adjust}>
                <View style={styles.stepper}>
                  <Pressable
                    testID="adjust-decrease"
                    accessibilityRole="button"
                    accessibilityLabel={t("mobile.common.decrease")}
                    disabled={adjust.isPending}
                    onPress={() => step(-1)}
                    style={({ pressed }) => [styles.stepBtn, pressed && styles.stepBtnPressed]}
                  >
                    <Minus size={22} color={colors.accent} weight="bold" />
                  </Pressable>
                  <TextInput
                    testID="adjust-delta"
                    accessibilityLabel={t("app.common.quantity")}
                    value={deltaText}
                    onChangeText={(v) => {
                      setAdjustError(null);
                      setDeltaText(v);
                    }}
                    keyboardType="numbers-and-punctuation"
                    selectTextOnFocus
                    editable={!adjust.isPending}
                    style={[styles.stepValue, delta > 0 && styles.stepUp, delta < 0 && styles.stepDown]}
                  />
                  <Pressable
                    testID="adjust-increase"
                    accessibilityRole="button"
                    accessibilityLabel={t("mobile.common.increase")}
                    disabled={adjust.isPending}
                    onPress={() => step(1)}
                    style={({ pressed }) => [styles.stepBtn, pressed && styles.stepBtnPressed]}
                  >
                    <Plus size={22} color={colors.accent} weight="bold" />
                  </Pressable>
                </View>
                <View style={styles.quickRow}>
                  {[-10, -5, 5, 10].map((by) => (
                    <Pressable
                      key={by}
                      accessibilityRole="button"
                      disabled={adjust.isPending}
                      onPress={() => step(by)}
                      style={({ pressed }) => [styles.quick, pressed && styles.stepBtnPressed]}
                    >
                      <Text style={styles.quickText}>{signed(by)}</Text>
                    </Pressable>
                  ))}
                </View>
                <View style={styles.projection}>
                  <Text style={styles.projLabel}>{t("mobile.inventoryDetail.current", { n: current })}</Text>
                  <Text style={[styles.projValue, current + delta < 0 && styles.detailDanger]}>
                    {t("mobile.inventoryDetail.resultQty", { n: projected })}
                  </Text>
                </View>
                {adjustError ? <Text style={styles.err}>{adjustError}</Text> : null}
                <View testID="adjust-apply">
                  <Button
                    label={t("mobile.inventoryDetail.applyAdjust")}
                    disabled={!canAdjust}
                    loading={adjust.isPending}
                    onPress={() => adjust.mutate({ id: product.id, delta })}
                  />
                </View>
              </View>
            ) : (
              <Text style={styles.muted}>{t("mobile.inventoryDetail.readOnly")}</Text>
            )}
          </Card>

          <Card title={t("app.inventory.addProduct.step3.heading")}>
            <View style={styles.details}>
              <Detail
                label={t("app.inventory.table.col.margin")}
                value={t("mobile.product.margin", { amount: money(margin), pct: marginPct })}
                tone={margin > 0 ? "success" : margin < 0 ? "danger" : "default"}
              />
              <Detail
                label={t("app.inventory.editForm.fields.lowStockThreshold")}
                value={String(product.lowStockThreshold)}
              />
              <Detail label={t("app.common.category")} value={categoryLabel || t("app.catalog.uncategorized")} />
              <Detail label={t("app.inventory.editForm.fields.brand")} value={product.brand || "—"} />
              <Detail label={t("app.suppliers.detail.title")} value={supplierName || "—"} />
              <Detail
                label={t("app.inventory.editForm.fields.sku")}
                value={product.sku || product.barcode || "—"}
              />
              <Detail label={t("mobile.common.addedOn")} value={shortDate(product.createdAt)} />
              {attributes.map(([key, value]) => (
                <Detail key={key} label={key} value={value} />
              ))}
            </View>
            {canManage ? (
              <Pressable
                accessibilityRole="button"
                onPress={openEdit}
                style={({ pressed }) => [styles.editBtn, pressed && styles.stepBtnPressed]}
              >
                <PencilSimple size={16} color={colors.accent} />
                <Text style={styles.editBtnText}>{t("mobile.inventoryDetail.editTitle")}</Text>
              </Pressable>
            ) : null}
          </Card>

          {product.tags.length > 0 ? (
            <Card title={t("mobile.common.tags")}>
              <View style={styles.tagRow}>
                {product.tags.map((tag) => (
                  <Badge key={tag} label={tag} variant="neutral" />
                ))}
              </View>
            </Card>
          ) : null}

          {/* ---- Movement history ---- */}
          <Card title={t("app.inventory.table.actions.history")}>
            {historyQ.isLoading ? (
              <ActivityIndicator color={colors.accent} />
            ) : historyQ.isError ? (
              <View style={styles.historyState}>
                <Text style={styles.err}>{t("mobile.inventoryDetail.historyFailed")}</Text>
                <Button label={t("app.common.retry")} variant="outline" onPress={() => void historyQ.refetch()} />
              </View>
            ) : historyRows.length === 0 ? (
              <Text style={styles.muted}>{t("app.inventory.history.empty")}</Text>
            ) : (
              <View style={styles.history} testID="product-history">
                {visibleHistory.map((event, i) => (
                  <View key={event.id}>
                    {i > 0 ? <View style={styles.historySep} /> : null}
                    <HistoryRow event={event} />
                  </View>
                ))}
                {historyRows.length > visibleHistory.length ? (
                  <View style={styles.historyMore}>
                    <Button
                      label={t("app.common.showMore")}
                      variant="outline"
                      onPress={() => setHistoryLimit((n) => n + HISTORY_PAGE)}
                    />
                  </View>
                ) : null}
              </View>
            )}
          </Card>
        </>
      )}

      <Sheet
        visible={editOpen}
        onClose={() => setEditOpen(false)}
        title={t("mobile.inventoryDetail.editTitle")}
        subtitle={product?.name ?? ""}
        testID="product-edit"
        bodyStyle={styles.modalContent}
        primaryAction={{
          label: t("app.common.save"),
          onPress: saveEdit,
          disabled: !canSaveEdit,
          loading: update.isPending,
          testID: "product-edit-submit",
        }}
        secondaryAction={{ label: t("app.common.cancel"), onPress: () => setEditOpen(false) }}
      >
        <Field
          label={t("app.inventory.editForm.fields.price")}
          value={price}
          onChangeText={(v) => {
            setEditError(null);
            setPrice(v);
          }}
          keyboardType="decimal-pad"
          ltr
        />
        <Field
          label={t("app.inventory.editForm.fields.costPrice")}
          value={cost}
          onChangeText={(v) => {
            setEditError(null);
            setCost(v);
          }}
          keyboardType="decimal-pad"
          ltr
        />
        <Field
          label={t("app.inventory.editForm.fields.lowStockThreshold")}
          value={threshold}
          onChangeText={(v) => {
            setEditError(null);
            setThreshold(v);
          }}
          keyboardType="number-pad"
          ltr
        />
        {!editValid && (price.trim() || cost.trim() || threshold.trim()) ? (
          <Text style={styles.err}>{t("mobile.common.checkInput")}</Text>
        ) : null}
        {editError ? <Text style={styles.err}>{editError}</Text> : null}
      </Sheet>
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Parsing. Hermes has no ICU, so no Intl here; Arabic-Indic digits are folded
// to Latin because the number-pad on an Arabic keyboard can produce them.
// ---------------------------------------------------------------------------

function latinDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[،٫]/g, ".");
}

/** "+3", "-2", " 5 ", "٣" → 3 / -2 / 5 / 3; anything else → 0. */
function parseDelta(s: string): number {
  const m = /^\s*([+-]?)\s*(\d+)\s*$/.exec(latinDigits(s));
  if (!m) return 0;
  const n = Number(m[2]);
  return m[1] === "-" ? -n : n;
}

/** Non-negative decimal, or null. */
function parseMoney(s: string): number | null {
  const v = latinDigits(s).trim();
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Non-negative integer, or null. */
function parseCount(s: string): number | null {
  const v = latinDigits(s).trim();
  if (!/^\d+$/.test(v)) return null;
  return Number(v);
}

/** U+2212 minus, matching the totals and the stepper glyph — not an ASCII hyphen. */
function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : String(n);
}

/**
 * ISO → "18 سبتمبر 2026 · 14:05" / "18 September 2026 · 14:05". The month
 * NAME from shortDate() gives the run a strong direction in both locales, so
 * the Text must NOT force `writingDirection: "ltr"` — that stranded the day
 * number at the far left of every history row (round-2 shot 15).
 */
function dateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${shortDate(iso)} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function writeError(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    if (e.kind === "offline") return t("mobile.common.offline");
    if (e.kind === "timeout") return t("mobile.common.timeout");
    if (e.kind === "forbidden") return t("mobile.common.forbidden");
    if (e.kind === "validation") return t("mobile.common.checkInput");
    if (e.kind === "notFound") return t("mobile.product.notFound");
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Rows.
// ---------------------------------------------------------------------------

function eventIcon(type: catalog.ProductHistoryEvent["type"]) {
  switch (type) {
    case "created":
      return <Sparkle size={16} color={colors.accent} />;
    case "updated":
      return <PencilSimple size={16} color={colors.textSecondary} />;
    case "restocked":
      return <ArrowUp size={16} color={colors.successStrong} />;
    case "decreased":
      return <ArrowDown size={16} color={colors.warningStrong} />;
    case "sold":
      return <ShoppingCart size={16} color={colors.accent} />;
    case "returned":
      return <ArrowCounterClockwise size={16} color={colors.warningStrong} />;
  }
}

/** Mirrors the web's ProductHistoryModal row: icon, label + time, then delta · qty after · note. */
function HistoryRow({ event }: { event: catalog.ProductHistoryEvent }) {
  const hasDelta = typeof event.delta === "number";
  const hasAfter = typeof event.quantityAfter === "number";
  return (
    <View style={styles.historyRow} testID="history-row">
      <View style={styles.historyIcon}>{eventIcon(event.type)}</View>
      <View style={styles.historyBody}>
        <View style={styles.historyHead}>
          <Text style={styles.historyLabel}>{t(`app.inventory.history.events.${event.type}`)}</Text>
          <Text style={styles.historyTime}>{dateTime(event.createdAt)}</Text>
        </View>
        {hasDelta || hasAfter || event.note ? (
          <View style={styles.historyMeta}>
            {hasDelta ? (
              <Text
                style={[
                  styles.historyDelta,
                  (event.delta ?? 0) >= 0 ? styles.detailSuccess : styles.historyDown,
                ]}
              >
                {signed(event.delta ?? 0)}
              </Text>
            ) : null}
            {hasAfter ? (
              <Text style={styles.historyAfter}>
                {t("app.inventory.history.qtyAfter", { n: event.quantityAfter ?? 0 })}
              </Text>
            ) : null}
            {event.note ? (
              <Text numberOfLines={2} style={styles.historyNote}>
                {event.note}
              </Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** Label on the start edge, value on the end edge — one line each. */
function Detail({
  label,
  value,
  tone = "default",
  icon,
}: {
  label: string;
  value: string;
  tone?: "default" | "success" | "danger";
  icon?: React.ReactNode;
}) {
  return (
    <View style={styles.detailRow}>
      <View style={styles.detailLabelWrap}>
        {icon}
        <Text numberOfLines={2} style={styles.detailLabel}>
          {label}
        </Text>
      </View>
      <Text
        numberOfLines={1}
        style={[
          styles.detailValue,
          tone === "success" && styles.detailSuccess,
          tone === "danger" && styles.detailDanger,
        ]}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({

  notFound: { fontFamily: fonts.regular, fontSize: 15, color: colors.textSecondary, ...RTL_TEXT },
  backLink: { minHeight: 44, justifyContent: "center" },
  backLinkText: { fontFamily: fonts.medium, fontSize: 15, color: colors.accent, ...RTL_TEXT },

  heroRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  heroImage: { width: 96, height: 96, borderRadius: radius.lg, backgroundColor: colors.neutralTint },
  photoBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    backgroundColor: colors.accentLight,
  },
  photoBtnPressed: { opacity: 0.7 },
  photoBtnText: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 13, color: colors.accent },
  photoError: { fontFamily: fonts.regular, fontSize: 13, color: colors.danger, marginBottom: spacing.sm, ...RTL_TEXT },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: radius.full,
    backgroundColor: colors.accentLight,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "flex-start",
  },
  name: { fontFamily: fonts.bold, fontSize: 24, color: colors.text, ...RTL_TEXT },
  brand: {
    fontFamily: fonts.regular,
    fontSize: 14,
    color: colors.textSecondary,
    marginTop: 2,
    ...RTL_TEXT,
  },
  badgeRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.md,
  },

  notice: {
    backgroundColor: colors.successLight,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  noticeText: { fontFamily: fonts.medium, fontSize: 14, color: colors.successStrong, ...RTL_TEXT },

  gridRow: { flexDirection: "row", gap: spacing.lg },

  // Stepper
  adjust: { gap: spacing.md },
  stepper: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  stepBtn: {
    width: 52,
    height: 52,
    minHeight: MIN_TOUCH,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.accentLight,
    alignItems: "center",
    justifyContent: "center",
  },
  stepBtnPressed: { opacity: 0.6 },
  stepValue: {
    flex: 1,
    minHeight: 52,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    fontFamily: fonts.bold,
    fontSize: 24,
    color: colors.text,
    textAlign: "center",
    paddingVertical: 0,
    fontVariant: ["tabular-nums"],
  },
  stepUp: { color: colors.successStrong },
  stepDown: { color: colors.warningStrong },
  quickRow: { flexDirection: "row", gap: spacing.sm },
  quick: {
    flex: 1,
    minHeight: MIN_TOUCH,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  // "+10" / "−5" carry no strong-direction character: on an Arabic-language
  // phone the sign would trail the digits. `writingDirection: "ltr"` is a
  // locale-independent constant, so it may live here (theme/rtl.ts).
  quickText: { ...RTL_TEXT, writingDirection: "ltr", fontFamily: fonts.semibold, fontSize: 14, color: colors.text, fontVariant: ["tabular-nums"] },
  projection: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  projLabel: { flexShrink: 1, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  projValue: { fontFamily: fonts.semibold, fontSize: 14, color: colors.text, ...RTL_TEXT },
  muted: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },
  err: { fontFamily: fonts.medium, fontSize: 14, color: colors.danger, ...RTL_TEXT },

  editBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    minHeight: MIN_TOUCH,
    marginTop: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.accent,
  },
  editBtnText: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 14, color: colors.accent },

  details: { gap: spacing.md },
  detailRow: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  detailLabelWrap: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: spacing.xs },
  detailLabel: { flexShrink: 1, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  detailValue: {
    ...RTL_TEXT,
    flexShrink: 0,
    maxWidth: "55%",
    fontFamily: fonts.semibold,
    fontSize: 14,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  detailSuccess: { color: colors.successStrong },
  detailDanger: { color: colors.danger },

  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },

  // History
  // Plain rows inside the History Card — a bordered box per row nested in the
  // bordered Card doubled every hairline (U79); a hairline between rows
  // instead, like the Detail rows above.
  history: { gap: 0 },
  historyState: { gap: spacing.md },
  historyRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  historySep: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  historyMore: { marginTop: spacing.md },
  historyIcon: {
    width: 32,
    height: 32,
    borderRadius: radius.md,
    backgroundColor: colors.neutralTint,
    alignItems: "center",
    justifyContent: "center",
  },
  historyBody: { flex: 1, minWidth: 0, gap: 2 },
  historyHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: spacing.xs },
  historyLabel: { fontFamily: fonts.medium, fontSize: 14, color: colors.text, ...RTL_TEXT },
  historyTime: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, fontVariant: ["tabular-nums"] },
  historyMeta: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.sm },
  historyDelta: { ...RTL_TEXT, writingDirection: "ltr", fontFamily: fonts.semibold, fontSize: 13, fontVariant: ["tabular-nums"] },
  historyDown: { color: colors.warningStrong },
  historyAfter: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, fontVariant: ["tabular-nums"] },
  historyNote: { flexShrink: 1, fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },

  modalContent: { gap: spacing.md },
});
