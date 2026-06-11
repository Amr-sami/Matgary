# Platform Admin — Spec 05: Admins management

Owner: Amr · Drafted: 2026-06-10 · Depends on: **Spec 01**.

`/admin/admins` for super-admins to add other admins, promote/demote
between `super_admin` and `ops_admin`, disable / re-enable, and reset
someone's password (which forces them to rotate on next login).

[master]: ./platform-admin-dashboard.md

---

## 1. Goal

- `super_admin` can list, add, edit, disable, and delete other admins.
- Adding an admin returns a one-time temporary password shown only
  once (no email integration yet).
- Cannot delete or demote the last remaining `super_admin` — 409.
- Disabled admins can't log in but are kept in `admins` so audit refs
  still resolve.
- An admin can reset another admin's password (forces rotation on
  next login).

`ops_admin` sees `/admin/admins` as 404 — same hard-404 pattern as
elsewhere.

---

## 2. Data — no new migrations

Uses the `admins` table from Spec 01. No schema changes.

---

## 3. Repo layer

`lib/admin/admins.ts`:

```ts
export async function listAdmins(): Promise<AdminListRow[]>;

export interface AddAdminInput {
  email: string;
  displayName: string;
  role: 'super_admin' | 'ops_admin';
}

export async function addAdmin(
  callerAdminId: string,
  input: AddAdminInput,
  meta: { ip: string; userAgent: string },
): Promise<{ id: string; tempPassword: string }>;

export async function patchAdmin(
  callerAdminId: string,
  targetId: string,
  patch: { displayName?: string; role?: 'super_admin' | 'ops_admin'; disabled?: boolean },
  meta: { ip: string; userAgent: string },
): Promise<void>;

export async function deleteAdmin(
  callerAdminId: string,
  targetId: string,
  meta: { ip: string; userAgent: string },
): Promise<void>;

export async function resetAdminPassword(
  callerAdminId: string,
  targetId: string,
  meta: { ip: string; userAgent: string },
): Promise<{ tempPassword: string }>;
```

Rules:

- `addAdmin` generates a temp password using a CSPRNG: 16 chars,
  uppercase + lowercase + digits (no symbols to avoid confusion when
  shared OOB). Returned ONCE; never re-fetchable.
- All mutations:
  - run as transactions with the audit row,
  - refuse self-target on `delete` / `disable` / role demote — admin
    can't lock themselves out from `/admin/admins`,
  - refuse if target is the last `super_admin` (see §4),
  - revoke all `admin_sessions` for the target on role change / disable
    / delete / password reset (so a compromised admin can be evicted
    immediately).

---

## 4. Last-super-admin guard

Centralized check used by every mutating endpoint:

```ts
async function refuseIfLastSuperAdminCheck(targetAdminId: string, desiredRole: 'super_admin' | 'ops_admin', desiredDisabled: boolean) {
  // Count enabled super_admins after the hypothetical change.
  // If < 1 → throw LAST_SUPER_ADMIN.
}
```

Used on:
- DELETE target — if target is the only super_admin → 409.
- PATCH role to `ops_admin` on target — if target is the only super_admin → 409.
- PATCH `disabled=true` on target — if target is the only super_admin → 409.

---

## 5. API surface

| Method | Path | Role | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/admin/admins` | super_admin | list all admins |
| `POST` | `/api/admin/admins` | super_admin | body `{ email, displayName, role }` → 201 `{ id, tempPassword }` |
| `PATCH` | `/api/admin/admins/[id]` | super_admin | body partial `{ displayName?, role?, disabled? }` |
| `DELETE` | `/api/admin/admins/[id]` | super_admin | hard delete; refuses self + last super_admin |
| `POST` | `/api/admin/admins/[id]/reset-password` | super_admin | returns new `tempPassword` |

All write paths produce `admin_audit_log` rows.

---

## 6. UI — `/admin/admins`

### 6.1 List table

Columns:

- Email
- Display name
- Role badge (super_admin = blue, ops_admin = neutral)
- Status (active / disabled)
- Last login (relative)
- Last password change (relative; warn-color if > 60 days)
- Created by (admin email or `bootstrap`)
- Row actions: **Reset password**, **Disable** / **Enable**,
  **Delete**, **Edit**.

`/admin/admins` is reachable only to super_admin; ops_admin gets 404.

### 6.2 Add admin modal

Fields:

- Email (`citext`, validated).
- Display name (1-80).
- Role select.

Submit → success modal:

```
Admin created.

