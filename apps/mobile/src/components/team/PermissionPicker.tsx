import { StyleSheet, Text, View } from "react-native";

import { t } from "@/i18n";
import { ToggleRow } from "@/components/ui/ToggleRow";
import { RTL_TEXT } from "@/theme/rtl";
import { colors, fonts, spacing } from "@/theme/tokens";

/**
 * Mirrors apps/web/lib/permissions.ts PERMISSION_GROUPS + the i18n group keys
 * in usePermissionCopy.ts. Add new permissions here AND in the web catalog;
 * the server is the authority (POST /api/team zod uses ALL_PERMISSIONS), so a
 * drift here only hides the toggle — it never changes effective access.
 *
 * Exported so screens can show a permission count alongside the picker.
 */
export const PERMISSION_GROUPS = (): { title: string; permissions: string[] }[] => [
  {
    title: t("app.permissions.groups.pages"),
    permissions: [
      "view_dashboard",
      "view_inventory",
      "view_sales",
      "view_customers",
      "view_expenses",
      "view_returns",
      "view_insights",
      "view_settings",
      "view_suppliers",
      "view_purchases",
    ],
  },
  {
    title: t("app.permissions.groups.edit"),
    permissions: [
      "manage_inventory",
      "record_sales",
      "modify_sales",
      "manage_returns",
      "manage_expenses",
      "manage_catalog",
      "manage_whatsapp",
    ],
  },
  {
    title: t("app.permissions.groups.suppliersPurchases"),
    permissions: ["manage_suppliers", "manage_purchases"],
  },
  {
    title: t("app.permissions.groups.inventoryCounts"),
    permissions: ["view_inventory_counts", "manage_inventory_counts"],
  },
  {
    title: t("app.permissions.groups.tasksLeaves"),
    permissions: ["manage_tasks", "request_leave", "manage_leave"],
  },
  { title: t("app.permissions.groups.audit"), permissions: ["view_activity_log"] },
  { title: t("app.permissions.groups.attendance"), permissions: ["attendance_self_manual"] },
  { title: t("app.digestSettings.title"), permissions: ["manage_digest_settings"] },
  {
    title: t("app.permissions.groups.notifications"),
    permissions: ["receive_all_alerts"],
  },
  {
    title: t("app.permissions.groups.collections"),
    permissions: ["view_collections", "confirm_collections", "manage_collection_accounts"],
  },
];

export function permissionLabel(p: string): string {
  const label = t(`app.permissions.labels.${p}`);
  // t() echoes the path for a missing key — fall back to the raw permission.
  return label.startsWith("app.permissions.labels.") ? p : label;
}

export interface PermissionPickerProps {
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  testID?: string;
}

export function PermissionPicker({ value, onChange, disabled, testID }: PermissionPickerProps) {
  const set = new Set(value);
  const toggle = (p: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(p);
    else next.delete(p);
    onChange([...next]);
  };
  return (
    <View testID={testID}>
      {PERMISSION_GROUPS().map((g) => (
        <View key={g.title} style={styles.group}>
          <Text style={styles.groupTitle}>{g.title}</Text>
          {g.permissions.map((p) => (
            <ToggleRow
              key={p}
              label={permissionLabel(p)}
              value={set.has(p)}
              disabled={disabled}
              onValueChange={(v) => toggle(p, v)}
              testID={testID ? `${testID}-${p}` : undefined}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { marginTop: spacing.md, gap: spacing.xs },
  groupTitle: {
    fontFamily: fonts.semibold,
    fontSize: 12,
    lineHeight: 16,
    color: colors.text,
    alignSelf: "flex-start",
    ...RTL_TEXT,
  },
});
