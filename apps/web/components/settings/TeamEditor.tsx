"use client";

import { useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import {
  Plus,
  Trash2,
  KeyRound,
  Save,
  ShieldCheck,
  Copy,
  Check,
  AtSign,
  Pencil,
  Phone,
  IdentificationCard,
} from "@/lib/icons";
import { Button } from "../ui/Button";
import { PasswordInput } from "../ui/PasswordInput";
import { Modal } from "../ui/Modal";
import { EmployeeFormModal } from "./EmployeeFormModal";
import { type Permission } from "@/lib/permissions";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { usePermissionCopy } from "@/components/i18n/usePermissionCopy";

type Toast = { type: "success" | "error"; message: string };

interface Member {
  userId: string;
  loginEmail: string;
  username: string;
  displayName: string;
  role: string;
  permissions: Permission[];
  mustChangePassword: boolean;
  joinedAt: string;
  phone: string | null;
  nationalId: string | null;
  address: string | null;
  profilePhotoPath: string | null;
  idPhotoPath: string | null;
  branchId: string | null;
}

interface Props {
  onToast: (t: Toast) => void;
}

export function TeamEditor({ onToast }: Props) {
  const dict = useDictionary();
  const t = dict.app.teamAdmin;
  const { data: session, update: refreshSession } = useSession();
  const slug = session?.user?.tenantSlug ?? t.fallbackSlug;
  const isOwner = session?.user?.role === "owner";

  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [employeeModalOpen, setEmployeeModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Member | null>(null);
  const [credModal, setCredModal] = useState<{ login: string; password: string } | null>(null);
  const [resetTarget, setResetTarget] = useState<Member | null>(null);
  const [resetPassword, setResetPasswordValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Member | null>(null);
  const [editHandleOpen, setEditHandleOpen] = useState(false);
  const [draftHandle, setDraftHandle] = useState(
    slug === t.fallbackSlug ? "" : slug,
  );

  useEffect(() => {
    setDraftHandle(session?.user?.tenantSlug ?? "");
  }, [session?.user?.tenantSlug]);

  const refresh = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/team", { cache: "no-store" });
      if (!res.ok) {
        if (res.status === 403) {
          setMembers([]);
          return;
        }
        throw new Error(`HTTP ${res.status}`);
      }
      const json: { data: Member[] } = await res.json();
      setMembers(json.data);
    } catch (e) {
      onToast({ type: "error", message: e instanceof Error ? e.message : t.toast.loadFailed });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOwner) refresh();
    else setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOwner]);

  if (!isOwner) return null;

  const openAdd = () => {
    setEditTarget(null);
    setEmployeeModalOpen(true);
  };

  const openEdit = (m: Member) => {
    setEditTarget(m);
    setEmployeeModalOpen(true);
  };

  const handleEmployeeSaved = async (
    created?: { loginEmail: string; password: string },
  ) => {
    if (created) {
      onToast({ type: "success", message: t.toast.memberAdded });
      setCredModal({ login: created.loginEmail, password: created.password });
    } else {
      onToast({ type: "success", message: t.toast.edited });
    }
    await refresh();
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setBusyId(deleteTarget.userId);
    try {
      const res = await fetch(`/api/team/${deleteTarget.userId}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      onToast({ type: "success", message: t.toast.deleted });
      setDeleteTarget(null);
      await refresh();
    } catch (e) {
      onToast({ type: "error", message: e instanceof Error ? e.message : t.toast.deleteFailed });
    } finally {
      setBusyId(null);
    }
  };

  const confirmReset = async () => {
    if (!resetTarget) return;
    if (resetPassword.length < 8) {
      onToast({ type: "error", message: t.toast.shortPassword });
      return;
    }
    setBusyId(resetTarget.userId);
    try {
      const res = await fetch(`/api/team/${resetTarget.userId}/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: resetPassword }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      setCredModal({ login: resetTarget.loginEmail, password: resetPassword });
      setResetTarget(null);
      setResetPasswordValue("");
      await refresh();
    } catch (e) {
      onToast({ type: "error", message: e instanceof Error ? e.message : t.toast.resetFailed });
    } finally {
      setBusyId(null);
    }
  };

  const submitHandleRename = async () => {
    setBusyId("__handle");
    try {
      const res = await fetch("/api/account/store-handle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle: draftHandle }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      onToast({
        type: "success",
        message: t.toast.renameSuccess,
      });
      setEditHandleOpen(false);
      try {
        await refreshSession?.();
      } catch {
        // ignore
      }
      await refresh();
    } catch (e) {
      onToast({ type: "error", message: e instanceof Error ? e.message : t.toast.renameFailed });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setEditHandleOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-white text-text-secondary hover:text-accent hover:border-accent transition-colors"
          title={t.toolbar.handleTooltip}
        >
          <AtSign className="w-3.5 h-3.5" />
          <span dir="ltr" className="font-mono text-sm">{slug}</span>
          <span className="text-[10px] text-text-secondary">{t.toolbar.handleHint}</span>
        </button>
        <Button onClick={openAdd}>
          <Plus className="w-4 h-4 me-1" />
          {t.toolbar.addEmployee}
        </Button>
      </div>

      <div className="bg-white rounded-2xl border border-border overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-border bg-bg-main/40">
          <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-accent" />
            {t.list.title}
          </h2>
          {!loading && members.length > 0 && (
            <span className="text-xs text-text-secondary">
              {members.length}{" "}
              {members.length === 1 ? t.list.countOne : t.list.countMany}
            </span>
          )}
        </div>

        {loading ? (
          <div className="px-5 py-8 text-center">
            <p className="text-sm text-text-secondary">{t.list.loading}</p>
          </div>
        ) : members.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <div className="w-14 h-14 mx-auto mb-3 rounded-full bg-accent-light text-accent flex items-center justify-center">
              <ShieldCheck className="w-7 h-7" />
            </div>
            <p className="text-sm font-medium text-text-primary mb-1">
              {t.list.emptyTitle}
            </p>
            <p className="text-xs text-text-secondary mb-4 max-w-xs mx-auto">
              {t.list.emptyHint}
            </p>
            <Button size="sm" onClick={openAdd}>
              <Plus className="w-4 h-4 me-1" />
              {t.list.addFirst}
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {members.map((m) => (
              <MemberRow
                key={m.userId}
                member={m}
                busy={busyId === m.userId}
                onChange={refresh}
                onToast={onToast}
                onRemove={() => setDeleteTarget(m)}
                onResetPassword={() => {
                  setResetTarget(m);
                  setResetPasswordValue("");
                }}
                onEditDetails={() => openEdit(m)}
              />
            ))}
          </ul>
        )}
      </div>

      <EmployeeFormModal
        isOpen={employeeModalOpen}
        member={
          editTarget
            ? {
                userId: editTarget.userId,
                username: editTarget.username,
                displayName: editTarget.displayName,
                permissions: editTarget.permissions,
                phone: editTarget.phone,
                nationalId: editTarget.nationalId,
                address: editTarget.address,
                profilePhotoPath: editTarget.profilePhotoPath,
                idPhotoPath: editTarget.idPhotoPath,
                branchId: editTarget.branchId,
              }
            : null
        }
        slug={slug}
        onClose={() => setEmployeeModalOpen(false)}
        onSaved={handleEmployeeSaved}
        onToast={onToast}
      />
      <CredentialsModal
        creds={credModal}
        onClose={() => setCredModal(null)}
      />
      <ResetPasswordModal
        target={resetTarget}
        value={resetPassword}
        onChange={setResetPasswordValue}
        onConfirm={confirmReset}
        onCancel={() => {
          setResetTarget(null);
          setResetPasswordValue("");
        }}
        busy={busyId === resetTarget?.userId}
      />
      <DeleteMemberModal
        target={deleteTarget}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
        busy={busyId === deleteTarget?.userId}
      />
      <RenameHandleModal
        isOpen={editHandleOpen}
        currentSlug={slug}
        value={draftHandle}
        onChange={setDraftHandle}
        onConfirm={submitHandleRename}
        onCancel={() => {
          setEditHandleOpen(false);
          setDraftHandle(session?.user?.tenantSlug ?? "");
        }}
        busy={busyId === "__handle"}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Modals
// ─────────────────────────────────────────────────────────────────────────────

function CredentialsModal({
  creds,
  onClose,
}: {
  creds: { login: string; password: string } | null;
  onClose: () => void;
}) {
  const dict = useDictionary();
  const t = dict.app.teamAdmin.credModal;
  const [copiedField, setCopiedField] = useState<"login" | "password" | "both" | null>(null);
  const [testStatus, setTestStatus] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [testMessage, setTestMessage] = useState<string | null>(null);

  const copy = async (text: string, which: "login" | "password" | "both") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(which);
      setTimeout(() => setCopiedField(null), 1500);
    } catch {
      // ignore
    }
  };

  const testLogin = async () => {
    if (!creds) return;
    setTestStatus("testing");
    setTestMessage(null);
    try {
      const res = await fetch("/api/team/test-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: creds.login, password: creds.password }),
      });
      const json = await res.json();
      if (json.ok) {
        setTestStatus("ok");
        setTestMessage(json.message);
      } else {
        setTestStatus("fail");
        setTestMessage(json.message ?? t.verifyFail);
      }
    } catch (e) {
      setTestStatus("fail");
      setTestMessage(e instanceof Error ? e.message : t.networkError);
    }
  };

  useEffect(() => {
    if (creds) {
      setTestStatus("idle");
      setTestMessage(null);
    }
  }, [creds]);

  return (
    <Modal isOpen={!!creds} onClose={onClose} title={t.title}>
      {creds && (
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            {t.intro}
          </p>
          <CredField
            label={t.loginLabel}
            value={creds.login}
            copied={copiedField === "login"}
            onCopy={() => copy(creds.login, "login")}
          />
          <CredField
            label={t.passwordLabel}
            value={creds.password}
            copied={copiedField === "password"}
            onCopy={() => copy(creds.password, "password")}
          />

          <div className="rounded-lg border border-border p-3 space-y-2 bg-bg-main/40">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-text-primary">{t.verifyTitle}</p>
              <Button
                size="sm"
                variant="secondary"
                onClick={testLogin}
                loading={testStatus === "testing"}
              >
                {t.verifyButton}
              </Button>
            </div>
            {testStatus === "ok" && (
              <p className="text-sm text-success flex items-start gap-1.5">
                <Check className="w-4 h-4 mt-0.5 shrink-0" />
                {testMessage}
              </p>
            )}
            {testStatus === "fail" && (
              <p className="text-sm text-danger">{testMessage}</p>
            )}
            {testStatus === "idle" && (
              <p className="text-xs text-text-secondary">
                {t.verifyIdle}
              </p>
            )}
          </div>

          <div className="flex gap-2 pt-2">
            <Button
              variant="secondary"
              className="flex-1"
              onClick={() =>
                copy(`Login: ${creds.login}\nPassword: ${creds.password}`, "both")
              }
            >
              {copiedField === "both" ? (
                <>
                  <Check className="w-4 h-4 me-1" />
                  {t.copied}
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4 me-1" />
                  {t.copyBoth}
                </>
              )}
            </Button>
            <Button className="flex-1" onClick={onClose}>
              {t.done}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function CredField({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  const dict = useDictionary();
  return (
    <div>
      <label className="block text-xs text-text-secondary mb-1">{label}</label>
      <div className="flex items-center gap-2 bg-bg-main rounded-lg border border-border p-2">
        <code dir="ltr" className="flex-1 font-mono text-sm text-text-primary truncate">
          {value}
        </code>
        <button
          type="button"
          onClick={onCopy}
          className="p-1.5 rounded-md text-text-secondary hover:bg-white hover:text-accent"
          title={dict.app.teamAdmin.credModal.copy}
        >
          {copied ? (
            <Check className="w-4 h-4 text-success" />
          ) : (
            <Copy className="w-4 h-4" />
          )}
        </button>
      </div>
    </div>
  );
}

function ResetPasswordModal({
  target,
  value,
  onChange,
  onConfirm,
  onCancel,
  busy,
}: {
  target: Member | null;
  value: string;
  onChange: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const dict = useDictionary();
  const t = dict.app.teamAdmin.resetModal;
  return (
    <Modal isOpen={!!target} onClose={onCancel} title={t.title}>
      {target && (
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            {t.intro.split("{name}").map((part, i, arr) => (
              <span key={i}>
                {part}
                {i < arr.length - 1 && (
                  <span className="font-medium text-text-primary" dir="auto">
                    {target.displayName}
                  </span>
                )}
              </span>
            ))}
          </p>
          <div className="bg-bg-main rounded-lg border border-border p-2">
            <p className="text-xs text-text-secondary mb-0.5">{t.loginLabel}</p>
            <code dir="ltr" className="text-sm font-mono">{target.loginEmail}</code>
          </div>
          <PasswordInput
            label={t.newPasswordLabel}
            placeholder={t.newPasswordPlaceholder}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            autoFocus
          />
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={onCancel} disabled={busy}>
              {t.cancel}
            </Button>
            <Button
              className="flex-1"
              onClick={onConfirm}
              loading={busy}
              disabled={value.length < 8}
            >
              {t.confirm}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function DeleteMemberModal({
  target,
  onConfirm,
  onCancel,
  busy,
}: {
  target: Member | null;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const dict = useDictionary();
  const t = dict.app.teamAdmin.deleteModal;
  return (
    <Modal isOpen={!!target} onClose={onCancel} title={t.title}>
      {target && (
        <div className="space-y-4">
          <p className="text-sm text-text-primary">
            {t.intro.split("{name}").map((part, i, arr) => (
              <span key={i}>
                {part}
                {i < arr.length - 1 && (
                  <span className="font-bold" dir="auto">{target.displayName}</span>
                )}
              </span>
            ))}
          </p>
          <p className="text-xs text-text-secondary">
            {t.warning.split("{login}").map((part, i, arr) => (
              <span key={i}>
                {part}
                {i < arr.length - 1 && (
                  <code dir="ltr" className="font-mono">{target.loginEmail}</code>
                )}
              </span>
            ))}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={onCancel} disabled={busy}>
              {t.cancel}
            </Button>
            <Button variant="danger" className="flex-1" onClick={onConfirm} loading={busy}>
              {t.confirm}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function RenameHandleModal({
  isOpen,
  currentSlug,
  value,
  onChange,
  onConfirm,
  onCancel,
  busy,
}: {
  isOpen: boolean;
  currentSlug: string;
  value: string;
  onChange: (v: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  const dict = useDictionary();
  const t = dict.app.teamAdmin.renameModal;
  const valid = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(value) && value.length >= 2;
  const changed = value && value !== currentSlug;

  return (
    <Modal isOpen={isOpen} onClose={onCancel} title={t.title}>
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          {t.intro.split("{pattern}").map((part, i, arr) => (
            <span key={i}>
              {part}
              {i < arr.length - 1 && (
                <code dir="ltr" className="font-mono">username@&lt;handle&gt;</code>
              )}
            </span>
          ))}
        </p>
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1.5">
            {t.newLabel}
          </label>
          <div className="flex items-center gap-1 bg-white border border-border rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-accent">
            <span dir="ltr" className="px-3 py-2.5 text-text-secondary bg-bg-main text-sm">
              @
            </span>
            <input
              type="text"
              dir="ltr"
              value={value}
              onChange={(e) =>
                onChange(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))
              }
              placeholder="elhenawystore"
              className="flex-1 px-3 py-2.5 bg-transparent focus:outline-none text-text-primary"
              autoFocus
            />
          </div>
          <p className="mt-1 text-xs text-text-secondary">
            {t.currentLabel}{" "}
            <code dir="ltr" className="font-mono">@{currentSlug}</code>
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onCancel} disabled={busy}>
            {t.cancel}
          </Button>
          <Button
            className="flex-1"
            onClick={onConfirm}
            loading={busy}
            disabled={!valid || !changed}
          >
            {t.save}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MemberRow
// ─────────────────────────────────────────────────────────────────────────────

interface RowProps {
  member: Member;
  busy: boolean;
  onChange: () => Promise<void> | void;
  onToast: (t: Toast) => void;
  onRemove: () => void;
  onResetPassword: () => void;
  onEditDetails: () => void;
}

function MemberRow({
  member,
  busy,
  onChange,
  onToast,
  onRemove,
  onResetPassword,
  onEditDetails,
}: RowProps) {
  const dict = useDictionary();
  const t = dict.app.teamAdmin;
  const permissionCopy = usePermissionCopy();
  const [editing, setEditing] = useState(false);
  const [perms, setPerms] = useState<Permission[]>(member.permissions);

  useEffect(() => {
    setPerms(member.permissions);
  }, [member.permissions]);

  const save = async () => {
    try {
      const res = await fetch(`/api/team/${member.userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: perms }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      onToast({ type: "success", message: t.toast.savePermsSuccess });
      setEditing(false);
      await onChange();
    } catch (e) {
      onToast({ type: "error", message: e instanceof Error ? e.message : t.toast.saveFailed });
    }
  };

  const isOwnerRow = member.role === "owner";
  const monogram = (member.displayName || member.username || "?").trim()[0]?.toUpperCase() ?? "?";

  return (
    <li className="px-5 py-3.5 hover:bg-bg-main/60 transition-colors">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1 flex items-center gap-3">
          <div
            className={`w-11 h-11 rounded-full flex items-center justify-center font-semibold text-sm shrink-0 overflow-hidden ring-2 ring-white ${
              isOwnerRow ? "bg-accent text-white" : "bg-accent-light text-accent"
            }`}
          >
            {member.profilePhotoPath ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={`/api/uploads/team/${member.profilePhotoPath.replace(/^\/+/, "")}`}
                alt=""
                className="w-full h-full object-cover"
              />
            ) : (
              <span aria-hidden>{monogram}</span>
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-medium text-text-primary truncate" dir="auto">{member.displayName}</span>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                  isOwnerRow
                    ? "bg-accent-light text-accent"
                    : "bg-gray-100 text-text-secondary"
                }`}
              >
                {isOwnerRow ? t.role.owner : t.role.staff}
              </span>
              {member.mustChangePassword && !isOwnerRow && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-50 text-orange-700">
                  {t.role.mustChange}
                </span>
              )}
            </div>
            <p className="text-xs text-text-secondary font-mono mt-0.5 truncate" dir="ltr">
              {member.loginEmail}
            </p>
            {(member.phone || member.nationalId) && (
              <p className="text-[11px] text-text-secondary mt-1 truncate flex items-center gap-2.5">
                {member.phone && (
                  <span dir="ltr" className="inline-flex items-center gap-1">
                    <Phone className="w-3 h-3" />
                    {member.phone}
                  </span>
                )}
                {member.nationalId && (
                  <span dir="ltr" className="inline-flex items-center gap-1 font-mono">
                    <IdentificationCard className="w-3 h-3" />
                    {member.nationalId}
                  </span>
                )}
              </p>
            )}
          </div>
        </div>
        {!isOwnerRow && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={onEditDetails}
              disabled={busy}
              className="hidden sm:inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium text-text-secondary hover:bg-white hover:text-accent border border-transparent hover:border-border disabled:opacity-50 transition-colors"
              title={t.row.editDetailsTitle}
            >
              <Pencil className="w-3.5 h-3.5" />
              {t.row.edit}
            </button>
            <button
              type="button"
              onClick={onEditDetails}
              disabled={busy}
              className="sm:hidden p-2 rounded-md text-text-secondary hover:bg-white hover:text-accent disabled:opacity-50"
              title={t.row.editDetailsTitle}
            >
              <Pencil className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              disabled={busy}
              className="hidden md:inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-medium text-accent hover:bg-accent-light disabled:opacity-50 transition-colors"
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              {editing ? t.row.close : t.row.permissions}
            </button>
            <button
              type="button"
              onClick={onResetPassword}
              disabled={busy}
              className="p-2 rounded-md text-text-secondary hover:bg-white hover:text-accent disabled:opacity-50"
              title={t.row.resetPassword}
            >
              <KeyRound className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onRemove}
              disabled={busy}
              className="p-2 rounded-md text-text-secondary hover:bg-danger-light hover:text-danger disabled:opacity-50"
              title={t.row.deleteTitle}
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {editing && !isOwnerRow && (
        <div className="mt-3 ms-14 rounded-xl border border-border p-4 bg-bg-main/60 space-y-3">
          {permissionCopy.groups.map((group) => (
            <div key={group.title}>
              <p className="text-xs font-medium text-text-secondary mb-1.5">{group.title}</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                {group.permissions.map((p) => (
                  <label
                    key={p}
                    className="flex items-start gap-2 text-sm rounded-md p-1.5 hover:bg-white cursor-pointer transition-colors"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 accent-accent w-4 h-4"
                      checked={perms.includes(p)}
                      onChange={() => {
                        if (perms.includes(p)) setPerms(perms.filter((x) => x !== p));
                        else setPerms([...perms, p]);
                      }}
                    />
                    <span>{permissionCopy.labels[p]}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
          <div className="flex justify-end pt-1">
            <Button size="sm" onClick={save}>
              <Save className="w-4 h-4 me-1" />
              {t.row.savePermissions}
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
