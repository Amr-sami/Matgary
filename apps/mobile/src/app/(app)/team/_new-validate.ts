// Pure form validation for /team/new. Kept outside the screen file so the
// node --test harness can import it without pulling react-native or expo
// modules. Mirrors apps/web/app/api/team/route.ts createSchema (zod) and the
// username regex in apps/web/lib/repo/team.ts addTeamMember(); the server is
// still the authority — this just short-circuits a bad round-trip.
export const USERNAME_RE = /^[a-z0-9._-]{2,40}$/;

export type FieldError =
  | "usernameRequired"
  | "usernameFormat"
  | "displayNameRequired"
  | "passwordTooShort";

export interface NewMemberForm {
  username: string;
  displayName: string;
  password: string;
}

export function validateNewMember(
  form: NewMemberForm,
): Partial<Record<"username" | "displayName" | "password", FieldError>> {
  const errors: Partial<Record<"username" | "displayName" | "password", FieldError>> = {};
  const u = form.username.trim().toLowerCase();
  if (!u) errors.username = "usernameRequired";
  else if (!USERNAME_RE.test(u)) errors.username = "usernameFormat";
  if (!form.displayName.trim()) errors.displayName = "displayNameRequired";
  if (form.password.length < 8) errors.password = "passwordTooShort";
  return errors;
}
