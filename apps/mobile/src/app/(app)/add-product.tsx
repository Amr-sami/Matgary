import { type ReactNode, useState } from "react";
import { ActivityIndicator, Image, Linking, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Device from "expo-device";
import * as ImagePicker from "expo-image-picker";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ArrowClockwiseIcon as ArrowClockwise } from "phosphor-react-native/src/icons/ArrowClockwise";
import { BarcodeIcon as Barcode } from "phosphor-react-native/src/icons/Barcode";
import { CameraIcon as Camera } from "phosphor-react-native/src/icons/Camera";
import { CheckCircleIcon as CheckCircle } from "phosphor-react-native/src/icons/CheckCircle";
import { TrashIcon as Trash } from "phosphor-react-native/src/icons/Trash";
import { ApiError, catalog, taxonomy } from "@matgary/api-client";

import { api } from "@/api/client";
import {
  MAX_PHOTO_BYTES,
  PICKER_OPTIONS,
  acceptPickerResult,
  pickLibraryPhoto,
  uploadErrorText,
  type PickResult,
} from "@/lib/productPhoto";
import { Screen } from "@/components/layout/Screen";
import { ScannerSheet } from "@/components/scanner/ScannerSheet";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { Field } from "@/components/ui/Field";
import { money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Port of app__add-product.png + states/add-product-step2.png, step3.png.
 *
 * Doc 02 §1.1 row 4: the web's three-step wizard becomes a native step stack
 * (a phone cannot show a progress rail beside the form), the SKU field is
 * scan-first, and the skip-step-2-when-no-attributes rule is kept. Kept as one
 * file with a step index so the draft survives the whole flow — the cashier
 * should not lose the name they typed because they went back to fix the brand.
 *
 *   details     photo (camera-first) · name · barcode (scan-first) · category
 *               · brand, with the web's free-text "Other" (page.tsx:96-104)
 *   attributes  one value per category attribute — only when the category
 *               has any, exactly like app/add-product/page.tsx:59-77
 *   price       price · cost · opening stock · low-stock threshold
 *   review      then POST /api/products
 *
 * Photo: the other half of row 4 — "photo field camera-first". Take photo /
 * Choose go through expo-image-picker (quality 0.5, editing on so the cashier
 * crops on the counter). The pick uploads IMMEDIATELY through
 * catalog.uploadProductImage (POST /api/uploads/product-image, multipart via
 * the shared client so refresh / dead-session / timeout handling apply) and
 * the tile shows uploading → ready / failed (+ Retry). The returned relative
 * url rides on the POST /api/products body as `imageUrl`. There is no image
 * manipulator in the dev client, so the only size control is the picker's
 * quality; anything the picker still reports over 3 MB is refused up front
 * with the same message the server would send.
 *
 * `?sku=` (useLocalSearchParams) is the POS "not found → create" hand-off: the
 * scanned code lands in the barcode field before the cashier types anything.
 * `?at=` is an optional nonce the sender bumps per push so the same code can
 * be handed off twice (cleared barcode, or "Add another" then re-scan).
 */
type StepKey = "details" | "attributes" | "price" | "review";

/** Sentinel for the web's "Other (add a new brand)" option. */
const OTHER_BRAND = "__other__";

/** The picked photo and where its upload stands — see the header note. */
interface PhotoFile {
  uri: string;
  name: string;
  type: string;
  status: "uploading" | "ready" | "failed";
  /** Relative url from the upload route once `status === "ready"`. */
  url?: string;
  /** Why it failed — already the user-facing i18n string. */
  error?: string;
}

export default function AddProductScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const { sku, at } = useLocalSearchParams<{ sku?: string | string[]; at?: string | string[] }>();

  const [stepIdx, setStepIdx] = useState(0);
  const [name, setName] = useState("");
  const [barcode, setBarcode] = useState("");
  const [scanned, setScanned] = useState(false);
  const [skuFromPos, setSkuFromPos] = useState(false);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [category, setCategory] = useState<string | null>(null);
  // A brand id, OTHER_BRAND, or null — the same three states the web's select has.
  const [brand, setBrand] = useState<string | null>(null);
  const [customBrand, setCustomBrand] = useState("");
  const [photo, setPhoto] = useState<PhotoFile | null>(null);
  // Why the tile has no photo yet (denied / no camera); `settings` adds the deep link.
  const [photoNote, setPhotoNote] = useState<{ text: string; settings?: boolean } | null>(null);
  // attributeId -> attributeValueId, the same shape the web keeps.
  const [attrValues, setAttrValues] = useState<Record<string, string>>({});
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [quantity, setQuantity] = useState("");
  const [threshold, setThreshold] = useState("3");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const categories = useQuery({ queryKey: ["categories"], queryFn: () => catalog.listCategories(api) });
  const brands = useQuery({ queryKey: ["brands"], queryFn: () => catalog.listBrands(api) });
  // GET /api/categories/[id]/attributes — the attribute list is per category,
  // which is why it cannot be fetched before one is picked.
  const attributes = useQuery({
    queryKey: ["category-attributes", category],
    queryFn: () => taxonomy.listAttributes(api, category!),
    enabled: category !== null,
  });

  // Brands are scoped to a category on the web; offering all of them would
  // suggest combinations the catalogue does not have.
  const brandsFor = (brands.data ?? []).filter((b) => !category || b.categoryId === category);
  const brandName = brand === OTHER_BRAND
    ? (customBrand.trim() || undefined)
    : brandsFor.find((b) => b.id === brand)?.name;
  // page.tsx:95 — "Other" without a typed name is not a brand.
  const brandOk = brand !== OTHER_BRAND || customBrand.trim().length > 0;
  const pickedCategory = categories.data?.find((c) => c.id === category);
  const categoryLabel = pickedCategory?.label;

  const attrs = attributes.data ?? [];
  const attrsPending = category !== null && attributes.isPending;
  const attrsLoadedEmpty = category !== null && attributes.isSuccess && attrs.length === 0;
  // A failed attribute fetch empties `attrs`, which would drop the attributes
  // step and let a category with required attributes through with none picked.
  // The list payload says whether the category has any, so the cashier has to
  // Retry before Next opens up; a category without attributes is not blocked.
  const attrsBlocked = attributes.isError && !!pickedCategory?.hasAttributes;

  // The web skips step 2 when the category has no attributes; here the step
  // simply is not in the list, so the rail and "step n of total" stay honest.
  const steps: StepKey[] = attrs.length > 0
    ? ["details", "attributes", "price", "review"]
    : ["details", "price", "review"];
  const step = steps[Math.min(stepIdx, steps.length - 1)];

  const priceN = parseMoney(price);
  // undefined = not given (the field is optional); null = typed but unparseable.
  const costN = cost.trim() ? parseMoney(cost) : undefined;
  const quantityN = parseCount(quantity);
  // An emptied threshold means the server default (3); anything typed must parse.
  const thresholdN = threshold.trim() ? parseCount(threshold) : 3;

  // The web refuses a 0-priced or 0-stock product (canSubmit in
  // app/add-product/page.tsx: price >= 1 && quantity >= 1) and the API only
  // enforces min(0), so the wizard is the gate. Number("") is 0, which is why
  // the old check let an untouched form reach Review.
  const priceValid = priceN !== null && priceN >= 1;
  const costValid = costN !== null;
  const quantityValid = quantityN !== null && quantityN >= 1;
  const thresholdValid = thresholdN !== null;

  const detailsOk = name.trim().length > 1 && category !== null && brandOk && !attrsPending && !attrsBlocked;
  const attributesOk = attrs.filter((a) => a.required).every((a) => !!attrValues[a.id]);
  const priceOk = priceValid && costValid && quantityValid && thresholdValid;
  const canAdvance = step === "details" ? detailsOk : step === "attributes" ? attributesOk : priceOk;

  const chosenAttrs = attrs
    .map((a) => ({ label: a.label, value: a.values.find((v) => v.id === attrValues[a.id])?.label }))
    .filter((r): r is { label: string; value: string } => !!r.value);

  const create = useMutation({
    mutationFn: () => {
      // apps/web/app/api/products/route.ts accepts `attributeValueIds`
      // (uuid[]), posted exactly as the web does — Object.values of the map.
      // CreateProductInput in the api-client predates it; the field is added
      // here rather than widening a file another feature owns.
      // Review is only reachable through Next, which requires priceOk, so the
      // parsed values are non-null here; the same numbers the Review rows show.
      const ids = Object.values(attrValues);
      const body: catalog.CreateProductInput & { attributeValueIds?: string[] } = {
        ...(photo?.status === "ready" && photo.url ? { imageUrl: photo.url } : {}),
        name: name.trim(),
        categoryId: category!,
        ...(brandName ? { brand: brandName } : {}),
        price: priceN ?? 0,
        ...(costN != null ? { costPrice: costN } : {}),
        quantity: quantityN ?? 0,
        lowStockThreshold: thresholdN ?? 3,
        ...(barcode.trim() ? { sku: barcode.trim() } : {}),
        ...(ids.length ? { attributeValueIds: ids } : {}),
      };
      return catalog.createProduct(api, body);
    },
    onSuccess: ({ id }) => {
      setCreated(id);
      setError(null);
      void qc.invalidateQueries({ queryKey: ["products"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      // page.tsx:136-150 — a typed brand is registered for the category so the
      // next add-product offers it as a chip. Best-effort: POST /api/brands
      // needs manage_catalog, and the product is already saved with the name.
      const typed = brand === OTHER_BRAND ? customBrand.trim() : "";
      if (typed && category) {
        const known = (brands.data ?? []).some((b) => b.name.toLowerCase() === typed.toLowerCase());
        if (!known) {
          void taxonomy.createBrand(api, { name: typed, categoryId: category })
            .catch(() => {})
            .then(() => qc.invalidateQueries({ queryKey: ["brands"] }));
        }
      }
    },
    onError: (e) => setError(messageFor(e)),
  });

  // State only — safe to call during render (below).
  const clearDraft = () => {
    setStepIdx(0); setName(""); setBarcode(""); setScanned(false); setSkuFromPos(false); setCategory(null); setBrand(null);
    setCustomBrand(""); setAttrValues({}); setPhoto(null); setPhotoNote(null);
    setPrice(""); setCost(""); setQuantity(""); setThreshold("3"); setError(null); setCreated(null);
  };

  // POS hand-off: /add-product?sku=<code>[&at=<nonce>]. Adopted the React way
  // for a prop that changes — set state during render, keyed on the last push
  // seen — so each new push from the POS lands once. The tab keeps its draft
  // between visits: a finished flow is cleared first; a mid-draft one keeps its
  // name/category and only the barcode is replaced — that is the point.
  // The params outlive the push (a tab keeps them until the next navigation),
  // so the key cannot be reset on "Add another" — that would re-adopt the code
  // of the product just saved. The sender's `at` nonce is what lets the same
  // code arrive twice; without one, a repeated code is one hand-off.
  const skuParam = (Array.isArray(sku) ? sku[0] : sku)?.trim() ?? "";
  const atParam = (Array.isArray(at) ? at[0] : at)?.trim() ?? "";
  const handoffKey = skuParam ? `${atParam}\n${skuParam}` : "";
  const [seenHandoff, setSeenHandoff] = useState("");
  if (handoffKey && handoffKey !== seenHandoff) {
    setSeenHandoff(handoffKey);
    if (created) clearDraft();
    setBarcode(skuParam);
    setScanned(false);
    setSkuFromPos(true);
    setStepIdx(0);
  }

  const pickCategory = (id: string) => {
    setCategory(id);
    setBrand(null);
    setCustomBrand("");
    setAttrValues({});
  };

  // ---- photo: camera-first, library second, uploaded on pick ----------------

  const uploadPhoto = async (file: PhotoFile) => {
    setPhoto({ ...file, status: "uploading", error: undefined });
    try {
      const { url } = await catalog.uploadProductImage(api, {
        uri: file.uri,
        name: file.name,
        type: file.type,
      });
      // The cashier may have picked again meanwhile — only the latest wins.
      setPhoto((cur) => (cur?.uri === file.uri ? { ...cur, status: "ready", url } : cur));
    } catch (err) {
      const error = uploadErrorText(err);
      setPhoto((cur) => (cur?.uri === file.uri ? { ...cur, status: "failed", url: undefined, error } : cur));
    }
  };

  const acceptPicked = (res: PickResult) => {
    if (res.kind === "cancelled") return;
    setPhotoNote(null);
    if (res.kind === "tooBig") {
      setPhotoNote({ text: t("mobile.product.photoInvalid") });
      return;
    }
    if (res.kind === "denied") {
      setPhotoNote({ text: t("mobile.product.libraryDenied"), settings: !res.canAskAgain });
      return;
    }
    if (res.kind === "pickFailed") {
      setPhotoNote({ text: t("mobile.product.photoPickFailed") });
      return;
    }
    const { uri, name, type } = res.photo;
    void uploadPhoto({ uri, name, type, status: "uploading" });
  };

  const retryUpload = () => {
    if (photo) void uploadPhoto(photo);
  };

  const takePhoto = async () => {
    setPhotoNote(null);
    // The simulator has no camera; UIImagePickerController refuses the source
    // type outright, so the tile says so and Choose (sample photos) still works.
    if (!Device.isDevice) {
      setPhotoNote({ text: t("mobile.product.cameraUnavailable") });
      return;
    }
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) {
      setPhotoNote({ text: t("mobile.product.cameraDenied"), settings: !perm.canAskAgain });
      return;
    }
    try {
      acceptPicked(acceptPickerResult(await ImagePicker.launchCameraAsync(PICKER_OPTIONS), MAX_PHOTO_BYTES));
    } catch {
      setPhotoNote({ text: t("mobile.product.cameraUnavailable") });
    }
  };

  const choosePhoto = async () => {
    setPhotoNote(null);
    acceptPicked(await pickLibraryPhoto());
  };

  const removePhoto = () => {
    setPhoto(null);
    setPhotoNote(null);
  };

  // A failed save's banner must not follow the cashier back through the steps
  // while they fix the input — it is about the attempt, not the draft.
  const goTo = (delta: number) => {
    setError(null);
    create.reset();
    setStepIdx((i) => Math.min(steps.length - 1, Math.max(0, i + delta)));
  };

  // Pull-to-refresh re-runs the lookups without touching the draft; with the
  // app-wide retry: false it is the recovery path when the tab was opened offline.
  const refresh = () => {
    void categories.refetch();
    void brands.refetch();
    if (category !== null) void attributes.refetch();
  };

  const pickAttrValue = (attributeId: string, valueId: string) =>
    setAttrValues((prev) => {
      const next = { ...prev };
      if (next[attributeId] === valueId) delete next[attributeId];
      else next[attributeId] = valueId;
      return next;
    });

  if (created) {
    return (
      <Screen title={t("app.inventory.tools.addProduct")}>
        <Card>
          <View style={styles.doneRow}>
            <CheckCircle size={28} color={colors.success} weight="fill" />
            <Text style={styles.doneTitle}>{t("app.inventory.toast.productAdded")}</Text>
          </View>
          <Text style={styles.doneName}>{name}</Text>
          <View style={styles.doneActions}>
            <Button label={t("mobile.product.another")} onPress={clearDraft} />
            <Button label={t("mobile.product.openInInventory")} variant="outline" onPress={() => { clearDraft(); router.push("/inventory"); }} />
          </View>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen
      title={t("app.inventory.tools.addProduct")}
      subtitle={t("mobile.common.step", { step: stepIdx + 1, total: steps.length, title: STEP_TITLES()[step] })}
      onRefresh={refresh}
      refreshing={categories.isRefetching || brands.isRefetching}
    >
      <View style={styles.rail}>
        {steps.map((key, i) => (
          <View key={key} style={[styles.dot, i <= stepIdx && styles.dotActive]} />
        ))}
      </View>

      {step === "details" ? (
        <Card>
          <View style={styles.form}>
            <PhotoTile
              photo={photo}
              note={photoNote}
              onTake={() => void takePhoto()}
              onChoose={() => void choosePhoto()}
              onRemove={removePhoto}
              onRetry={retryUpload}
            />
            <Field label={t("app.sales.form.quickAddProduct.name")} value={name} onChangeText={setName} placeholder={t("app.sales.form.quickAddProduct.namePlaceholder")} />
            <View>
              <BarcodeField
                value={barcode}
                onChangeText={(v) => { setBarcode(v); setScanned(false); setSkuFromPos(false); }}
                onPressScan={() => setScannerOpen(true)}
              />
              {scanned && barcode ? (
                <Text style={styles.scanNote}>{t("mobile.product.scanFilled", { code: barcode })}</Text>
              ) : skuFromPos && barcode ? (
                <Text style={styles.scanNote}>{t("mobile.product.skuFromPos", { code: barcode })}</Text>
              ) : null}
            </View>
            <View>
              <Text style={styles.label}>{t("app.sales.form.quickAddProduct.category")}</Text>
              {categories.isPending ? <Text style={styles.hint}>{t("app.common.loading")}</Text> : null}
              {categories.isError ? (
                <View style={styles.inlineError}>
                  <Text style={styles.inlineErrorText}>{t("mobile.product.categoriesLoadFailed")}</Text>
                  <Button label={t("app.common.retry")} variant="ghost" onPress={() => void categories.refetch()} />
                </View>
              ) : null}
              {categories.isSuccess && categories.data.length === 0 ? (
                <Text style={styles.hint}>{t("mobile.product.categoriesEmpty")}</Text>
              ) : null}
              <View style={styles.chipRow}>
                {(categories.data ?? []).map((c) => (
                  <Chip key={c.id} label={c.label} active={category === c.id} onPress={() => pickCategory(c.id)} />
                ))}
              </View>
              {attrsPending ? <Text style={styles.hint}>{t("app.common.loading")}</Text> : null}
              {attrsLoadedEmpty ? <Text style={styles.hint}>{t("mobile.product.attributesNone")}</Text> : null}
              {category !== null && attributes.isError ? (
                <View style={styles.inlineError}>
                  <Text style={styles.inlineErrorText}>{t("mobile.product.attributesLoadFailed")}</Text>
                  <Button label={t("app.common.retry")} variant="ghost" onPress={() => void attributes.refetch()} />
                </View>
              ) : null}
              {attrsBlocked ? <Text style={styles.fieldError}>{t("mobile.product.attributesRetryFirst")}</Text> : null}
            </View>
            {category ? (
              <View>
                <Text style={styles.label}>{t("app.inventory.addProduct.step3.fields.brand")}</Text>
                {brands.isPending ? <Text style={styles.hint}>{t("app.common.loading")}</Text> : null}
                {brands.isError ? (
                  <View style={styles.inlineError}>
                    <Text style={styles.inlineErrorText}>{t("mobile.product.brandsLoadFailed")}</Text>
                    <Button label={t("app.common.retry")} variant="ghost" onPress={() => void brands.refetch()} />
                  </View>
                ) : null}
                {brands.isSuccess && brandsFor.length === 0 ? (
                  <Text style={styles.hint}>{t("app.catalog.brandsAdmin.empty")}</Text>
                ) : null}
                <View style={styles.chipRow}>
                  {brandsFor.map((b) => (
                    <Chip key={b.id} label={b.name} active={brand === b.id}
                      onPress={() => setBrand(brand === b.id ? null : b.id)} />
                  ))}
                  <Chip
                    label={t("app.inventory.addProduct.step3.fields.brandOther")}
                    active={brand === OTHER_BRAND}
                    onPress={() => setBrand(brand === OTHER_BRAND ? null : OTHER_BRAND)}
                  />
                </View>
                {brand === OTHER_BRAND ? (
                  <View style={styles.otherBrand}>
                    <Field
                      label={t("app.inventory.addProduct.step3.fields.newBrand")}
                      value={customBrand}
                      onChangeText={setCustomBrand}
                      placeholder={t("app.inventory.addProduct.step3.fields.newBrandPlaceholder")}
                      autoFocus
                    />
                  </View>
                ) : null}
              </View>
            ) : null}
          </View>
        </Card>
      ) : step === "attributes" ? (
        <Card title={t("app.inventory.addProduct.step2.heading")}>
          <Text style={styles.hint}>{t("mobile.product.attributesHint")}</Text>
          <View style={styles.form}>
            {attrs.map((a) => (
              <View key={a.id}>
                <Text style={styles.label}>{a.required ? `${a.label} *` : a.label}</Text>
                <View style={styles.chipRow}>
                  {a.values.map((v) => (
                    <Chip key={v.id} label={v.label} active={attrValues[a.id] === v.id} onPress={() => pickAttrValue(a.id, v.id)} />
                  ))}
                </View>
              </View>
            ))}
          </View>
        </Card>
      ) : step === "price" ? (
        <Card>
          <View style={styles.form}>
            {/* Hints say why Next is disabled: grey guidance while the field is
                empty, red once something unparseable (or 0) has been typed. */}
            <View>
              <Field label={t("app.sales.form.quickAddProduct.price")} value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="0" />
              {!priceValid ? (
                <Text style={price.trim() ? styles.fieldError : styles.hint}>{t("mobile.product.priceMin")}</Text>
              ) : null}
            </View>
            <View>
              <Field label={t("mobile.product.costOptional")} value={cost} onChangeText={setCost} keyboardType="decimal-pad" placeholder="0" />
              {!costValid ? <Text style={styles.fieldError}>{t("mobile.product.costInvalid")}</Text> : null}
            </View>
            <View>
              <Field label={t("mobile.product.openingStock")} value={quantity} onChangeText={setQuantity} keyboardType="number-pad" placeholder="0" />
              {!quantityValid ? (
                <Text style={quantity.trim() ? styles.fieldError : styles.hint}>{t("mobile.product.quantityMin")}</Text>
              ) : null}
            </View>
            <View>
              <Field label={t("mobile.product.lowStockThreshold")} value={threshold} onChangeText={setThreshold} keyboardType="number-pad" placeholder="3" />
              {!thresholdValid ? <Text style={styles.fieldError}>{t("mobile.product.thresholdInvalid")}</Text> : null}
            </View>
          </View>
        </Card>
      ) : (
        <Card title={t("mobile.common.review")}>
          {photo ? (
            <View style={styles.reviewPhotoRow}>
              <Image source={{ uri: photo.uri }} style={styles.reviewThumb} accessibilityLabel={t("mobile.product.a11yPhotoPreview")} />
              <Text style={styles.reviewPhotoNote} numberOfLines={3}>
                {photo.status === "ready"
                  ? t("mobile.product.photoReady")
                  : photo.status === "uploading"
                    ? t("mobile.product.photoUploading")
                    : t("mobile.product.photoFailedBlocksSave")}
              </Text>
            </View>
          ) : null}
          <Row label={t("app.common.name")} value={name} />
          <Row label={t("app.sales.form.quickAddProduct.category")} value={categoryLabel ?? "—"} />
          <Row label={t("app.sales.table.col.brand")} value={brandName ?? "—"} />
          {barcode.trim() ? <Row label={t("mobile.common.barcode")} value={barcode} /> : null}
          {chosenAttrs.map((r) => (
            <Row key={r.label} label={r.label} value={r.value} />
          ))}
          <Row label={t("app.inventory.addProduct.step3.fields.price")} value={money(priceN ?? 0)} />
          {costN != null ? <Row label={t("mobile.common.cost")} value={money(costN)} /> : null}
          <Row label={t("app.inventory.addProduct.step3.preview.quantity")} value={t("mobile.common.pieces", { n: quantityN ?? 0 })} />
          <Row label={t("app.inventory.addProduct.step3.preview.lowStock")} value={t("mobile.common.pieces", { n: thresholdN ?? 3 })} />
        </Card>
      )}

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.nav}>
        {stepIdx > 0 ? (
          <Button label={t("app.common.back")} variant="outline" onPress={() => goTo(-1)} style={styles.navBtn} />
        ) : null}
        {step !== "review" ? (
          <Button
            label={t("app.inventory.addProduct.footer.next")}
            disabled={!canAdvance}
            onPress={() => goTo(1)}
            style={styles.navBtn}
          />
        ) : (
          <Button
            label={t("app.inventory.addProduct.footer.save")}
            loading={create.isPending || photo?.status === "uploading"}
            disabled={photo?.status === "failed"}
            onPress={() => create.mutate()}
            style={styles.navBtn}
          />
        )}
      </View>

      {/* Single mode: the sheet closes itself after one accepted code, so the
          field is filled and the cashier is back on the form in one tap. */}
      <ScannerSheet
        visible={scannerOpen}
        mode="single"
        onClose={() => setScannerOpen(false)}
        onScan={(code) => { setBarcode(code); setScanned(true); }}
      />
    </Screen>
  );
}

const STEP_TITLES = (): Record<StepKey, string> => ({
  details: t("mobile.product.details"),
  attributes: t("app.inventory.addProduct.indicator.steps.attributes.label"),
  price: t("mobile.product.priceAndStock"),
  review: t("mobile.common.review"),
});

/**
 * The camera-first photo tile. Empty: a dashed box with Take photo (primary)
 * and Choose. Picked: the preview, the upload status (uploading / uploaded /
 * failed + Retry), Take photo again and Remove. `note` is why nothing was
 * picked (denied, no camera, too big) — with an Open Settings link once iOS
 * stops asking.
 */
function PhotoTile({
  photo,
  note,
  onTake,
  onChoose,
  onRemove,
  onRetry,
}: {
  photo: PhotoFile | null;
  note: { text: string; settings?: boolean } | null;
  onTake: () => void;
  onChoose: () => void;
  onRemove: () => void;
  onRetry: () => void;
}) {
  return (
    <View>
      <Text style={styles.label}>{t("mobile.product.photo")}</Text>
      {photo ? (
        <View style={styles.photoRow}>
          <View>
            <Image source={{ uri: photo.uri }} style={styles.preview} accessibilityLabel={t("mobile.product.a11yPhotoPreview")} />
            {photo.status === "uploading" ? (
              <View style={styles.previewOverlay}>
                <ActivityIndicator color={colors.onAccent} />
              </View>
            ) : null}
          </View>
          <View style={styles.photoMeta}>
            <View style={styles.photoStatus}>
              {photo.status === "ready" ? <CheckCircle size={16} color={colors.success} weight="fill" /> : null}
              <Text
                style={[
                  styles.hintTight,
                  photo.status === "ready" && styles.photoStatusOk,
                  photo.status === "failed" && styles.inlineErrorText,
                ]}
              >
                {photo.status === "ready"
                  ? t("mobile.product.photoReady")
                  : photo.status === "uploading"
                    ? t("mobile.product.photoUploading")
                    : photo.error ?? t("mobile.product.photoUploadFailed")}
              </Text>
            </View>
            <View style={styles.photoActions}>
              {photo.status === "failed" ? (
                <PhotoAction icon={<ArrowClockwise size={18} color={colors.accent} />} label={t("mobile.product.retryUpload")} onPress={onRetry} />
              ) : null}
              <PhotoAction icon={<Camera size={18} color={colors.accent} />} label={t("mobile.product.takePhoto")} onPress={onTake} />
              <PhotoAction icon={<Trash size={18} color={colors.danger} />} label={t("mobile.product.removePhoto")} onPress={onRemove} danger />
            </View>
          </View>
        </View>
      ) : (
        <View style={styles.photoEmpty}>
          <Text style={styles.hintTight}>{t("mobile.product.photoHint")}</Text>
          <View style={styles.photoButtons}>
            <Button label={t("mobile.product.takePhoto")} onPress={onTake} style={styles.photoBtn} />
            <Button label={t("mobile.product.choosePhoto")} variant="outline" onPress={onChoose} style={styles.photoBtn} />
          </View>
        </View>
      )}
      {note ? (
        <View style={styles.inlineError}>
          <Text style={styles.inlineErrorText}>{note.text}</Text>
          {note.settings ? (
            <Button label={t("mobile.product.openSettings")} variant="ghost" onPress={() => void Linking.openSettings()} />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function PhotoAction({
  icon,
  label,
  onPress,
  danger = false,
}: {
  icon: ReactNode;
  label: string;
  onPress: () => void;
  danger?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.photoAction, pressed && styles.photoActionPressed]}
    >
      {icon}
      <Text style={[styles.photoActionText, danger && styles.photoActionDanger]}>{label}</Text>
    </Pressable>
  );
}

/**
 * Field with the barcode glyph as a trailing tap target — the same affordance
 * SearchField gives the inventory search. `Field` has no trailing slot and is
 * shared, so the box is mirrored here. Codes are never Arabic, hence the
 * forced LTR input (the web sets dir="ltr" on the same field).
 */
function BarcodeField({
  value,
  onChangeText,
  onPressScan,
}: {
  value: string;
  onChangeText: (v: string) => void;
  onPressScan: () => void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.label}>{t("mobile.product.barcodeOptional")}</Text>
      <View style={[styles.fieldBox, focused && styles.fieldBoxFocused]}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={t("mobile.product.scanOrType")}
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          style={styles.fieldInput}
        />
        <Pressable
          onPress={onPressScan}
          hitSlop={8}
          style={styles.scanBtn}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.a11y.scanBarcode")}
        >
          <Barcode size={22} color={colors.accent} />
        </Pressable>
      </View>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text numberOfLines={1} style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function messageFor(e: unknown): string {
  if (!(e instanceof ApiError)) return t("mobile.product.saveFailed");
  switch (e.kind) {
    case "offline": return t("mobile.common.offline");
    case "rateLimited": return t("mobile.common.tooManyAttempts");
    case "forbidden": return t("mobile.product.noPermission");
    case "validation": return t("mobile.common.checkInput");
    default: return t("mobile.product.saveFailed");
  }
}

// ---------------------------------------------------------------------------
// Parsing — a copy of the helpers in inventory/[id].tsx:512-540 so the two
// product edit paths read the same keystrokes the same way (that file belongs
// to the inventory feature; lifting both into @/lib/format is the follow-up).
// Hermes has no ICU, so no Intl; an Arabic keypad produces Arabic-Indic digits
// and "٫" for the decimal point; most non-US decimal pads type "," for it — the
// old `replace(/,/g, "")` read 12,5 as 125.
// ---------------------------------------------------------------------------

function latinDigits(s: string): string {
  return s.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/[,،٫]/g, ".");
}

/** Non-negative decimal — "12", "12.5", "12,5", "١٢٫٥" — or null. */
function parseMoney(s: string): number | null {
  const v = latinDigits(s).trim();
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Non-negative integer, or null; a sign or a decimal separator is rejected. */
function parseCount(s: string): number | null {
  const v = latinDigits(s).trim();
  if (!/^\d+$/.test(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const styles = StyleSheet.create({
  rail: { flexDirection: "row", gap: spacing.sm },
  dot: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.accentLight },
  dotActive: { backgroundColor: colors.accent },
  form: { gap: spacing.lg },
  label: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary, marginBottom: spacing.sm, ...RTL_TEXT },
  hint: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, marginTop: spacing.sm, marginBottom: spacing.sm, ...RTL_TEXT },
  scanNote: { fontFamily: fonts.medium, fontSize: 13, color: colors.successStrong, marginTop: spacing.sm, ...RTL_TEXT },
  hintTight: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  otherBrand: { marginTop: spacing.md },
  photoEmpty: {
    gap: spacing.md,
    padding: spacing.lg,
    borderWidth: 1,
    borderStyle: "dashed",
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.neutralTint,
  },
  photoButtons: { flexDirection: "row", gap: spacing.sm },
  photoBtn: { flex: 1 },
  photoRow: { flexDirection: "row", gap: spacing.md, alignItems: "flex-start" },
  preview: { width: 96, height: 96, borderRadius: radius.lg, backgroundColor: colors.neutralTint },
  previewOverlay: {
    position: "absolute", top: 0, left: 0, right: 0, bottom: 0,
    borderRadius: radius.lg,
    backgroundColor: colors.scrim,
    alignItems: "center",
    justifyContent: "center",
  },
  photoStatus: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  photoStatusOk: { color: colors.success },
  photoMeta: { flex: 1, gap: spacing.sm, minHeight: 96, justifyContent: "center" },
  photoActions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  photoAction: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    backgroundColor: colors.accentLight,
  },
  photoActionPressed: { opacity: 0.7 },
  photoActionText: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 13, color: colors.accent },
  photoActionDanger: { color: colors.danger },
  reviewPhotoRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  reviewThumb: { width: 56, height: 56, borderRadius: radius.md, backgroundColor: colors.neutralTint },
  reviewPhotoNote: { flexShrink: 1, fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  inlineError: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm, marginTop: spacing.sm },
  inlineErrorText: { flexShrink: 1, fontFamily: fonts.medium, fontSize: 13, color: colors.danger, ...RTL_TEXT },
  fieldError: { fontFamily: fonts.medium, fontSize: 13, color: colors.danger, marginTop: spacing.sm, ...RTL_TEXT },
  fieldWrap: { gap: 0 },
  fieldBox: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 52,
    paddingStart: spacing.lg,
    paddingEnd: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.bg,
  },
  fieldBoxFocused: { borderColor: colors.accent },
  fieldInput: {
    flex: 1,
    fontFamily: fonts.regular,
    fontSize: 16,
    color: colors.text,
    includeFontPadding: false,
    paddingVertical: 12,
    writingDirection: "ltr",
    textAlign: "left",
  },
  scanBtn: { minWidth: MIN_TOUCH, minHeight: MIN_TOUCH, alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", justifyContent: "space-between", gap: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowLabel: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary },
  rowValue: { flexShrink: 1, fontFamily: fonts.semibold, fontSize: 14, color: colors.text, ...RTL_TEXT },
  nav: { flexDirection: "row", gap: spacing.md },
  navBtn: { flex: 1 },
  errorBox: { backgroundColor: colors.dangerLight, borderRadius: radius.md, padding: spacing.md },
  errorText: { fontFamily: fonts.medium, fontSize: 14, color: colors.danger, textAlign: "center" },
  doneRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  doneTitle: { fontFamily: fonts.bold, fontSize: 18, color: colors.successStrong, ...RTL_TEXT },
  doneName: { fontFamily: fonts.regular, fontSize: 15, color: colors.text, marginTop: 4, marginBottom: spacing.lg, ...RTL_TEXT },
  doneActions: { gap: spacing.md },
});
