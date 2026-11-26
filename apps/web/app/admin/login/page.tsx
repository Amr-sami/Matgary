"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useDictionary } from "@/components/i18n/DictionaryProvider";
import { LangSwitcher } from "@/components/i18n/LangSwitcher";

export default function AdminLoginPage() {
  const router = useRouter();
  const dict = useDictionary();
  const t = dict.app.admin.login;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        const j = (await res.json()) as { redirectTo?: string };
        router.push(j.redirectTo ?? "/admin");
        router.refresh();
        return;
      }
      if (res.status === 429) {
        setError(t.rateLimited);
        return;
      }
      setError(t.invalidCredentials);
    } catch {
      setError(t.networkError);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg-main flex items-center justify-center p-4 relative">
      <div className="absolute top-3 end-3">
        <LangSwitcher variant="compact" cookieOnly />
      </div>
      <div className="w-full max-w-sm bg-bg-card border border-border rounded-2xl p-6 shadow-sm">
        <div className="text-center mb-5">
          <p className="text-[11px] uppercase tracking-wider text-text-secondary">
            {t.brand}
          </p>
          <h1 className="text-xl font-bold text-text-primary mt-1">
            {t.title}
          </h1>
          <p className="text-xs text-text-secondary mt-1">{t.subtitle}</p>
        </div>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label
              htmlFor="email"
              className="block text-xs font-medium text-text-secondary mb-1"
            >
              {t.emailLabel}
            </label>
            <input
              id="email"
              type="email"
              dir="ltr"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          <div>
            <label
              htmlFor="password"
              className="block text-xs font-medium text-text-secondary mb-1"
            >
              {t.passwordLabel}
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
            />
          </div>
          {error && (
            <p className="text-xs text-danger bg-danger-light rounded-md px-3 py-2">
              {error}
            </p>
          )}
          <button
            type="submit"
            disabled={submitting}
            className="w-full h-10 rounded-lg bg-accent text-white text-sm font-semibold hover:bg-accent/90 disabled:opacity-50"
          >
            {submitting ? t.submitting : t.submit}
          </button>
        </form>
      </div>
    </div>
  );
}
