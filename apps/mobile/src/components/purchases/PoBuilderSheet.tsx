import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CheckIcon as Check } from "phosphor-react-native/src/icons/Check";
import { CheckCircleIcon as CheckCircle } from "phosphor-react-native/src/icons/CheckCircle";
import { MinusIcon as Minus } from "phosphor-react-native/src/icons/Minus";
import { PlusIcon as Plus } from "phosphor-react-native/src/icons/Plus";
import { TrashIcon as Trash } from "phosphor-react-native/src/icons/Trash";
import { UserPlusIcon as UserPlus } from "phosphor-react-native/src/icons/UserPlus";
import { ApiError, catalog, type Product, type Supplier } from "@matgary/api-client";

import { api } from "@/api/client";
import { isRTL, t } from "@/i18n";
import { Button } from "@/components/ui/Button";
import { ChevronBack } from "@/components/ui/Chevron";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { SearchField } from "@/components/ui/SearchField";
import { Sheet } from "@/components/ui/Sheet";
import { ScannerSheet, type ScanTone } from "@/components/scanner/ScannerSheet";
import { money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";

/** Visible-caret inset inside a 16pt Phosphor caret icon box. */
const GLYPH_INSET = 5;

/**
 * The web's PurchaseOrderBuilder (one modal, inline editable table) split into
 * the four-step sheet doc 02 §1.1 row 7 asks for:
 *
 *   1 supplier  — search the list or create one inline (POST /api/suppliers)
 *   2 lines     — search the catalogue OR scan; the scanner is the same
 *                 ScannerSheet inventory.tsx mounts, in continuous mode so a
 *                 delivery of twelve boxes is twelve scans, not twelve taps
 *   3 review    — notes + totals, then POST /api/purchase-orders
 *   4 done      — the new draft's reference and a "receive now" shortcut
 *
 * Nothing here is invented over the web: the POST body is the same zod shape
 * (supplierId, notes, items[]), and the server has no "expected date" column,
 * so the review step does not pretend to collect one. Free-text lines
 * (productId=null) are kept — the server materialises them as products on
 * receive, filed under the default category.
 */

type Step = 1 | 2 | 3 | 4;
const STEP_COUNT = 4;

export interface BuilderLine {
  uid: string;
  productId: string | null;
  productName: string;
  quantity: number;
  unitCost: number;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  /**
   * POST /api/suppliers is gated on manage_suppliers, not manage_purchases;
   * false hides the inline "new supplier" form (the web SupplierPicker's
   * canCreate) instead of letting a purchases-only user collect a 403.
   */
  canCreateSupplier: boolean;
  /** Fired after the POST succeeded; the parent invalidates its list. */
  onCreated: (id: string) => void;
  /**
   * "Receive now" on the done step. The parent runs its own receive flow —
   * confirm + mutation — WHILE the sheet is still open, and closes it once
   * the mutation settles. Closing first and alerting after does not work:
   * the alert goes native before the Modal's dismiss commits, so iOS
   * presents it on the modal's view controller and tears it down with it.
   */
  onReceiveNow: (id: string) => void;
  /** The parent's receive mutation is in flight; the done step's button shows it. */
  receiving?: boolean;
}

let nextUid = 1;
const newUid = () => `line-${nextUid++}`;

/** Parse a numeric TextInput; Arabic-Indic digits are typed by the Arabic keyboard. */
function parseNum(raw: string): number {
  const ascii = raw.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/٫/g, ".");
  const n = Number(ascii);
  return Number.isFinite(n) ? n : 0;
}

