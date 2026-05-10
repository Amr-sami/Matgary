"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { AppShell } from "@/components/layout/AppShell";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Toast } from "@/components/ui/Toast";
import {
  Plus,
  Pencil,
  Trash2,
  Store,
  Eye,
  EyeOff,
} from "@/lib/icons";
import { useBranches, type BranchSummary } from "@/hooks/useBranches";

interface DraftBranch {
  id: string | null;
  name: string;
  address: string;
  phone: string;
}

const EMPTY_DRAFT: DraftBranch = {
  id: null,
  name: "",
  address: "",
  phone: "",
};

export default function BranchesSettingsPage() {
  const { data: session, status } = useSession();
  const router = useRouter();
  const isOwner = session?.user?.role === "owner";

  const { branches, current, loading, refresh, switchTo } = useBranches();
  const [draft, setDraft] = useState<DraftBranch | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{
    msg: string;
    tone: "success" | "error";
  } | null>(null);

  // Owners only — non-owners get bounced. SSR doesn't know the role; once the
  // session resolves on the client we redirect away.
  useEffect(() => {
    if (status === "loading") return;
    if (!isOwner) router.replace("/settings");
  }, [status, isOwner, router]);

  if (status === "loading" || !isOwner) {
    return (
      <AppShell title="الفروع">
        <p className="text-sm text-text-secondary">جاري التحميل…</p>
      </AppShell>
    );
  }

  const startEdit = (b: BranchSummary) =>
    setDraft({
      id: b.id,
      name: b.name,
      address: b.address ?? "",
      phone: b.phone ?? "",
    });

  const startCreate = () => setDraft({ ...EMPTY_DRAFT });
  const cancelDraft = () => setDraft(null);

  const submit = async () => {
    if (!draft) return;
    if (!draft.name.trim()) {
      setToast({ msg: "اسم الفرع مطلوب", tone: "error" });
      return;
    }
    setBusy(true);
    try {
      const isCreate = draft.id === null;
      const url = isCreate ? "/api/branches" : `/api/branches/${draft.id}`;
      const method = isCreate ? "POST" : "PATCH";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name.trim(),
          address: draft.address.trim() || null,
          phone: draft.phone.trim() || null,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "تعذر الحفظ");
      }
      setToast({
        msg: isCreate ? "تم إنشاء الفرع" : "تم حفظ التعديلات",
        tone: "success",
      });
      setDraft(null);
      await refresh();
    } catch (err) {
      setToast({
        msg: err instanceof Error ? err.message : "حدث خطأ",
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (b: BranchSummary) => {
    if (b.isPrimary && b.isActive) {
      setToast({ msg: "لا يمكن إيقاف الفرع الرئيسي", tone: "error" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/branches/${b.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !b.isActive }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "تعذر التحديث");
      }
      setToast({
        msg: b.isActive ? "تم إيقاف الفرع" : "تم تفعيل الفرع",
        tone: "success",
      });
      await refresh();
    } catch (err) {
      setToast({
        msg: err instanceof Error ? err.message : "حدث خطأ",
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (b: BranchSummary) => {
    if (b.isPrimary) {
      setToast({ msg: "لا يمكن حذف الفرع الرئيسي", tone: "error" });
      return;
    }
    if (
      !window.confirm(
        `هل تريد حذف فرع «${b.name}»؟ سيتم رفض العملية إذا كان الفرع يحتوي على بيانات (مبيعات/مصاريف/مخزون).`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/branches/${b.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const counts = body.counts as
          | Record<string, number>
          | undefined;
        const hint = counts
          ? Object.entries(counts)
              .filter(([, n]) => n > 0)
              .map(([k, n]) => `${k}: ${n}`)
              .join(" • ")
          : "";
        throw new Error(`${body.error ?? "تعذر الحذف"}${hint ? ` (${hint})` : ""}`);
      }
      setToast({ msg: "تم حذف الفرع", tone: "success" });
      await refresh();
    } catch (err) {
      setToast({
        msg: err instanceof Error ? err.message : "حدث خطأ",
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AppShell title="إدارة الفروع">
      <div className="max-w-3xl mx-auto space-y-5">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-text-primary">الفروع</h1>
            <p className="text-sm text-text-secondary mt-1">
              تعدد الفروع يتيح لك تتبع المبيعات والمخزون لكل موقع على حدة.
            </p>
          </div>
          {!draft && (
            <Button onClick={startCreate} disabled={busy} className="shrink-0">
              <Plus className="w-4 h-4" />
              إضافة فرع
            </Button>
          )}
        </header>

        {/* Editor */}
        {draft && (
          <div className="bg-bg-card border border-border rounded-2xl p-5 space-y-4">
            <h2 className="text-base font-semibold text-text-primary">
              {draft.id ? "تعديل فرع" : "فرع جديد"}
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Input
                label="اسم الفرع"
                value={draft.name}
                onChange={(e) =>
                  setDraft({ ...draft, name: e.target.value })
                }
                placeholder="مثال: فرع المعادي"
                disabled={busy}
              />
              <Input
                label="رقم الهاتف"
                value={draft.phone}
                onChange={(e) =>
                  setDraft({ ...draft, phone: e.target.value })
                }
                placeholder="01XXXXXXXXX"
                disabled={busy}
              />
              <div className="md:col-span-2">
                <Input
                  label="العنوان"
                  value={draft.address}
                  onChange={(e) =>
                    setDraft({ ...draft, address: e.target.value })
                  }
                  placeholder="شارع X، حي Y، …"
                  disabled={busy}
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={cancelDraft}
                disabled={busy}
                className="text-sm text-text-secondary hover:text-text-primary px-3 py-2"
              >
                إلغاء
              </button>
              <Button onClick={submit} disabled={busy} loading={busy}>
                {draft.id ? "حفظ التعديلات" : "إنشاء"}
              </Button>
            </div>
          </div>
        )}

        {/* List */}
        <div className="bg-bg-card border border-border rounded-2xl overflow-hidden">
          {loading ? (
            <p className="text-sm text-text-secondary text-center py-10">
              جاري التحميل…
            </p>
          ) : branches.length === 0 ? (
            <p className="text-sm text-text-secondary text-center py-10">
              لا توجد فروع.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {branches.map((b) => {
                const isCurrent = b.id === current?.id;
                return (
                  <li
                    key={b.id}
                    className="flex items-start gap-3 px-5 py-4"
                  >
                    <div
                      className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center ${
                        b.isActive
                          ? "bg-accent-light text-accent"
                          : "bg-gray-100 text-text-secondary"
                      }`}
                    >
                      <Store className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="font-medium text-text-primary truncate">
                          {b.name}
                        </p>
                        {b.isPrimary && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-accent-light text-accent">
                            رئيسي
                          </span>
                        )}
                        {isCurrent && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-success-light text-success">
                            الفرع الحالي
                          </span>
                        )}
                        {!b.isActive && (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-gray-100 text-text-secondary">
                            موقوف
                          </span>
                        )}
                      </div>
                      {b.address && (
                        <p className="text-xs text-text-secondary mt-0.5 truncate">
                          {b.address}
                        </p>
                      )}
                      {b.phone && (
                        <p className="text-xs text-text-secondary mt-0.5">
                          {b.phone}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {!isCurrent && b.isActive && (
                        <button
                          type="button"
                          onClick={async () => {
                            try {
                              await switchTo(b.id);
                            } catch (err) {
                              setToast({
                                msg:
                                  err instanceof Error
                                    ? err.message
                                    : "تعذر التبديل",
                                tone: "error",
                              });
                            }
                          }}
                          disabled={busy}
                          className="text-xs px-3 py-1.5 rounded-md bg-accent text-white hover:bg-accent-hover transition-colors"
                        >
                          فتح
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => startEdit(b)}
                        disabled={busy}
                        title="تعديل"
                        className="p-2 rounded-md text-text-secondary hover:bg-bg-main hover:text-accent"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => toggleActive(b)}
                        disabled={busy || b.isPrimary}
                        title={b.isActive ? "إيقاف الفرع" : "تفعيل الفرع"}
                        className={`p-2 rounded-md transition-colors disabled:opacity-30 ${
                          b.isActive
                            ? "text-text-secondary hover:bg-bg-main hover:text-orange-600"
                            : "text-success hover:bg-success-light"
                        }`}
                      >
                        {b.isActive ? (
                          <EyeOff className="w-4 h-4" />
                        ) : (
                          <Eye className="w-4 h-4" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(b)}
                        disabled={busy || b.isPrimary}
                        title="حذف"
                        className="p-2 rounded-md text-text-secondary hover:bg-danger-light hover:text-danger disabled:opacity-30"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {toast && (
        <Toast
          message={toast.msg}
          type={toast.tone}
          onClose={() => setToast(null)}
        />
      )}
    </AppShell>
  );
}
