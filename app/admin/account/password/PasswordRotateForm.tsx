"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useDictionary } from "@/components/i18n/DictionaryProvider";

interface Props {
  required: boolean;
}

const MIN_LEN = 12;

export function PasswordRotateForm({ required }: Props) {
  const router = useRouter();
  const dict = useDictionary();
  const t = dict.app.admin.password;
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const shapeError = checkShape(newPassword);
  const mismatch = newPassword !== "" && confirm !== "" && newPassword !== confirm;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (shapeError) {
      setError(mapShape(shapeError, t.rules));
      return;
    }
    if (mismatch) {
      setError(t.errors.mismatch);
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/auth/rotate-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(mapServer(j.error, t.errors));
        return;
      }
      const j = (await res.json()) as { redirectTo?: string };
      router.push(j.redirectTo ?? "/admin");
      router.refresh();
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">
          {t.currentLabel}
        </label>
        <input
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(e) => setCurrentPassword(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">
          {t.newLabel}
        </label>
        <input
          type="password"
          autoComplete="new-password"
          required
          value={newPassword}
          onChange={(e) => setNewPassword(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>
      <div>
        <label className="block text-xs font-medium text-text-secondary mb-1">
          {t.confirmLabel}
        </label>
        <input
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          className="w-full px-3 py-2 rounded-lg border border-border bg-white text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      <div className="text-[11px] text-text-secondary space-y-0.5">
        <p>• {t.rules.minLen.replace("{n}", String(MIN_LEN))}</p>
        <p>• {t.rules.upperLower}</p>
        <p>• {t.rules.digit}</p>
        <p>• {t.rules.noReuse}</p>
      </div>

      {error && (
        <p className="text-xs text-danger bg-danger-light rounded-md px-3 py-2">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={saving}
        className="w-full h-10 rounded-lg bg-accent text-white text-sm font-semibold hover:bg-accent/90 disabled:opacity-50"
      >
        {saving ? t.saving : t.save}
      </button>

      {!required && (
        <Link
          href="/admin/account"
          className="block text-center text-xs text-text-secondary hover:text-accent"
        >
          {t.cancel}
        </Link>
      )}
    </form>
  );
}

type Shape = "TOO_SHORT" | "NEED_LOWER" | "NEED_UPPER" | "NEED_DIGIT" | null;

function checkShape(pw: string): Shape {
  if (pw.length === 0) return null;
  if (pw.length < MIN_LEN) return "TOO_SHORT";
  if (!/[a-z]/.test(pw)) return "NEED_LOWER";
  if (!/[A-Z]/.test(pw)) return "NEED_UPPER";
  if (!/[0-9]/.test(pw)) return "NEED_DIGIT";
  return null;
}

interface RulesT {
  minLen: string;
  upperLower: string;
  digit: string;
  noReuse: string;
}

function mapShape(s: NonNullable<Shape>, rules: RulesT): string {
  switch (s) {
    case "TOO_SHORT":
      return rules.minLen.replace("{n}", String(MIN_LEN));
    case "NEED_LOWER":
    case "NEED_UPPER":
      return rules.upperLower;
    case "NEED_DIGIT":
      return rules.digit;
  }
}

interface ErrorsT {
  mismatch: string;
  wrongCurrent: string;
  reused: string;
  generic: string;
}

function mapServer(code: string | undefined, errors: ErrorsT): string {
  switch (code) {
    case "WRONG_CURRENT":
      return errors.wrongCurrent;
    case "PASSWORD_REUSED":
      return errors.reused;
    default:
      return errors.generic;
  }
}
