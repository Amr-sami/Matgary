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
import {
  PERMISSION_GROUPS,
  PERMISSION_LABELS,
  type Permission,
} from "@/lib/permissions";

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
}

interface Props {
  onToast: (t: Toast) => void;
}

export function TeamEditor({ onToast }: Props) {
  const { data: session, update: refreshSession } = useSession();
  const slug = session?.user?.tenantSlug ?? "متجرك";
  const isOwner = session?.user?.role === "owner";

  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Modals
  const [employeeModalOpen, setEmployeeModalOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Member | null>(null);
  const [credModal, setCredModal] = useState<{ login: string; password: string } | null>(null);
  const [resetTarget, setResetTarget] = useState<Member | null>(null);
  const [resetPassword, setResetPasswordValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Member | null>(null);
  const [editHandleOpen, setEditHandleOpen] = useState(false);
  const [draftHandle, setDraftHandle] = useState(slug === "متجرك" ? "" : slug);

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
      onToast({ type: "error", message: e instanceof Error ? e.message : "تعذر التحميل" });
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
      onToast({ type: "success", message: "تم إضافة الموظف" });
      setCredModal({ login: created.loginEmail, password: created.password });
    } else {
      onToast({ type: "success", message: "تم حفظ التعديلات" });
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
      onToast({ type: "success", message: "تم الحذف" });
      setDeleteTarget(null);
      await refresh();
    } catch (e) {
      onToast({ type: "error", message: e instanceof Error ? e.message : "تعذر الحذف" });
    } finally {
      setBusyId(null);
    }
  };

  const confirmReset = async () => {
    if (!resetTarget) return;
    if (resetPassword.length < 8) {
      onToast({ type: "error", message: "كلمة السر 8 أحرف على الأقل" });
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
      // Show the new credentials so the owner can pass them to the employee.
      setCredModal({ login: resetTarget.loginEmail, password: resetPassword });
      setResetTarget(null);
      setResetPasswordValue("");
      await refresh();
    } catch (e) {
      onToast({ type: "error", message: e instanceof Error ? e.message : "تعذر التعيين" });
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
        message: "تم تغيير اسم تسجيل الدخول — أعد إخبار الموظفين بالعنوان الجديد",
      });
      setEditHandleOpen(false);
      try {
        await refreshSession?.();
      } catch {
        // ignore
      }
      await refresh();
    } catch (e) {
      onToast({ type: "error", message: e instanceof Error ? e.message : "تعذر التغيير" });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Section toolbar — outside the card so the action button reads as page-level */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setEditHandleOpen(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-white text-text-secondary hover:text-accent hover:border-accent transition-colors"
          title="تغيير اسم تسجيل الدخول للمتجر"
        >
          <AtSign className="w-3.5 h-3.5" />
          <span dir="ltr" className="font-mono text-sm">{slug}</span>
          <span className="text-[10px] text-text-secondary">— رابط دخول الموظفين</span>
        </button>
        <Button onClick={openAdd}>
          <Plus className="w-4 h-4 me-1" />
          موظف جديد
        </Button>
      </div>

      {/* List card */}
      <div className="bg-white rounded-2xl border border-border overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-5 py-3 border-b border-border bg-bg-main/40">
          <h2 className="text-sm font-semibold text-text-primary flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-accent" />
            الموظفون
          </h2>
          {!loading && members.length > 0 && (
            <span className="text-xs text-text-secondary">
              {members.length} {members.length === 1 ? "حساب" : "حسابات"}
            </span>
          )}
        </div>

        {loading ? (
          <div className="px-5 py-8 text-center">
            <p className="text-sm text-text-secondary">جاري التحميل…</p>
          </div>
        ) : members.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <div className="w-14 h-14 mx-auto mb-3 rounded-full bg-accent-light text-accent flex items-center justify-center">
              <ShieldCheck className="w-7 h-7" />
            </div>
            <p className="text-sm font-medium text-text-primary mb-1">
              لم تُضف موظفين بعد
            </p>
            <p className="text-xs text-text-secondary mb-4 max-w-xs mx-auto">
              أنشئ حساباً لكل موظف لمنحه صلاحيات الدخول للنظام وتسجيل المبيعات والحضور.
            </p>
            <Button size="sm" onClick={openAdd}>
              <Plus className="w-4 h-4 me-1" />
              إضافة أول موظف
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

      {/* Modals */}
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
        setTestMessage(json.message ?? "فشل تسجيل الدخول");
      }
    } catch (e) {
      setTestStatus("fail");
      setTestMessage(e instanceof Error ? e.message : "خطأ في الشبكة");
    }
  };

  // Reset test status when the modal opens with new creds.
  useEffect(() => {
    if (creds) {
      setTestStatus("idle");
      setTestMessage(null);
    }
  }, [creds]);

  return (
    <Modal isOpen={!!creds} onClose={onClose} title="بيانات تسجيل الدخول للموظف">
      {creds && (
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            احفظ هذه البيانات أو ابعتها للموظف الآن — لن تُعرض كلمة السر مرة أخرى.
          </p>
          <CredField
            label="اسم تسجيل الدخول"
            value={creds.login}
            copied={copiedField === "login"}
            onCopy={() => copy(creds.login, "login")}
          />
          <CredField
            label="كلمة السر"
            value={creds.password}
            copied={copiedField === "password"}
            onCopy={() => copy(creds.password, "password")}
          />

          <div className="rounded-lg border border-border p-3 space-y-2 bg-bg-main/40">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium text-text-primary">تأكد أن البيانات تعمل</p>
              <Button
                size="sm"
                variant="secondary"
                onClick={testLogin}
                loading={testStatus === "testing"}
              >
                اختبار تسجيل الدخول
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
                يجرّب البيانات على السيرفر ويخبرك ما إذا كانت ستعمل.
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
                  تم النسخ
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4 me-1" />
                  نسخ الاثنين
                </>
              )}
            </Button>
            <Button className="flex-1" onClick={onClose}>
              تم
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
          title="نسخ"
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
  return (
    <Modal isOpen={!!target} onClose={onCancel} title="إعادة تعيين كلمة السر">
      {target && (
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            سيُطلب من <span className="font-medium text-text-primary">{target.displayName}</span> تغيير
            كلمة السر فور تسجيل الدخول التالي.
          </p>
          <div className="bg-bg-main rounded-lg border border-border p-2">
            <p className="text-xs text-text-secondary mb-0.5">اسم تسجيل الدخول</p>
            <code dir="ltr" className="text-sm font-mono">{target.loginEmail}</code>
          </div>
          <PasswordInput
            label="كلمة السر الجديدة"
            placeholder="٨ أحرف على الأقل"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            autoFocus
          />
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={onCancel} disabled={busy}>
              إلغاء
            </Button>
            <Button
              className="flex-1"
              onClick={onConfirm}
              loading={busy}
              disabled={value.length < 8}
            >
              تعيين
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
  return (
    <Modal isOpen={!!target} onClose={onCancel} title="حذف موظف">
      {target && (
        <div className="space-y-4">
          <p className="text-sm text-text-primary">
            هل تريد حذف <span className="font-bold">{target.displayName}</span>؟
          </p>
          <p className="text-xs text-text-secondary">
            لن يستطيع <code dir="ltr" className="font-mono">{target.loginEmail}</code> تسجيل الدخول بعد ذلك.
            الإجراء لا يمكن التراجع عنه.
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" className="flex-1" onClick={onCancel} disabled={busy}>
              إلغاء
            </Button>
            <Button variant="danger" className="flex-1" onClick={onConfirm} loading={busy}>
              حذف
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
  const valid = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(value) && value.length >= 2;
  const changed = value && value !== currentSlug;

  return (
    <Modal isOpen={isOpen} onClose={onCancel} title="اسم تسجيل الدخول للمتجر">
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">
          يستخدمه موظفوك في تسجيل الدخول كـ <code dir="ltr" className="font-mono">username@&lt;handle&gt;</code>.
          تغييره يحدّث جميع عناوين الموظفين تلقائياً.
        </p>
        <div>
          <label className="block text-sm font-medium text-text-secondary mb-1.5">
            الاسم الجديد
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
            الحالي:{" "}
            <code dir="ltr" className="font-mono">@{currentSlug}</code>
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onCancel} disabled={busy}>
            إلغاء
          </Button>
          <Button
            className="flex-1"
            onClick={onConfirm}
            loading={busy}
            disabled={!valid || !changed}
          >
            حفظ
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
      onToast({ type: "success", message: "تم حفظ الصلاحيات" });
      setEditing(false);
      await onChange();
    } catch (e) {
      onToast({ type: "error", message: e instanceof Error ? e.message : "تعذر الحفظ" });
    }
  };

  const isOwnerRow = member.role === "owner";
  const monogram = (member.displayName || member.username || "?").trim()[0]?.toUpperCase() ?? "?";

  return (
    <li className="px-5 py-3.5 hover:bg-bg-main/60 transition-colors">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1 flex items-center gap-3">
          {/* Avatar */}
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
              <span className="font-medium text-text-primary truncate">{member.displayName}</span>
              <span
                className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                  isOwnerRow
                    ? "bg-accent-light text-accent"
                    : "bg-gray-100 text-text-secondary"
                }`}
              >
                {isOwnerRow ? "المالك" : "موظف"}
              </span>
              {member.mustChangePassword && !isOwnerRow && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-orange-50 text-orange-700">
                  يجب تغيير كلمة السر
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
              title="تعديل البيانات"
            >
              <Pencil className="w-3.5 h-3.5" />
              تعديل
            </button>
            <button
              type="button"
              onClick={onEditDetails}
              disabled={busy}
              className="sm:hidden p-2 rounded-md text-text-secondary hover:bg-white hover:text-accent disabled:opacity-50"
              title="تعديل البيانات"
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
              {editing ? "إغلاق" : "الصلاحيات"}
            </button>
            <button
              type="button"
              onClick={onResetPassword}
              disabled={busy}
              className="p-2 rounded-md text-text-secondary hover:bg-white hover:text-accent disabled:opacity-50"
              title="إعادة تعيين كلمة السر"
            >
              <KeyRound className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onRemove}
              disabled={busy}
              className="p-2 rounded-md text-text-secondary hover:bg-danger-light hover:text-danger disabled:opacity-50"
              title="حذف"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {editing && !isOwnerRow && (
        <div className="mt-3 ms-14 rounded-xl border border-border p-4 bg-bg-main/60 space-y-3">
          {PERMISSION_GROUPS.map((group) => (
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
                    <span>{PERMISSION_LABELS[p]}</span>
                  </label>
                ))}
              </div>
            </div>
          ))}
          <div className="flex justify-end pt-1">
            <Button size="sm" onClick={save}>
              <Save className="w-4 h-4 me-1" />
              حفظ الصلاحيات
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
