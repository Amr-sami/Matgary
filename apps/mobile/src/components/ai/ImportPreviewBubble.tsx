import { StyleSheet, Text, View } from "react-native";

import type { ai } from "@matgary/api-client";

import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * ImportPreviewBubble — F10.1 import preview summary.
 *
 * Numbers come from server-validated state (ai_import_sessions +
 * ai_import_rows); mobile only renders. Pair this with the accompanying
 * ConfirmationBubble (emitted in the same turn) so the user confirms the
 * exact previewed operation.
 */
export function ImportPreviewBubble({ block }: { block: ai.ImportPreviewBlock }) {
  return (
    <View style={styles.card}>
      <Text style={styles.title}>{block.title}</Text>
      <Text style={styles.description}>{block.description}</Text>

      <View style={styles.statRow}>
        <Stat label="New" value={block.toCreate} tone="accent" />
        <Stat label="Update" value={block.toUpdate} tone="neutral" />
        <Stat label="Skip" value={block.toSkip} tone="muted" />
      </View>
      {block.invalid + block.missing + block.ambiguous > 0 ? (
        <View style={styles.statRow}>
          {block.invalid > 0 ? <Stat label="Invalid" value={block.invalid} tone="danger" /> : null}
          {block.missing > 0 ? <Stat label="Missing" value={block.missing} tone="warn" /> : null}
          {block.ambiguous > 0 ? <Stat label="Ambiguous" value={block.ambiguous} tone="warn" /> : null}
        </View>
      ) : null}

      {block.sampleCreate.length > 0 ? (
        <SampleSection title="Create" rows={block.sampleCreate} />
      ) : null}
      {block.sampleUpdate.length > 0 ? (
        <SampleSection title="Update" rows={block.sampleUpdate} />
      ) : null}
      {block.sampleIssues.length > 0 ? (
        <View style={styles.issuesWrap}>
          {block.sampleIssues.map((it) => (
            <Text key={it.rowIndex} style={styles.issue}>
              Row {it.rowIndex}: {it.issue}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "accent" | "neutral" | "danger" | "warn" | "muted";
}) {
  const toneStyle =
    tone === "accent"
      ? styles.toneAccent
      : tone === "danger"
        ? styles.toneDanger
        : tone === "warn"
          ? styles.toneWarn
          : tone === "muted"
            ? styles.toneMuted
            : styles.toneNeutral;
  return (
    <View style={[styles.stat, toneStyle]}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function SampleSection({ title, rows }: { title: string; rows: ai.ImportPreviewRowSummary[] }) {
  return (
    <View style={styles.sampleWrap}>
      <Text style={styles.sampleTitle}>{title}</Text>
      {rows.map((r) => (
        <View key={`${title}-${r.rowIndex}`} style={styles.sampleRow}>
          <Text numberOfLines={1} style={styles.sampleName}>
            {r.entityLabel}
          </Text>
          {r.changes ? (
            <Text numberOfLines={1} style={styles.sampleChanges}>
              {Object.entries(r.changes)
                .map(([f, c]) => `${f}: ${c.before ?? "—"} → ${c.after ?? "—"}`)
                .join(" · ")}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.accent,
    gap: spacing.sm,
  },
  title: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 15, color: colors.text },
  description: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.text,
    lineHeight: 19,
  },
  statRow: { flexDirection: "row", gap: spacing.xs, marginTop: spacing.xs },
  stat: {
    flex: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.md,
    alignItems: "center",
    gap: 2,
  },
  statValue: {
    ...RTL_TEXT,
    fontFamily: fonts.bold,
    fontSize: 18,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
  statLabel: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 10,
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  toneAccent: { backgroundColor: colors.accentLight },
  toneNeutral: { backgroundColor: colors.neutralTint },
  toneMuted: { backgroundColor: colors.neutralTint, opacity: 0.6 },
  toneDanger: { backgroundColor: colors.dangerLight },
  toneWarn: { backgroundColor: colors.warningLight },
  sampleWrap: {
    marginTop: spacing.xs,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    gap: spacing.xs,
  },
  sampleTitle: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 11,
    color: colors.textSecondary,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  sampleRow: { gap: 2 },
  sampleName: { ...RTL_TEXT, fontFamily: fonts.semibold, fontSize: 13, color: colors.text },
  sampleChanges: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.textSecondary,
    fontVariant: ["tabular-nums"],
  },
  issuesWrap: {
    marginTop: spacing.xs,
    gap: 2,
  },
  issue: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.danger,
  },
});
