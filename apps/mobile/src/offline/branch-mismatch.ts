/**
 * The cart route's branch-mismatch 409 (apps/web/app/api/sales/cart/route.ts)
 * carries an Arabic sentence and NO machine code, and ApiError then uses that
 * sentence as `code`. Until the route returns `{error:"BRANCH_MISMATCH"}` the
 * sync screen has to recognise the prose; this module is a dependency-free
 * leaf so __tests__/branch-mismatch.test.ts can pin the regex to the exact
 * server sentence and fail the moment a copy edit on the web side would
 * silently downgrade the row to a generic "conflict".
 */
export const BRANCH_MISMATCH_CODE = "BRANCH_MISMATCH";

export const BRANCH_MISMATCH_RE = /فرع آخر|branch/i;

export function isBranchMismatchText(text: string | null | undefined): boolean {
  return !!text && BRANCH_MISMATCH_RE.test(text);
}

/** Row-level check over whatever the engine stored (code, or kind + text). */
export function isBranchMismatchRow(row: {
  lastErrorCode: string | null;
  lastErrorText: string | null;
}): boolean {
  if (row.lastErrorCode === BRANCH_MISMATCH_CODE) return true;
  return (
    isBranchMismatchText(row.lastErrorCode) ||
    (row.lastErrorCode === "conflict" && isBranchMismatchText(row.lastErrorText))
  );
}