export function PoBuilderSheet({
  visible,
  onClose,
  canCreateSupplier,
  onCreated,
  onReceiveNow,
  receiving = false,
}: Props) {
  const insets = useSafeAreaInsets();
  const [step, setStep] = useState<Step>(1);
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  const [lines, setLines] = useState<BuilderLine[]>([]);
  const [notes, setNotes] = useState("");
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setStep(1);
    setSupplier(null);
    setLines([]);
    setNotes("");
    setCreatedId(null);
    setError(null);
  }, [visible]);

  const total = useMemo(() => lines.reduce((s, l) => s + l.quantity * l.unitCost, 0), [lines]);
  const validLines = useMemo(
    () => lines.filter((l) => l.productName.trim() && l.quantity > 0),
    [lines],
  );

  const create = useMutation({
    mutationFn: () =>
      catalog.createPurchaseOrder(api, {
        supplierId: supplier!.id,
        notes: notes.trim() || null,
        items: validLines.map((l) => ({
          productId: l.productId,
          productName: l.productName.trim(),
          quantity: Math.round(l.quantity),
          unitCost: l.unitCost,
        })),
      }),
    onSuccess: (res) => {
      setCreatedId(res.id);
      setError(null);
      setStep(4);
      onCreated(res.id);
    },
    onError: (e) => setError(describeError(e, t("app.purchases.builder.errors.saveFailed"))),
  });

  const goBack = () => {
    if (step === 1 || step === 4) onClose();
    else setStep((s) => (s - 1) as Step);
  };

  const stepTitle = {
    1: t("mobile.purchases.builder.stepSupplier"),
    2: t("mobile.purchases.builder.stepLines"),
    3: t("mobile.purchases.builder.stepReview"),
    4: t("mobile.purchases.builder.stepDone"),
  }[step];

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      onRequestClose={goBack}
      title={t("app.purchases.builder.title")}
      subtitle={t("mobile.common.step", { step, total: STEP_COUNT, title: stepTitle })}
      size="full"
      testID="po-builder"
      closeOnBackdrop={false}
      scrollable={false}
      bodyStyle={[styles.wizardBody, { paddingBottom: insets.bottom }]}
    >
      <View style={styles.progress}>
        {[1, 2, 3, 4].map((n) => (
          <View key={n} style={[styles.progressSeg, n <= step && styles.progressSegActive]} />
        ))}
      </View>
      {step === 2 || step === 3 ? (
        // Sheet's X (po-builder-close) closes the whole draft; this is the
        // one-step-back affordance the wizard still needs.
        <Pressable
          onPress={goBack}
          testID="po-builder-back"
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t("mobile.purchases.builder.back")}
          style={styles.backRow}
        >
          <View style={styles.backGlyph}>
            <ChevronBack size={16} color={colors.accent} />
          </View>
          <Text style={styles.backLabel}>{t("mobile.purchases.builder.back")}</Text>
        </Pressable>
      ) : null}
      {step === 1 ? (
        <SupplierStep
          canCreate={canCreateSupplier}
          selected={supplier}
          onSelect={(s) => { setSupplier(s); setError(null); }}
          onNext={() => setStep(2)}
        />
      ) : step === 2 ? (
        <LinesStep lines={lines} setLines={setLines} onNext={() => setStep(3)} />
      ) : step === 3 ? (
        <ReviewStep
          supplier={supplier}
          lines={validLines}
          total={total}
          notes={notes}
          setNotes={setNotes}
          error={error}
          submitting={create.isPending}
          onSubmit={() => create.mutate()}
        />
      ) : (
        <DoneStep
          id={createdId ?? ""}
          supplierName={supplier?.name ?? ""}
          lineCount={validLines.length}
          total={total}
          receiving={receiving}
          onReceiveNow={() => createdId && onReceiveNow(createdId)}
          onClose={onClose}
        />
      )}
    </Sheet>
  );
}

/**
 * ApiError → one line the user can read (the suppliers screen's mapping).
 *
 * The purchase-order and supplier routes answer domain failures with a raw
 * Arabic sentence in `error`, which the transport reads into `code`. Arabic
 * there IS the message; anything else is a machine code — "Forbidden", zod's
 * "String must contain at most 200 character(s)" — and is mapped by kind
 * instead of shown verbatim. Only "offline" is really offline; a 403 or a
 * 500 must not be labelled "can't reach the server".
 */