Email:    sara@matgary.com
Temp PW:  k8mPRf2L9ZxQB7vH  [Copy]

Share this password OOB. It is not stored in plaintext and cannot be
shown again. The admin will be forced to set their own on first login.
```

Auto-dismiss on copy + 5 s.

### 6.3 Edit admin modal

Display name + role + disabled toggle. The role select is disabled
client-side when the row is the last enabled super_admin (with a hint
tooltip), and the server enforces it regardless.

### 6.4 Reset password confirmation

"This will sign out {email} from every session and force them to set a
new password on their next login. Continue?" → modal with the new temp
password, same one-time shape as Add.

### 6.5 Delete confirmation

"Delete admin {email} permanently? Their audit log entries will keep
referencing this admin id; UI will show `(deleted)` next to the name."

---

## 7. Edge cases

| Scenario | Behavior |
| --- | --- |
| Caller targets themselves on DELETE | 409 `SELF_TARGET`. |
| Caller targets themselves on role demote | 409 `SELF_TARGET`. |
| Caller targets themselves on disable | 409 `SELF_TARGET`. |
| Caller resets own password via this route | 400 `USE_ACCOUNT_PAGE`. (Account flow lives in Spec 01.) |
| Demoting the last super_admin | 409 `LAST_SUPER_ADMIN`. |
| Disabling the last super_admin | 409 `LAST_SUPER_ADMIN`. |
| Adding an admin with an existing email | 409 `EMAIL_TAKEN`. |
| Temp password leaks because the admin closed the modal | They use the **Reset password** action to issue a new one; original is irrelevant after first login. |
| Disabled admin tries to log in | 401 generic; admin_audit_log gets `auth.login.disabled_admin_attempt`. |
| Deleted admin appears in audit log filters | UI renders `(deleted #abc12)` for the actor. |

---

## 8. Test plan

### Unit
- Temp password entropy: 16 chars, mixed case + digit.
- `refuseIfLastSuperAdminCheck` matrix on every mutation path.
- Caller-self guard.

### Integration
- super_admin adds an ops_admin → returns temp pw once → second GET
  doesn't show pw.
- Logged-in temp admin → forced rotation on first action.
- Demote the only super_admin → 409.
- Promote that ops_admin → 200, now there are two super_admins → demote
  one → 200.
- Reset password → target's `admin_sessions` rows are deleted.

### Playwright
- super_admin adds an ops_admin → copies temp pw → opens incognito →
  logs in → forced rotation page → sets new pw → lands on `/admin`.
- ops_admin lands on `/admin/admins` → 404.

---

## 9. Acceptance criteria

- [ ] Temp passwords are never stored as plaintext anywhere.
- [ ] Last-super-admin guard refuses across DELETE / role demote /
      disable.
- [ ] Sessions of a target admin are revoked on role change /
      disable / delete / password reset within 1 s.
- [ ] ops_admin gets 404 on `/admin/admins` (no leak that the page
      exists for super_admins).
- [ ] All five endpoints produce audit rows.

---

## 10. Files this spec produces

```
lib/admin/admins.ts

app/api/admin/admins/route.ts
app/api/admin/admins/[id]/route.ts
app/api/admin/admins/[id]/reset-password/route.ts

app/admin/admins/page.tsx
components/admin/AdminListTable.tsx
components/admin/AddAdminModal.tsx
components/admin/EditAdminModal.tsx
components/admin/TempPasswordModal.tsx

dictionaries/ar.json + en.json                (admin.adminMgmt.*)
```
