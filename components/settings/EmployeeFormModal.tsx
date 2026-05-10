"use client";

import { useEffect, useState } from "react";
import { Save, Plus, ShieldCheck, IdentificationCard, MapPin, Phone, Store } from "@/lib/icons";
import { Modal } from "../ui/Modal";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { PasswordInput } from "../ui/PasswordInput";
import { PhotoUploadZone } from "./PhotoUploadZone";
import {
  DEFAULT_STAFF_PERMISSIONS,
  PERMISSION_GROUPS,
  PERMISSION_LABELS,
  type Permission,
} from "@/lib/permissions";
import { useBranches } from "@/hooks/useBranches";

export interface EmployeeFormMember {
  userId: string;
  username: string;
  displayName: string;
  permissions: Permission[];
  phone: string | null;
  nationalId: string | null;
  address: string | null;
  profilePhotoPath: string | null;
  idPhotoPath: string | null;
  branchId: string | null;
}

type ToastFn = (t: { type: "success" | "error"; message: string }) => void;

interface Props {
  isOpen: boolean;
  /** Member to edit; null = create mode. */
  member: EmployeeFormMember | null;
  /** Tenant slug shown next to the username in create mode. */
  slug: string;
  onClose: () => void;
  onSaved: (created?: { loginEmail: string; password: string }) => Promise<void>;
  onToast: ToastFn;
}

interface PendingPhoto {
  file: File;
  previewUrl: string;
}

const sectionTitle = "text-xs font-semibold uppercase tracking-wide text-text-secondary mb-3";