export function describeError(e: unknown, fallback: string): string {
  if (!(e instanceof ApiError)) return fallback;
  if (e.code && /[\u0600-\u06FF]/.test(e.code)) return e.code;
  switch (e.kind) {
    case "offline":
      return t("mobile.common.offline");
    case "timeout":
      return t("mobile.common.timeout");
    case "forbidden":
      return t("mobile.common.forbidden");
    case "validation":
      return t("mobile.common.checkInput");
    case "rateLimited":
      return t("mobile.common.tooManyAttempts");
    case "billing":
      return t("mobile.common.subscriptionInactive");
    case "server":
      return t("mobile.common.serverError");
    default:
      return fallback;
  }
}

/**
 * t() has no plural rules, so "{n} items" prints "1 items" for a one-line
 * order. The footer on steps 2 and 3 and the done-step summary all go through
 * here so the caption keeps one shape across the wizard.
 */
function linesSummary(n: number, total: number): string {
  return t(`mobile.purchases.builder.linesSummary${countForm(n)}`, { n, amount: money(total) });
}

/** Arabic counts 1 / 2 / 3–10 / 11+ differently; the dictionary carries One/Two/Few beside the default. */
function countForm(n: number): string {
  return n === 1 ? "One" : n === 2 ? "Two" : n >= 3 && n <= 10 ? "Few" : "";
}

/**
 * TextInput alignment is PHYSICAL — Fabric swaps textAlign left/right for
 * Text under an RTL layout but not for a native input, so `...RTL_TEXT`
 * would pin Arabic to the left edge. Resolved at render time (not in the
 * StyleSheet) so a live locale switch re-aligns the field.
 */
function inputAlign() {
  return isRTL() ? styles.inputRtl : styles.inputLtr;
}

// ---------------------------------------------------------------------------
// Step 1 — supplier
// ---------------------------------------------------------------------------

