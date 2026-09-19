import { useCallback, useRef, useState } from "react";
import { type LayoutChangeEvent, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { ArrowSquareOutIcon as ArrowSquareOut } from "phosphor-react-native/src/icons/ArrowSquareOut";
import { dictionaries } from "@matgary/i18n";

import { BackLink } from "@/components/ui/BackLink";
import { ChevronForward } from "@/components/ui/Chevron";
import { EmptyState } from "@/components/ui/EmptyState";
import { t, useLocale } from "@/i18n";
import { legalParent } from "@/lib/nav";
import { useSession } from "@/stores/session";
import { RTL, RTL_TEXT } from "@/theme/rtl";
import { MIN_TOUCH, colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * /legal/privacy and /legal/terms — the two documents both app stores require
 * to be reachable from inside the app (06 §9.6).
 *
 * The gap analysis (02 §1.2) said "remote WebView". We do better: the full
 * texts already live in the shared dictionary (`marketing.privacy`,
 * `marketing.terms`) — the same JSON the web renders — so they are typeset
 * natively, work offline, follow the app's font and the live locale switch,
 * and never show a browser chrome to an App Store reviewer. "Open on the web"
 * stays as an escape hatch to the canonical URL.
 *
 * This route sits outside both `(app)` and `(public)` in the root stack, so it
 * is reachable from the signup consent footer before login and from Settings →
 * About after.
 */
const DOCS = ["privacy", "terms"] as const;
type LegalDoc = (typeof DOCS)[number];

const WEB_ORIGIN = "https://thestoro.com";

function isLegalDoc(v: unknown): v is LegalDoc {
  return typeof v === "string" && (DOCS as readonly string[]).includes(v);
}

/**
 * `?from=` names the screen that pushed us so the back link can carry the
 * parent's title like every other sub-screen ("‹ About", "‹ Create account").
 * A route key, not a translated label: params outlive a live locale switch,
 * the label is resolved at render.
 */
const FROM_LABEL_KEY = {
  about: "mobile.settings.about",
  signup: "common.createAccount",
} as const;
type LegalFrom = keyof typeof FROM_LABEL_KEY;

function isLegalFrom(v: unknown): v is LegalFrom {
  return typeof v === "string" && v in FROM_LABEL_KEY;
}

/** The dictionary bakes "1. " into each clause title; the TOC sets the index in its own column. */
function untitled(title: string): string {
  return title.replace(/^\s*\d+\s*[.)]\s*/, "");
}

/**
 * Splits a body paragraph into display lines. The dictionary bodies are single
 * strings; enumerations inside them are written "(a) …, (b) …" or "1. …".
 * Long bodies read better as one justified paragraph than as forced list
 * items, so only explicit newlines break — the text stays faithful to the web.
 */
function paragraphs(body: string): string[] {
  return body
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function LegalScreen() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ doc?: string | string[]; from?: string | string[] }>();
  const raw = Array.isArray(params.doc) ? params.doc[0] : params.doc;
  const from = Array.isArray(params.from) ? params.from[0] : params.from;
  const locale = useLocale((s) => s.locale);
  const rtl = locale === "ar";
  const parentLabel = isLegalFrom(from) ? t(FROM_LABEL_KEY[from]) : t("app.common.back");
  const [openError, setOpenError] = useState<string | null>(null);

  // Table of contents → clause. Each section reports its y inside the scroll
  // content on layout; a TOC tap scrolls there, leaving a little air above the
  // heading. Refs, not state: layouts arrive 12× per render and nothing needs
  // to re-render when they do.
  const scrollRef = useRef<ScrollView>(null);
  const sectionY = useRef<number[]>([]);
  const onSectionLayout = useCallback(
    (i: number) => (e: LayoutChangeEvent) => {
      sectionY.current[i] = e.nativeEvent.layout.y;
    },
    [],
  );
  const jumpTo = useCallback((i: number) => {
    const y = sectionY.current[i];
    if (y === undefined) return;
    scrollRef.current?.scrollTo({ y: Math.max(0, y - spacing.md), animated: true });
  }, []);

  // With nothing to pop (cold-start deep link, the locale re-key) the link
  // lands on the screen that links here: About signed in, Login signed out.
  const signedIn = useSession((s) => s.status) === "signedIn";
  const fallback = legalParent(from, signedIn);

  const doc = isLegalDoc(raw) ? raw : null;

  const openOnWeb = useCallback(async () => {
    if (!doc) return;
    setOpenError(null);
    try {
      await WebBrowser.openBrowserAsync(`${WEB_ORIGIN}/${locale}/${doc}`, {
        presentationStyle: WebBrowser.WebBrowserPresentationStyle.PAGE_SHEET,
        dismissButtonStyle: "close",
        readerMode: false,
      });
    } catch {
      setOpenError(t("mobile.legal.openFailed"));
    }
  }, [doc, locale]);

  if (!doc) {
    return (
      <View style={styles.root}>
        <View style={[styles.header, { paddingTop: insets.top + spacing.md }]}>
          <BackLink label={parentLabel} fallback={fallback} />
        </View>
        <View style={styles.notFound}>
          <EmptyState
            title={t("mobile.legal.notFoundTitle")}
            hint={t("mobile.legal.notFoundHint")}
          />
        </View>
      </View>
    );
  }

  // Typed access to the whole document — `t()` is string-only and the
  // sections are an array of { title, body }.
  const dict = dictionaries[locale].marketing[doc];
  const sections = dict.sections as ReadonlyArray<{ title: string; body: string }>;

  return (
    <View style={styles.root}>
      <ScrollView
        ref={scrollRef}
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.md, paddingBottom: insets.bottom + spacing.xxl * 2 },
        ]}
      >
        <View style={styles.header}>
          <BackLink label={parentLabel} fallback={fallback} />
          {/* Tracking + uppercase only in English: letterSpacing pulls Arabic's joins apart. */}
          <Text style={[styles.eyebrow, !rtl && styles.tracked]}>{dict.eyebrow}</Text>
          <Text style={styles.title} accessibilityRole="header">
            {dict.title}
          </Text>
          <Text style={styles.lead}>{dict.lead}</Text>
        </View>

        <View style={styles.rule} />

        {/* Table of contents — 12 numbered clauses each; a reviewer or a
            merchant checking one clause should not have to scroll blind, so
            every row is a full-height button that jumps to its clause. */}
        <View style={styles.toc} accessibilityRole="list">
          <Text style={[styles.tocHeading, !rtl && styles.tracked]} accessibilityRole="header">
            {t("mobile.legal.contents")}
          </Text>
          {sections.map((s, i) => (
            <Pressable
              key={i}
              accessibilityRole="button"
              accessibilityLabel={s.title}
              accessibilityHint={t("mobile.legal.tocHint")}
              onPress={() => jumpTo(i)}
              style={({ pressed }) => [styles.tocRow, pressed && styles.tocRowPressed]}
            >
              <Text style={[styles.tocIndex, { writingDirection: rtl ? "rtl" : "ltr" }]}>{i + 1}.</Text>
              <Text style={styles.tocItem} numberOfLines={1}>
                {untitled(s.title)}
              </Text>
              <ChevronForward size={14} color={colors.textSecondary} />
            </Pressable>
          ))}
        </View>

        <View style={styles.rule} />

        {sections.map((s, i) => (
          <View key={i} style={styles.section} onLayout={onSectionLayout(i)}>
            <Text style={styles.sectionTitle} accessibilityRole="header">
              {s.title}
            </Text>
            {paragraphs(s.body).map((p, j) => (
              <Text key={j} style={styles.body}>
                {p}
              </Text>
            ))}
          </View>
        ))}

        <View style={styles.rule} />

        <Pressable
          accessibilityRole="link"
          accessibilityLabel={t("mobile.legal.openOnWeb")}
          accessibilityHint={t("mobile.legal.openOnWebSub")}
          onPress={() => void openOnWeb()}
          style={({ pressed }) => [styles.webRow, pressed && styles.webRowPressed]}
        >
          <View style={styles.webIcon}>
            <ArrowSquareOut size={20} color={colors.accent} />
          </View>
          <View style={styles.webText}>
            <Text style={styles.webTitle}>{t("mobile.legal.openOnWeb")}</Text>
            <Text style={styles.webSub} numberOfLines={2}>
              {t("mobile.legal.openOnWebSub")}
            </Text>
          </View>
          <ChevronForward size={16} color={colors.textSecondary} />
        </Pressable>
        {openError ? (
          <Text style={styles.openError} accessibilityLiveRegion="polite">
            {openError}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, ...RTL },
  scroll: { flex: 1 },
  content: { paddingHorizontal: spacing.lg, gap: spacing.lg },

  header: { gap: spacing.xs, paddingHorizontal: 0 },
  eyebrow: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: colors.accent,
    marginTop: spacing.sm,
    ...RTL_TEXT,
  },
  // No lineHeight: Cairo's marks (the hamza on أنت) sit above a 34pt line at
  // 26pt and were clipped; the natural line, like the home greeting, fits them.
  title: { fontFamily: fonts.bold, fontSize: 26, color: colors.text, ...RTL_TEXT },
  lead: { fontFamily: fonts.regular, fontSize: 14, lineHeight: 22, color: colors.textSecondary, ...RTL_TEXT },

  rule: { height: 1, backgroundColor: colors.border },

  toc: { gap: 2 },
  tocHeading: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    color: colors.textSecondary,
    marginBottom: spacing.xs,
    ...RTL_TEXT,
  },
  tracked: { textTransform: "uppercase", letterSpacing: 0.6 },
  tocRow: {
    marginHorizontal: -spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: MIN_TOUCH,
    paddingHorizontal: spacing.sm,
    borderRadius: radius.md,
  },
  tocRowPressed: { backgroundColor: colors.neutralTint },
  // Index in its own column, END-aligned ("right" = end under the Fabric swap)
  // so "1." and "12." share a dot edge and the titles start flush.
  tocIndex: { minWidth: 24, fontFamily: fonts.medium, fontSize: 13, lineHeight: 20, color: colors.textSecondary, textAlign: "right" },
  tocItem: { flex: 1, fontFamily: fonts.medium, fontSize: 13, lineHeight: 20, color: colors.text, ...RTL_TEXT },

  section: { gap: spacing.sm },
  sectionTitle: { fontFamily: fonts.bold, fontSize: 17, lineHeight: 28, color: colors.text, ...RTL_TEXT },
  body: { fontFamily: fonts.regular, fontSize: 15, lineHeight: 26, color: colors.text, ...RTL_TEXT },

  webRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    minHeight: MIN_TOUCH + 12,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  webRowPressed: { backgroundColor: colors.neutralTint },
  webIcon: {
    width: 36,
    height: 36,
    borderRadius: radius.md,
    backgroundColor: colors.accentLight,
    alignItems: "center",
    justifyContent: "center",
  },
  webText: { flex: 1, gap: 2 },
  webTitle: { fontFamily: fonts.semibold, fontSize: 15, color: colors.text, ...RTL_TEXT },
  webSub: { fontFamily: fonts.regular, fontSize: 12, lineHeight: 18, color: colors.textSecondary, ...RTL_TEXT },
  openError: { fontFamily: fonts.regular, fontSize: 13, color: colors.danger, ...RTL_TEXT },

  notFound: { flex: 1, justifyContent: "center", paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl * 3 },
});
