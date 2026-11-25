import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  I18nManager,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useMutation } from "@tanstack/react-query";

import { ai, ApiError } from "@matgary/api-client";

import { api } from "@/api/client";
import { t } from "@/i18n";
import { groupDigits, money } from "@/lib/format";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, radius, spacing } from "@/theme/tokens";

/**
 * F11 — EditableImportPreviewBubble.
 *
 * Full editable import workspace in chat. Every row from the uploaded file
 * is shown in a horizontally + vertically scrollable table with inline
 * editable cells. Edits go to /api/ai/import/update-row, which revalidates
 * the row server-side, recomputes the session counts, and returns a fresh
 * block. We replace the whole snapshot on every successful write so the UI
 * mirrors the server's authoritative state.
 *
 * NOT a parallel import system — reuses the existing ai_import_sessions
 * tables, adapter.validateAndResolve, permission gates, and F5 HMAC
 * confirmation.
 *
 * SAFETY:
 *   • The server owns validation. Client-side we only coerce the typed cell
 *     string for display + payload.
 *   • Row IDs come from ai_import_rows.id; client cannot forge them to
 *     touch another tenant's session (API re-checks tenant + user).
 *
 * UX:
 *   • Horizontal ScrollView wraps the table so wide schemas scroll left/right.
 *   • Inner vertical ScrollView bounds the table height so the chat stays
 *     scrollable above it.
 *   • Row status chip (NEW / UPDATE / SKIP / ERROR / MISSING / AMBIGUOUS).
 *   • Per-row saving indicator while the PATCH is in flight.
 *   • Edit field style becomes red when server flags the row invalid.
 *   • RTL support via I18nManager.isRTL + text alignment on each cell.
 */
