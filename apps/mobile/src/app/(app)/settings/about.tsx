import { useState } from "react";
import { Linking, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import * as Application from "expo-application";
import * as WebBrowser from "expo-web-browser";
import {
  ChatCircleText,
  EnvelopeSimple,
  FileText,
  Globe,
  ShieldCheck,
  type Icon,
} from "phosphor-react-native";
import { dictionaries } from "@matgary/i18n";

import { Logo } from "@/components/Logo";
import { Screen } from "@/components/layout/Screen";
import { ChevronBack, ChevronForward } from "@/components/ui/Chevron";
import { t, useLocale } from "@/i18n";
import { RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, elevation, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Settings → About. The web has no such page (its footer does this job), so
 * this screen is composed from what the footer and the contact page already
 * publish: version + build (App Store Guideline 2.1 reviewers look here),
 * the two legal documents, and the two support channels the contact page
 * lists. Every string comes from the shared dictionary so a change on the web
 * ships here unchanged — except the support addresses (see below).
 */
const WEB_ORIGIN = "https://thestoro.com";

/**
 * Support channels come from the build environment, not from marketing copy.
 * The contact page's WhatsApp number in the dictionary is a "+20 100 000 0000"
 * placeholder that the web renders as plain text and never links; turning it
 * into a tappable chat would drop a merchant into a stranger's WhatsApp. So:
 *   EXPO_PUBLIC_SUPPORT_WHATSAPP — any format, digits are extracted; the row
 *     is hidden while unset or while it still looks like the placeholder.
 *   EXPO_PUBLIC_SUPPORT_EMAIL — optional override of the dictionary address.
 * Expo inlines EXPO_PUBLIC_* at bundle time, so the literal property access
 * below is required (no dynamic lookup).
 */
const SUPPORT_WHATSAPP = process.env.EXPO_PUBLIC_SUPPORT_WHATSAPP ?? "";
const SUPPORT_EMAIL = process.env.EXPO_PUBLIC_SUPPORT_EMAIL ?? "";
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface Row {
  key: string;
  icon: Icon;
  title: string;
  hint?: string;
  /** The address or number itself — shown LTR under the hint, read as the a11y value. */
  detail?: string;
  onPress: () => void | Promise<void>;
  /** Visual hint that the row leaves the app. */
  external?: boolean;
}

export default function AboutSettingsScreen() {
  const router = useRouter();
  const locale = useLocale((s) => s.locale);
  const [error, setError] = useState<string | null>(null);

  const contact = dictionaries[locale].marketing.contact.channels;
  const supportEmail = (SUPPORT_EMAIL || contact.email.detail).trim();
  const hasEmail = EMAIL_SHAPE.test(supportEmail);
  // wa.me wants digits only. Hide the row while the number is unset or still
  // the dictionary placeholder (or any run of zeros that reads like one).
  const waDigits = SUPPORT_WHATSAPP.replace(/\D/g, "");
  const placeholderDigits = contact.whatsapp.detail.replace(/\D/g, "");
  const hasWhatsapp = waDigits.length >= 8 && waDigits !== placeholderDigits && !/0{6}/.test(waDigits);

  const version = Application.nativeApplicationVersion ?? t("mobile.about.unknownVersion");
  const build = Application.nativeBuildVersion ?? t("mobile.about.unknownVersion");

  // No canOpenURL pre-check: on Android 11+ package-visibility filtering makes
  // it return false for mailto:/https: unless the manifest declares <queries>,
  // which this app does not. openURL rejects when nothing handles the URL and
  // that already maps to the openFailed state.
  async function openExternal(url: string) {
    setError(null);
    try {
      await Linking.openURL(url);
    } catch {
      setError(t("mobile.about.openFailed"));
    }
  }

  async function openWeb(path: string) {
    setError(null);
    try {
      await WebBrowser.openBrowserAsync(`${WEB_ORIGIN}/${locale}${path}`, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
        dismissButtonStyle: "close",
      });
    } catch {
      setError(t("mobile.about.openFailed"));
    }
  }

  const legalRows: Row[] = [
    {
      key: "privacy",
      icon: ShieldCheck,
      title: t("footer.columns.legal.links.privacy"),
      hint: t("mobile.about.privacySub"),
      onPress: () => router.push("/legal/privacy"),
    },
    {
      key: "terms",
      icon: FileText,
      title: t("footer.columns.legal.links.terms"),
      hint: t("mobile.about.termsSub"),
      onPress: () => router.push("/legal/terms"),
    },
  ];

  const supportRows: Row[] = [
    ...(hasEmail
      ? [
          {
            key: "email",
            icon: EnvelopeSimple,
            title: contact.email.title,
            hint: t("mobile.about.supportEmailSub"),
            detail: supportEmail,
            external: true,
            onPress: () =>
              openExternal(
                `mailto:${supportEmail}?subject=${encodeURIComponent(
                  `${t("common.brand")} ${Platform.OS} ${version} (${build})`,
                )}`,
              ),
          } satisfies Row,
        ]
      : []),
    ...(hasWhatsapp
      ? [
          {
            key: "whatsapp",
            icon: ChatCircleText,
            title: contact.whatsapp.title,
            hint: t("mobile.about.supportWhatsappSub"),
            detail: SUPPORT_WHATSAPP.trim(),
            external: true,
            onPress: () => openExternal(`https://wa.me/${waDigits}`),
          } satisfies Row,
        ]
      : []),
    {
      key: "website",
      icon: Globe,
      title: t("mobile.about.website"),
      hint: t("mobile.about.websiteSub"),
      external: true,
      onPress: () => openWeb("/welcome"),
    },
  ];

  return (
    <Screen>
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
        <Text style={styles.title}>{t("mobile.settings.about")}</Text>
      </View>

      {/* Identity block — the same logo lock-up as the login screen, then the
          version line reviewers and support both ask for. */}
      <View style={styles.identity}>
        <Logo size="md" />
        <Text style={styles.tagline}>{t("footer.tagline")}</Text>
        <Text style={styles.version} selectable accessibilityLabel={t("mobile.about.versionLine", { version, build })}>
          {t("mobile.about.versionLine", { version, build })}
        </Text>
      </View>

      <Group heading={t("footer.columns.legal.heading")} rows={legalRows} />
      <Group heading={t("footer.columns.support.heading")} rows={supportRows} />

      {error ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}

      <View style={styles.footer}>
        <Text style={styles.disclaimer}>{t("footer.disclaimer")}</Text>
        <Text style={styles.copyright}>
          © {new Date().getFullYear()} {t("common.brand")}. {t("footer.copyright")}
        </Text>
      </View>
    </Screen>
  );
}

function Group({ heading, rows }: { heading: string; rows: Row[] }) {
  return (
    <View style={styles.group}>
      <Text style={styles.groupHeading} accessibilityRole="header">
        {heading}
      </Text>
      <View style={styles.card}>
        {rows.map((row, i) => {
          const IconCmp = row.icon;
          return (
            <Pressable
              key={row.key}
              accessibilityRole={row.external ? "link" : "button"}
              accessibilityLabel={row.title}
              accessibilityHint={row.hint}
              accessibilityValue={row.detail ? { text: row.detail } : undefined}
              onPress={() => void row.onPress()}
              style={({ pressed }) => [
                styles.row,
                i > 0 && styles.rowDivider,
                pressed && styles.rowPressed,
              ]}
            >
              <View style={styles.rowIcon}>
                <IconCmp size={20} color={colors.accent} />
              </View>
              <View style={styles.rowBody}>
                <Text style={styles.rowTitle}>{row.title}</Text>
                {row.hint ? (
                  <Text style={styles.rowHint} numberOfLines={2}>
                    {row.hint}
                  </Text>
                ) : null}
                {row.detail ? (
                  <Text style={styles.rowDetail} numberOfLines={1}>
                    {row.detail}
                  </Text>
                ) : null}
              </View>
              <ChevronForward size={16} color={colors.textSecondary} />
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { gap: spacing.xs },
  back: { flexDirection: "row", alignItems: "center", gap: 4, minHeight: 32, alignSelf: "flex-start" },
  backLabel: { fontFamily: fonts.medium, fontSize: 14, color: colors.textSecondary },
  title: { fontFamily: fonts.bold, fontSize: 26, color: colors.text, ...RTL_TEXT },

  identity: {
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    ...elevation.card,
  },
  tagline: {
    fontFamily: fonts.regular,
    fontSize: 13,
    lineHeight: 20,
    color: colors.textSecondary,
    textAlign: "center",
  },
  version: {
    fontFamily: fonts.medium,
    fontSize: 13,
    color: colors.text,
    backgroundColor: colors.neutralTint,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    textAlign: "center",
  },

  group: { gap: spacing.sm },
  groupHeading: {
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.textSecondary,
    marginStart: spacing.xs,
    ...RTL_TEXT,
  },
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    overflow: "hidden",
    ...elevation.card,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: MIN_TOUCH + spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  rowDivider: { borderTopWidth: 1, borderTopColor: colors.border },
  rowPressed: { backgroundColor: colors.neutralTint },
  rowIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.accentLight,
    alignItems: "center",
    justifyContent: "center",
  },
  rowBody: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  rowHint: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 18, color: colors.textSecondary, ...RTL_TEXT },
  // Addresses and numbers are always LTR, whatever the UI language.
  rowDetail: {
    fontFamily: fonts.medium,
    fontSize: 12,
    lineHeight: 18,
    color: colors.accent,
    writingDirection: "ltr",
    alignSelf: "flex-start",
  },

  error: { fontFamily: fonts.regular, fontSize: 13, color: colors.danger, ...RTL_TEXT },

  footer: { gap: spacing.sm, paddingTop: spacing.md },
  disclaimer: {
    fontFamily: fonts.regular,
    fontSize: 12,
    lineHeight: 18,
    color: colors.textSecondary,
    ...RTL_TEXT,
  },
  copyright: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textSecondary,
    textAlign: "center",
  },
});
