import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PencilSimple } from "phosphor-react-native";
import { ApiError, catalog, type Supplier } from "@matgary/api-client";

import { api } from "@/api/client";
import { Screen } from "@/components/layout/Screen";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { money } from "@/lib/format";
import { useSession } from "@/stores/session";
import { RTL_TEXT, directionStyle } from "@/theme/rtl";
import { MIN_TOUCH, colors, elevation, fonts, radius, spacing } from "@/theme/tokens";
import { isRTL, t } from "@/i18n";

/**
 * ApiError → one line the user can read.
 *
 * The supplier routes answer domain failures with a raw Arabic sentence in
 * `error` (a 409 on delete, for one), which the transport reads into `code`.
 * Arabic there IS the message; anything else is a machine code — "Forbidden",
 * zod's "Invalid email" — and is mapped by kind instead of shown verbatim.
 */
function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof ApiError)) return fallback;
  if (error.code && /[\u0600-\u06FF]/.test(error.code)) return error.code;
  switch (error.kind) {
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

/** Port of app__suppliers.png. Balance > 0 means the shop owes the supplier. */
export default function SuppliersScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useSession((s) => s.me);
  // The routes gate POST/PATCH on manage_suppliers (owners bypass); hiding the
  // affordances for everyone else saves a cashier a 403 they cannot act on.
  const canManage = !!me && (me.isOwner || me.permissions.includes("manage_suppliers"));

  const q = useQuery({
    queryKey: ["suppliers"],
    queryFn: () => catalog.listSuppliers(api),
  });

  // null = closed, "new" = create sheet, a Supplier = edit sheet for that row.
  const [sheet, setSheet] = useState<"new" | Supplier | null>(null);

  const rows = q.data ?? [];
  const owed = rows.reduce((s, r) => s + Math.max(r.balance, 0), 0);

  return (
    <Screen
      title={t("app.activityLabels.categories.supplier")}
      subtitle={rows.length ? t("mobile.suppliers.summary", { n: rows.length, owed: money(owed) }) : undefined}
      onRefresh={() => void q.refetch()}
      refreshing={q.isRefetching}
    >
      {canManage ? <Button label={t("app.suppliers.list.add")} onPress={() => setSheet("new")} /> : null}

      {/* A failed refetch keeps q.data (retry is off in app/_layout), so the
          cached rows stay on screen with a banner; the full error view is
          for a first load that never arrived. */}
      {q.isError && q.data ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("app.common.retry")}
          onPress={() => void q.refetch()}
          style={styles.refreshFailed}
        >
          <Text style={styles.refreshFailedText}>
            {`${t("mobile.suppliers.refreshFailed")} · ${t("app.common.retry")}`}
          </Text>
        </Pressable>
      ) : null}

      {q.isLoading ? (
        <ActivityIndicator color={colors.accent} />
      ) : q.isError && !q.data ? (
        <View>
          <EmptyState title={errorMessage(q.error, t("mobile.common.serverError"))} />
          <Button label={t("app.common.retry")} variant="outline" onPress={() => void q.refetch()} />
        </View>
      ) : rows.length === 0 ? (
        <EmptyState
          title={t("mobile.suppliers.empty")}
          hint={canManage ? t("app.suppliers.picker.addNew") : undefined}
        />
      ) : (
        <View style={styles.list}>
          {rows.map((s) => (
            <Pressable
              key={s.id}
              accessibilityRole="button"
              accessibilityLabel={t("mobile.suppliers.profileOf", { name: s.name })}
              onPress={() => router.push(`/suppliers/${encodeURIComponent(s.id)}`)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <View style={styles.head}>
                <Text numberOfLines={1} style={styles.name}>
                  {s.name}
                </Text>
                {s.balance > 0 ? (
                  <Badge label={money(s.balance)} variant="outofstock" />
                ) : (
                  <Badge label={t("mobile.suppliers.noBalance")} variant="success" />
                )}
                {canManage ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${t("app.suppliers.list.editTitle")} ${s.name}`}
                    hitSlop={8}
                    onPress={() => setSheet(s)}
                    style={({ pressed }) => [styles.editBtn, pressed && styles.editBtnPressed]}
                  >
                    <PencilSimple size={18} color={colors.textSecondary} />
                  </Pressable>
                ) : null}
              </View>
              {s.phone ? <Text style={styles.meta}>{s.phone}</Text> : null}
              {s.address ? (
                <Text numberOfLines={1} style={styles.meta}>
                  {s.address}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </View>
      )}

      <SupplierFormSheet
        visible={sheet !== null}
        initial={sheet !== null && sheet !== "new" ? sheet : null}
        onClose={() => setSheet(null)}
        onSaved={(id, created) => {
          setSheet(null);
          void queryClient.invalidateQueries({ queryKey: ["suppliers"] });
          if (created) {
            router.push(`/suppliers/${encodeURIComponent(id)}`);
          } else {
            // The detail screen reads ["supplier", id]; keep it honest too.
            void queryClient.invalidateQueries({ queryKey: ["supplier", id] });
          }
        }}
      />
    </Screen>
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The web's SupplierFormModal: name (required), phone, email, address, notes —
 * the exact fields of the route's zod schema, nothing the server would drop.
 *
 * One sheet for both create and edit: `initial` null means POST, otherwise
 * PATCH on that supplier. Client-side checks mirror the schema's two hard
 * rules (name non-empty, email well-formed when given) so the user reads an
 * Arabic line instead of zod's English 400.
 *
 * RTL is re-applied here on purpose: a Modal mounts its own native root, so the
 * `direction` set on the screen root does not reach inside it.
 */
function SupplierFormSheet({
  visible,
  initial,
  onClose,
  onSaved,
}: {
  visible: boolean;
  initial: Supplier | null;
  onClose: () => void;
  onSaved: (id: string, created: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Re-seed on every open so an edit shows the row's values and a create
  // starts blank — even after the previous sheet was dismissed mid-typing.
  useEffect(() => {
    if (!visible) return;
    setName(initial?.name ?? "");
    setPhone(initial?.phone ?? "");
    setEmail(initial?.email ?? "");
    setAddress(initial?.address ?? "");
    setNotes(initial?.notes ?? "");
    setError(null);
  }, [visible, initial]);

  const validate = (): string | null => {
    if (!name.trim()) return t("mobile.suppliers.nameRequired");
    if (email.trim() && !EMAIL_RE.test(email.trim())) return t("auth.signup.errors.badEmail");
    return null;
  };

  const save = useMutation({
    mutationFn: async () => {
      const input: catalog.SupplierInput = {
        name: name.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        address: address.trim() || null,
        notes: notes.trim() || null,
      };
      if (initial) {
        await catalog.updateSupplier(api, initial.id, input);
        return { id: initial.id, created: false };
      }
      const res = await catalog.createSupplier(api, input);
      return { id: res.id, created: true };
    },
    onSuccess: ({ id, created }) => onSaved(id, created),
    onError: (err) => {
      // POST /api/suppliers carries no idempotency key. A timeout — or a link
      // that died mid-flight, which fetch reports as "offline" — leaves the
      // insert's fate unknown: the server may have committed it. Refresh the
      // list behind the sheet and tell the user to look there before tapping
      // Add again, or a flaky link mints a duplicate supplier. PATCH is
      // idempotent, so an edit keeps the plain message.
      const uncertain =
        !initial && err instanceof ApiError && (err.kind === "timeout" || err.kind === "offline");
      if (uncertain) {
        void queryClient.invalidateQueries({ queryKey: ["suppliers"] });
        setError(t("mobile.suppliers.maybeSaved"));
        return;
      }
      setError(errorMessage(err, t("app.suppliers.form.errors.saveFailed")));
    },
  });

  const submit = () => {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    save.mutate();
  };

  const close = () => {
    if (save.isPending) return;
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      <View style={[styles.overlay, directionStyle(isRTL())]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={close} accessibilityLabel={t("app.common.close")} />
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <View style={styles.sheet}>
            <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.sheetBody}>
              <Text style={styles.sheetTitle}>
                {initial ? t("app.suppliers.form.editTitle") : t("app.suppliers.form.createTitle")}
              </Text>

              <Field
                label={t("app.suppliers.form.name")}
                value={name}
                onChangeText={setName}
                autoFocus={!initial}
                maxLength={120}
                returnKeyType="next"
              />
              <Field
                label={t("app.suppliers.form.phone")}
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
                textContentType="telephoneNumber"
                maxLength={40}
                ltr
              />
              <Field
                label={t("app.suppliers.form.email")}
                value={email}
                onChangeText={setEmail}
                keyboardType="email-address"
                textContentType="emailAddress"
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={120}
                ltr
              />
              <Field
                label={t("app.suppliers.form.address")}
                value={address}
                onChangeText={setAddress}
                maxLength={255}
              />
              <Field
                label={t("app.suppliers.form.notes")}
                value={notes}
                onChangeText={setNotes}
                maxLength={2000}
                multiline
              />

              {error ? (
                <Text numberOfLines={3} style={styles.error}>
                  {error}
                </Text>
              ) : null}

              <View style={styles.actions}>
                <Button
                  label={initial ? t("app.suppliers.form.save") : t("app.suppliers.form.add")}
                  onPress={submit}
                  disabled={!name.trim()}
                  loading={save.isPending}
                  style={styles.actionGrow}
                />
                <Button
                  label={t("app.suppliers.form.cancel")}
                  variant="outline"
                  onPress={close}
                  style={styles.actionGrow}
                />
              </View>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  list: { gap: spacing.md },
  row: {
    backgroundColor: colors.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: 4,
    ...elevation.card,
  },
  rowPressed: { backgroundColor: colors.accentLight },
  head: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  name: { flex: 1, fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  // Block-level Text keeps its natural (left) alignment on iOS whatever Yoga's
  // direction says — a digits-only phone has no strong character, and even the
  // Arabic address hugged the left edge under the RTL name row. alignSelf is
  // resolved by Yoga against the live direction, so it lands on the reading
  // edge in both locales (and survives a live language switch).
  meta: { alignSelf: "flex-start", fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  editBtn: {
    minWidth: MIN_TOUCH - 12,
    minHeight: MIN_TOUCH - 12,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    // Pull the icon into the card's padding so the row's text keeps its width.
    marginEnd: -spacing.sm,
  },
  editBtnPressed: { backgroundColor: colors.accentLight },
  refreshFailed: {
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.dangerLight,
    minHeight: MIN_TOUCH,
    justifyContent: "center",
  },
  refreshFailedText: { alignSelf: "flex-start", fontFamily: fonts.medium, fontSize: 13, color: colors.danger, ...RTL_TEXT },

  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: colors.scrim },
  sheet: {
    backgroundColor: colors.card,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    maxHeight: "90%",
    ...elevation.modal,
  },
  sheetBody: { padding: spacing.xl, gap: spacing.lg },
  sheetTitle: { alignSelf: "flex-start", fontFamily: fonts.bold, fontSize: 18, color: colors.text, ...RTL_TEXT },
  error: { alignSelf: "flex-start", fontFamily: fonts.medium, fontSize: 14, color: colors.danger, ...RTL_TEXT },
  actions: { flexDirection: "row", gap: spacing.sm },
  actionGrow: { flex: 1 },
});
