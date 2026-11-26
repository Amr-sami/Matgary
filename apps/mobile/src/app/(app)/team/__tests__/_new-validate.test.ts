import { strict as assert } from "node:assert";
import { test } from "node:test";

import { USERNAME_RE, validateNewMember } from "../_new-validate";

test("USERNAME_RE accepts lowercase letters, digits and . _ -", () => {
  for (const ok of ["ab", "ahmed", "a.b_c-d", "s1", "01234567890123456789012345678901234567890"]) {
    const bounded = ok.slice(0, 40);
    assert.equal(USERNAME_RE.test(bounded), true, `expected ok: ${bounded}`);
  }
});

test("USERNAME_RE rejects uppercase, spaces, specials and out-of-range lengths", () => {
  for (const bad of ["", "a", "Ahmed", "a b", "ahmed!", "ahmed@shop", "a".repeat(41)]) {
    assert.equal(USERNAME_RE.test(bad), false, `expected bad: '${bad}'`);
  }
});

test("validateNewMember flags each missing / invalid field", () => {
  const errors = validateNewMember({ username: "", displayName: "", password: "" });
  assert.equal(errors.username, "usernameRequired");
  assert.equal(errors.displayName, "displayNameRequired");
  assert.equal(errors.password, "passwordTooShort");
});

test("validateNewMember flags a badly formatted username", () => {
  const errors = validateNewMember({ username: "Ahmed!", displayName: "A", password: "12345678" });
  assert.equal(errors.username, "usernameFormat");
});

test("validateNewMember returns no errors for a valid form", () => {
  const errors = validateNewMember({
    username: "ahmed",
    displayName: "Ahmed Mohamed",
    password: "letmein!",
  });
  assert.deepEqual(errors, {});
});

test("validateNewMember normalises username by trimming and lowercasing", () => {
  const errors = validateNewMember({
    username: "  AHMED  ",
    displayName: "A",
    password: "12345678",
  });
  // Uppercase + whitespace → trim + lowercase makes it valid.
  assert.equal(errors.username, undefined);
});