export function EmployeeFormModal({ isOpen, member, slug, onClose, onSaved, onToast }: Props) {
  const isEdit = !!member;

  // Field state
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [nationalId, setNationalId] = useState("");
  const [address, setAddress] = useState("");
  const [perms, setPerms] = useState<Permission[]>(DEFAULT_STAFF_PERMISSIONS);
  // Multi-store: each staff member is locked to ONE branch. The picker is
  // hidden when the tenant has only one branch (nothing to choose).
  const [branchId, setBranchId] = useState<string>("");
  const { branches } = useBranches();

  // Photo state — saved path on server vs. just-picked local file
  const [profilePath, setProfilePath] = useState<string | null>(null);
  const [profilePending, setProfilePending] = useState<PendingPhoto | null>(null);
  const [idPath, setIdPath] = useState<string | null>(null);
  const [idPending, setIdPending] = useState<PendingPhoto | null>(null);
  const [profileUploading, setProfileUploading] = useState(false);
  const [idUploading, setIdUploading] = useState(false);

  const [submitting, setSubmitting] = useState(false);

  // Hydrate when opening / switching member
  useEffect(() => {
    if (!isOpen) return;
    if (member) {
      setDisplayName(member.displayName);
      setUsername(member.username);
      setPassword("");
      setPhone(member.phone ?? "");
      setNationalId(member.nationalId ?? "");
      setAddress(member.address ?? "");
      setPerms(member.permissions);
      setBranchId(member.branchId ?? "");
      setProfilePath(member.profilePhotoPath);
      setIdPath(member.idPhotoPath);
    } else {
      setDisplayName("");
      setUsername("");
      setPassword("");
      setPhone("");
      setNationalId("");
      setAddress("");
      setPerms(DEFAULT_STAFF_PERMISSIONS);
      // Default a new staff member to the active branch (whichever the
      // owner is currently on) so the most common case is one click.
      const primary = branches.find((b) => b.isPrimary)?.id;
      setBranchId(primary ?? branches[0]?.id ?? "");
      setProfilePath(null);
      setIdPath(null);
    }
    setProfilePending(null);
    setIdPending(null);
  }, [isOpen, member, branches]);

  // Revoke preview blob URLs on unmount/replacement so we don't leak.
  useEffect(() => {
    return () => {
      if (profilePending) URL.revokeObjectURL(profilePending.previewUrl);
      if (idPending) URL.revokeObjectURL(idPending.previewUrl);
    };
  }, [profilePending, idPending]);

  const togglePerm = (p: Permission) => {
    setPerms((curr) =>
      curr.includes(p) ? curr.filter((x) => x !== p) : [...curr, p],
    );
  };

  const pickPhoto = (kind: "profile" | "id", file: File) => {
    const previewUrl = URL.createObjectURL(file);
    if (kind === "profile") {
      if (profilePending) URL.revokeObjectURL(profilePending.previewUrl);
      setProfilePending({ file, previewUrl });
    } else {
      if (idPending) URL.revokeObjectURL(idPending.previewUrl);
      setIdPending({ file, previewUrl });
    }
  };

  const clearPhoto = (kind: "profile" | "id") => {
    if (kind === "profile") {
      if (profilePending) URL.revokeObjectURL(profilePending.previewUrl);
      setProfilePending(null);
      setProfilePath(null);
    } else {
      if (idPending) URL.revokeObjectURL(idPending.previewUrl);
      setIdPending(null);
      setIdPath(null);
    }
  };

  /** Upload a pending file, return its server path (or null on failure). */
  const uploadPending = async (
    file: File,
    setUploading: (v: boolean) => void,
  ): Promise<string | null> => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/uploads/team", { method: "POST", body: fd });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        onToast({ type: "error", message: json.error || "تعذر رفع الصورة" });
        return null;
      }
      const json = await res.json();
      return json.path as string;
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    // Required fields per spec.
    if (!displayName.trim()) {
      onToast({ type: "error", message: "اسم الموظف مطلوب" });
      return;
    }
    if (!isEdit && (!username.trim() || password.length < 8)) {
      onToast({ type: "error", message: "اسم المستخدم وكلمة سر ٨ أحرف على الأقل" });
      return;
    }
    if (!phone.trim() || !nationalId.trim() || !address.trim()) {
      onToast({ type: "error", message: "رقم الهاتف والرقم القومي والعنوان مطلوبون" });
      return;
    }

    setSubmitting(true);
    try {
      // Resolve photo paths: upload anything pending first.
      let resolvedProfile = profilePath;
      let resolvedId = idPath;

      if (profilePending) {
        const p = await uploadPending(profilePending.file, setProfileUploading);
        if (!p) {
          setSubmitting(false);
          return;
        }
        resolvedProfile = p;
      }
      if (idPending) {
        const p = await uploadPending(idPending.file, setIdUploading);
        if (!p) {
          setSubmitting(false);
          return;
        }
        resolvedId = p;
      }

      if (isEdit) {
        const res = await fetch(`/api/team/${member!.userId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            displayName: displayName.trim(),
            permissions: perms,
            phone: phone.trim() || null,
            nationalId: nationalId.trim() || null,
            address: address.trim() || null,
            profilePhotoPath: resolvedProfile,
            idPhotoPath: resolvedId,
            branchId,
          }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          onToast({ type: "error", message: json.error || "تعذر الحفظ" });
          return;
        }
        await onSaved();
        onClose();
      } else {
        const res = await fetch("/api/team", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: username.trim(),
            displayName: displayName.trim(),
            password,
            permissions: perms,
            phone: phone.trim() || null,
            nationalId: nationalId.trim() || null,
            address: address.trim() || null,
            profilePhotoPath: resolvedProfile,
            idPhotoPath: resolvedId,
            branchId,
          }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          onToast({ type: "error", message: json.error || "تعذر الإضافة" });
          return;
        }
        const json = await res.json();
        await onSaved({ loginEmail: json.loginEmail, password });
        onClose();
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEdit ? "تعديل بيانات الموظف" : "إضافة موظف جديد"}
      className="max-w-2xl"
    >
      <div className="space-y-6">
        {/* Section 1: Basic info */}
        <section>
          <h3 className={sectionTitle}>بيانات الموظف</h3>
          <div className="grid md:grid-cols-2 gap-3">
            <Input
              label="الاسم *"
              placeholder="أحمد محمد"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />

            {!isEdit ? (
              <div>
                <label className="block text-sm font-medium text-text-secondary mb-1.5">
                  اسم المستخدم *
                </label>
                <div className="flex items-center gap-1 bg-white border border-border rounded-lg overflow-hidden focus-within:ring-2 focus-within:ring-accent">
                  <input
                    type="text"
                    dir="ltr"
                    placeholder="ahmed"
                    value={username}
                    onChange={(e) =>
                      setUsername(
                        e.target.value.replace(/[^a-z0-9._-]/gi, "").toLowerCase(),
                      )
                    }
                    className="flex-1 px-3 py-2.5 bg-transparent focus:outline-none text-text-primary"
                  />
                  <span dir="ltr" className="px-3 py-2.5 text-text-secondary bg-bg-main text-sm">
                    @{slug}
                  </span>
                </div>
              </div>
            ) : (
              <Input
                label="اسم المستخدم"
                value={`${username}@${slug}`}
                disabled
                dir="ltr"
              />
            )}
          </div>

          {!isEdit && (
            <div className="mt-3">
              <PasswordInput
                label="كلمة السر المؤقتة *"
                placeholder="٨ أحرف على الأقل — يغيّرها الموظف عند أول دخول"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          )}
        </section>

        {/* Section 2: Identity */}
        <section className="pt-4 border-t border-border">
          <h3 className={sectionTitle}>الهوية وبيانات الاتصال</h3>
          <div className="grid md:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5">
                <Phone className="w-3.5 h-3.5 inline-block me-1" />
                رقم الهاتف *
              </label>
              <input
                type="tel"
                dir="ltr"
                inputMode="tel"
                placeholder="01012345678"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="w-full px-4 py-2.5 rounded-lg border border-border bg-white text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1.5">
                <IdentificationCard className="w-3.5 h-3.5 inline-block me-1" />
                الرقم القومي *
              </label>
              <input
                type="text"
                dir="ltr"
                inputMode="numeric"
                placeholder="14 رقم"
                value={nationalId}
                onChange={(e) =>
                  setNationalId(e.target.value.replace(/[^0-9]/g, "").slice(0, 14))
                }
                className="w-full px-4 py-2.5 rounded-lg border border-border bg-white text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm font-mono"
              />
            </div>
          </div>
          <div className="mt-3">
            <label className="block text-sm font-medium text-text-secondary mb-1.5">
              <MapPin className="w-3.5 h-3.5 inline-block me-1" />
              العنوان *
            </label>
            <textarea
              dir="rtl"
              rows={2}
              placeholder="المدينة، الشارع، رقم العقار"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              className="w-full px-4 py-2.5 rounded-lg border border-border bg-white text-text-primary focus:outline-none focus:ring-2 focus:ring-accent text-sm resize-none"
            />
          </div>
        </section>

        {/* Section 3: Photos */}
        <section className="pt-4 border-t border-border">
          <h3 className={sectionTitle}>الصور (اختياري)</h3>
          <div className="grid grid-cols-2 gap-4">
            <PhotoUploadZone
              label="الصورة الشخصية"
              shape="circle"
              path={profilePath}
              previewUrl={profilePending?.previewUrl}
              uploading={profileUploading}
              onPick={(f) => pickPhoto("profile", f)}
              onClear={() => clearPhoto("profile")}
            />
            <PhotoUploadZone
              label="صورة بطاقة الرقم القومي"
              shape="card"
              path={idPath}
              previewUrl={idPending?.previewUrl}
              uploading={idUploading}
              onPick={(f) => pickPhoto("id", f)}
              onClear={() => clearPhoto("id")}
            />
          </div>
        </section>

        {/* Section 3.5: Branch — multi-store: each staff member is locked
            to exactly one branch (when they sign in they only see that
            branch's data). Hidden for single-store tenants. */}
        {branches.length > 1 && (
          <section className="pt-4 border-t border-border">
            <h3 className={sectionTitle}>
              <Store className="w-3.5 h-3.5 inline-block me-1" />
              الفرع
            </h3>
            <p className="text-xs text-text-secondary mb-2">
              اختر الفرع الذي يعمل به الموظف. عند تسجيل الدخول لن يرى سوى بيانات هذا الفرع.
            </p>
            <select
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:border-accent"
            >
              <option value="" disabled>
                اختر فرعاً…
              </option>
              {branches
                .filter((b) => b.isActive)
                .map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                    {b.isPrimary ? " (الرئيسي)" : ""}
                  </option>
                ))}
            </select>
          </section>
        )}

        {/* Section 4: Permissions */}
        <section className="pt-4 border-t border-border">
          <h3 className={sectionTitle}>
            <ShieldCheck className="w-3.5 h-3.5 inline-block me-1" />
            الصلاحيات
          </h3>
          <div className="space-y-3">
            {PERMISSION_GROUPS.map((group) => (
              <div key={group.title}>
                <p className="text-xs text-text-secondary mb-1.5">{group.title}</p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  {group.permissions.map((p) => (
                    <label
                      key={p}
                      className="flex items-start gap-2 text-sm rounded-md p-1.5 hover:bg-bg-main cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 accent-accent w-4 h-4"
                        checked={perms.includes(p)}
                        onChange={() => togglePerm(p)}
                      />
                      <span>{PERMISSION_LABELS[p]}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Footer */}
        <div className="flex gap-2 justify-end pt-4 border-t border-border">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            إلغاء
          </Button>
          <Button onClick={submit} loading={submitting}>
            {isEdit ? (
              <>
                <Save className="w-4 h-4 me-1" />
                حفظ التعديلات
              </>
            ) : (
              <>
                <Plus className="w-4 h-4 me-1" />
                إضافة موظف
              </>
            )}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