export function EditableImportPreviewBubble({
  block: initial,
}: {
  block: ai.EditableImportPreviewBlock;
}) {
  // Server-authoritative snapshot; replaced after every successful PATCH.
  const [block, setBlock] = useState<ai.EditableImportPreviewBlock>(initial);
  const blockRef = useRef(block);
  blockRef.current = block;

  useEffect(() => {
    setBlock(initial);
  }, [initial.sessionId, initial.computedAt, initial]);

  // Per-row saving state so we can show a small spinner / "saved" tick next
  // to the row the user is editing.
  const [savingByRow, setSavingByRow] = useState<Record<number, boolean>>({});
  const [errorByRow, setErrorByRow] = useState<Record<number, string | null>>({});
  const [savedPulse, setSavedPulse] = useState<Record<number, number>>({});

  const update = useMutation({
    // Retry disabled: the endpoint is idempotent (last-write-wins per row),
    // but a retry would race the user's next keystroke's debounced write.
    // On failure we surface an inline per-row error and let the user
    // decide.
    retry: 0,
    mutationFn: (v: {
      rowIndex: number;
      fields: Record<string, string | number | null>;
    }) =>
      ai.importUpdateRow(api, {
        sessionId: blockRef.current.sessionId,
        rowIndex: v.rowIndex,
        fields: v.fields,
      }),
    onMutate: (v) => {
      setSavingByRow((s) => ({ ...s, [v.rowIndex]: true }));
      setErrorByRow((s) => ({ ...s, [v.rowIndex]: null }));
    },
    onSuccess: (resp, v) => {
      setBlock(resp.block);
      setSavingByRow((s) => ({ ...s, [v.rowIndex]: false }));
      setSavedPulse((s) => ({ ...s, [v.rowIndex]: Date.now() }));
    },
    onError: (err, v) => {
      setSavingByRow((s) => ({ ...s, [v.rowIndex]: false }));
      setErrorByRow((s) => ({
        ...s,
        [v.rowIndex]:
          err instanceof ApiError
            ? err.message
            : t("mobile.ai.import.editable.saveFailed"),
      }));
    },
  });

  // Debounced write per (row, field). Keyed by `${rowIndex}:${field}` so edits
  // to different cells don't trample each other. Latest value wins.
  const pendingRef = useRef<Map<number, Record<string, string | number | null>>>(
    new Map(),
  );
  const timerRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const queueEdit = useCallback(
    (rowIndex: number, field: string, value: string | number | null) => {
      const prev = pendingRef.current.get(rowIndex) ?? {};
      prev[field] = value;
      pendingRef.current.set(rowIndex, prev);
      const existingTimer = timerRef.current.get(rowIndex);
      if (existingTimer) clearTimeout(existingTimer);
      const timer = setTimeout(() => {
        const fields = pendingRef.current.get(rowIndex);
        if (!fields) return;
        pendingRef.current.delete(rowIndex);
        timerRef.current.delete(rowIndex);
        update.mutate({ rowIndex, fields });
      }, 450);
      timerRef.current.set(rowIndex, timer);
    },
    [update],
  );

  // Cleanup timers on unmount.
  useEffect(() => {
    const timers = timerRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
    };
  }, []);

  const rtl = I18nManager.isRTL;

  const summary = useMemo(() => summariseCounts(block), [block]);

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <Text style={styles.title}>{block.title}</Text>
        <Text style={styles.desc}>{block.description}</Text>

        <View style={styles.statRow}>
          <Stat label={t("mobile.ai.import.editable.rowStatus.new")} value={block.toCreate} tone="accent" />
          <Stat label={t("mobile.ai.import.editable.rowStatus.update")} value={block.toUpdate} tone="neutral" />
          <Stat label={t("mobile.ai.import.editable.rowStatus.skip")} value={block.toSkip} tone="muted" />
        </View>
        {summary.needsAttention > 0 ? (
          <View style={styles.statRow}>
            {block.invalid > 0 ? (
              <Stat label={t("mobile.ai.import.editable.rowStatus.invalid")} value={block.invalid} tone="danger" />
            ) : null}
            {block.missing > 0 ? (
              <Stat label={t("mobile.ai.import.editable.rowStatus.missing")} value={block.missing} tone="warn" />
            ) : null}
            {block.ambiguous > 0 ? (
              <Stat label={t("mobile.ai.import.editable.rowStatus.ambiguous")} value={block.ambiguous} tone="warn" />
            ) : null}
          </View>
        ) : null}

        <Text style={styles.editHint}>
          {t("mobile.ai.import.editable.editHint")}
        </Text>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        contentContainerStyle={styles.hScrollContent}
      >
        <View>
          {/* Header row */}
          <View style={styles.headRow}>
            <View style={[styles.statusCell, styles.headCell]}>
              <Text style={styles.headText}>#</Text>
            </View>
            {block.columns.map((col) => (
              <View
                key={col.key}
                style={[styles.headCell, { minWidth: col.minWidth ?? 120 }]}
              >
                <Text style={styles.headText}>
                  {col.label}
                  {col.required ? <Text style={styles.required}> *</Text> : null}
                </Text>
              </View>
            ))}
          </View>

          {/* Vertical scroll inside horizontal scroll — bounds the max height
              so the chat screen stays scrollable above the table. */}
          <ScrollView
            style={styles.vScroll}
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator
          >
            {block.rows.map((row, i) => (
              <EditableRow
                key={row.rowId}
                row={row}
                columns={block.columns}
                zebra={i % 2 === 1}
                rtl={rtl}
                saving={!!savingByRow[row.rowIndex]}
                savedAt={savedPulse[row.rowIndex]}
                error={errorByRow[row.rowIndex] ?? null}
                onChange={(field, value) => queueEdit(row.rowIndex, field, value)}
                currency={block.currency}
              />
            ))}
          </ScrollView>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        {block.readyToConfirm ? (
          <Text style={styles.readyLabel}>
            {t("mobile.ai.import.editable.readyToConfirm")}
          </Text>
        ) : (
          <Text style={styles.needsAttentionLabel}>
            {t("mobile.ai.import.editable.fixIssuesFirst", {
              n: summary.needsAttention,
            })}
          </Text>
        )}
      </View>
    </View>
  );
}

function summariseCounts(b: ai.EditableImportPreviewBlock) {
  return {
    needsAttention: b.invalid + b.missing + b.ambiguous,
  };
}

/* ─────────────────────────── row ──────────────────────────────────────── */

function EditableRow({
  row,
  columns,
  zebra,
  rtl,
  saving,
  savedAt,
  error,
  onChange,
  currency,
}: {
  row: ai.EditableImportRow;
  columns: ai.EditableImportColumn[];
  zebra: boolean;
  rtl: boolean;
  saving: boolean;
  savedAt?: number;
  error: string | null;
  onChange: (field: string, value: string | number | null) => void;
  currency?: string;
}) {
  const showSaved = savedAt && Date.now() - savedAt < 2000;
  const bad = row.status === "invalid" || row.status === "missing";
  const chipTone = rowStatusTone(row);
  return (
    <View style={[styles.row, zebra && styles.rowAlt, bad && styles.rowBad]}>
      <View style={styles.statusCell}>
        <View style={[styles.rowStatusChip, chipTone.chip]}>
          <Text style={[styles.rowStatusText, chipTone.text]}>
            {rowStatusLabel(row)}
          </Text>
        </View>
        <Text style={styles.rowIndexText}>
          {t("mobile.ai.import.editable.rowLabel", { n: row.rowIndex })}
        </Text>
        {saving ? (
          <View style={styles.savingBadge}>
            <ActivityIndicator size="small" color={colors.textSecondary} />
            <Text style={styles.savingText}>
              {t("mobile.ai.import.editable.saving")}
            </Text>
          </View>
        ) : showSaved ? (
          <Text style={styles.savedText}>
            {t("mobile.ai.import.editable.saved")}
          </Text>
        ) : null}
        {row.issue ? (
          <Text numberOfLines={2} style={styles.issueText}>
            {row.issue}
          </Text>
        ) : null}
        {error ? (
          <Text numberOfLines={2} style={styles.saveErrorText}>
            {error}
          </Text>
        ) : null}
      </View>
      {columns.map((col) => (
        <Cell
          key={col.key}
          col={col}
          row={row}
          rtl={rtl}
          onChange={(value) => onChange(col.key, value)}
          currency={currency}
        />
      ))}
    </View>
  );
}

