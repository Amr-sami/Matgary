import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { CheckCircle } from "phosphor-react-native";
import { ApiError, catalog } from "@matgary/api-client";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { Field } from "@/components/ui/Field";
import { money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";
import { t } from "@/i18n";

/**
 * Port of app__add-product.png + states/add-product-step2.png, step3.png.
 *
 * Doc 04 marks this SPLIT: the web's three-step wizard becomes three native
 * screens because a phone cannot show a progress rail beside the form. Kept as
 * one file with a step state so the draft survives the whole flow — the
 * cashier should not lose the name they typed because they went back to fix
 * the brand.
 *
 *   1  name · barcode · category · brand
 *   2  price · cost · opening stock · low-stock threshold
 *   3  review, then POST /api/products
 */
type Step = 1 | 2 | 3;

export default function AddProductScreen() {
  const router = useRouter();
  const qc = useQueryClient();

  const [step, setStep] = useState<Step>(1);
  const [name, setName] = useState("");
  const [barcode, setBarcode] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [brand, setBrand] = useState<string | null>(null);
  const [price, setPrice] = useState("");
  const [cost, setCost] = useState("");
  const [quantity, setQuantity] = useState("");
  const [threshold, setThreshold] = useState("3");
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);

  const categories = useQuery({ queryKey: ["categories"], queryFn: () => catalog.listCategories(api) });
  const brands = useQuery({ queryKey: ["brands"], queryFn: () => catalog.listBrands(api) });

  // Brands are scoped to a category on the web; offering all of them would
  // suggest combinations the catalogue does not have.
  const brandsFor = (brands.data ?? []).filter((b) => !category || b.categoryId === category);
  const brandName = brandsFor.find((b) => b.id === brand)?.name;
  const categoryLabel = categories.data?.find((c) => c.id === category)?.label;

  const num = (s: string) => {
    const n = Number(s.replace(/,/g, ""));
    return Number.isFinite(n) ? n : NaN;
  };

  const step1Ok = name.trim().length > 1 && category !== null;
  const step2Ok = num(price) >= 0 && !Number.isNaN(num(price)) && Number.isInteger(num(quantity)) && num(quantity) >= 0;

  const create = useMutation({
    mutationFn: () =>
      catalog.createProduct(api, {
        name: name.trim(),
        categoryId: category!,
        ...(brandName ? { brand: brandName } : {}),
        price: num(price),
        ...(cost.trim() ? { costPrice: num(cost) } : {}),
        quantity: num(quantity),
        lowStockThreshold: Number.isInteger(num(threshold)) ? num(threshold) : 3,
        ...(barcode.trim() ? { sku: barcode.trim() } : {}),
      }),
    onSuccess: ({ id }) => {
      setCreated(id);
      setError(null);
      void qc.invalidateQueries({ queryKey: ["products"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (e) => setError(messageFor(e)),
  });

  const resetAll = () => {
    setStep(1); setName(""); setBarcode(""); setCategory(null); setBrand(null);
    setPrice(""); setCost(""); setQuantity(""); setThreshold("3"); setError(null); setCreated(null);
  };

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
            <Button label={t("mobile.product.another")} onPress={resetAll} />
            <Button label={t("mobile.product.openInInventory")} variant="outline" onPress={() => { resetAll(); router.push("/inventory"); }} />
          </View>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen title={t("app.inventory.tools.addProduct")} subtitle={t("mobile.common.step", { step, total: 3, title: STEP_TITLES()[step] })}>
      <View style={styles.rail}>
        {[1, 2, 3].map((n) => (
          <View key={n} style={[styles.dot, n <= step && styles.dotActive]} />
        ))}
      </View>

      {step === 1 ? (
        <Card>
          <View style={styles.form}>
            <Field label={t("app.sales.form.quickAddProduct.name")} value={name} onChangeText={setName} placeholder={t("app.sales.form.quickAddProduct.namePlaceholder")} />
            <Field
              label={t("mobile.product.barcodeOptional")}
              value={barcode}
              onChangeText={setBarcode}
              placeholder={t("mobile.product.scanOrType")}
              autoCapitalize="none"
            />
            <View>
              <Text style={styles.label}>{t("app.sales.form.quickAddProduct.category")}</Text>
              <View style={styles.chipRow}>
                {(categories.data ?? []).map((c) => (
                  <Chip key={c.id} label={c.label} active={category === c.id}
                    onPress={() => { setCategory(c.id); setBrand(null); }} />
                ))}
              </View>
            </View>
            {category ? (
              <View>
                <Text style={styles.label}>{t("app.inventory.addProduct.step3.fields.brand")}</Text>
                <View style={styles.chipRow}>
                  {brandsFor.map((b) => (
                    <Chip key={b.id} label={b.name} active={brand === b.id}
                      onPress={() => setBrand(brand === b.id ? null : b.id)} />
                  ))}
                </View>
              </View>
            ) : null}
          </View>
        </Card>
      ) : step === 2 ? (
        <Card>
          <View style={styles.form}>
            <Field label={t("app.sales.form.quickAddProduct.price")} value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="0" />
            <Field label={t("mobile.product.costOptional")} value={cost} onChangeText={setCost} keyboardType="decimal-pad" placeholder="0" />
            <Field label={t("mobile.product.openingStock")} value={quantity} onChangeText={setQuantity} keyboardType="number-pad" placeholder="0" />
            <Field label={t("mobile.product.lowStockThreshold")} value={threshold} onChangeText={setThreshold} keyboardType="number-pad" />
          </View>
        </Card>
      ) : (
        <Card title={t("mobile.common.review")}>
          <Row label={t("app.common.name")} value={name} />
          <Row label={t("app.sales.form.quickAddProduct.category")} value={categoryLabel ?? "—"} />
          <Row label={t("app.sales.table.col.brand")} value={brandName ?? "—"} />
          {barcode.trim() ? <Row label={t("mobile.common.barcode")} value={barcode} /> : null}
          <Row label={t("app.inventory.addProduct.step3.fields.price")} value={money(num(price))} />
          {cost.trim() ? <Row label={t("mobile.common.cost")} value={money(num(cost))} /> : null}
          <Row label={t("app.inventory.addProduct.step3.preview.quantity")} value={t("mobile.common.pieces", { n: num(quantity) })} />
          <Row label={t("app.inventory.addProduct.step3.preview.lowStock")} value={t("mobile.common.pieces", { n: num(threshold) || 3 })} />
        </Card>
      )}

      {error ? (
        <View style={styles.errorBox}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      <View style={styles.nav}>
        {step > 1 ? (
          <Button label={t("app.common.back")} variant="outline" onPress={() => setStep((s) => (s - 1) as Step)} style={styles.navBtn} />
        ) : null}
        {step < 3 ? (
          <Button
            label={t("app.inventory.addProduct.footer.next")}
            disabled={step === 1 ? !step1Ok : !step2Ok}
            onPress={() => setStep((s) => (s + 1) as Step)}
            style={styles.navBtn}
          />
        ) : (
          <Button label={t("app.inventory.addProduct.footer.save")} loading={create.isPending} onPress={() => create.mutate()} style={styles.navBtn} />
        )}
      </View>
    </Screen>
  );
}

const STEP_TITLES = (): Record<Step, string> => ({ 1: t("mobile.product.details"), 2: t("mobile.product.priceAndStock"), 3: t("mobile.common.review") });

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

const styles = StyleSheet.create({
  rail: { flexDirection: "row", gap: spacing.sm },
  dot: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.accentLight },
  dotActive: { backgroundColor: colors.accent },
  form: { gap: spacing.lg },
  label: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary, marginBottom: spacing.sm, ...RTL_TEXT },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  row: { flexDirection: "row", justifyContent: "space-between", gap: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowLabel: { fontFamily: fonts.regular, fontSize: 14, color: colors.textSecondary },
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
