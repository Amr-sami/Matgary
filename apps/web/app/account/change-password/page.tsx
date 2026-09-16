"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import { KeyRound } from "@/lib/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

export default function ChangePasswordPage() {
  const dict = useDictionary();
  const t = dict.app.changePassword;
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
      setError(t.tooShort);
      return;
    }
    if (next !== confirm) {
      setError(t.mismatch);
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
        setError(err.error || t.genericError);
        return;
      }
      setSuccess(true);
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
          <h1 className="text-2xl font-bold text-text-primary">{t.title}</h1>
          {mustChange && (
            <p className="text-sm text-text-secondary mt-1">
              {t.mustChange}
            </p>
          )}
        </div>

        <form onSubmit={submit} className="space-y-4">
          <Input
            type="password"
            label={t.current}
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
            dir="ltr"
            autoComplete="current-password"
          />
          <Input
            type="password"
            label={t.new}
            value={next}
            onChange={(e) => setNext(e.target.value)}
            required
            dir="ltr"
            autoComplete="new-password"
            placeholder={t.newPlaceholder}
          />
          <Input
            type="password"
            label={t.confirm}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            dir="ltr"
            autoComplete="new-password"
          />

          {error && <p className="text-sm text-danger">{error}</p>}
          {success && (
            <p className="text-sm text-success">{t.success}</p>
          )}

          <Button
            type="submit"
            className="w-full"
            loading={isPending}
            disabled={!current || !next || !confirm}
          >
            {t.submit}
          </Button>
        </form>
      </div>
    </div>
  );
}
