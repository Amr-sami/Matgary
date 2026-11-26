"use client";

import { useCallback, useEffect, useState } from "react";
import { useDictionary, useLocale } from "@/components/i18n/DictionaryProvider";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Toast } from "@/components/ui/Toast";

interface AdminRow {
  id: string;
  email: string;
  displayName: string | null;
  role: "super_admin" | "ops_admin";
  disabled: boolean;
  mustRotate: boolean;
  lastLoginAt: string | null;
  lastPasswordChangeAt: string | null;
  createdAt: string;
  createdByEmail: string | null;
  isCurrent: boolean;
}

export function AdminsClient({ currentAdminId }: { currentAdminId: string }) {
  const dict = useDictionary();
  const locale = useLocale();
  const t = dict.app.admin.adminMgmt;
  const dateLocale = locale === "ar" ? "ar-EG" : "en-US";

  const [rows, setRows] = useState<AdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<AdminRow | null>(null);
  const [resetting, setResetting] = useState<AdminRow | null>(null);
  const [deleting, setDeleting] = useState<AdminRow | null>(null);
  const [tempPasswordInfo, setTempPasswordInfo] = useState<
    { email: string; password: string } | null
  >(null);
  const [toast, setToast] = useState<
    { type: "success" | "error"; message: string } | null
  >(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/admins", { cache: "no-store" });
      if (res.ok) {
        const json = (await res.json()) as { data: AdminRow[] };
        setRows(json.data);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onError = (code: string | undefined) => {
    const msg =
      (code && (t.errors as Record<string, string>)[code]) || t.toast.errorGeneric;
    setToast({ type: "error", message: msg });
  };

  const ymd = (s: string | null) =>
    s == null ? "—" : new Date(s).toLocaleString(dateLocale);
  const tooOld = (s: string | null) =>
    !!s && Date.now() - new Date(s).getTime() > 60 * 24 * 60 * 60 * 1000;

  const onPatch = async (row: AdminRow, patch: Partial<AdminRow>) => {
    const body: Record<string, unknown> = {};
    if (patch.displayName !== undefined) body.displayName = patch.displayName;
    if (patch.role !== undefined) body.role = patch.role;
    if (patch.disabled !== undefined) body.disabled = patch.disabled;
    const res = await fetch(`/api/admin/admins/${row.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      onError(j.error);
      return false;
    }
    setToast({ type: "success", message: t.toast.edited });
    await load();
    return true;
  };

  const onDelete = async (row: AdminRow) => {
    const res = await fetch(`/api/admin/admins/${row.id}`, { method: "DELETE" });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      onError(j.error);
      return false;
    }
    setToast({ type: "success", message: t.toast.deleted });
    await load();
    return true;
  };

  const onResetPassword = async (row: AdminRow) => {
    const res = await fetch(`/api/admin/admins/${row.id}/reset-password`, {
      method: "POST",
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      onError(j.error);
      return false;
    }
    const json = (await res.json()) as { tempPassword: string };
    setTempPasswordInfo({ email: row.email, password: json.tempPassword });
    setToast({ type: "success", message: t.toast.passwordReset });
    await load();
    return true;
  };

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t.title}</h1>
          <p className="text-sm text-text-secondary mt-1">{t.subtitle}</p>
        </div>
        <Button onClick={() => setAddOpen(true)}>{t.addCta}</Button>
      </header>

      {loading ? (
        <p className="text-sm text-text-secondary text-center py-8">…</p>
      ) : (
        <div className="bg-white rounded-2xl border border-border overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-bg-main/40 text-xs text-text-secondary">
                <tr>
                  <th className="text-start font-medium px-3 py-2">{t.columns.email}</th>
                  <th className="text-start font-medium px-3 py-2">{t.columns.name}</th>
                  <th className="text-start font-medium px-3 py-2">{t.columns.role}</th>
                  <th className="text-start font-medium px-3 py-2">{t.columns.status}</th>
                  <th className="text-start font-medium px-3 py-2">{t.columns.lastLogin}</th>
                  <th className="text-start font-medium px-3 py-2">
                    {t.columns.lastPasswordChange}
                  </th>
                  <th className="text-start font-medium px-3 py-2">{t.columns.createdBy}</th>
                  <th className="text-end font-medium px-3 py-2">{t.columns.actions}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-border hover:bg-bg-main/30">
                    <td className="px-3 py-2" dir="ltr">
                      {r.email}{" "}
                      {r.isCurrent && (
                        <span className="text-[10px] text-accent ms-1">
                          ({t.youBadge})
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2" dir="auto">
                      {r.displayName ?? "—"}
                      {r.mustRotate && (
                        <span className="block text-[10px] text-orange-700 mt-0.5">
                          ⚠ {t.mustRotateBadge}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                          r.role === "super_admin"
                            ? "bg-accent-light text-accent"
                            : "bg-bg-main text-text-secondary"
                        }`}
                      >
                        {(t.roles as Record<string, string>)[r.role]}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                          r.disabled
                            ? "bg-danger-light text-danger"
                            : "bg-success-light text-success"
                        }`}
                      >
                        {r.disabled ? t.statusDisabled : t.statusActive}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-text-secondary">
                      {ymd(r.lastLoginAt)}
                    </td>
                    <td
                      className={`px-3 py-2 text-xs ${
                        tooOld(r.lastPasswordChangeAt) ? "text-orange-700" : "text-text-secondary"
                      }`}
                    >
                      {ymd(r.lastPasswordChangeAt)}
                    </td>
                    <td className="px-3 py-2 text-xs text-text-secondary" dir="ltr">
                      {r.createdByEmail ?? "bootstrap"}
                    </td>
                    <td className="px-3 py-2 text-end space-x-1 rtl:space-x-reverse">
                      <button
                        type="button"
                        onClick={() => setEditing(r)}
                        className="text-xs text-text-secondary hover:text-accent"
                      >
                        {t.rowActions.edit}
                      </button>
                      <span className="text-text-secondary">·</span>
                      <button
                        type="button"
                        onClick={() => setResetting(r)}
                        disabled={r.isCurrent}
                        className="text-xs text-text-secondary hover:text-accent disabled:opacity-40"
                      >
                        {t.rowActions.resetPassword}
                      </button>
                      <span className="text-text-secondary">·</span>
                      <button
                        type="button"
                        onClick={() =>
                          onPatch(r, { disabled: !r.disabled })
                        }
                        disabled={r.isCurrent}
                        className="text-xs text-text-secondary hover:text-accent disabled:opacity-40"
                      >
                        {r.disabled ? t.rowActions.enable : t.rowActions.disable}
                      </button>
                      <span className="text-text-secondary">·</span>
                      <button
                        type="button"
                        onClick={() => setDeleting(r)}
                        disabled={r.isCurrent}
                        className="text-xs text-text-secondary hover:text-danger disabled:opacity-40"
                      >
                        {t.rowActions.delete}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <AddAdminModal
        isOpen={addOpen}
        t={t}
        onClose={() => setAddOpen(false)}
        onSuccess={async ({ email, tempPassword }) => {
          setAddOpen(false);
          setTempPasswordInfo({ email, password: tempPassword });
          setToast({ type: "success", message: t.toast.added });
          await load();
        }}
        onError={onError}
      />

      <EditAdminModal
        row={editing}
        currentAdminId={currentAdminId}
        t={t}
        onClose={() => setEditing(null)}
        onSubmit={async (patch) => {
          if (!editing) return;
          const ok = await onPatch(editing, patch);
          if (ok) setEditing(null);
        }}
      />

      <Modal
        isOpen={!!resetting}
        onClose={() => setResetting(null)}
        title={t.resetConfirm.title}
      >
        {resetting && (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              {t.resetConfirm.intro.replace("{email}", resetting.email)}
            </p>
            <div className="flex gap-2 justify-end pt-2 border-t border-border">
              <Button variant="secondary" onClick={() => setResetting(null)}>
                {t.resetConfirm.cancel}
              </Button>
              <Button
                onClick={async () => {
                  const ok = await onResetPassword(resetting);
                  if (ok) setResetting(null);
                }}
              >
                {t.resetConfirm.submit}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={!!deleting}
        onClose={() => setDeleting(null)}
        title={t.deleteConfirm.title}
      >
        {deleting && (
          <div className="space-y-3">
            <p className="text-sm text-text-secondary">
              {t.deleteConfirm.intro.replace("{email}", deleting.email)}
            </p>
            <div className="flex gap-2 justify-end pt-2 border-t border-border">
              <Button variant="secondary" onClick={() => setDeleting(null)}>
                {t.deleteConfirm.cancel}
              </Button>
              <Button
                variant="danger"
                onClick={async () => {
                  const ok = await onDelete(deleting);
                  if (ok) setDeleting(null);
                }}
              >
                {t.deleteConfirm.submit}
              </Button>
            </div>
          </div>
        )}
      </Modal>

      <TempPasswordModal
        info={tempPasswordInfo}
        t={t}
        onClose={() => setTempPasswordInfo(null)}
      />

      {toast && (
        <Toast type={toast.type} message={toast.message} onClose={() => setToast(null)} />
      )}
    </div>
  );
}

interface AdminMgmtT {
  roles: { super_admin: string; ops_admin: string };
  addModal: {
    title: string;
    intro: string;
    emailLabel: string;
    nameLabel: string;
    roleLabel: string;
    submit: string;
    cancel: string;
  };
  editModal: {
    title: string;
    intro: string;
    nameLabel: string;
    roleLabel: string;
    disabledLabel: string;
    submit: string;
    cancel: string;
  };
  tempPasswordModal: {
    title: string;
    intro: string;
    copy: string;
    copied: string;
    done: string;
  };
}

function AddAdminModal({
  isOpen,
  t,
  onClose,
  onSuccess,
  onError,
}: {
  isOpen: boolean;
  t: AdminMgmtT;
  onClose: () => void;
  onSuccess: (r: { email: string; tempPassword: string }) => void;
  onError: (code: string | undefined) => void;
}) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<"super_admin" | "ops_admin">("ops_admin");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    setSubmitting(true);
    try {
      const res = await fetch("/api/admin/admins", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          displayName: displayName.trim(),
          role,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        onError(j.error);
        return;
      }
      const json = (await res.json()) as { tempPassword: string };
      onSuccess({ email: email.trim().toLowerCase(), tempPassword: json.tempPassword });
      setEmail("");
      setDisplayName("");
      setRole("ops_admin");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={t.addModal.title}>
      <div className="space-y-3">
        <p className="text-sm text-text-secondary">{t.addModal.intro}</p>
        <Field label={t.addModal.emailLabel}>
          <input
            type="email"
            dir="ltr"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </Field>
        <Field label={t.addModal.nameLabel}>
          <input
            type="text"
            dir="auto"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </Field>
        <Field label={t.addModal.roleLabel}>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "super_admin" | "ops_admin")}
            className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          >
            <option value="ops_admin">{t.roles.ops_admin}</option>
            <option value="super_admin">{t.roles.super_admin}</option>
          </select>
        </Field>
        <div className="flex gap-2 justify-end pt-2 border-t border-border">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {t.addModal.cancel}
          </Button>
          <Button onClick={submit} loading={submitting}>
            {t.addModal.submit}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function EditAdminModal({
  row,
  currentAdminId,
  t,
  onClose,
  onSubmit,
}: {
  row: AdminRow | null;
  currentAdminId: string;
  t: AdminMgmtT;
  onClose: () => void;
  onSubmit: (patch: Partial<AdminRow>) => Promise<void> | void;
}) {
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<"super_admin" | "ops_admin">("ops_admin");
  const [disabled, setDisabled] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!row) return;
    setDisplayName(row.displayName ?? "");
    setRole(row.role);
    setDisabled(row.disabled);
  }, [row]);

  if (!row) return null;

  const isSelf = row.id === currentAdminId;
  const submit = async () => {
    setSubmitting(true);
    try {
      const patch: Partial<AdminRow> = {};
      if (displayName !== (row.displayName ?? "")) patch.displayName = displayName.trim();
      if (!isSelf && role !== row.role) patch.role = role;
      if (!isSelf && disabled !== row.disabled) patch.disabled = disabled;
      await onSubmit(patch);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal isOpen={!!row} onClose={onClose} title={t.editModal.title}>
      <div className="space-y-3">
        <p className="text-sm text-text-secondary">{t.editModal.intro}</p>
        <Field label={t.editModal.nameLabel}>
          <input
            type="text"
            dir="auto"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
          />
        </Field>
        <Field label={t.editModal.roleLabel}>
          <select
            value={role}
            disabled={isSelf}
            onChange={(e) => setRole(e.target.value as "super_admin" | "ops_admin")}
            className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
          >
            <option value="ops_admin">{t.roles.ops_admin}</option>
            <option value="super_admin">{t.roles.super_admin}</option>
          </select>
        </Field>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            disabled={isSelf}
            checked={disabled}
            onChange={(e) => setDisabled(e.target.checked)}
          />
          <span>{t.editModal.disabledLabel}</span>
        </label>
        <div className="flex gap-2 justify-end pt-2 border-t border-border">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            {t.editModal.cancel}
          </Button>
          <Button onClick={submit} loading={submitting}>
            {t.editModal.submit}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function TempPasswordModal({
  info,
  t,
  onClose,
}: {
  info: { email: string; password: string } | null;
  t: AdminMgmtT;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (!info) return null;
  return (
    <Modal isOpen={!!info} onClose={onClose} title={t.tempPasswordModal.title}>
      <div className="space-y-3">
        <p className="text-sm text-text-secondary" dir="auto">
          {t.tempPasswordModal.intro.replace("{email}", info.email)}
        </p>
        <div className="flex items-center gap-2">
          <code
            dir="ltr"
            className="flex-1 font-mono text-base bg-bg-main/50 rounded-lg px-3 py-2 select-all"
          >
            {info.password}
          </code>
          <Button
            variant="secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(info.password);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              } catch {
                /* clipboard blocked — user can still select */
              }
            }}
          >
            {copied ? t.tempPasswordModal.copied : t.tempPasswordModal.copy}
          </Button>
        </div>
        <div className="flex justify-end pt-2 border-t border-border">
          <Button onClick={onClose}>{t.tempPasswordModal.done}</Button>
        </div>
      </div>
    </Modal>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium text-text-secondary mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}
