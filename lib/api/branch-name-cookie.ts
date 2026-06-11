import type { NextResponse } from "next/server";

/**
 * Non-HttpOnly companion cookie carrying the active branch's display name.
 *
 * The HttpOnly `mg.branch` cookie (in branch-context.ts) is the security
 * source of truth — it carries the branch UUID and the server always
 * validates it against the user's accessible-branch list. This cookie is
 * a UI hint *only*: it lets the SSR layer render the correct branch
 * heading on the very first paint without doing a DB lookup, eliminating
 * the "متجري → elhenawystore → Elhenawy Stores → Main" flicker that
 * happens when the active branch lives only in client-side state.
 *
 * If a user tampers with this cookie they only mis-label their own
 * sidebar heading — every privileged read still authenticates via the
 * HttpOnly cookie, so there's no security surface here.
 */
export const BRANCH_NAME_COOKIE = "mg.branch_name";

const ONE_YEAR_SEC = 60 * 60 * 24 * 365;

/** Write the branch name into the response so subsequent renders see it.
 *  Pass `null` to clear (sign-out / branch deletion / 401). */
export function setBranchNameCookie(
  res: NextResponse,
  name: string | null,
): void {
  if (name === null) {
    res.cookies.set(BRANCH_NAME_COOKIE, "", {
      path: "/",
      maxAge: 0,
      sameSite: "lax",
      // NOT HttpOnly on purpose — see file header.
    });
    return;
  }
  res.cookies.set(BRANCH_NAME_COOKIE, name, {
    path: "/",
    maxAge: ONE_YEAR_SEC,
    sameSite: "lax",
    // NOT HttpOnly on purpose — see file header.
  });
}
