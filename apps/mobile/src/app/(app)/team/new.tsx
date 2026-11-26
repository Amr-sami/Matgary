import { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Clipboard, // Deprecated RN export but still backed by NativeClipboard. Using
  // this avoids adding expo-clipboard (which needs a native rebuild of the
  // dev-client); swap for expo-clipboard the next time the app is rebuilt.
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CopyIcon as Copy } from "phosphor-react-native/src/icons/Copy";
import { CheckIcon as Check } from "phosphor-react-native/src/icons/Check";
import { ApiError, team } from "@matgary/api-client";

// TODO (follow-up): photo uploads (profile + national ID) via expo-image-picker
// + FormData → /api/uploads/team/, mirroring apps/web/components/settings/
// EmployeeFormModal.tsx. Deferred; the backend accepts user creation without
// them (profilePhotoPath / idPhotoPath are optional on POST /api/team).

import { api } from "@/api/client";
import { getLocale, t } from "@/i18n";
import { Screen } from "@/components/layout/Screen";
import { HeaderAccessories } from "@/components/shell/HeaderAccessories";
import { BackLink } from "@/components/ui/BackLink";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/EmptyState";
import { Field } from "@/components/ui/Field";
import { Sheet } from "@/components/ui/Sheet";
import { PermissionPicker } from "@/components/team/PermissionPicker";
import { errorText as sharedErrorText } from "@/lib/errors";
import { validateNewMember, type FieldError } from "./_new-validate";
import { useSession } from "@/stores/session";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing, MIN_TOUCH } from "@/theme/tokens";

/**
 * Maps a `createMember` failure to the sentence shown on this screen. The
 * server writes 409 bodies in Arabic (apps/web/lib/repo/team.ts
 * TeamConflictError), so echo them when the UI is Arabic, otherwise fall back
 * to the generic "username is taken" line.
 */
function createErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === "forbidden") return t("mobile.team.new.errors.forbidden");
    if (error.kind === "conflict") {
      return getLocale() === "ar" && error.message
        ? error.message
        : t("mobile.team.new.errors.conflict");
    }
    // 400 with human prose (e.g. a zod issue sentence): show it verbatim.
    if (error.status !== null && error.status >= 400 && error.status < 500 && error.message) {
      const seemsCode = /^[A-Z_][A-Z_0-9]*$/.test(error.message);
      if (!seemsCode) return error.message;
      return t("mobile.team.new.errors.genericValidation");
    }
  }
  return sharedErrorText(error, t("mobile.team.new.errors.generic"));
}

