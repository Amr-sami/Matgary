import { ScrollView, StyleSheet, Text, View } from "react-native";

import type { ai } from "@matgary/api-client";

import { groupDigits, money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * Data table block. Horizontally scrollable for wide schemas; up to ~15 rows
 * before the user is better off asking a narrower question. Column `format`
 * drives cell rendering (money with EGP, number with tabular-nums, percent,
 * date passthrough, text).
 */
export function TableBubble({ block }: { block: ai.TableBlock }) {
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>{block.title}</Text>
      {block.description ? <Text style={styles.desc}>{block.description}</Text> : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
      >
        <View style={styles.table}>
          <View style={styles.headRow}>
            {block.columns.map((c) => (
              <Text
                key={c.key}
                numberOfLines={1}
                style={[styles.headCell, alignStyle(c.align)]}
              >
                {c.label}
              </Text>
            ))}
          </View>
          {block.rows.map((row, i) => (
            <View key={i} style={[styles.row, i % 2 === 1 && styles.rowAlt]}>
              {block.columns.map((c) => {
                const raw = row[c.key];
                return (
                  <Text
                    key={c.key}
                    numberOfLines={1}
                    style={[styles.cell, alignStyle(c.align)]}
                  >
                    {formatCell(raw, c.format, block.currency)}
                  </Text>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

function alignStyle(a?: "start" | "end" | "center") {
  if (a === "end") return { textAlign: "right" as const };
  if (a === "center") return { textAlign: "center" as const };
  return { textAlign: "left" as const };
}

function formatCell(
  raw: string | number | null,
  format: ai.TableColumn["format"],
  _currency: string | undefined,
): string {
  if (raw === null || raw === undefined) return "—";
  if (format === "money") {
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) ? money(n) : String(raw);
  }
  if (format === "number") {
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) ? groupDigits(Math.round(n)) : String(raw);
  }
  if (format === "percent") {
    const n = typeof raw === "number" ? raw : Number(raw);
    return Number.isFinite(n) ? `${n.toFixed(1)}%` : String(raw);
  }
  return String(raw);
}

const CELL_MIN = 110;

const styles = StyleSheet.create({
  wrap: { gap: spacing.xs },
  title: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 15, color: colors.text },
  desc: { ...RTL_TEXT, fontFamily: fonts.regular, fontSize: 12, color: colors.textSecondary },
  scroll: { paddingVertical: spacing.xs },
  table: {
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
    minWidth: "100%",
  },
  headRow: {
    flexDirection: "row",
    backgroundColor: colors.neutralTint,
  },
  headCell: {
    minWidth: CELL_MIN,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    fontFamily: fonts.bold,
    fontSize: 12,
    color: colors.textSecondary,
  },
  row: {
    flexDirection: "row",
    backgroundColor: colors.card,
  },
  rowAlt: { backgroundColor: colors.neutralTint },
  cell: {
    minWidth: CELL_MIN,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.text,
    fontVariant: ["tabular-nums"],
  },
});
