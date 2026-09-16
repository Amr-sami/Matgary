"use client";

import { useMemo } from "react";
import { useDictionary } from "./DictionaryProvider";
import { type Permission } from "@/lib/permissions";

/**
 * Locale-aware version of `PERMISSION_LABELS` + `PERMISSION_GROUPS` from
 * `@/lib/permissions`. Use this hook in components that render the team-admin
 * permissions UI. The structural data (which permissions belong to which
 * group) lives here so the legacy constants in `lib/permissions.ts` can stay
 * pinned to Arabic for back-compat with anything that imports them directly.
 */
export interface PermissionGroupView {
  title: string;
  permissions: Permission[];
}

interface PermissionCopy {
  labels: Record<Permission, string>;
  groups: PermissionGroupView[];
}

const GROUPS: { titleKey: "pages" | "edit" | "suppliersPurchases" | "tasksLeaves" | "audit" | "attendance"; permissions: Permission[] }[] = [
  {
    titleKey: "pages",
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
    titleKey: "edit",
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
    titleKey: "suppliersPurchases",
    permissions: ["manage_suppliers", "manage_purchases"],
  },
  {
    titleKey: "tasksLeaves",
    permissions: ["manage_tasks", "request_leave", "manage_leave"],
  },
  {
    titleKey: "audit",
    permissions: ["view_activity_log"],
  },
  {
    titleKey: "attendance",
    permissions: ["attendance_self_manual"],
  },
];

export function usePermissionCopy(): PermissionCopy {
  const dict = useDictionary();
  const t = dict.app.permissions;
  return useMemo(
    () => ({
      labels: t.labels as Record<Permission, string>,
      groups: GROUPS.map((g) => ({
        title: t.groups[g.titleKey],
        permissions: g.permissions,
      })),
    }),
    [t],
  );
}