export default function NewTeamMemberScreen() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useSession((s) => s.me);
  const canManage = new Set(me?.permissions ?? []).has("manage_team");
  const branchId = me?.branch.id ?? null;

  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [nationalId, setNationalId] = useState("");
  const [address, setAddress] = useState("");
  const [permissions, setPermissions] = useState<string[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const [created, setCreated] = useState<{
    userId: string;
    loginEmail: string;
    password: string;
  } | null>(null);

  const errors = useMemo(
    () => validateNewMember({ username, displayName, password }),
    [username, displayName, password],
  );
  const hasErrors = Object.keys(errors).length > 0;

  const createM = useMutation({
    mutationFn: async () => {
      if (!branchId) throw new Error("NO_BRANCH_ID");
      const result = await team.createMember(api, {
        username: username.trim().toLowerCase(),
        displayName: displayName.trim(),
        password,
        phone: phone.trim() || null,
        nationalId: nationalId.trim() || null,
        address: address.trim() || null,
        permissions,
        branchId,
      });
      // Verify persistence: the architecture has no GET /api/team/[userId];
      // the detail view reads from the list. Re-fetch, locate the new user,
      // and only then treat the create as done.
      await queryClient.invalidateQueries({ queryKey: ["team"] });
      const rows = await queryClient.fetchQuery({
        queryKey: ["team"],
        queryFn: () => team.listTeam(api),
      });
      const found = rows.find((r) => r.userId === result.userId);
      return { result, verified: !!found };
    },
    onSuccess: ({ result, verified }) => {
      if (verified) {
        // Keep the owner on this screen briefly so they can copy the login
        // + password. The sheet's "Done" button performs the navigation.
        setCreated({ userId: result.userId, loginEmail: result.loginEmail, password });
      } else {
        setSubmitError(t("mobile.team.new.verifyFailed"));
      }
    },
    onError: (error) => setSubmitError(createErrorText(error)),
  });

  const onSubmit = () => {
    setTouched(true);
    if (hasErrors || !branchId) return;
    setSubmitError(null);
    createM.mutate();
  };

  // Close the sheet THEN navigate. Setting `created` to null flips the Sheet's
  // `visible` false synchronously; without it the sheet lingered because the
  // destination route re-mounts a child screen under the same owner View.
  const dismissSheet = () => {
    const uid = created?.userId;
    setCreated(null);
    if (uid) router.replace(`/team/${encodeURIComponent(uid)}`);
  };

  if (!canManage) {
    return (
      <Screen
        header={
          <View style={styles.fixedHeader}>
            <HeaderAccessories />
            <BackLink label={t("mobile.team.back")} onPress={() => router.navigate("/team")} />
          </View>
        }
      >
        <EmptyState title={t("mobile.team.new.errors.forbidden")} />
      </Screen>
    );
  }

  // Format errors (e.g. invalid username characters, short password) surface
  // as soon as the owner has typed into the field — a "too short" message
  // that waits for submit is the most annoying way to report it. "Required"
  // errors on untouched empty fields wait for the submit tap so the form
  // doesn't shout at the owner before they've started.
  const hasValue = { username: !!username, displayName: !!displayName, password: !!password };
  const errorFor = (k: "username" | "displayName" | "password"): string | null => {
    const code = errors[k];
    if (!code) return null;
    const isRequired = code === "usernameRequired" || code === "displayNameRequired";
    if (isRequired && !touched) return null;
    if (!isRequired && !hasValue[k] && !touched) return null;
    return t(`mobile.team.new.errors.${code}`);
  };

  return (
    <Screen
      header={
        <View style={styles.fixedHeader}>
          <HeaderAccessories />
          <BackLink label={t("mobile.team.back")} onPress={() => router.navigate("/team")} />
        </View>
      }
    >
      <View style={styles.stack}>
        <View style={styles.hero}>
          <Text style={styles.title}>{t("mobile.team.new.title")}</Text>
          <Text style={styles.intro}>{t("mobile.team.new.intro")}</Text>
        </View>

        {submitError ? (
          <View style={styles.errorBanner}>
            <Text style={styles.errorBannerText}>{submitError}</Text>
          </View>
        ) : null}

        <Card title={t("mobile.team.new.credentialsSection")}>
          <Field
            label={t("mobile.team.new.usernameLabel")}
            placeholder={t("mobile.team.new.usernamePlaceholder")}
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            ltr
            testID="new-username"
          />
          {errorFor("username") ? (
            <Text style={styles.fieldError}>{errorFor("username")}</Text>
          ) : (
            <Text style={styles.fieldHint}>{t("mobile.team.new.usernameHint")}</Text>
          )}
          <Field
            label={t("mobile.team.new.displayNameLabel")}
            placeholder={t("mobile.team.new.displayNamePlaceholder")}
            value={displayName}
            onChangeText={setDisplayName}
            testID="new-display-name"
          />
          {errorFor("displayName") ? (
            <Text style={styles.fieldError}>{errorFor("displayName")}</Text>
          ) : null}
          <Field
            label={t("mobile.team.new.passwordLabel")}
            placeholder={t("mobile.team.new.passwordPlaceholder")}
            value={password}
            onChangeText={setPassword}
            secure
            ltr
            autoCapitalize="none"
            autoCorrect={false}
            testID="new-password"
          />
          {errorFor("password") ? (
            <Text style={styles.fieldError}>{errorFor("password")}</Text>
          ) : (
            <Text style={styles.fieldHint}>{t("mobile.team.new.passwordHint")}</Text>
          )}
        </Card>

        <Card title={t("mobile.team.new.profileSection")}>
          <Field
            label={t("mobile.team.new.phoneLabel")}
            placeholder={t("mobile.team.new.phonePlaceholder")}
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            ltr
            testID="new-phone"
          />
          <Field
            label={t("mobile.team.new.nationalIdLabel")}
            placeholder={t("mobile.team.new.nationalIdPlaceholder")}
            value={nationalId}
            onChangeText={setNationalId}
            keyboardType="number-pad"
            ltr
            testID="new-national-id"
          />
          <Field
            label={t("mobile.team.new.addressLabel")}
            placeholder={t("mobile.team.new.addressPlaceholder")}
            value={address}
            onChangeText={setAddress}
            testID="new-address"
          />
        </Card>

        <Card title={t("mobile.team.new.permissionsSection")}>
          <PermissionPicker
            value={permissions}
            onChange={setPermissions}
            disabled={createM.isPending}
            testID="new-perms"
          />
        </Card>

        {createM.isPending ? (
          <View style={styles.pendingRow}>
            <ActivityIndicator color={colors.accent} />
            <Text style={styles.pendingText}>{t("mobile.team.new.verifying")}</Text>
          </View>
        ) : null}

        <Button
          label={createM.isPending ? t("mobile.team.new.submitting") : t("mobile.team.new.submit")}
          onPress={onSubmit}
          loading={createM.isPending}
          disabled={createM.isPending}
          testID="new-submit"
        />
      </View>

      <Sheet
        visible={!!created}
        onClose={dismissSheet}
        title={t("app.teamAdmin.credModal.title")}
        subtitle={t("app.teamAdmin.credModal.intro")}
        testID="new-creds-sheet"
        closeOnBackdrop={false}
        primaryAction={{
          label: t("app.teamAdmin.credModal.done"),
          onPress: dismissSheet,
          testID: "new-creds-done",
        }}
      >
        {created ? (
          <View style={styles.credsStack}>
            <CopyField
              label={t("app.teamAdmin.credModal.loginLabel")}
              value={created.loginEmail}
              testID="new-creds-login"
            />
            <CopyField
              label={t("app.teamAdmin.credModal.passwordLabel")}
              value={created.password}
              testID="new-creds-password"
            />
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                Clipboard.setString(
                  `${t("app.teamAdmin.credModal.loginLabel")}: ${created.loginEmail}\n${t("app.teamAdmin.credModal.passwordLabel")}: ${created.password}`,
                );
              }}
              style={({ pressed }) => [styles.copyBothRow, pressed && styles.pressed]}
              testID="new-creds-copy-both"
            >
              <Copy size={16} color={colors.accent} />
              <Text style={styles.copyBothLabel}>{t("app.teamAdmin.credModal.copyBoth")}</Text>
            </Pressable>
          </View>
        ) : null}
      </Sheet>
    </Screen>
  );
}