function SupplierStep({
  canCreate,
  selected,
  onSelect,
  onNext,
}: {
  canCreate: boolean;
  selected: Supplier | null;
  onSelect: (s: Supplier) => void;
  onNext: () => void;
}) {
  const qc = useQueryClient();
  const suppliers = useQuery({ queryKey: ["suppliers"], queryFn: () => catalog.listSuppliers(api) });
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = suppliers.data ?? [];
    if (!needle) return all;
    return all.filter((s) => `${s.name} ${s.phone ?? ""}`.toLowerCase().includes(needle));
  }, [suppliers.data, q]);

  const createSupplier = useMutation({
    mutationFn: () =>
      catalog.createSupplier(api, { name: name.trim(), phone: phone.trim() || null }),
    onSuccess: async (res) => {
      const fresh: Supplier = {
        id: res.id,
        name: name.trim(),
        phone: phone.trim() || null,
        email: null,
        address: null,
        notes: null,
        balance: 0,
        createdAt: new Date().toISOString(),
      };
      await qc.invalidateQueries({ queryKey: ["suppliers"] });
      onSelect(fresh);
      setCreating(false);
      setName("");
      setPhone("");
      setErr(null);
    },
    onError: (e) => setErr(describeError(e, t("app.suppliers.form.errors.saveFailed"))),
  });

  return (
    <>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* The same SearchField step 2 uses, minus its barcode button (a
            supplier is not scanned) — a bespoke box here jogged the
            placeholder inset between consecutive steps (F28). */}
        <View testID="po-supplier-search">
          <SearchField value={q} onChangeText={setQ} placeholder={t("mobile.purchases.builder.searchSupplier")} />
        </View>

        {canCreate ? (
          <Pressable
            onPress={() => setCreating((v) => !v)}
            accessibilityRole="button"
            style={[styles.newSupplierBtn, creating && styles.newSupplierBtnActive]}
          >
            <UserPlus size={18} color={colors.accent} weight="bold" />
            <Text style={styles.newSupplierText}>{t("mobile.purchases.builder.newSupplier")}</Text>
          </Pressable>
        ) : null}

        {canCreate && creating ? (
          <View style={styles.inlineForm}>
            <Text style={styles.hint}>{t("mobile.purchases.builder.newSupplierHint")}</Text>
            <Field label={t("app.suppliers.form.name")} value={name} onChangeText={setName} autoFocus />
            <Field
              label={t("app.suppliers.form.phone")}
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
              ltr
            />
            {err ? <Text style={styles.err}>{err}</Text> : null}
            <Button
              label={t("app.suppliers.form.add")}
              disabled={!name.trim() || createSupplier.isPending}
              loading={createSupplier.isPending}
              onPress={() => createSupplier.mutate()}
            />
          </View>
        ) : null}

        {suppliers.isLoading ? (
          <ActivityIndicator color={colors.accent} />
        ) : suppliers.isError ? (
          <Text style={styles.err}>{describeError(suppliers.error, t("mobile.common.serverError"))}</Text>
        ) : rows.length === 0 ? (
          <EmptyState title={t("mobile.purchases.builder.noSuppliers")} />
        ) : (
          <View style={styles.list}>
            {rows.map((s) => {
              const active = selected?.id === s.id;
              return (
                <Pressable
                  key={s.id}
                  testID="po-supplier-row"
                  onPress={() => onSelect(s)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  style={[styles.pickRow, active && styles.pickRowActive]}
                >
                  <View style={styles.pickText}>
                    <Text numberOfLines={1} style={styles.pickName}>{s.name}</Text>
                    {s.phone ? <Text style={styles.meta}>{s.phone}</Text> : null}
                  </View>
                  {active ? <Check size={20} color={colors.accent} weight="bold" /> : null}
                </Pressable>
              );
            })}
          </View>
        )}
      </ScrollView>
      <View style={styles.footer}>
        {selected ? <Text style={styles.footerMeta} numberOfLines={1}>{selected.name}</Text> : null}
        <View testID="po-supplier-next">
          <Button label={t("mobile.purchases.builder.next")} disabled={!selected} onPress={onNext} />
        </View>
      </View>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — lines (search or scan)
// ---------------------------------------------------------------------------

function LinesStep({
  lines,
  setLines,
  onNext,
}: {
  lines: BuilderLine[];
  setLines: Dispatch<SetStateAction<BuilderLine[]>>;
  onNext: () => void;
}) {
  const products = useQuery({ queryKey: ["products"], queryFn: () => catalog.listProducts(api) });
  const [q, setQ] = useState("");
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanMsg, setScanMsg] = useState<{ text: string; tone: ScanTone } | null>(null);
  const inflight = useRef(false);
  /** Newest code decoded while a lookup was in flight; run once that lookup lands. */
  const queued = useRef<string | null>(null);

  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [] as Product[];
    return (products.data ?? [])
      .filter((p) =>
        `${p.name} ${p.brand ?? ""} ${p.sku ?? ""} ${p.barcode ?? ""}`.toLowerCase().includes(needle),
      )
      .slice(0, 8);
  }, [products.data, q]);

  const addProduct = useCallback(
    (p: Product) => {
      setLines((cur) => {
        const existing = cur.find((l) => l.productId === p.id);
        if (existing) {
          return cur.map((l) => (l.uid === existing.uid ? { ...l, quantity: l.quantity + 1 } : l));
        }
        return [
          ...cur,
          { uid: newUid(), productId: p.id, productName: p.name, quantity: 1, unitCost: p.costPrice ?? 0 },
        ];
      });
      setQ("");
    },
    [setLines],
  );

  const addFreeText = () =>
    setLines((cur) => [...cur, { uid: newUid(), productId: null, productName: "", quantity: 1, unitCost: 0 }]);

  const update = (uid: string, patch: Partial<BuilderLine>) =>
    setLines((cur) => cur.map((l) => (l.uid === uid ? { ...l, ...patch } : l)));
  const remove = (uid: string) => setLines((cur) => cur.filter((l) => l.uid !== uid));

  /**
   * Same lookup the POS uses: raw decoder output to the server, which
   * normalises both sides. Repeated scans of one label increment the line
   * (addProduct bumps an existing productId), which is what unpacking a
   * carton of the same SKU should do.
   */
  const onScan = useCallback(
    async (code: string) => {
      // Continuous mode keeps decoding while a lookup is in flight. Rather
      // than drop those, keep the newest one and run it when the current
      // lookup lands — the second label of a fast unpack is not lost, and the
      // ScannerSheet's same-code window already filters the re-reads.
      if (inflight.current) {
        queued.current = code;
        return;
      }
      inflight.current = true;
      let next: string | null = code;
      try {
        while (next) {
          const current: string = next;
          next = null;
          try {
            const res = await catalog.findProductByBarcode(api, current);
            if (res.product) {
              addProduct(res.product);
              setScanMsg({ text: t("mobile.purchases.builder.scanned", { name: res.product.name }), tone: "success" });
            } else {
              setScanMsg({ text: t("mobile.purchases.builder.scanNotFound"), tone: "error" });
            }
          } catch (e) {
            setScanMsg({ text: describeError(e, t("mobile.purchases.builder.scanFailed")), tone: "error" });
          }
          next = queued.current;
          queued.current = null;
        }
      } finally {
        inflight.current = false;
      }
    },
    [addProduct],
  );

  const count = lines.filter((l) => l.productName.trim() && l.quantity > 0).length;
  const total = lines.reduce((s, l) => s + l.quantity * l.unitCost, 0);

  return (
    <>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {lines.length > 0 ? <Text style={styles.hint}>{t("mobile.purchases.builder.scanHint")}</Text> : null}
        <View testID="po-product-search">
          <SearchField
            value={q}
            onChangeText={setQ}
            placeholder={t("app.purchases.builder.productSearchPlaceholder")}
            onPressScan={() => { setScanMsg(null); setScannerOpen(true); }}
          />
        </View>
        <ScannerSheet
          visible={scannerOpen}
          mode="continuous"
          onClose={() => setScannerOpen(false)}
          onScan={(code) => void onScan(code)}
          message={scanMsg?.text ?? null}
          tone={scanMsg?.tone ?? "info"}
        />

        {products.isLoading && q.trim() ? <ActivityIndicator color={colors.accent} /> : null}
        {products.isError ? (
          <Text style={styles.err}>{describeError(products.error, t("mobile.common.serverError"))}</Text>
        ) : null}
        {matches.map((p) => (
          <Pressable key={p.id} style={styles.pickRow} onPress={() => addProduct(p)} accessibilityRole="button" testID="po-product-match">
            <View style={styles.pickText}>
              <Text numberOfLines={1} style={styles.pickName}>
                {p.name}{p.brand ? ` — ${p.brand}` : ""}
              </Text>
              <Text style={styles.meta}>{t("mobile.purchases.cost", { amount: money(p.costPrice ?? 0) })}</Text>
            </View>
            <Plus size={18} color={colors.accent} weight="bold" />
          </Pressable>
        ))}

        <Pressable onPress={addFreeText} accessibilityRole="button" style={styles.newSupplierBtn}>
          <Plus size={18} color={colors.accent} weight="bold" />
          <Text style={styles.newSupplierText}>{t("mobile.purchases.builder.freeText")}</Text>
        </Pressable>

        {lines.length === 0 ? (
          <EmptyState title={t("mobile.purchases.builder.noLines")} hint={t("mobile.purchases.builder.noLinesHint")} />
        ) : (
          <View style={styles.list}>
            {lines.map((l) => (
              <View key={l.uid} style={styles.lineCard} testID="po-line">
                <View style={styles.lineHead}>
                  {l.productId ? (
                    <Text numberOfLines={2} style={[styles.pickName, styles.grow]}>{l.productName}</Text>
                  ) : (
                    <TextInput
                      value={l.productName}
                      onChangeText={(v) => update(l.uid, { productName: v })}
                      placeholder={t("mobile.purchases.builder.lineNamePlaceholder")}
                      placeholderTextColor={colors.textSecondary}
                      maxLength={200}
                      style={[styles.input, inputAlign(), styles.grow]}
                    />
                  )}
                  <Pressable
                    onPress={() => remove(l.uid)}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={t("mobile.purchases.builder.remove")}
                    style={styles.iconBtn}
                  >
                    <Trash size={18} color={colors.danger} />
                  </Pressable>
                </View>
                <View style={styles.lineEditors}>
                  <View style={styles.editor}>
                    <Text style={styles.editorLabel}>{t("app.purchases.builder.table.quantity")}</Text>
                    <View style={styles.stepper}>
                      <Pressable style={styles.qtyBtn} hitSlop={6} onPress={() => update(l.uid, { quantity: Math.max(1, l.quantity - 1) })} accessibilityRole="button">
                        <Minus size={14} color={colors.accent} weight="bold" />
                      </Pressable>
                      <TextInput
                        value={String(l.quantity)}
                        onChangeText={(v) => update(l.uid, { quantity: Math.max(0, Math.floor(parseNum(v))) })}
                        onBlur={() => l.quantity < 1 && update(l.uid, { quantity: 1 })}
                        keyboardType="number-pad"
                        selectTextOnFocus
                        style={styles.qtyInput}
                      />
                      <Pressable style={styles.qtyBtn} hitSlop={6} onPress={() => update(l.uid, { quantity: l.quantity + 1 })} accessibilityRole="button">
                        <Plus size={14} color={colors.accent} weight="bold" />
                      </Pressable>
                    </View>
                  </View>
                  <View style={styles.editor}>
                    <Text style={styles.editorLabel}>{t("app.purchases.builder.table.unitCost")}</Text>
                    <CostInput value={l.unitCost} onChange={(v) => update(l.uid, { unitCost: v })} />
                  </View>
                  <View style={[styles.editor, styles.editorEnd]}>
                    <Text style={styles.editorLabel}>{t("app.purchases.builder.table.total")}</Text>
                    <Text style={styles.lineTotal}>{money(l.quantity * l.unitCost)}</Text>
                  </View>
                </View>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
      <View style={styles.footer}>
        <Text style={styles.footerMeta}>{linesSummary(count, total)}</Text>
        <View testID="po-lines-next">
          <Button label={t("mobile.purchases.builder.next")} disabled={count === 0} onPress={onNext} />
        </View>
      </View>
    </>
  );
}

/** Numeric input that keeps the user's partial text ("12.") until blur. */
function CostInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);
  return (
    <TextInput
      value={text}
      onChangeText={(v) => { setText(v); onChange(Math.max(0, parseNum(v))); }}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); setText(String(Math.max(0, parseNum(text)))); }}
      keyboardType="decimal-pad"
      selectTextOnFocus
      style={[styles.input, inputAlign()]}
    />
  );
}

