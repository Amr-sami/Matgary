import { View } from "react-native";

import { Sheet } from "@/components/ui/Sheet";
import { t } from "@/i18n";
import { spacing } from "@/theme/tokens";

import { SheetOption } from "./ProviderSheet";

export interface BranchOption {
  id: string;
  name: string;
}

/**
 * Pick the account's branch (doc 15 spec 09 §4.4 `branch_id` row; §4.2 staff
 * rule). The owner gets "All branches" (`branchId = null`,
 * `collection-account-form-branch_id-all`) plus every branch; a staff member
 * gets only their own branch — 05 enforces the same rule server-side
 * (`FORBIDDEN_BRANCH`), the phone only mirrors it.
 */
export function BranchSheet({
  visible,
  value,
  branches,
  allowAll,
  onPick,
  onClose,
}: {
  visible: boolean;
  value: string | null;
  branches: readonly BranchOption[];
  allowAll: boolean;
  onPick: (branchId: string | null) => void;
  onClose: () => void;
}) {
  const pick = (id: string | null) => {
    onPick(id);
    onClose();
  };
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={t("app.collectionsSettings.form.fields.branch.label")}
      testID="collection-account-form-branch_id-sheet"
    >
      <View style={{ gap: spacing.sm }} accessibilityRole="radiogroup">
        {allowAll ? (
          <SheetOption
            label={t("app.collectionsSettings.form.fields.branch.all")}
            active={value == null}
            testID="collection-account-form-branch_id-all"
            onPress={() => pick(null)}
          />
        ) : null}
        {branches.map((b) => (
          <SheetOption
            key={b.id}
            label={b.name}
            active={value === b.id}
            testID={`collection-account-form-branch_id-${b.id}`}
            onPress={() => pick(b.id)}
          />
        ))}
      </View>
    </Sheet>
  );
}