/**
 * Read-only value + copy button. State machine: idle → copied (2s) → idle.
 * Uses the deprecated RN Clipboard (see import note).
 */
function CopyField({ label, value, testID }: { label: string; value: string; testID?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(id);
  }, [copied]);
  return (
    <View style={styles.credRow} testID={testID}>
      <Text style={styles.credLabel}>{label}</Text>
      <View style={styles.credValueRow}>
        <Text style={styles.credValue} numberOfLines={1} selectable>
          {value}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t("app.teamAdmin.credModal.copy")}
          onPress={() => {
            Clipboard.setString(value);
            setCopied(true);
          }}
          style={({ pressed }) => [styles.copyBtn, pressed && styles.pressed]}
          testID={testID ? `${testID}-copy` : undefined}
        >
          {copied ? (
            <Check size={16} color={colors.successStrong} />
          ) : (
            <Copy size={16} color={colors.accent} />
          )}
          <Text style={[styles.copyBtnLabel, copied && styles.copyBtnLabelDone]}>
            {copied ? t("app.teamAdmin.credModal.copied") : t("app.teamAdmin.credModal.copy")}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: spacing.md },
  fixedHeader: { gap: spacing.xs, alignItems: "flex-start" },
  hero: { gap: spacing.xs },
  title: { fontFamily: fonts.bold, fontSize: 22, color: colors.text, ...RTL_TEXT },
  intro: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  errorBanner: {
    borderRadius: radius.md,
    padding: spacing.md,
    backgroundColor: colors.dangerLight,
  },
  errorBannerText: { fontFamily: fonts.medium, fontSize: 14, color: colors.danger, ...RTL_TEXT },
  fieldError: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.danger,
    marginTop: -spacing.xs,
    ...RTL_TEXT,
  },
  fieldHint: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    marginTop: -spacing.xs,
    ...RTL_TEXT,
  },
  pendingRow: { flexDirection: "row", gap: spacing.sm, alignItems: "center" },
  pendingText: { fontFamily: fonts.regular, fontSize: 13, color: colors.textSecondary, ...RTL_TEXT },
  credsStack: { gap: spacing.md },
  credRow: { gap: spacing.xs },
  credLabel: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.textSecondary,
    ...RTL_TEXT,
  },
  credValueRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 12,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.card,
  },
  credValue: {
    flex: 1,
    fontFamily: fonts.semibold,
    fontSize: 15,
    color: colors.text,
    writingDirection: "ltr",
  },
  copyBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.sm,
  },
  copyBtnLabel: { fontFamily: fonts.semibold, fontSize: 13, color: colors.accent, ...RTL_TEXT },
  copyBtnLabelDone: { color: colors.successStrong },
  copyBothRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xs,
    minHeight: MIN_TOUCH,
    marginTop: spacing.xs,
  },
  copyBothLabel: { fontFamily: fonts.semibold, fontSize: 14, color: colors.accent, ...RTL_TEXT },
  pressed: { opacity: 0.6 },
});
