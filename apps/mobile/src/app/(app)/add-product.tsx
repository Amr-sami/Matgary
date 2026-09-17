import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { catalog } from "@matgary/api-client";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Chip } from "@/components/ui/Chip";
import { Field } from "@/components/ui/Field";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";

/**
 * Port of app__add-product.png, which is a three-step wizard on the web
 * (states/add-product-step2.png, step3.png).
 *
 * Doc 04 marks this SPLIT — each step becomes its own screen in a native stack,
 * because a phone cannot show a progress rail beside the form. Step 1 is here;
 * steps 2 (attributes) and 3 (pricing/stock) follow the same pattern.
 */
export default function AddProductScreen() {
  const [name, setName] = useState("");
  const [barcode, setBarcode] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [brand, setBrand] = useState<string | null>(null);

  const categories = useQuery({
    queryKey: ["categories"],
    queryFn: () => catalog.listCategories(api),
  });
  const brands = useQuery({
    queryKey: ["brands"],
    queryFn: () => catalog.listBrands(api),
  });

  // Brands are scoped to a category on the web; showing all of them would offer
  // combinations the catalogue does not have.
  const brandsForCategory = (brands.data ?? []).filter(
    (b) => !category || b.categoryId === category,
  );

  const canContinue = name.trim().length > 1 && category !== null;

  return (
    <Screen title="إضافة منتج" subtitle="الخطوة 1 من 3 — بيانات المنتج">
      <Card>
        <View style={styles.form}>
          <Field label="اسم المنتج" value={name} onChangeText={setName} placeholder="مثال: Citizen Promaster" />
          <Field
            label="الباركود (اختياري)"
            value={barcode}
            onChangeText={setBarcode}
            placeholder="امسح أو اكتب الباركود"
            autoCapitalize="none"
          />

          <View>
            <Text style={styles.label}>الصنف</Text>
            <View style={styles.chipRow}>
              {(categories.data ?? []).map((c) => (
                <Chip
                  key={c.id}
                  label={c.label}
                  active={category === c.id}
                  onPress={() => {
                    setCategory(c.id);
                    setBrand(null);
                  }}
                />
              ))}
            </View>
          </View>

          {category ? (
            <View>
              <Text style={styles.label}>البراند</Text>
              <View style={styles.chipRow}>
                {brandsForCategory.map((b) => (
                  <Chip
                    key={b.id}
                    label={b.name}
                    active={brand === b.id}
                    onPress={() => setBrand(b.id)}
                  />
                ))}
              </View>
            </View>
          ) : null}
        </View>
      </Card>

      {/* TODO(phase-2): steps 2 and 3, then POST /api/products. */}
      <Button label="التالي" disabled={!canContinue} onPress={() => {}} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.lg },
  label: {
    fontFamily: fonts.medium,
    fontSize: 14,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
    ...RTL_TEXT,
  },
  chipRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
});