function Cell({
  col,
  row,
  rtl,
  onChange,
  currency,
}: {
  col: ai.EditableImportColumn;
  row: ai.EditableImportRow;
  rtl: boolean;
  onChange: (value: string | number | null) => void;
  currency?: string;
}) {
  const initial = row.cells[col.key];
  const [draft, setDraft] = useState<string>(cellToInput(initial, col));
  // Track the last value we committed to the server so a PATCH response
  // echoing our own write doesn't clobber in-progress typing. Only re-sync
  // when the server returns something we didn't send (e.g. coerced from a
  // different field, or a revalidation flipped the value).
  const lastCommittedRef = useRef<string>(cellToInput(initial, col));
  useEffect(() => {
    const serverStr = cellToInput(initial, col);
    if (serverStr === lastCommittedRef.current) return;
    setDraft(serverStr);
    lastCommittedRef.current = serverStr;
  }, [initial, col.type]);

  const existing = row.existing?.[col.key];
  const showWas =
    row.action === "update" &&
    existing !== undefined &&
    existing !== null &&
    String(existing) !== String(initial ?? "");

  const align = rtl ? "right" : "left";

  const commit = (text: string) => {
    if (!col.editable) return;
    lastCommittedRef.current = text;
    if (text.trim() === "") {
      onChange(null);
      return;
    }
    if (col.type === "integer" || col.type === "number" || col.type === "money") {
      const n = Number(text.replace(/,/g, "."));
      if (!Number.isFinite(n)) {
        onChange(text);
        return;
      }
      onChange(col.type === "integer" ? Math.trunc(n) : n);
      return;
    }
    onChange(text);
  };

  return (
    <View style={[styles.cell, { minWidth: col.minWidth ?? 120 }]}>
      <TextInput
        value={draft}
        onChangeText={(v) => {
          setDraft(v);
          commit(v);
        }}
        editable={col.editable}
        placeholder={col.required ? "—" : ""}
        placeholderTextColor={colors.textSecondary}
        keyboardType={keyboardFor(col.type)}
        style={[
          styles.input,
          { textAlign: align, writingDirection: rtl ? "rtl" : "ltr" },
          !col.editable && styles.inputReadonly,
          row.status === "invalid" && styles.inputBad,
          row.status === "missing" && !draft && styles.inputMissing,
        ]}
      />
      {showWas ? (
        <Text numberOfLines={1} style={styles.wasText}>
          {t("mobile.ai.import.editable.wasLabel", {
            value: formatExisting(existing, col, currency),
          })}
        </Text>
      ) : null}
    </View>
  );
}

function keyboardFor(type: ai.EditableImportFieldType) {
  if (type === "integer") return "number-pad" as const;
  if (type === "money" || type === "number") return "decimal-pad" as const;
  return "default" as const;
}

function cellToInput(
  value: string | number | null,
  col: ai.EditableImportColumn,
): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    if (col.type === "integer") return String(Math.trunc(value));
    return String(value);
  }
  return String(value);
}

function formatExisting(
  value: string | number | null | undefined,
  col: ai.EditableImportColumn,
  currency?: string,
): string {
  if (value === null || value === undefined || value === "") return "—";
  if (col.type === "money") {
    const n = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(n)) return money(n);
  }
  if (col.type === "integer") {
    const n = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(n)) return groupDigits(Math.trunc(n));
  }
  void currency;
  return String(value);
}

/* ─────────────────────────── status chips ─────────────────────────────── */