// ---------------------------------------------------------------------------
// Step 3 — review
// ---------------------------------------------------------------------------

function ReviewStep({
  supplier,
  lines,
  total,
  notes,
  setNotes,
  error,
  submitting,
  onSubmit,
}: {
  supplier: Supplier | null;
  lines: BuilderLine[];
  total: number;
  notes: string;
  setNotes: (v: string) => void;
  error: string | null;
  submitting: boolean;
  onSubmit: () => void;
}) {
  return (
    <>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.reviewCard}>
          <Text style={styles.editorLabel}>{t("mobile.purchases.builder.stepSupplier")}</Text>
          <Text style={styles.pickName}>{supplier?.name ?? ""}</Text>
          {supplier?.phone ? <Text style={styles.meta}>{supplier.phone}</Text> : null}
        </View>

        <View style={styles.reviewCard}>
          <Text style={styles.editorLabel}>
            {t(`app.purchases.row.itemCount${countForm(lines.length)}`, { n: lines.length })}
          </Text>
          {lines.map((l) => (
            <View key={l.uid} style={styles.reviewLine}>
              <Text numberOfLines={2} style={[styles.pickName, styles.grow]}>{l.productName}</Text>
              <Text style={styles.meta}>
                {t("mobile.purchases.builder.lineTotal", {
                  qty: l.quantity,
                  cost: money(l.unitCost),
                  total: money(l.quantity * l.unitCost),
                })}
              </Text>
            </View>
          ))}
          <View style={styles.totalRow}>
            <Text style={styles.pickName}>{t("app.purchases.builder.table.totalRow")}</Text>
            <Text style={styles.grandTotal}>{money(total)}</Text>
          </View>
        </View>

        <Field
          label={t("app.purchases.builder.notesLabel")}
          value={notes}
          onChangeText={setNotes}
          placeholder={t("mobile.purchases.builder.notesPlaceholder")}
          multiline
          numberOfLines={3}
          maxLength={2000}
        />
        {error ? <Text style={styles.err}>{error}</Text> : null}
      </ScrollView>
      <View style={styles.footer}>
        <Text style={styles.footerMeta}>{linesSummary(lines.length, total)}</Text>
        <View testID="po-submit">
          <Button
            label={t("app.purchases.builder.save")}
            disabled={!supplier || lines.length === 0 || submitting}
            loading={submitting}
            onPress={onSubmit}
          />
        </View>
      </View>
    </>
  );
}

