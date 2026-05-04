"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

export default function ChangePasswordPage() {
  const router = useRouter();
  const { data: session, update } = useSession();
  const [isPending, startTransition] = useTransition();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const mustChange = !!session?.user?.mustChangePassword;

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    if (next.length < 8) {
      setError("كلمة السر الجديدة يجب أن تكون ٨ أحرف على الأقل");
      return;
    }
    if (next !== confirm) {
      setError("كلمتا السر غير متطابقتين");
      return;
    }
    startTransition(async () => {
      const res = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error || "تعذر التغيير");
        return;
      }
      setSuccess(true);
      // Refresh JWT so mustChangePassword flips to false (otherwise middleware
      // would redirect them right back here).
      try {
        await update?.();
      } catch {
        // ignore
      }
      router.replace("/");
      router.refresh();
    });
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-main px-4 py-10">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-sm border border-border p-8">
        <div className="text-center mb-6">
          <div className="w-12 h-12 rounded-full bg-accent-light text-accent mx-auto mb-3 flex items-center justify-center">
            <KeyRound className="w-6 h-6" />
          </div>
          <h1 className="text-2xl font-bold text-text-primary">تغيير كلمة السر</h1>
          {mustChange && (
            <p className="text-sm text-text-secondary mt-1">
              يجب عليك تغيير كلمة السر قبل المتابعة
            </p>
          )}
        </div>

        <form onSubmit={submit} className="space-y-4">
          <Input
            type="password"
            label="كلمة السر الحالية"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
            dir="ltr"
            autoComplete="current-password"
          />
          <Input
            type="password"
            label="كلمة السر الجديدة"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
            dir="ltr"
            autoComplete="new-password"
            placeholder="٨ أحرف على الأقل"
          />
          <Input
            type="password"
            label="تأكيد كلمة السر الجديدة"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            dir="ltr"
            autoComplete="new-password"
          />

          {error && <p className="text-sm text-danger">{error}</p>}
          {success && (
            <p className="text-sm text-success">تم تغيير كلمة السر بنجاح</p>
          )}

          <Button
            type="submit"
            className="w-full"
            loading={isPending}
            disabled={!current || !next || !confirm}
          >
            حفظ
          </Button>
        </form>
      </div>
    </div>
  );
}