function rowStatusLabel(row: ai.EditableImportRow): string {
  if (row.status === "invalid") return t("mobile.ai.import.editable.rowStatus.invalid");
  if (row.status === "missing") return t("mobile.ai.import.editable.rowStatus.missing");
  if (row.status === "ambiguous") return t("mobile.ai.import.editable.rowStatus.ambiguous");
  if (row.action === "create") return t("mobile.ai.import.editable.rowStatus.new");
  if (row.action === "update") return t("mobile.ai.import.editable.rowStatus.update");
  if (row.action === "skip") return t("mobile.ai.import.editable.rowStatus.skip");
  return t("mobile.ai.import.editable.rowStatus.valid");
}

function rowStatusTone(row: ai.EditableImportRow): {
  chip: { backgroundColor: string };
  text: { color: string };
} {
  if (row.status === "invalid")
    return { chip: { backgroundColor: colors.dangerLight }, text: { color: colors.danger } };
  if (row.status === "missing" || row.status === "ambiguous")
    return { chip: { backgroundColor: colors.warningLight }, text: { color: colors.warningStrong } };
  if (row.action === "update")
    return { chip: { backgroundColor: colors.neutralTint }, text: { color: colors.text } };
  if (row.action === "skip")
    return { chip: { backgroundColor: colors.neutralTint }, text: { color: colors.textSecondary } };
  // create / ready
  return { chip: { backgroundColor: colors.accentLight }, text: { color: colors.accent } };
}

/* ─────────────────────────── summary stat ─────────────────────────────── */

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

/* ─────────────────────────── styles ───────────────────────────────────── */

const MAX_TABLE_HEIGHT = 420;

const styles = StyleSheet.create({
  card: {
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.accent,
    gap: spacing.sm,
  },
  header: { gap: spacing.xs },
  title: { ...RTL_TEXT, fontFamily: fonts.bold, fontSize: 15, color: colors.text },
  desc: {
    ...RTL_TEXT,
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.text,
    lineHeight: 19,
  },
  editHint: {
    ...RTL_TEXT,
    fontFamily: fonts.medium,
    fontSize: 11,
    color: colors.textSecondary,
    marginTop: spacing.xs,
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
    fontSize: 16,
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

  hScrollContent: { paddingVertical: spacing.xs },
  vScroll: { maxHeight: MAX_TABLE_HEIGHT },

  headRow: {
    flexDirection: "row",
    backgroundColor: colors.neutralTint,
    borderTopLeftRadius: radius.md,
    borderTopRightRadius: radius.md,
  },
  headCell: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  headText: {
    fontFamily: fonts.bold,
    fontSize: 11,
    color: colors.textSecondary,
    textTransform: "uppercase",
  },
  required: { color: colors.danger, fontFamily: fonts.bold },

  row: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowAlt: { backgroundColor: colors.neutralTint },
  rowBad: { backgroundColor: colors.dangerLight },

  statusCell: {
    minWidth: 140,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    gap: 4,
  },
  rowStatusChip: {
    alignSelf: "flex-start",
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    borderRadius: radius.md,
  },
  rowStatusText: {
    fontFamily: fonts.bold,
    fontSize: 10,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  rowIndexText: {
    fontFamily: fonts.medium,
    fontSize: 11,
    color: colors.textSecondary,
  },
  savingBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  savingText: {
    fontFamily: fonts.regular,
    fontSize: 10,
    color: colors.textSecondary,
  },
  savedText: {
    fontFamily: fonts.medium,
    fontSize: 10,
    color: colors.successStrong,
  },
  issueText: {
    fontFamily: fonts.regular,
    fontSize: 10,
    color: colors.danger,
    ...RTL_TEXT,
  },
  saveErrorText: {
    fontFamily: fonts.regular,
    fontSize: 10,
    color: colors.danger,
  },

  cell: {
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
    justifyContent: "center",
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  input: {
    paddingHorizontal: spacing.xs,
    paddingVertical: spacing.xs,
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.text,
    minHeight: 36,
    backgroundColor: "transparent",
  },
  inputReadonly: { color: colors.textSecondary },
  inputBad: {
    borderWidth: 1,
    borderColor: colors.danger,
    borderRadius: radius.md,
  },
  inputMissing: {
    borderWidth: 1,
    borderColor: colors.warningStrong,
    borderRadius: radius.md,
  },
  wasText: {
    marginTop: 2,
    fontFamily: fonts.regular,
    fontSize: 10,
    color: colors.textSecondary,
  },

  footer: { marginTop: spacing.xs },
  readyLabel: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.successStrong,
  },
  needsAttentionLabel: {
    ...RTL_TEXT,
    fontFamily: fonts.semibold,
    fontSize: 13,
    color: colors.warningStrong,
  },
});