// ---------------------------------------------------------------------------
// Step 4 — done
// ---------------------------------------------------------------------------

function DoneStep({
  id,
  supplierName,
  lineCount,
  total,
  receiving,
  onReceiveNow,
  onClose,
}: {
  id: string;
  supplierName: string;
  lineCount: number;
  total: number;
  receiving: boolean;
  onReceiveNow: () => void;
  onClose: () => void;
}) {
  return (
    <>
      <ScrollView contentContainerStyle={[styles.content, styles.doneContent]}>
        <CheckCircle size={72} color={colors.success} weight="fill" />
        <Text style={styles.doneTitle}>{t("app.purchases.toast.created")}</Text>
        <Text style={styles.doneRef} testID="po-done-ref">
          {t("mobile.purchases.builder.orderRef", { ref: id.slice(0, 8).toUpperCase() })}
        </Text>
        <Text style={styles.pickName} testID="po-done-supplier">{supplierName}</Text>
        <Text style={styles.meta} testID="po-done-summary">{linesSummary(lineCount, total)}</Text>
        <Text style={[styles.hint, styles.doneHint]}>{t("mobile.purchases.builder.createdHint")}</Text>
      </ScrollView>
      <View style={styles.footer}>
        <View testID="po-done-receive">
          <Button
            label={t("mobile.purchases.builder.receiveNow")}
            onPress={onReceiveNow}
            disabled={receiving}
            loading={receiving}
          />
        </View>
        <View testID="po-done-close">
          <Button label={t("mobile.purchases.builder.close")} variant="ghost" onPress={onClose} disabled={receiving} />
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  // The steps bring their own ScrollView + footer, so the Sheet body is a
  // bare flex column (bottom inset added at render).
  wizardBody: { paddingHorizontal: 0, paddingTop: 0, paddingBottom: 0, gap: 0 },
  // Same rail as add-product.tsx (6pt, gap sm, accentLight -> accent) so the
  // two wizards read as one pattern.
  // Horizontal inset is xl everywhere below (progress, backRow, content,
  // footer): the Sheet header starts its title at xl, and a 4pt kink in the
  // start edge ran through all three steps when the body sat at lg.
  progress: { flexDirection: "row", gap: spacing.sm, paddingHorizontal: spacing.xl, marginBottom: spacing.sm },
  backRow: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: spacing.xs,
    minHeight: MIN_TOUCH - 8,
    paddingHorizontal: spacing.xl,
  },
  // The Phosphor caret path fills ~37% of its viewBox, so at 16pt the visible
  // glyph starts ~5pt inside the icon box; pull it back so the caret's edge
  // lands on the same xl start as the progress rail below (U72).
  backGlyph: { marginStart: -GLYPH_INSET },
  backLabel: { fontFamily: fonts.semibold, fontSize: 14, color: colors.accent, ...RTL_TEXT },
  progressSeg: { flex: 1, height: 6, borderRadius: 3, backgroundColor: colors.accentLight },
  progressSegActive: { backgroundColor: colors.accent },
  content: { padding: spacing.lg, paddingHorizontal: spacing.xl, gap: spacing.md, paddingBottom: spacing.xl },
  footer: {
    padding: spacing.lg,
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.card,
  },
  footerMeta: { fontFamily: fonts.semibold, fontSize: 14, color: colors.textSecondary, ...RTL_TEXT },
  hint: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  err: { fontFamily: fonts.medium, fontSize: 13, color: colors.danger, ...RTL_TEXT },
  list: { gap: spacing.sm },
  grow: { flex: 1 },
  // pickRow / newSupplierBtn take SearchField's horizontal inset and radius
  // so the stacked boxes on step 1 share one start edge and one corner (F30).
  pickRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: MIN_TOUCH,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
  },
  pickRowActive: { borderColor: colors.accent, backgroundColor: colors.accentLight },
  pickText: { flex: 1, gap: 2 },
  pickName: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  meta: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  // Also the "add unlisted item" row on step 2 — one chrome for "add something new" (F29).
  newSupplierBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: "dashed",
  },
  newSupplierBtnActive: { borderColor: colors.accent, backgroundColor: colors.accentLight },
  newSupplierText: { fontFamily: fonts.semibold, fontSize: 14, color: colors.accent, ...RTL_TEXT },
  inlineForm: {
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  lineCard: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  lineHead: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  iconBtn: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: "center", justifyContent: "center" },
  lineEditors: { flexDirection: "row", alignItems: "flex-end", gap: spacing.sm },
  editor: { flex: 1, gap: spacing.xs },
  editorEnd: { alignItems: "flex-end" },
  editorLabel: { fontFamily: fonts.medium, fontSize: 12, color: colors.textSecondary, ...RTL_TEXT },
  stepper: { flexDirection: "row", alignItems: "center", gap: spacing.xs },
  qtyBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  qtyInput: {
    minWidth: 40,
    height: 36,
    textAlign: "center",
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  input: {
    height: 40,
    paddingHorizontal: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.bg,
    fontFamily: fonts.regular,
    fontSize: 15,
    color: colors.text,
  },
  inputLtr: { textAlign: "left", writingDirection: "ltr" },
  inputRtl: { textAlign: "right", writingDirection: "rtl" },
  lineTotal: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 15, color: colors.text, fontVariant: ["tabular-nums"] },
  reviewCard: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  reviewLine: { flexDirection: "row", alignItems: "center", gap: spacing.md, justifyContent: "space-between" },
  totalRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  grandTotal: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 18, color: colors.text, fontVariant: ["tabular-nums"] },
  doneContent: { alignItems: "center", justifyContent: "center", flexGrow: 1, gap: spacing.sm },
  doneTitle: { fontFamily: fonts.bold, fontSize: 22, color: colors.text, marginTop: spacing.md, ...RTL_TEXT },
  doneRef: { ...RTL_TEXT, fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary, fontVariant: ["tabular-nums"] },
  doneHint: { marginTop: spacing.md, paddingHorizontal: spacing.lg, textAlign: "center" },
});
